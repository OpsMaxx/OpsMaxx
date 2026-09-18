package protocol

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"errors"
	"fmt"
)

// The roster: an append-only hash-chained log of devices.
//
// THIS IS THE CONTROL THAT MAKES THE HEADLINE CLAIM TRUE. The server holds the
// chain and has no signing key, so it cannot author an entry. A device is added
// by an existing device, never by the server. Every client verifies the whole
// chain from genesis before it encrypts anything to any device in it.

// Op is what an entry does.
type Op uint8

const (
	OpAdd    Op = 0x01
	OpRevoke Op = 0x02
	OpEpoch  Op = 0x03
	opMax       = uint8(OpEpoch)
)

// Signer names which key signed an entry.
//
// An EXPLICIT FIELD rather than an inference from op plus context. The verifier
// has to know which key to check before it checks, and an implicit rule is the
// kind two implementations get differently.
type Signer uint8

const (
	SignerAK  Signer = 0x01
	SignerRK  Signer = 0x02
	signerMax        = uint8(SignerRK)
)

// Entry flags. All other bits MUST be zero: an ignored bit is a covert channel
// and a future compatibility trap at the same time.
const (
	// FlagMnemonicAuthored marks an entry authored during a recovery ceremony.
	// It is INSIDE the signed body, so the server cannot strip it to hide the
	// fact.
	FlagMnemonicAuthored uint8 = 0x01
	// FlagRevocationRotation marks an epoch transition as a response to
	// compromise rather than hygiene.
	FlagRevocationRotation uint8 = 0x02

	knownFlags = FlagMnemonicAuthored | FlagRevocationRotation
)

const linkDomain = "addy-roster-link-v1"

// Entry is one roster record. On the wire it is body || sig, and the split is
// unambiguous without a length prefix because sig is fixed-width and last.
type Entry struct {
	AccountID AccountID
	Epoch     uint64
	Seq       uint64
	PrevHash  []byte // fixed[32]; 32 zero bytes at genesis
	Op        Op
	Signer    Signer
	Flags     uint8
	Nonce     []byte // fixed[32], the author's
	PubSign   []byte // fixed[32]; meaning depends on Op
	PubEnc    []byte // fixed[32]
	LabelCT   []byte // sealed pseudonym for add; MUST be empty for revoke and epoch
	TS        uint64 // display only

	Sig []byte // 64 bytes, over the encoded body
}

// Encode produces the signed body.
func (e Entry) Encode() ([]byte, error) {
	for name, p := range map[string][]byte{
		"prev_hash": e.PrevHash,
		"nonce":     e.Nonce,
		"pub_sign":  e.PubSign,
		"pub_enc":   e.PubEnc,
	} {
		if err := fixed(name, p, 32); err != nil {
			return nil, err
		}
	}
	return NewEncoder(DomainRoster).
		Fixed(e.AccountID[:]).
		U64(e.Epoch).
		U64(e.Seq).
		Fixed(e.PrevHash).
		U8(uint8(e.Op)).
		U8(uint8(e.Signer)).
		U8(e.Flags).
		Fixed(e.Nonce).
		Fixed(e.PubSign).
		Fixed(e.PubEnc).
		Bytes(e.LabelCT).
		U64(e.TS).
		Out(), nil
}

// Wire is body || sig.
func (e Entry) Wire() ([]byte, error) {
	body, err := e.Encode()
	if err != nil {
		return nil, err
	}
	if len(e.Sig) != ed25519.SignatureSize {
		return nil, fmt.Errorf("protocol: an entry signature is %d bytes, want %d", len(e.Sig), ed25519.SignatureSize)
	}
	return append(body, e.Sig...), nil
}

// Hash is H(entry) = SHA-256("addy-roster-link-v1\0" || body || sig).
//
// THE HASH COVERS THE SIGNATURE, not just the body. A hash over the body alone
// would let an attacker who can produce a second valid signature over the same
// body substitute it without changing any subsequent prev_hash -- the chain
// would still link and the head hash a human compares between two windows would
// still match. Covering sig makes the head a commitment to the exact bytes,
// which is the only version of that check worth showing to a person.
func (e Entry) Hash() ([]byte, error) {
	wire, err := e.Wire()
	if err != nil {
		return nil, err
	}
	h := sha256.New()
	h.Write([]byte(linkDomain))
	h.Write([]byte{0x00})
	h.Write(wire)
	return h.Sum(nil), nil
}

