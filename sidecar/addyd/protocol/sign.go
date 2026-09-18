// SPDX-License-Identifier: MIT
// Vendored from github.com/opsmaxx/addy internal/protocol/sign.go @ fe66709
//
// Edit it THERE and copy it here. A fix made only in this copy is a
// protocol divergence with no symptom until an AEAD tag fails on somebody
// else's machine. See VENDORED.md in this directory.
package protocol

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
)

// The four signature purposes.
//
// As the design was originally drafted, the same device key signed both a login
// challenge THE SERVER CHOSE and a request authorization -- a chosen-message
// oracle across two purposes. The fix is structural rather than procedural, and
// it is two rules:
//
//  1. Every signature is over an ACE-1 structure with its own DOMAIN PREFIX, so
//     a signature over addy-login-v1\0... cannot verify against
//     addy-authz-v1\0... -- the first bytes differ, and a valid signature for
//     one purpose is worthless for another.
//  2. Every signature covers a CLIENT-CONTRIBUTED NONCE: 32 bytes from the
//     signing device, fresh per signature. The server never chooses all of the
//     bytes that get signed.
const (
	DomainLogin  = "addy-login-v1"
	DomainAuthz  = "addy-authz-v1"
	DomainRoster = "addy-roster-v1"
	DomainSignal = "addy-signal-v1"
)

// NonceLen is 32 bytes, drawn fresh for every signature.
const NonceLen = 32

// Nonce draws a client-contributed nonce.
func Nonce() ([]byte, error) {
	n := make([]byte, NonceLen)
	if _, err := rand.Read(n); err != nil {
		return nil, fmt.Errorf("protocol: drawing a nonce: %w", err)
	}
	return n, nil
}

var errFixedLen = errors.New("protocol: a fixed-width field is the wrong length")

func fixed(name string, p []byte, n int) error {
	if len(p) != n {
		return fmt.Errorf("%w: %s is %d bytes, want %d", errFixedLen, name, len(p), n)
	}
	return nil
}

// Login is what a device signs to authenticate to an instance.
type Login struct {
	AccountID   AccountID
	DeviceNonce []byte // fixed[32], this device, this login
	ServerNonce []byte // fixed[32], the server's challenge
	ServerSPKI  []byte // fixed[32], SHA-256 of the instance's TLS SubjectPublicKeyInfo
	TS          uint64
}

// Encode produces the exact bytes that get signed.
//
// ServerSPKI is the TOFU pin from the addy:// join string, and it is in here for
// a specific reason: without it, a login signature captured from one instance
// replays against another instance that serves the same account. The signature
// has to say "I am this device TALKING TO YOU", not merely "I am this device".
func (l Login) Encode() ([]byte, error) {
	if err := fixed("device_nonce", l.DeviceNonce, NonceLen); err != nil {
		return nil, err
	}
	if err := fixed("server_nonce", l.ServerNonce, NonceLen); err != nil {
		return nil, err
	}
	if err := fixed("server_spki", l.ServerSPKI, 32); err != nil {
		return nil, err
	}
	return NewEncoder(DomainLogin).
		Fixed(l.AccountID[:]).
		Fixed(l.DeviceNonce).
		Fixed(l.ServerNonce).
		Fixed(l.ServerSPKI).
		U64(l.TS).
		Out(), nil
}

// Authz is what a device signs to authorise one request.
type Authz struct {
	AccountID   AccountID
	DeviceNonce []byte
	Method      string
	Path        string
	BodyHash    []byte // fixed[32]; 32 zero bytes when there is no body
	TS          uint64
}

// NoBody is the body hash for a request that has none. Thirty-two zero bytes
// rather than an absent field, so the structure has one shape and a decoder has
// nothing to branch on.
var NoBody = make([]byte, 32)

// HashBody is SHA-256 of a request body.
func HashBody(body []byte) []byte {
	if len(body) == 0 {
		return NoBody
	}
	sum := sha256.Sum256(body)
	return sum[:]
}

// Encode produces the exact bytes that get signed.
//
// Binding method, path and body is what stops an authorization for a GET being
// replayed as the DELETE the server would rather have had.
func (a Authz) Encode() ([]byte, error) {
	if err := fixed("device_nonce", a.DeviceNonce, NonceLen); err != nil {
		return nil, err
	}
	if err := fixed("body_hash", a.BodyHash, 32); err != nil {
		return nil, err
	}
	return NewEncoder(DomainAuthz).
		Fixed(a.AccountID[:]).
		Fixed(a.DeviceNonce).
		Str(a.Method).
		Str(a.Path).
		Fixed(a.BodyHash).
		U64(a.TS).
		Out(), nil
}

// Signal is what a device signs on a WebRTC offer or answer.
type Signal struct {
	AccountID       AccountID
	Epoch           uint64
	DeviceNonce     []byte
	PeerNonce       []byte // the peer's nonce from the offer this answers; zeroes on an offer
	PeerPubSign     []byte // the peer's DK_sign public half
	DTLSFingerprint []byte // SHA-256 of the local DTLS certificate
	RosterHead      []byte // the signer's current roster head hash
	TS              uint64
}

// Encode produces the exact bytes that get signed.
//
// THE DTLS FINGERPRINT IS THE POINT. Without it inside the signature a malicious
// relay substitutes its own certificate and reads the clipboard, the files and
// everything else on the data channel -- it does not need to break any crypto,
// it just needs the fingerprint to be unsigned.
//
// RosterHead lets each peer notice immediately that the other is on a different
// view of the roster, which is what a forked chain looks like from the inside.
func (s Signal) Encode() ([]byte, error) {
	for name, p := range map[string][]byte{
		"device_nonce":     s.DeviceNonce,
		"peer_nonce":       s.PeerNonce,
		"peer_pub_sign":    s.PeerPubSign,
		"dtls_fingerprint": s.DTLSFingerprint,
		"roster_head":      s.RosterHead,
	} {
		if err := fixed(name, p, 32); err != nil {
			return nil, err
		}
	}
	return NewEncoder(DomainSignal).
		Fixed(s.AccountID[:]).
		U64(s.Epoch).
		Fixed(s.DeviceNonce).
		Fixed(s.PeerNonce).
		Fixed(s.PeerPubSign).
		Fixed(s.DTLSFingerprint).
		Fixed(s.RosterHead).
		U64(s.TS).
		Out(), nil
}

// Signable is anything with a canonical encoding to sign.
type Signable interface{ Encode() ([]byte, error) }

// Sign encodes and signs.
func Sign(key ed25519.PrivateKey, s Signable) ([]byte, error) {
	msg, err := s.Encode()
	if err != nil {
		return nil, err
	}
	return ed25519.Sign(key, msg), nil
}

// Verify re-encodes and checks.
//
// Re-encoding rather than verifying over received bytes is what makes ACE-1
// worth having: there is exactly one encoding of a given field list, so
// "re-serialise and compare" and "verify the signature" are the same statement.
// Verifying over bytes a peer sent would accept any encoding they chose.
func Verify(pub ed25519.PublicKey, s Signable, sig []byte) error {
	msg, err := s.Encode()
	if err != nil {
		return err
	}
	if !ed25519.Verify(pub, msg, sig) {
		return fmt.Errorf("protocol: signature does not verify")
	}
	return nil
}
