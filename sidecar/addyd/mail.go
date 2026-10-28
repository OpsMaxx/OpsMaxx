package main

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"sync"
	"time"

	"github.com/opsmaxx/opsmaxx/sidecar/addyd/protocol"
)

// Device-to-device mail: clipboards and file notices.
//
// These were sealed with `seal` under the epoch key and a `clipboard:<peer>`
// label, so any holder of the epoch key -- a removed device until the next
// re-key -- could read every one and write one that arrived "from" any device
// the relay cared to name. A forged clipboard pasted into an SSH terminal runs
// commands. Now each mail is sealed to the recipient's DK_enc and signed by
// the sender's DK_sign (protocol/mail.go), and `openMail` refuses one unless
// its signer is a device the parent's VERIFIED roster lists.

// mailFutureSkew is how far ahead of this clock a sender's may run. Two
// machines a user owns drift by seconds, not minutes; a mail stamped further
// ahead than this is one somebody stamped to outlive its window.
const mailFutureSkew = 5 * time.Minute

// mailMaxAge caps the window a caller may ask for. The relay keeps mail for
// 48 hours, so nothing legitimate is older than that by much.
const mailMaxAge = 7 * 24 * time.Hour

// mailSeen remembers every (sender, nonce) opened, until its window closes, so
// the relay cannot hand the same mail over twice. In memory: a restart forgets
// it, which re-admits only mail still inside its window that a current member
// really did send to this device.
var mailSeen = struct {
	sync.Mutex
	until map[string]time.Time
}{until: map[string]time.Time{}}

type sealMailRequest struct {
	Kind string `json:"kind"`
	// Hex of the recipient's DK_sign and DK_enc, both from ONE entry of the
	// roster the parent verified. Never from a relay response.
	To      string `json:"to"`
	ToEnc   string `json:"toEnc"`
	Payload string `json:"payload"`
}

func handleSealMail(req Request) (any, error) {
	var in sealMailRequest
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}
	to, err := hex.DecodeString(in.To)
	if err != nil || len(to) != ed25519.PublicKeySize {
		return nil, codedf(ErrConfigInvalid, "to is 32 bytes of hex")
	}
	encRaw, err := hex.DecodeString(in.ToEnc)
	if err != nil {
		return nil, codedf(ErrConfigInvalid, "toEnc is hex")
	}
	toEnc, err := ecdh.X25519().NewPublicKey(encRaw)
	if err != nil {
		return nil, codedf(ErrConfigInvalid, "toEnc is not an X25519 public key")
	}
	payload, err := base64.StdEncoding.DecodeString(in.Payload)
	if err != nil {
		return nil, codedf(ErrConfigInvalid, "payload is not base64")
	}

	keys.mu.RLock()
	acct, device, loaded := keys.account, keys.device, keys.loaded
	keys.mu.RUnlock()
	if !loaded || device == nil {
		return nil, codedf(ErrNotPaired, "no account is loaded")
	}
	nonce, err := protocol.Nonce()
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "drawing a nonce")
	}
	sealed, err := protocol.SealMail(protocol.Mail{
		AccountID: acct,
		Kind:      in.Kind,
		From:      device.Sign.Public().(ed25519.PublicKey),
		To:        to,
		Nonce:     nonce,
		TS:        uint64(time.Now().UnixMilli()),
	}, payload, device.Sign, toEnc)
	if err != nil {
		return nil, wrapCoded(ErrConfigInvalid, err, "sealing mail")
	}
	return map[string]any{"sealed": base64.StdEncoding.EncodeToString(sealed)}, nil
}

type openMailRequest struct {
	Kind   string `json:"kind"`
	Sealed string `json:"sealed"`
	// Hex DK_sign of every device the parent's verified roster lists. The
	// relay's `fromDevice` is not an input here on purpose: who sent a mail is
	// what its signature says, and only these keys may have.
	Senders []string `json:"senders"`
	// How old a mail of this kind may be and still be acted on.
	MaxAgeMs uint64 `json:"maxAgeMs"`
}

