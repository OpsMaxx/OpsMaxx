package protocol

import (
	"bytes"
	"crypto/ed25519"
	"testing"
)

// The account a first device mints, offline, must verify under the same code a
// second device will use. The ceremony and the verifier are different pieces of
// code, and an account whose own first entry does not verify would fail on the
// SECOND device rather than the first -- which is the expensive place to find
// out.
func TestGenesisProducesAChainThatVerifies(t *testing.T) {
	a, err := NewAccount("quiet-otter-41")
	if err != nil {
		t.Fatalf("NewAccount: %v", err)
	}

	v, err := a.Verify()
	if err != nil {
		t.Fatalf("an account's own genesis chain did not verify: %v", err)
	}
	if len(v.Devices) != 1 {
		t.Fatalf("device set has %d entries, want 1", len(v.Devices))
	}
	if v.Epoch != 1 || v.HeadSeq != 0 {
		t.Errorf("epoch=%d headSeq=%d, want 1 and 0", v.Epoch, v.HeadSeq)
	}
	if !bytes.Equal(v.Head, a.Head) {
		t.Error("the verifier's head hash differs from the ceremony's")
	}
}

// The account id is a function of the root key, and the root key is a function
// of the phrase. Recovery rests entirely on that being true.
func TestTheWholeAccountIsReachableFromThePhraseAlone(t *testing.T) {
	a, err := NewAccount("brave-pylon-07")
	if err != nil {
		t.Fatal(err)
	}

	// Everything a recovering device can compute without the server.
	seed, err := mnemonicSeed(a.Mnemonic)
	if err != nil {
		t.Fatal(err)
	}
	root, err := DeriveRoot(seed)
	if err != nil {
		t.Fatal(err)
	}
	if root.AccountID != a.Root.AccountID {
		t.Fatal("the phrase does not reproduce the account id")
	}
	if !bytes.Equal(root.SignSeed, a.Root.SignSeed) {
		t.Fatal("the phrase does not reproduce the root signing key")
	}

	// And the one thing it CANNOT compute, which is why the escrow exists.
	got, err := OpenEscrow(a.Escrow, root.AccountID, 1, 1, root.Enc, 0)
	if err != nil {
		t.Fatalf("the escrow did not open under the key derived from the phrase: %v", err)
	}
	if !bytes.Equal(got.AKSeed, a.Epoch.AK) {
		t.Fatal("the escrow did not carry the epoch key")
	}

	// The escrow's head entry must be the genesis entry, verbatim, so a
	// recovering device can check the head's signature itself rather than
	// taking the server's word for where the chain ends.
	wire, err := a.Genesis.Wire()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got.HeadEntry, wire) {
		t.Fatal("the escrow's head entry is not the genesis entry")
	}
}

// The label is sealed to K_profile, and pub_sign is in its AAD -- so two labels
// cannot be swapped between two entries by an attacker who cannot decrypt
// either.
func TestALabelCannotBeMovedToAnotherDevice(t *testing.T) {
	a, err := NewAccount("sable-hill-14")
	if err != nil {
		t.Fatal(err)
	}
	acct := a.Root.AccountID
	kp := a.Epoch.Profile
	mine := a.Genesis.PubSign

	got, err := OpenLabel(a.Genesis.LabelCT, acct, 1, mine, kp)
	if err != nil {
		t.Fatalf("OpenLabel: %v", err)
	}
	if got != "sable-hill-14" {
		t.Errorf("label = %q", got)
	}

	// The same ciphertext, claimed for a different device.
	other, err := NewDeviceKeys()
	if err != nil {
		t.Fatal(err)
	}
	theirs := other.Sign.Public().(ed25519.PublicKey)
	if _, err := OpenLabel(a.Genesis.LabelCT, acct, 1, theirs, kp); err == nil {
		t.Fatal("a label opened for a device it does not name")
	}

	// And from a different epoch.
	if _, err := OpenLabel(a.Genesis.LabelCT, acct, 2, mine, kp); err == nil {
		t.Fatal("a label opened under the wrong epoch")
	}
}

// Two accounts must share nothing.
func TestTwoAccountsShareNothing(t *testing.T) {
	a, err := NewAccount("one")
	if err != nil {
		t.Fatal(err)
	}
	b, err := NewAccount("two")
	if err != nil {
		t.Fatal(err)
	}

	if a.Mnemonic == b.Mnemonic {
		t.Fatal("two accounts got the same phrase")
	}
	if a.Root.AccountID == b.Root.AccountID {
		t.Fatal("two accounts got the same id")
	}
	if bytes.Equal(a.Epoch.AK, b.Epoch.AK) {
		t.Fatal("two accounts got the same epoch key")
	}
	if bytes.Equal(a.Device.SignSeed, b.Device.SignSeed) {
		t.Fatal("two accounts got the same device key")
	}

	// One account's chain must not verify as the other's.
	chain, err := a.Chain()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyChain(chain, b.Root.AccountID,
		b.Root.Sign.Public().(ed25519.PublicKey),
		b.Epoch.Sign.Public().(ed25519.PublicKey), nil); err == nil {
		t.Fatal("one account's chain verified as another's")
	}
}
