// SPDX-License-Identifier: MIT
// Vendored from github.com/opsmaxx/addy internal/protocol/points_test.go @ fe66709
//
// Edit it THERE and copy it here. A fix made only in this copy is a
// protocol divergence with no symptom until an AEAD tag fails on somebody
// else's machine. See VENDORED.md in this directory.
package protocol

import (
	"bytes"
	"crypto/ed25519"
	"errors"
	"testing"
)

// THE WORST FINDING OF THE M1 REVIEW, reproduced as a test.
//
// An authorised device publishes a hygiene rotation whose AK_2.sign public half
// is the identity point. Every signature then verifies trivially under it, so
// from that entry onward the SERVER can author roster entries with no account
// key at all -- which is the single thing the chain exists to prevent.
func TestARotationToADegenerateEpochKeyIsRefused(t *testing.T) {
	b := newBuilder(t)
	b.addDevice(1)

	identity := make([]byte, 32)
	identity[0] = 0x01 // the identity point's canonical encoding

	next := b.epoch + 1
	real, err := DeriveEpoch(bytes.Repeat([]byte{0x2a}, 32), b.acct, next)
	if err != nil {
		t.Fatal(err)
	}
	b.epochs[next] = real.Sign

	// Signed correctly by the current epoch key -- an authorised device -- but
	// naming a public key nobody holds.
	b.append(Entry{
		Epoch: next, Op: OpEpoch, Signer: SignerAK,
		PubSign: identity,
		PubEnc:  real.Enc.PublicKey().Bytes(), TS: 1,
	})

	_, err = b.verify(b.raw(), nil)
	if !errors.Is(err, ErrDegenerateKey) {
		t.Fatalf("verify = %v, want ErrDegenerateKey", err)
	}
}

// The same class on an add: a device nobody holds a key for.
func TestAnAddWithADegenerateDeviceKeyIsRefused(t *testing.T) {
	b := newBuilder(t)
	identity := make([]byte, 32)
	identity[0] = 0x01

	_, pubEnc := device(1)
	b.append(Entry{
		Epoch: 1, Op: OpAdd, Signer: SignerAK,
		PubSign: identity, PubEnc: pubEnc,
		LabelCT: bytes.Repeat([]byte{1}, 40), TS: 1,
	})

	if _, err := b.verify(b.raw(), nil); !errors.Is(err, ErrDegenerateKey) {
		t.Fatalf("verify = %v, want ErrDegenerateKey", err)
	}
}

// A small-order X25519 point drives every shared secret to zero, so a handoff
// "sealed" to one is sealed to a value the attacker also computes.
func TestAnAddWithADegenerateAgreementKeyIsRefused(t *testing.T) {
	b := newBuilder(t)
	pubSign, _ := device(1)

	b.append(Entry{
		Epoch: 1, Op: OpAdd, Signer: SignerAK,
		PubSign: pubSign, PubEnc: make([]byte, 32), // the all-zero point
		LabelCT: bytes.Repeat([]byte{1}, 40), TS: 1,
	})

	if _, err := b.verify(b.raw(), nil); !errors.Is(err, ErrDegenerateKey) {
		t.Fatalf("verify = %v, want ErrDegenerateKey", err)
	}
}

// A client handed a degenerate PINNED key would verify a chain anybody could
// have written -- and those keys arrive from a handoff or an escrow rather than
// from thin air.
func TestADegeneratePinnedKeyIsRefused(t *testing.T) {
	b := newBuilder(t)
	b.addDevice(1)
	raw := b.raw()

	identity := make([]byte, 32)
	identity[0] = 0x01

	if _, err := VerifyChain(raw, b.acct, ed25519.PublicKey(identity), b.epoch1Pub(), nil); !errors.Is(err, ErrDegenerateKey) {
		t.Errorf("a degenerate root key was accepted: %v", err)
	}
	if _, err := VerifyChain(raw, b.acct, b.rootPub(), ed25519.PublicKey(identity), nil); !errors.Is(err, ErrDegenerateKey) {
		t.Errorf("a degenerate epoch 1 key was accepted: %v", err)
	}
}

// Two distinct byte strings naming one point would mean two roster entries that
// look different and are the same device.
func TestANonCanonicallyEncodedKeyIsRefused(t *testing.T) {
	nonCanonical := append(bytes.Repeat([]byte{0xff}, 31), 0x7f)
	if err := CheckSigningKey(nonCanonical); !errors.Is(err, ErrNonCanonical) {
		t.Fatalf("CheckSigningKey = %v, want ErrNonCanonical", err)
	}
}

// And the happy path, so the refusals above cannot pass by refusing everything.
func TestRealKeysAreAccepted(t *testing.T) {
	for i := 0; i < 50; i++ {
		d, err := NewDeviceKeys()
		if err != nil {
			t.Fatal(err)
		}
		if err := CheckSigningKey(d.Sign.Public().(ed25519.PublicKey)); err != nil {
			t.Fatalf("a real signing key was refused: %v", err)
		}
		if err := CheckAgreementKey(d.Enc.PublicKey().Bytes()); err != nil {
			t.Fatalf("a real agreement key was refused: %v", err)
		}
	}
}

// Every published low-order X25519 point, so the list is exercised rather than
// merely present.
func TestEveryLowOrderAgreementPointIsRefused(t *testing.T) {
	for i, p := range lowOrderX25519 {
		if err := CheckAgreementKey(p); !errors.Is(err, ErrDegenerateKey) {
			t.Errorf("low-order point %d was accepted: %v", i, err)
		}
	}
}
