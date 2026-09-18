package main

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"sync"

	"github.com/opsmaxx/opsmaxx/sidecar/addyd/pair"
	"github.com/opsmaxx/opsmaxx/sidecar/addyd/protocol"
)

// Pairing, in the process that holds the keys.
//
// The relay carries opaque frames between the two devices and learns nothing.
// What it CANNOT do, and what makes the short code safe, is guess: SPAKE2 turns
// a six-word code into a shared secret in one round trip, and a wrong guess
// gives an attacker one attempt rather than an offline target.
//
// THE ATTEMPT LIMITER IS ON THE DEVICE, not the server. A server-side limiter
// protects a server that is not the thing under attack -- the code is between
// two devices, and a relay that counted attempts would be a relay trusted to
// count honestly.

// pairings holds in-flight sessions. In memory only, like everything else
// here: a pairing that survived a restart would be a pairing whose other end
// has already given up.
var pairings = struct {
	mu        sync.Mutex
	initiator map[string]*pair.Initiator
	joiner    map[string]*pair.Joiner
	// attempts counts failed joins per pairing id. THE LIMITER, and it lives
	// beside the sessions rather than in the parent because a limiter the
	// parent enforced would be one a bug in the parent could skip.
	attempts map[string]int
}{
	initiator: map[string]*pair.Initiator{},
	joiner:    map[string]*pair.Joiner{},
	attempts:  map[string]int{},
}

// maxAttempts is how many wrong codes a pairing tolerates before it is dead.
//
// Three. SPAKE2 gives an attacker one guess per attempt and no offline target,
// so the limit is not protecting the code's entropy -- it is making a
// shoulder-surfed or mistyped code fail visibly rather than letting somebody
// grind quietly while the user wonders why pairing is slow.
const maxAttempts = 3

// --- the device showing the code ---

// handlePairBegin mints a code and returns the first frame.
func handlePairBegin(req Request) (any, error) {
	keys.mu.RLock()
	device := keys.device
	loaded := keys.loaded
	keys.mu.RUnlock()
	if !loaded || device == nil {
		return nil, codedf(ErrNotPaired, "no account is loaded")
	}

	keys.mu.RLock()
	acct := keys.account
	keys.mu.RUnlock()

	code, err := pair.NewCode()
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "minting a pairing code")
	}
	pubSign := device.Sign.Public().(ed25519.PublicKey)
	initiator, frame, err := pair.Begin(code, pubSign)
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "starting a pairing")
	}

	id := hex.EncodeToString(frame.PairingID)
	pairings.mu.Lock()
	pairings.initiator[id] = initiator
	pairings.mu.Unlock()

	return map[string]any{
		// The code is shown to the user and read aloud or typed on the other
		// device. It never goes over the relay.
		"code":      code,
		"pairingId": id,
		"startFrame": map[string]string{
			"pairingId": id,
			"msgA":      base64.StdEncoding.EncodeToString(frame.MsgA),
			"pubSign":   hex.EncodeToString(frame.PubSign),
			// The account the joiner is being invited to.
			//
			// It has to travel, because the handoff binds it into the HPKE
			// info, the key-commitment context AND the AAD -- so the joiner
			// must know it BEFORE it can open anything, and cannot read it out
			// of what it is trying to open. A first version of this assumed
			// the opposite and failed with a commitment mismatch, which is the
			// binding doing its job.
			//
			// Safe to send in the clear: it is derived from a public key and
			// the relay already routes by it. And a relay that substituted one
			// would produce a handoff that does not open -- which is the same
			// commitment mismatch, arriving as a refusal rather than as a
			// device joined to the wrong account.
			"accountId": acct.String(),
		},
	}, nil
}

