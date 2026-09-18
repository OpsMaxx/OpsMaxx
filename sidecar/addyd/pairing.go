package main

import (
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
