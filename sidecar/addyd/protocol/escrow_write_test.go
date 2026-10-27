// SPDX-License-Identifier: MIT
// Vendored from github.com/opsmaxx/addy internal/protocol/escrow_write_test.go
//
// Edit it THERE and copy it here. A fix made only in this copy is a
// protocol divergence with no symptom until an AEAD tag fails on somebody
// else's machine. See VENDORED.md in this directory.
package protocol

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

// The same fixed inputs and the same expected bytes in both copies of this
// package: an escrow write signed by the client must verify on the relay.
func TestEscrowWriteVector(t *testing.T) {
	key := ed25519.NewKeyFromSeed(make([]byte, 32))
	var acct AccountID
	copy(acct[:], []byte("0123456789abcdef"))
	sum := sha256.Sum256([]byte("sealed escrow"))
	w := EscrowWrite{AccountID: acct, Epoch: 2, Counter: 1, BodyHash: sum[:]}

	msg, err := w.Encode()
	if err != nil {
		t.Fatal(err)
	}
	const wantMsg = "616464792d657363726f772d77726974652d7631003031323334353637383961626364656600000000000000020000000000000001529f28f4cc2df6778b72a4e043d396544c4b1a1d4db421715ec78106410a3c89"
	if got := hex.EncodeToString(msg); got != wantMsg {
		t.Fatalf("encoding changed:\n got %s\nwant %s", got, wantMsg)
	}
	sig, err := Sign(key, w)
	if err != nil {
		t.Fatal(err)
	}
	const wantSig = "c92c28e282c234954fb6c66018c3cc92687f658f0357873a85e40266ebfeb13daa46eb1704d6d170a6f5fe07502acbe46e0dd26ceadf13ceadd3abea3a5cee07"
	if got := hex.EncodeToString(sig); got != wantSig {
		t.Fatalf("signature changed:\n got %s\nwant %s", got, wantSig)
	}
	if err := Verify(key.Public().(ed25519.PublicKey), w, sig); err != nil {
		t.Fatal(err)
	}
}

func TestEscrowWriteBindsEveryField(t *testing.T) {
	key := ed25519.NewKeyFromSeed(make([]byte, 32))
	pub := key.Public().(ed25519.PublicKey)
	sum := sha256.Sum256([]byte("sealed escrow"))
	w := EscrowWrite{Epoch: 2, Counter: 1, BodyHash: sum[:]}
	sig, err := Sign(key, w)
	if err != nil {
		t.Fatal(err)
	}
	other := sha256.Sum256([]byte("another escrow"))
	for name, changed := range map[string]EscrowWrite{
		"epoch":   {Epoch: 3, Counter: 1, BodyHash: sum[:]},
		"counter": {Epoch: 2, Counter: 2, BodyHash: sum[:]},
		"body":    {Epoch: 2, Counter: 1, BodyHash: other[:]},
		"account": {AccountID: AccountID{1}, Epoch: 2, Counter: 1, BodyHash: sum[:]},
	} {
		if Verify(pub, changed, sig) == nil {
			t.Errorf("a signature over one escrow write verified with a different %s", name)
		}
	}
	// And not as any other purpose: an authz over the same bytes is a
	// different structure with a different domain.
	authz := Authz{DeviceNonce: make([]byte, 32), Method: "PUT", Path: "/v1/obj/escrow", BodyHash: sum[:]}
	if Verify(pub, authz, sig) == nil {
		t.Error("an escrow-write signature verified as a request authorization")
	}
}
