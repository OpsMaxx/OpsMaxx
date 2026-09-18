// SPDX-License-Identifier: MIT
// Vendored from github.com/opsmaxx/addy internal/protocol/escrow_test.go @ fe66709
//
// Edit it THERE and copy it here. A fix made only in this copy is a
// protocol divergence with no symptom until an AEAD tag fails on somebody
// else's machine. See VENDORED.md in this directory.
package protocol

import (
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"errors"
	"testing"
)

func testEscrow(t *testing.T) (Escrow, *ecdh.PrivateKey) {
	t.Helper()
	root, err := DeriveRoot(bytes.Repeat([]byte{0x33}, 64))
	if err != nil {
		t.Fatal(err)
	}
	return Escrow{
		AccountID: root.AccountID,
		Epoch:     3,
		Counter:   7,
		AKSeed:    bytes.Repeat([]byte{0x44}, 32),
		HeadEntry: bytes.Repeat([]byte{0x55}, 200),
	}, root.Enc
}

func TestAnEscrowRoundTrips(t *testing.T) {
	e, rk := testEscrow(t)

	obj, err := SealEscrow(e, rk.PublicKey())
	if err != nil {
		t.Fatalf("SealEscrow: %v", err)
	}
	got, err := OpenEscrow(obj, e.AccountID, e.Epoch, e.Counter, rk, 0)
	if err != nil {
		t.Fatalf("OpenEscrow: %v", err)
	}
	if !bytes.Equal(got.AKSeed, e.AKSeed) {
		t.Error("the epoch key did not round-trip")
	}
	if !bytes.Equal(got.HeadEntry, e.HeadEntry) {
		t.Error("the roster head entry did not round-trip")
	}
	if got.Epoch != e.Epoch || got.Counter != e.Counter || got.AccountID != e.AccountID {
		t.Errorf("fields did not round-trip: %+v", got)
	}
}

// THE REASON THE COMMITMENT EXISTS. Recovery is a person typing twelve words
// off a printed card into a machine, against a server that chooses which blob to
// serve. A wrong key has to fail loudly: plausible garbage that parsed as an
// epoch key would have the user re-seal the whole estate under a key an attacker
// chose.
func TestAWrongKeyFailsAtTheCommitmentNotAfterOpening(t *testing.T) {
	e, rk := testEscrow(t)
	obj, err := SealEscrow(e, rk.PublicKey())
	if err != nil {
		t.Fatal(err)
	}

	stranger, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_, err = OpenEscrow(obj, e.AccountID, e.Epoch, e.Counter, stranger, 0)
	if err == nil {
		t.Fatal("an escrow opened under a key it was not sealed to")
	}
	// It must be the COMMITMENT that refused, not the AEAD. An implementation
	// that opens first and notices afterwards is non-conforming: the point is
	// to fail before a chosen ciphertext produces any plaintext at all.
	if !errors.Is(err, ErrEscrowCommit) {
		t.Fatalf("refused with %v, want ErrEscrowCommit -- the commitment must be checked before the AEAD", err)
	}
}

// The epoch is in the HPKE info and in the AAD, so a blob from one epoch cannot
// be presented as one from another.
func TestAnEscrowFromOneEpochCannotBePresentedAsAnother(t *testing.T) {
	e, rk := testEscrow(t)
	obj, err := SealEscrow(e, rk.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := OpenEscrow(obj, e.AccountID, e.Epoch+1, e.Counter, rk, 0); err == nil {
		t.Fatal("an escrow from epoch 3 opened as epoch 4")
	}
}

// A server that lies about the counter is caught by the commitment, because the
// counter is inside the exporter context. That is the check doing exactly what
// it is for.
func TestLyingAboutTheCounterIsCaughtByTheCommitment(t *testing.T) {
	e, rk := testEscrow(t)
	obj, err := SealEscrow(e, rk.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	_, err = OpenEscrow(obj, e.AccountID, e.Epoch, e.Counter+1, rk, 0)
	if !errors.Is(err, ErrEscrowCommit) {
		t.Fatalf("refused with %v, want ErrEscrowCommit", err)
	}
}

// An old escrow served to a device that has already seen a newer one.
func TestAnOlderEscrowIsRefused(t *testing.T) {
	e, rk := testEscrow(t)
	e.Counter = 4
	obj, err := SealEscrow(e, rk.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	_, err = OpenEscrow(obj, e.AccountID, e.Epoch, e.Counter, rk, 9)
	if !errors.Is(err, ErrEscrowRollback) {
		t.Fatalf("refused with %v, want ErrEscrowRollback", err)
	}
}

// A suite an attacker can choose is a downgrade waiting to happen.
func TestAnUnknownSuiteIsRefused(t *testing.T) {
	e, rk := testEscrow(t)
	obj, err := SealEscrow(e, rk.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	// The suite byte sits immediately after the domain prefix.
	at := len(domainEscrowObject) + 1
	if obj[at] != SuitePinned {
		t.Fatalf("expected the suite byte at %d, found %#02x", at, obj[at])
	}
	obj[at] = 0x02
	if _, err := OpenEscrow(obj, e.AccountID, e.Epoch, e.Counter, rk, 0); !errors.Is(err, ErrEscrowSuite) {
		t.Fatalf("refused with %v, want ErrEscrowSuite", err)
	}
}

// Any change to the object at all must be refused.
func TestATamperedObjectIsRefused(t *testing.T) {
	e, rk := testEscrow(t)
	obj, err := SealEscrow(e, rk.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	for _, at := range []int{len(obj) - 1, len(obj) / 2, len(obj) - 20} {
		tampered := bytes.Clone(obj)
		tampered[at] ^= 0x01
		if _, err := OpenEscrow(tampered, e.AccountID, e.Epoch, e.Counter, rk, 0); err == nil {
			t.Errorf("a one-bit change at offset %d was accepted", at)
		}
	}
}

// The escrow holds exactly what is NOT derivable. A counter of zero would make
// "never seen one" and "the first one" indistinguishable.
func TestAnEscrowWithoutItsEssentialsIsRefused(t *testing.T) {
	_, rk := testEscrow(t)
	base, _ := testEscrow(t)

	cases := map[string]Escrow{
		"no epoch key":         func() Escrow { c := base; c.AKSeed = nil; return c }(),
		"a short epoch key":    func() Escrow { c := base; c.AKSeed = []byte{1, 2, 3}; return c }(),
		"no roster head entry": func() Escrow { c := base; c.HeadEntry = nil; return c }(),
		"a zero counter":       func() Escrow { c := base; c.Counter = 0; return c }(),
	}
	for name, c := range cases {
		if _, err := SealEscrow(c, rk.PublicKey()); err == nil {
			t.Errorf("SealEscrow accepted an escrow with %s", name)
		}
	}
}
