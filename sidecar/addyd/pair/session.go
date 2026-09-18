package pair

import (
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"errors"
	"fmt"

	"github.com/opsmaxx/opsmaxx/sidecar/addyd/pair/spake2"
)

// The pairing exchange: three frames on the signalling channel, two of which
// carry PAKE material. The server relays all three and learns nothing from any
// of them.
//
//	1  pair.start    A -> B   pairing_id, spake2_msg_A, A's DK_sign.pub
//	2  pair.reply    B -> A   spake2_msg_B, conf_B, B's DK_sign.pub, DK_enc.pub
//	3  pair.confirm  A -> B   conf_A
//
// B can compute the shared secret on receiving frame 1, so its key confirmation
// rides along with its PAKE message. A cannot confirm before it has seen B's,
// which is why there is a third frame -- "a two-message exchange" is true of
// SPAKE2 itself, not of a pairing that also has to confirm.
//
// CORRECTION TO docs/PROTOCOL.md section 8.3, found by implementing it. The
// specification puts A's DK_sign.pub on frame 3 and conf_B on frame 2 -- and
// section 8.4 puts BOTH signing keys in the confirmation label. Those cannot
// both hold: B has to compute conf_B for frame 2, and at that point it has not
// been told A's key.
//
// Resolved by moving A's DK_sign.pub to frame 1, which is the smaller change
// and costs nothing: it is a public key, the relay sees it either way, and the
// roster carries device public keys as T1 metadata regardless. Frame 3 then
// carries only conf_A, since conf_A already binds A's key -- a relay that
// substituted it would fail the confirmation rather than need a second copy to
// be compared against.

const (
	// PairingIDLen names the session. Sixteen CSPRNG bytes, carried in the
	// clear: it is a name, not a secret. Binding it into the password is what
	// stops a code observed in one session being replayed into another.
	PairingIDLen = 16

	pwLabel      = "addy-pake-pw-v1"
	confirmLabel = "addy-pair-confirm-v1"
	confirmLen   = 32
)

var (
	ErrConfirmFailed = errors.New("pair: key confirmation failed")
	ErrOutOfOrder    = errors.New("pair: frames arrived out of order")
)

// NewPairingID names a session.
func NewPairingID() ([]byte, error) {
	id := make([]byte, PairingIDLen)
	if _, err := rand.Read(id); err != nil {
		return nil, fmt.Errorf("pair: drawing a pairing id: %w", err)
	}
	return id, nil
}

// password turns the code into the PAKE password.
//
// account_id is deliberately NOT in here: the joining device does not know it
// yet and learns it from the pairing. A binding to a value one side cannot
// compute is not a binding, it is a bug.
func password(code string, pairingID []byte) []byte {
	h := sha256.New()
	h.Write([]byte(pwLabel))
	h.Write([]byte{0x00})
	var n [4]byte
	n[0] = byte(len(code) >> 24)
	n[1] = byte(len(code) >> 16)
	n[2] = byte(len(code) >> 8)
	n[3] = byte(len(code))
	h.Write(n[:])
	h.Write([]byte(code))
	h.Write(pairingID)
	return h.Sum(nil)
}

// Initiator is the device showing the code.
type Initiator struct {
	PairingID []byte
	PubSign   []byte // this device's DK_sign public half

	state  *spake2.State
	msgA   []byte
	secret []byte
	peer   []byte // the joiner's DK_sign public half, learned on frame 2
	sas    SAS
}

// Joiner is the device the code is typed into.
type Joiner struct {
	PairingID []byte
	PubSign   []byte

	secret  []byte
	msgB    []byte
	initPub []byte // the initiator's DK_sign public half, from frame 1
	done    bool
	sas     SAS
}

// StartFrame is frame 1.
type StartFrame struct {
	PairingID []byte
	MsgA      []byte
	PubSign   []byte // A's DK_sign public half; see the correction above
}

// ReplyFrame is frame 2.
type ReplyFrame struct {
	MsgB     []byte
	ConfirmB []byte
	PubSign  []byte
	PubEnc   []byte
}

// ConfirmFrame is frame 3.
type ConfirmFrame struct {
	ConfirmA []byte
}

// Begin starts a pairing on the device showing the code.
func Begin(code string, pubSign []byte) (*Initiator, StartFrame, error) {
	normalised, err := NormaliseCode(code)
	if err != nil {
		return nil, StartFrame{}, err
	}
	id, err := NewPairingID()
	if err != nil {
		return nil, StartFrame{}, err
	}
	msgA, st, err := spake2.Start(spake2.Initiator, password(normalised, id))
	if err != nil {
		return nil, StartFrame{}, err
	}
	return &Initiator{PairingID: id, PubSign: pubSign, state: st, msgA: msgA},
		StartFrame{PairingID: id, MsgA: msgA, PubSign: pubSign}, nil
}

// Join answers frame 1 with frame 2, on the device the code was typed into.
//
// The joiner reaches the shared secret first, which is why its confirmation
// rides along here rather than needing a frame of its own.
func Join(code string, f StartFrame, pubSign, pubEnc []byte) (*Joiner, ReplyFrame, error) {
	normalised, err := NormaliseCode(code)
	if err != nil {
		return nil, ReplyFrame{}, err
	}
	if len(f.PairingID) != PairingIDLen {
		return nil, ReplyFrame{}, fmt.Errorf("pair: a pairing id is %d bytes", PairingIDLen)
	}

	msgB, st, err := spake2.Start(spake2.Joiner, password(normalised, f.PairingID))
	if err != nil {
		return nil, ReplyFrame{}, err
	}
	secret, err := st.Finish(f.MsgA)
	if err != nil {
		return nil, ReplyFrame{}, err
	}

	if len(f.PubSign) == 0 {
		return nil, ReplyFrame{}, errors.New("pair: frame 1 carries no initiator signing key")
	}

	_, confB, err := confirmations(secret, f.PairingID, f.PubSign, pubSign)
	if err != nil {
		return nil, ReplyFrame{}, err
	}

	j := &Joiner{PairingID: f.PairingID, PubSign: pubSign, secret: secret, msgB: msgB, initPub: f.PubSign}
	return j, ReplyFrame{MsgB: msgB, ConfirmB: confB, PubSign: pubSign, PubEnc: pubEnc}, nil
}