// DecodeEntry reads one entry from the front of b and returns the rest.
func DecodeEntry(b []byte) (Entry, []byte, error) {
	var e Entry
	d := NewDecoder(DomainRoster, b)

	copy(e.AccountID[:], d.Fixed(AccountIDLen))
	e.Epoch = d.U64()
	e.Seq = d.U64()
	e.PrevHash = d.Fixed(32)
	e.Op = Op(d.Enum(opMax))
	e.Signer = Signer(d.Enum(signerMax))
	e.Flags = d.U8()
	e.Nonce = d.Fixed(32)
	e.PubSign = d.Fixed(32)
	e.PubEnc = d.Fixed(32)
	e.LabelCT = d.Bytes()
	e.TS = d.U64()

	if err := d.Err(); err != nil {
		return Entry{}, nil, err
	}

	// Op 0 is not in the table, and neither is signer 0, so a zeroed field
	// cannot be a legitimate entry. Enum() rejects above the table but 0 is
	// below it.
	if e.Op == 0 {
		return Entry{}, nil, fmt.Errorf("%w: op 0", ErrBadEnum)
	}
	if e.Signer == 0 {
		return Entry{}, nil, fmt.Errorf("%w: signer 0", ErrBadEnum)
	}

	bodyEnd := d.Offset()
	rest := b[bodyEnd:]
	if len(rest) < ed25519.SignatureSize {
		return Entry{}, nil, fmt.Errorf("%w: an entry has no signature", ErrTruncated)
	}
	e.Sig = rest[:ed25519.SignatureSize]
	return e, rest[ed25519.SignatureSize:], nil
}

// Device is one entry in the resulting device set.
type Device struct {
	PubSign []byte
	PubEnc  []byte
	LabelCT []byte
	Epoch   uint64 // the epoch it was added in
	AddedBy Signer
	Flags   uint8
}

// MnemonicAuthored reports whether this device was added using the recovery
// phrase.
//
// Either condition counts: the flag inside the signed body, OR an add signed by
// RK_sign, because RK_sign only exists where the phrase was typed. Both raise
// the loud, separate "a device was added using the recovery phrase"
// notification on every other device -- which is exactly the sentence a user
// needs to see if it was not them.
func (d Device) MnemonicAuthored() bool {
	return d.Flags&FlagMnemonicAuthored != 0 || d.AddedBy == SignerRK
}

// Verified is what a client adopts once the chain has passed every step.
type Verified struct {
	Devices   []Device
	Head      []byte // H(last entry)
	HeadSeq   uint64
	Epoch     uint64 // the epoch the chain ends in
	EpochSign []byte // AK_epoch.sign public half
	EpochEnc  []byte // AK_epoch.enc public half
	Entries   int
}

// Pin is what a client remembers between verifications.
type Pin struct {
	Seq  uint64
	Hash []byte
}

var (
	ErrEmptyChain   = errors.New("roster: the chain is empty")
	ErrBadGenesis   = errors.New("roster: the first entry is not a genesis")
	ErrWrongAccount = errors.New("roster: the chain belongs to another account")
	ErrBadSequence  = errors.New("roster: sequence numbers are not contiguous from zero")
	ErrBrokenLink   = errors.New("roster: an entry does not link to its predecessor")
	ErrBadEpoch     = errors.New("roster: the epoch moved without a transition, or skipped")
	ErrBadFlags     = errors.New("roster: unknown or contradictory flags")
	ErrBadSigner    = errors.New("roster: the entry is signed by the wrong key")
	ErrBadSignature = errors.New("roster: an entry's signature does not verify")
	ErrBadOp        = errors.New("roster: the operation is not valid at this point in the chain")
	ErrForked       = errors.New("roster: the chain has forked from the one this device has seen")
	ErrRewound      = errors.New("roster: the chain is shorter than the one this device has seen")
)