// handlePairReply takes the joiner's frame and returns the confirmation plus
// the SAS.
//
// THE SAS IS RETURNED ONLY AFTER THE KEY CONFIRMATION MAC VERIFIES. That
// ordering is the whole value of showing emoji: a SAS computed before
// confirmation would be a SAS an attacker can influence, and a user comparing
// two matching lists would be confirming the attacker's session.
func handlePairReply(req Request) (any, error) {
	var in struct {
		PairingID string `json:"pairingId"`
		MsgB      string `json:"msgB"`
		ConfirmB  string `json:"confirmB"`
		PubSign   string `json:"pubSign"`
		PubEnc    string `json:"pubEnc"`
	}
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}

	pairings.mu.Lock()
	initiator, ok := pairings.initiator[in.PairingID]
	attempts := pairings.attempts[in.PairingID]
	pairings.mu.Unlock()
	if !ok {
		return nil, codedf(ErrPairingExpired, "no pairing is in progress with that id")
	}
	if attempts >= maxAttempts {
		return nil, codedf(ErrPairingRefused,
			"too many failed attempts on this pairing; start a new one")
	}

	msgB, err1 := base64.StdEncoding.DecodeString(in.MsgB)
	confirmB, err2 := base64.StdEncoding.DecodeString(in.ConfirmB)
	pubSign, err3 := hex.DecodeString(in.PubSign)
	pubEnc, err4 := hex.DecodeString(in.PubEnc)
	if err1 != nil || err2 != nil || err3 != nil || err4 != nil {
		return nil, codedf(ErrConfigInvalid, "the reply frame is malformed")
	}

	confirm, err := initiator.Reply(pair.ReplyFrame{
		MsgB: msgB, ConfirmB: confirmB, PubSign: pubSign, PubEnc: pubEnc,
	})
	if err != nil {
		// A wrong code lands here, as a failed MAC. Counted, and counted
		// before the error is returned so a caller that retries in a loop
		// still runs out.
		pairings.mu.Lock()
		pairings.attempts[in.PairingID]++
		spent := pairings.attempts[in.PairingID] >= maxAttempts
		if spent {
			delete(pairings.initiator, in.PairingID)
		}
		pairings.mu.Unlock()
		return nil, wrapCoded(ErrSASMismatch, err, "the other device did not confirm")
	}

	sas, err := initiator.SAS()
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "deriving the comparison emoji")
	}

	return map[string]any{
		"confirmFrame": map[string]string{
			"confirmA": base64.StdEncoding.EncodeToString(confirm.ConfirmA),
		},
		"sas":      sas.Emoji[:],
		"sasWords": sas.Words(),
		"peer": map[string]string{
			"pubSign": hex.EncodeToString(initiator.PeerPubSign()),
			"pubEnc":  hex.EncodeToString(pubEnc),
		},
	}, nil
}

// --- the device typing the code ---

// handlePairJoin answers the first frame.
func handlePairJoin(req Request) (any, error) {
	var in struct {
		Code      string `json:"code"`
		PairingID string `json:"pairingId"`
		MsgA      string `json:"msgA"`
		PubSign   string `json:"pubSign"`
	}
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}

	keys.mu.RLock()
	device := keys.device
	keys.mu.RUnlock()
	if device == nil {
		// A joining device has its own key before it has an account: it is
		// about to be ADDED to one. So the key is minted here rather than
		// required to exist.
		fresh, err := protocol.NewDeviceKeys()
		if err != nil {
			return nil, wrapCoded(ErrInternal, err, "minting a device key")
		}
		keys.mu.Lock()
		keys.device = fresh
		keys.mu.Unlock()
		device = fresh
	}

	pairingID, err1 := hex.DecodeString(in.PairingID)
	msgA, err2 := base64.StdEncoding.DecodeString(in.MsgA)
	peerSign, err3 := hex.DecodeString(in.PubSign)
	if err1 != nil || err2 != nil || err3 != nil {
		return nil, codedf(ErrConfigInvalid, "the start frame is malformed")
	}

	joiner, reply, err := pair.Join(in.Code, pair.StartFrame{
		PairingID: pairingID, MsgA: msgA, PubSign: peerSign,
	}, device.Sign.Public().(ed25519.PublicKey), device.Enc.PublicKey().Bytes())
	if err != nil {
		return nil, wrapCoded(ErrPairingRefused, err, "joining the pairing")
	}

	pairings.mu.Lock()
	pairings.joiner[in.PairingID] = joiner
	pairings.mu.Unlock()

	return map[string]any{
		"replyFrame": map[string]string{
			"msgB":     base64.StdEncoding.EncodeToString(reply.MsgB),
			"confirmB": base64.StdEncoding.EncodeToString(reply.ConfirmB),
			"pubSign":  hex.EncodeToString(reply.PubSign),
			"pubEnc":   hex.EncodeToString(reply.PubEnc),
		},
		// Deliberately NO SAS here. The joiner has not verified the
		// initiator's confirmation yet, so any emoji it showed now would be
		// emoji derived from a session nobody has authenticated.
	}, nil
}