// confirmations derives both tags. The identity keys are in the label, so the
// confirmation binds the PAKE result to the two keys the devices are about to
// trust -- without that, the PAKE proves a shared password and nothing about
// who holds it.
func confirmations(secret, pairingID, initPubSign, joinPubSign []byte) (confA, confB []byte, err error) {
	// LENGTH-PREFIXED, not concatenated. An unprefixed concatenation means two
	// different key pairs can produce the same label -- shift a byte from the
	// end of one key to the start of the next and the bytes are identical.
	//
	// It is not exploitable here today: SPAKE2 already stops a relay choosing
	// the secret, and the roster's fixed[32] fields stop a key of another
	// width reaching this. But "two inputs, one label" is the shape of a real
	// bug, and prefixes cost four bytes each.
	label := lengthPrefixed(confirmLabel, pairingID, initPubSign, joinPubSign)

	// No salt: the shared secret is already high-entropy and unique to this
	// exchange, and a salt the two sides derive differently is a mismatch a
	// user reads as an attack.
	okm, err := hkdf.Key(sha256.New, secret, nil, string(label), confirmLen*2)
	if err != nil {
		return nil, nil, fmt.Errorf("pair: deriving confirmations: %w", err)
	}
	return okm[:confirmLen], okm[confirmLen:], nil
}

// Reply consumes frame 2 on the initiator and produces frame 3.
//
// It verifies the joiner's confirmation first. A failure here aborts, burns the
// code and counts an attempt -- a code that survives a failed confirmation is a
// code an attacker gets to try again.
func (i *Initiator) Reply(f ReplyFrame) (ConfirmFrame, error) {
	if i.secret != nil {
		return ConfirmFrame{}, ErrOutOfOrder
	}
	secret, err := i.state.Finish(f.MsgB)
	if err != nil {
		return ConfirmFrame{}, err
	}
	confA, confB, err := confirmations(secret, i.PairingID, i.PubSign, f.PubSign)
	if err != nil {
		return ConfirmFrame{}, err
	}
	// Unconditional. An earlier draft skipped the comparison when ConfirmB was
	// nil, which would have let a relay strip the confirmation and be believed
	// -- a check that an attacker can turn off is not a check.
	if subtle.ConstantTimeCompare(confB, f.ConfirmB) != 1 {
		return ConfirmFrame{}, ErrConfirmFailed
	}

	i.secret = secret
	i.peer = f.PubSign

	// THE SAS IS DERIVED ONLY NOW, after the confirmation verified. Seven emoji
	// shown before key confirmation would be seven emoji a user compares
	// against a session that has proved nothing.
	sas, err := DeriveSAS(secret, i.PairingID, i.PubSign, f.PubSign)
	if err != nil {
		return ConfirmFrame{}, err
	}
	i.sas = sas

	return ConfirmFrame{ConfirmA: confA}, nil
}

// Confirm consumes frame 3 on the joiner.
func (j *Joiner) Confirm(f ConfirmFrame) error {
	if j.done {
		return ErrOutOfOrder
	}
	confA, _, err := confirmations(j.secret, j.PairingID, j.initPub, j.PubSign)
	if err != nil {
		return err
	}
	if subtle.ConstantTimeCompare(confA, f.ConfirmA) != 1 {
		return ErrConfirmFailed
	}
	j.done = true

	sas, err := DeriveSAS(j.secret, j.PairingID, j.initPub, j.PubSign)
	if err != nil {
		return err
	}
	j.sas = sas
	return nil
}

// PeerPubSign is the other device's signing key, once the pairing has confirmed.
func (i *Initiator) PeerPubSign() []byte { return i.peer }

// PeerPubSign is the other device's signing key, once the pairing has confirmed.
func (j *Joiner) PeerPubSign() []byte {
	if !j.done {
		return nil
	}
	return j.initPub
}

// SAS returns the seven emoji, and only after key confirmation has verified.
func (i *Initiator) SAS() (SAS, error) {
	if i.secret == nil {
		return SAS{}, errors.New("pair: no SAS until key confirmation has verified")
	}
	return i.sas, nil
}

// SAS returns the seven emoji, and only after key confirmation has verified.
func (j *Joiner) SAS() (SAS, error) {
	if !j.done {
		return SAS{}, errors.New("pair: no SAS until key confirmation has verified")
	}
	return j.sas, nil
}

// Secret is the pairing's shared secret, for sealing the account key handoff.
func (i *Initiator) Secret() []byte { return i.secret }

// Secret is the pairing's shared secret.
func (j *Joiner) Secret() []byte { return j.secret }

// lengthPrefixed builds an HKDF label whose parts cannot be shifted into one
// another: the ASCII tag, a NUL, then each field preceded by its own length.
func lengthPrefixed(tag string, parts ...[]byte) []byte {
	out := make([]byte, 0, len(tag)+1+len(parts)*36)
	out = append(out, tag...)
	out = append(out, 0x00)
	for _, p := range parts {
		var n [4]byte
		binary.BigEndian.PutUint32(n[:], uint32(len(p)))
		out = append(out, n[:]...)
		out = append(out, p...)
	}
	return out
}