func handleOpenMail(req Request) (any, error) {
	var in openMailRequest
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}
	maxAge := time.Duration(in.MaxAgeMs) * time.Millisecond
	if maxAge <= 0 || maxAge > mailMaxAge {
		return nil, codedf(ErrConfigInvalid, "maxAgeMs must be between 1 and %d", mailMaxAge.Milliseconds())
	}
	object, err := base64.StdEncoding.DecodeString(in.Sealed)
	if err != nil {
		return nil, codedf(ErrConfigInvalid, "sealed is not base64")
	}

	keys.mu.RLock()
	acct, device, loaded := keys.account, keys.device, keys.loaded
	keys.mu.RUnlock()
	if !loaded || device == nil {
		return nil, codedf(ErrNotPaired, "no account is loaded")
	}

	m, payload, err := protocol.OpenMail(object, acct, in.Kind,
		device.Sign.Public().(ed25519.PublicKey), device.Enc)
	if err != nil {
		if errors.Is(err, protocol.ErrMailForged) {
			return nil, codedf(ErrConfigInvalid, "this mail was not signed by the device it names")
		}
		return nil, wrapCoded(ErrConfigInvalid, err, "opening mail")
	}

	// A MEMBER, by the roster the parent verified. A valid signature from a
	// key that is not on it -- a removed device's -- is refused exactly like a
	// forgery, because it is one as far as this account is concerned.
	from := hex.EncodeToString(m.From)
	member := false
	for _, s := range in.Senders {
		if s == from {
			member = true
		}
	}
	if !member {
		return nil, codedf(ErrConfigInvalid, "this mail was signed by a device that is not on this account")
	}

	sent := time.UnixMilli(int64(m.TS))
	now := time.Now()
	if sent.After(now.Add(mailFutureSkew)) {
		return nil, codedf(ErrConfigInvalid, "this mail is dated in the future")
	}
	if now.Sub(sent) > maxAge {
		return nil, codedf(ErrConfigInvalid, "this mail is too old to act on")
	}

	key := from + hex.EncodeToString(m.Nonce)
	mailSeen.Lock()
	defer mailSeen.Unlock()
	for k, until := range mailSeen.until {
		if now.After(until) {
			delete(mailSeen.until, k)
		}
	}
	if _, seen := mailSeen.until[key]; seen {
		return nil, codedf(ErrConfigInvalid, "this mail was already delivered once")
	}
	// Remembered until the window closes measured from the LATER of the two
	// clocks, so a sender running ahead does not shorten how long that is.
	mailSeen.until[key] = later(sent, now).Add(maxAge + mailFutureSkew)

	return map[string]any{
		"from":    from,
		"sentAt":  m.TS,
		"payload": base64.StdEncoding.EncodeToString(payload),
	}, nil
}

func later(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}

// handleSealBlob seals a file transfer's bytes under a one-time key, which the
// caller puts in the transfer's notice. Needs no account: the key IS the
// access, and it travels only inside a mail sealed to the recipient.
func handleSealBlob(req Request) (any, error) {
	var in struct {
		Payload string `json:"payload"`
	}
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}
	payload, err := base64.StdEncoding.DecodeString(in.Payload)
	if err != nil {
		return nil, codedf(ErrConfigInvalid, "payload is not base64")
	}
	key, sealed, err := protocol.SealMailBlob(payload)
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "sealing a blob")
	}
	return map[string]any{
		"key":    base64.StdEncoding.EncodeToString(key),
		"sealed": base64.StdEncoding.EncodeToString(sealed),
	}, nil
}

func handleOpenBlob(req Request) (any, error) {
	var in struct {
		Key    string `json:"key"`
		Sealed string `json:"sealed"`
	}
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}
	key, err := base64.StdEncoding.DecodeString(in.Key)
	if err != nil {
		return nil, codedf(ErrConfigInvalid, "key is not base64")
	}
	sealed, err := base64.StdEncoding.DecodeString(in.Sealed)
	if err != nil {
		return nil, codedf(ErrConfigInvalid, "sealed is not base64")
	}
	payload, err := protocol.OpenMailBlob(key, sealed)
	if err != nil {
		return nil, wrapCoded(ErrConfigInvalid, err, "opening a blob")
	}
	return map[string]any{"payload": base64.StdEncoding.EncodeToString(payload)}, nil
}