// handlePairConfirm verifies the initiator's MAC and only then returns the SAS.
func handlePairConfirm(req Request) (any, error) {
	var in struct {
		PairingID string `json:"pairingId"`
		ConfirmA  string `json:"confirmA"`
	}
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}

	pairings.mu.Lock()
	joiner, ok := pairings.joiner[in.PairingID]
	pairings.mu.Unlock()
	if !ok {
		return nil, codedf(ErrPairingExpired, "no pairing is in progress with that id")
	}

	confirmA, err := base64.StdEncoding.DecodeString(in.ConfirmA)
	if err != nil {
		return nil, codedf(ErrConfigInvalid, "the confirm frame is malformed")
	}
	if err := joiner.Confirm(pair.ConfirmFrame{ConfirmA: confirmA}); err != nil {
		pairings.mu.Lock()
		pairings.attempts[in.PairingID]++
		if pairings.attempts[in.PairingID] >= maxAttempts {
			delete(pairings.joiner, in.PairingID)
		}
		pairings.mu.Unlock()
		return nil, wrapCoded(ErrSASMismatch, err, "the other device did not confirm")
	}

	sas, err := joiner.SAS()
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "deriving the comparison emoji")
	}

	keys.mu.RLock()
	device := keys.device
	keys.mu.RUnlock()

	return map[string]any{
		"sas":      sas.Emoji[:],
		"sasWords": sas.Words(),
		"peer": map[string]string{
			"pubSign": hex.EncodeToString(joiner.PeerPubSign()),
		},
		// The joiner's own public halves, which the initiator needs in order
		// to write the roster entry that adds it.
		"self": map[string]string{
			"pubSign": hex.EncodeToString(device.Sign.Public().(ed25519.PublicKey)),
			"pubEnc":  hex.EncodeToString(device.Enc.PublicKey().Bytes()),
		},
	}, nil
}

// handlePairForget drops a session.
//
// Called when the user says the emoji do not match, and on every ordinary
// completion. A pairing left in the map is a session an attacker can still
// send frames to, and the map is the only thing holding the shared secret.
func handlePairForget(req Request) (any, error) {
	var in struct {
		PairingID string `json:"pairingId"`
	}
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}
	pairings.mu.Lock()
	delete(pairings.initiator, in.PairingID)
	delete(pairings.joiner, in.PairingID)
	delete(pairings.attempts, in.PairingID)
	pairings.mu.Unlock()
	return map[string]any{"ok": true}, nil
}

// --- the handoff ---
//
// PAIRING WITHOUT THIS IS TWO DEVICES THAT AGREE WHO EACH OTHER ARE AND
// NOTHING ELSE. The emoji confirm identity; the handoff is what actually makes
// the joiner a member of the account, by giving it AK_n. Until this ran, a
// device could complete a pairing, see matching emoji, and then find it could
// not read a single object -- which looks like a broken sync rather than an
// unfinished pairing.
//
// NOTHING IS SEALED BEFORE THE HUMAN CONFIRMS. The initiator calls
// `pairHandoff` only after the user has said the emoji match, and that
// ordering is the entire value of the confirmation step: a handoff sealed
// before it would be a handoff to whoever answered, which is the attack the
// emoji exist to stop.

