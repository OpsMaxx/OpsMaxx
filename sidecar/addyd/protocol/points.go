// SPDX-License-Identifier: MIT
// Vendored from github.com/opsmaxx/addy internal/protocol/points.go @ fe66709
//
// Edit it THERE and copy it here. A fix made only in this copy is a
// protocol divergence with no symptom until an AEAD tag fails on somebody
// else's machine. See VENDORED.md in this directory.
package protocol

import (
	"crypto/ed25519"
	"errors"
	"fmt"

	"filippo.io/edwards25519"
)

// Public keys that are not usable keys.
//
// WHAT THIS PREVENTS, and it is the worst thing found in the M1 review: an
// authorised device publishes a hygiene rotation whose AK_{n+1}.sign public half
// is the IDENTITY POINT. Every signature then verifies trivially under it -- so
// from that entry onward the SERVER can author roster entries with no account
// key at all. The same applies to an `add` carrying a degenerate DK_sign: a
// device nobody holds a key for.
//
// The specification requires this at §1 and at §5.7 step 9. The code did not do
// it, which is the gap between "the spec says so" and "the spec is enforced".
var (
	ErrDegenerateKey = errors.New("protocol: that public key is a small-order point; nobody holds a key for it")
	ErrNonCanonical  = errors.New("protocol: that public key is not canonically encoded")
)

// CheckSigningKey rejects an Ed25519 public half that no private key controls.
//
// Two checks, and they are different things:
//
//   - CANONICALITY. edwards25519's SetBytes accepts a y coordinate larger than
//     the field prime and silently reduces it, so two distinct byte strings name
//     one point. In a roster that means two entries that look different and are
//     the same device, and a prev_hash chain that commits to bytes rather than
//     to points would let an attacker produce a second encoding of an existing
//     device.
//   - SMALL ORDER. A point with no prime-order component -- the identity and the
//     seven other torsion points -- verifies signatures that anybody can
//     produce.
func CheckSigningKey(pub []byte) error {
	if len(pub) != ed25519.PublicKeySize {
		return fmt.Errorf("%w: %d bytes, want %d", ErrDegenerateKey, len(pub), ed25519.PublicKeySize)
	}
	p, err := new(edwards25519.Point).SetBytes(pub)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrDegenerateKey, err)
	}
	if string(p.Bytes()) != string(pub) {
		return ErrNonCanonical
	}
	if new(edwards25519.Point).MultByCofactor(p).Equal(edwards25519.NewIdentityPoint()) == 1 {
		return ErrDegenerateKey
	}
	return nil
}

// CheckAgreementKey rejects an X25519 public half with the same problems.
//
// A small-order X25519 point drives every shared secret to zero, so a handoff
// or an escrow "sealed" to one is sealed to a value the attacker also computes.
func CheckAgreementKey(pub []byte) error {
	if len(pub) != 32 {
		return fmt.Errorf("%w: %d bytes, want 32", ErrDegenerateKey, len(pub))
	}
	if _, err := x25519Public(pub); err != nil {
		// NewPublicKey already rejects the all-zero point and anything else it
		// cannot use; the explicit low-order list below covers the rest.
		return fmt.Errorf("%w: %v", ErrDegenerateKey, err)
	}
	for _, bad := range lowOrderX25519 {
		if constantTimeEqual(pub, bad) {
			return ErrDegenerateKey
		}
	}
	return nil
}

// The canonical low-order X25519 points. Written out rather than computed,
// because they are a fixed, published set and a computation that produced the
// wrong one would be a check that passes.
var lowOrderX25519 = [][]byte{
	{0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0},
	{1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0},
	{0xe0, 0xeb, 0x7a, 0x7c, 0x3b, 0x41, 0xb8, 0xae, 0x16, 0x56, 0xe3, 0xfa, 0xf1, 0x9f, 0xc4, 0x6a,
		0xda, 0x09, 0x8d, 0xeb, 0x9c, 0x32, 0xb1, 0xfd, 0x86, 0x62, 0x05, 0x16, 0x5f, 0x49, 0xb8, 0x00},
	{0x5f, 0x9c, 0x95, 0xbc, 0xa3, 0x50, 0x8c, 0x24, 0xb1, 0xd0, 0xb1, 0x55, 0x9c, 0x83, 0xef, 0x5b,
		0x04, 0x44, 0x5c, 0xc4, 0x58, 0x1c, 0x8e, 0x86, 0xd8, 0x22, 0x4e, 0xdd, 0xd0, 0x9f, 0x11, 0x57},
	{0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
		0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f},
	{0xed, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
		0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f},
	{0xee, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
		0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f},
}

func constantTimeEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var diff byte
	for i := range a {
		diff |= a[i] ^ b[i]
	}
	return diff == 0
}