// VerifyChain performs every step of the specification's algorithm in order and
// aborts at the first failure.
//
// THERE IS NO PARTIAL ACCEPTANCE AND NO "WARN AND CONTINUE". A chain that fails
// any step is not a chain with a problem in it; it is a chain from a server that
// is lying, and the only safe response is to stop.
//
// rootSignPub and epoch1Sign are pinned out of band -- from the genesis
// ceremony on this device, or from the escrow blob during a recovery.
func VerifyChain(raw []byte, acct AccountID, rootSignPub ed25519.PublicKey, epoch1Sign ed25519.PublicKey, pin *Pin) (*Verified, error) {
	// Step 1: parse.
	var entries []Entry
	rest := raw
	for len(rest) > 0 {
		e, next, err := DecodeEntry(rest)
		if err != nil {
			return nil, fmt.Errorf("roster: entry %d: %w", len(entries), err)
		}
		entries = append(entries, e)
		rest = next
	}
	if len(entries) == 0 {
		return nil, ErrEmptyChain
	}

	// Step 2: genesis.
	g := entries[0]
	if g.Seq != 0 || g.Op != OpAdd || g.Epoch != 1 || !bytes.Equal(g.PrevHash, make([]byte, 32)) {
		return nil, fmt.Errorf("%w: seq=%d op=%d epoch=%d", ErrBadGenesis, g.Seq, g.Op, g.Epoch)
	}

	// The pinned keys are checked too. A client handed a degenerate root or
	// epoch-1 key would verify a chain anybody could have written, and those
	// keys arrive from a handoff or an escrow rather than from thin air.
	if rootSignPub != nil {
		if err := CheckSigningKey(rootSignPub); err != nil {
			return nil, fmt.Errorf("roster: the pinned root key: %w", err)
		}
	}
	if epoch1Sign != nil {
		if err := CheckSigningKey(epoch1Sign); err != nil {
			return nil, fmt.Errorf("roster: the pinned epoch 1 key: %w", err)
		}
	}

	// Step 3: account binding. Checked against the account id derived from the
	// root key this client holds, so a chain that is internally consistent but
	// belongs to somebody else is refused.
	if rootSignPub != nil {
		if derived := DeriveAccountID(rootSignPub); derived != acct {
			return nil, fmt.Errorf("%w: the root key does not name this account", ErrWrongAccount)
		}
	}

	epochSign := map[uint64]ed25519.PublicKey{1: epoch1Sign}
	epochEnc := map[uint64][]byte{}

	var devices []Device
	var prev []byte
	currentEpoch := uint64(1)

	for i, e := range entries {
		if e.AccountID != acct {
			return nil, fmt.Errorf("%w: entry %d", ErrWrongAccount, i)
		}

		// Step 4: sequence.
		if e.Seq != uint64(i) {
			return nil, fmt.Errorf("%w: entry %d carries seq %d", ErrBadSequence, i, e.Seq)
		}

		// Step 5: link.
		if i > 0 && !bytes.Equal(e.PrevHash, prev) {
			return nil, fmt.Errorf("%w: entry %d", ErrBrokenLink, i)
		}

		// Step 6: epoch monotonicity.
		if i > 0 {
			switch {
			case e.Epoch == currentEpoch:
				if e.Op == OpEpoch {
					return nil, fmt.Errorf("%w: entry %d is a transition that does not advance the epoch", ErrBadEpoch, i)
				}
			case e.Epoch == currentEpoch+1 && e.Op == OpEpoch:
				// The only legitimate increment.
			default:
				return nil, fmt.Errorf("%w: entry %d moves epoch %d to %d with op %d",
					ErrBadEpoch, i, currentEpoch, e.Epoch, e.Op)
			}
		}

		// Step 7: flags.
		if e.Flags&^knownFlags != 0 {
			return nil, fmt.Errorf("%w: entry %d sets unknown bits %#02x", ErrBadFlags, i, e.Flags&^knownFlags)
		}
		if e.Flags&FlagRevocationRotation != 0 {
			if e.Op != OpEpoch {
				return nil, fmt.Errorf("%w: entry %d is flagged a revocation rotation but is not a transition", ErrBadFlags, i)
			}
			// THE WHOLE POINT OF THE EPOCH: a compromised epoch key must not
			// authorise the escape from itself.
			if e.Signer != SignerRK {
				return nil, fmt.Errorf("%w: entry %d is a revocation rotation not signed by the root key", ErrBadSigner, i)
			}
		}

		// Step 8: signer selection.
		var pub ed25519.PublicKey
		switch e.Signer {
		case SignerRK:
			if rootSignPub == nil {
				return nil, fmt.Errorf("%w: entry %d is root-signed and no root key is known", ErrBadSigner, i)
			}
			pub = rootSignPub
		case SignerAK:
			want := e.Epoch
			if e.Op == OpEpoch {
				// A hygiene rotation is verified under the key of the epoch
				// BEFORE the one it names. Stated rather than inferred: getting
				// it off by one produces a chain that verifies on the author's
				// machine and nowhere else.
				want = e.Epoch - 1
			}
			var ok bool
			if pub, ok = epochSign[want]; !ok || pub == nil {
				return nil, fmt.Errorf("%w: entry %d needs epoch %d's key, which the chain has not established", ErrBadSigner, i, want)
			}
		}

		// Step 9: signature -- and FIRST, that the keys in the entry are keys
		// somebody could hold.
		//
		// An entry whose pub_sign is the identity point verifies any signature
		// at all. Without this check, an authorised device could publish a
		// rotation whose AK_{n+1}.sign is degenerate and hand the SERVER the
		// ability to author roster entries with no account key -- which is the
		// one thing this whole chain exists to prevent.
		if err := CheckSigningKey(e.PubSign); err != nil {
			return nil, fmt.Errorf("roster: entry %d pub_sign: %w", i, err)
		}
		if err := CheckAgreementKey(e.PubEnc); err != nil {
			return nil, fmt.Errorf("roster: entry %d pub_enc: %w", i, err)
		}

		body, err := e.Encode()
		if err != nil {
			return nil, fmt.Errorf("roster: entry %d: %w", i, err)
		}
		if !ed25519.Verify(pub, body, e.Sig) {
			return nil, fmt.Errorf("%w: entry %d", ErrBadSignature, i)
		}

		// Step 10: op semantics.
		switch e.Op {
		case OpAdd:
			if len(e.LabelCT) == 0 {
				return nil, fmt.Errorf("%w: entry %d adds a device with no label", ErrBadOp, i)
			}
			if indexOfDevice(devices, e.PubSign) >= 0 {
				// Re-adding a live device is either a bug or an attempt to
				// change its pub_enc.
				return nil, fmt.Errorf("%w: entry %d re-adds a device that is already present", ErrBadOp, i)
			}
			devices = append(devices, Device{
				PubSign: e.PubSign, PubEnc: e.PubEnc, LabelCT: e.LabelCT,
				Epoch: e.Epoch, AddedBy: e.Signer, Flags: e.Flags,
			})

		case OpRevoke:
			if len(e.LabelCT) != 0 {
				// There is nothing to name, so a payload here is a covert
				// channel in bytes the server stores verbatim.
				return nil, fmt.Errorf("%w: entry %d is a revoke carrying a label", ErrBadOp, i)
			}
			at := indexOfDevice(devices, e.PubSign)
			if at < 0 {
				return nil, fmt.Errorf("%w: entry %d revokes a device that is not present", ErrBadOp, i)
			}
			// A revoke naming a substituted pub_enc is refused: it would
			// otherwise be a way to rewrite a live device's encryption key.
			if !bytes.Equal(devices[at].PubEnc, e.PubEnc) {
				return nil, fmt.Errorf("%w: entry %d revokes a device with a substituted encryption key", ErrBadOp, i)
			}
			devices = append(devices[:at], devices[at+1:]...)

		case OpEpoch:
			if len(e.LabelCT) != 0 {
				return nil, fmt.Errorf("%w: entry %d is a transition carrying a label", ErrBadOp, i)
			}
			epochSign[e.Epoch] = ed25519.PublicKey(e.PubSign)
			epochEnc[e.Epoch] = e.PubEnc
		}

		currentEpoch = e.Epoch

		if prev, err = e.Hash(); err != nil {
			return nil, fmt.Errorf("roster: entry %d: %w", i, err)
		}
	}

	last := entries[len(entries)-1]

	// Step 12: rollback.
	if pin != nil {
		if last.Seq < pin.Seq {
			return nil, fmt.Errorf("%w: head is seq %d, this device has seen %d", ErrRewound, last.Seq, pin.Seq)
		}
		if int(pin.Seq) >= len(entries) {
			return nil, fmt.Errorf("%w: no entry at seq %d", ErrForked, pin.Seq)
		}
		at, err := entries[pin.Seq].Hash()
		if err != nil {
			return nil, err
		}
		if !bytes.Equal(at, pin.Hash) {
			return nil, fmt.Errorf("%w: entry %d differs from the one this device has seen", ErrForked, pin.Seq)
		}
	}

	// Step 13: adopt.
	return &Verified{
		Devices:   devices,
		Head:      prev,
		HeadSeq:   last.Seq,
		Epoch:     currentEpoch,
		EpochSign: epochSign[currentEpoch],
		EpochEnc:  epochEnc[currentEpoch],
		Entries:   len(entries),
	}, nil
}

func indexOfDevice(devices []Device, pubSign []byte) int {
	for i, d := range devices {
		if bytes.Equal(d.PubSign, pubSign) {
			return i
		}
	}
	return -1
}