func handlePairHandoff(req Request) (any, error) {
	var in struct {
		PairingID string `json:"pairingId"`
		Epoch     uint64 `json:"epoch"`
		// Base64 of AK_n, which the parent holds sealed and hands in for this
		// one operation. Not read from `keys`, because the epoch seed is not
		// what `load` stores -- it stores derived keys.
		AKSeed string `json:"akSeed"`
		// The roster head, verbatim, so the joiner can verify the chain it is
		// about to fetch rather than trusting the relay's copy.
		HeadEntry string `json:"headEntry"`
		// Hex of the peer's X25519 public half, from the confirmed pairing.
		PeerPubEnc string `json:"peerPubEnc"`
		Counter    uint64 `json:"counter"`
	}
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}

	pairings.mu.Lock()
	initiator, ok := pairings.initiator[in.PairingID]
	pairings.mu.Unlock()
	if !ok {
		// Refused rather than sealed to a key from a session nobody can prove
		// was confirmed. A handoff outside a live, confirmed pairing has no
		// binding to bind to.
		return nil, codedf(ErrPairingExpired, "no confirmed pairing with that id")
	}

	akSeed, err := base64.StdEncoding.DecodeString(in.AKSeed)
	if err != nil || len(akSeed) != 32 {
		return nil, codedf(ErrConfigInvalid, "akSeed is 32 bytes, base64")
	}
	head, err := base64.StdEncoding.DecodeString(in.HeadEntry)
	if err != nil {
		return nil, codedf(ErrConfigInvalid, "headEntry is not base64")
	}
	peerEncRaw, err := hex.DecodeString(in.PeerPubEnc)
	if err != nil || len(peerEncRaw) != 32 {
		return nil, codedf(ErrConfigInvalid, "peerPubEnc is 32 bytes of hex")
	}
	peerEnc, err := ecdh.X25519().NewPublicKey(peerEncRaw)
	if err != nil {
		return nil, wrapCoded(ErrConfigInvalid, err, "the peer's encryption key is not on the curve")
	}

	keys.mu.RLock()
	acct := keys.account
	loaded := keys.loaded
	rootPub := []byte(nil)
	if keys.device != nil {
		rootPub = keys.rootSignPub
	}
	keys.mu.RUnlock()
	if !loaded {
		return nil, codedf(ErrNotPaired, "no account is loaded")
	}

	// BOUND TO THE SPAKE2 SECRET. That is what stops a relay -- which carries
	// every frame -- from substituting its own handoff: it never learns the
	// secret, so it cannot produce a binding that opens.
	sealed, err := protocol.SealHandoff(protocol.Handoff{
		AccountID:   acct,
		Epoch:       in.Epoch,
		Counter:     in.Counter,
		AKSeed:      akSeed,
		RootSignPub: rootPub,
		HeadEntry:   head,
	}, peerEnc, initiator.Secret())
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "sealing the handoff")
	}
	return map[string]any{"handoff": base64.StdEncoding.EncodeToString(sealed)}, nil
}

// handlePairAccept opens the handoff on the joining device and loads the
// account, which is the moment it becomes a member.
func handlePairAccept(req Request) (any, error) {
	var in struct {
		PairingID string `json:"pairingId"`
		Handoff   string `json:"handoff"`
		Epoch     uint64 `json:"epoch"`
		Counter   uint64 `json:"counter"`
		// From the start frame. Required, because the handoff binds it and
		// cannot be opened without it -- see the note there.
		AccountID string `json:"accountId"`
	}
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}

	pairings.mu.Lock()
	joiner, ok := pairings.joiner[in.PairingID]
	pairings.mu.Unlock()
	if !ok {
		return nil, codedf(ErrPairingExpired, "no confirmed pairing with that id")
	}

	sealed, err := base64.StdEncoding.DecodeString(in.Handoff)
	if err != nil {
		return nil, codedf(ErrConfigInvalid, "handoff is not base64")
	}

	keys.mu.RLock()
	device := keys.device
	keys.mu.RUnlock()
	if device == nil {
		return nil, codedf(ErrNotPaired, "this device has no key; join a pairing first")
	}

	rawAcct, err := hex.DecodeString(in.AccountID)
	if err != nil || len(rawAcct) != protocol.AccountIDLen {
		return nil, codedf(ErrConfigInvalid, "accountId is %d bytes of hex", protocol.AccountIDLen)
	}
	var acct protocol.AccountID
	copy(acct[:], rawAcct)

	// Bound to the account, the epoch, the counter AND the pairing secret. A
	// relay that swapped any of the four produces a blob that does not open,
	// which is a refusal rather than a device joined to something it did not
	// agree to.
	h, err := protocol.OpenHandoff(sealed, acct, in.Epoch, in.Counter, device.Enc, joiner.Secret())
	if err != nil {
		return nil, wrapCoded(ErrPairingRefused, err, "opening the handoff")
	}

	epochKeys, err := protocol.DeriveEpoch(h.AKSeed, h.AccountID, h.Epoch)
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "deriving the epoch key")
	}

	keys.mu.Lock()
	keys.account = h.AccountID
	keys.rootSignPub = h.RootSignPub
	keys.epochs[h.Epoch] = epochKeys
	keys.loaded = true
	keys.mu.Unlock()

	return map[string]any{
		"accountId":   h.AccountID.String(),
		"epoch":       h.Epoch,
		"rootSignPub": hex.EncodeToString(h.RootSignPub),
		"headEntry":   base64.StdEncoding.EncodeToString(h.HeadEntry),
	}, nil
}
