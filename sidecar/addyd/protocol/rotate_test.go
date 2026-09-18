// SPDX-License-Identifier: MIT
// Vendored from github.com/opsmaxx/addy internal/protocol/rotate_test.go @ fe66709
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

// twoDeviceAccount returns an account with a second device added, plus the
// verified chain and its last entry.
func twoDeviceAccount(t *testing.T) (*Account, *DeviceKeys, []byte, Entry, *Verified) {
	t.Helper()
	a, err := NewAccount("quiet-otter-41")
	if err != nil {
		t.Fatal(err)
	}
	b, err := NewDeviceKeys()
	if err != nil {
		t.Fatal(err)
	}
	bPubSign := b.Sign.Public().(ed25519.PublicKey)

	prev, err := a.Genesis.Hash()
	if err != nil {
		t.Fatal(err)
	}
	labelCT, err := SealLabel("brave-pylon-07", a.Root.AccountID, 1, bPubSign, a.Epoch.Profile)
	if err != nil {
		t.Fatal(err)
	}
	nonce, err := Nonce()
	if err != nil {
		t.Fatal(err)
	}
	add := Entry{
		AccountID: a.Root.AccountID, Epoch: 1, Seq: 1, PrevHash: prev,
		Op: OpAdd, Signer: SignerAK, Nonce: nonce,
		PubSign: bPubSign, PubEnc: b.Enc.PublicKey().Bytes(),
		LabelCT: labelCT, TS: 2,
	}
	body, err := add.Encode()
	if err != nil {
		t.Fatal(err)
	}
	add.Sig = ed25519.Sign(a.Epoch.Sign, body)

	g, err := a.Genesis.Wire()
	if err != nil {
		t.Fatal(err)
	}
	w, err := add.Wire()
	if err != nil {
		t.Fatal(err)
	}
	chain := append(g, w...)

	v, err := VerifyChain(chain, a.Root.AccountID,
		a.Root.Sign.Public().(ed25519.PublicKey),
		a.Epoch.Sign.Public().(ed25519.PublicKey), nil)
	if err != nil {
		t.Fatal(err)
	}
	return a, b, chain, add, v
}

func appendEntry(t *testing.T, chain []byte, e Entry) []byte {
	t.Helper()
	w, err := e.Wire()
	if err != nil {
		t.Fatal(err)
	}
	return append(bytes.Clone(chain), w...)
}

// A hygiene rotation: signed by the current epoch key, reachable from any
// paired device.
func TestAHygieneRotationVerifies(t *testing.T) {
	a, _, chain, last, v := twoDeviceAccount(t)

	r, err := PrepareRotation(Hygiene, a.Root.AccountID, v, last, a.Epoch.Sign,
		a.Root.Sign.Public().(ed25519.PublicKey))
	if err != nil {
		t.Fatalf("PrepareRotation: %v", err)
	}
	if r.NewKeys.Epoch != 2 {
		t.Fatalf("new epoch is %d, want 2", r.NewKeys.Epoch)
	}
	if bytes.Equal(r.NewKeys.AK, a.Epoch.AK) {
		t.Fatal("the rotation reused the old epoch key")
	}

	after, err := VerifyChain(appendEntry(t, chain, r.Entry), a.Root.AccountID,
		a.Root.Sign.Public().(ed25519.PublicKey),
		a.Epoch.Sign.Public().(ed25519.PublicKey), nil)
	if err != nil {
		t.Fatalf("the rotated chain did not verify: %v", err)
	}
	if after.Epoch != 2 {
		t.Errorf("chain ends in epoch %d, want 2", after.Epoch)
	}
	// A transition changes the epoch and NOTHING ELSE.
	if len(after.Devices) != len(v.Devices) {
		t.Errorf("the device set changed across a transition: %d then %d", len(v.Devices), len(after.Devices))
	}
}

// A revocation rotation must be root-signed, and PrepareRotation refuses the
// wrong key rather than producing an entry the verifier will reject later.
func TestARevocationRotationRefusesTheEpochKey(t *testing.T) {
	a, _, _, last, v := twoDeviceAccount(t)

	_, err := PrepareRotation(Revocation, a.Root.AccountID, v, last, a.Epoch.Sign,
		a.Root.Sign.Public().(ed25519.PublicKey))
	if !errors.Is(err, ErrRevocationNeedsRoot) {
		t.Fatalf("PrepareRotation = %v, want ErrRevocationNeedsRoot", err)
	}
}

func TestARevocationRotationVerifies(t *testing.T) {
	a, _, chain, last, v := twoDeviceAccount(t)

	r, err := PrepareRotation(Revocation, a.Root.AccountID, v, last, a.Root.Sign,
		a.Root.Sign.Public().(ed25519.PublicKey))
	if err != nil {
		t.Fatalf("PrepareRotation: %v", err)
	}
	if r.Entry.Flags&FlagRevocationRotation == 0 {
		t.Error("the entry is not flagged as a revocation rotation")
	}
	if r.Entry.Signer != SignerRK {
		t.Error("the entry is not root-signed")
	}

	if _, err := VerifyChain(appendEntry(t, chain, r.Entry), a.Root.AccountID,
		a.Root.Sign.Public().(ed25519.PublicKey),
		a.Epoch.Sign.Public().(ed25519.PublicKey), nil); err != nil {
		t.Fatalf("the rotated chain did not verify: %v", err)
	}
}

// THE RULE THAT MATTERS. A revocation rotation must not chain, because the
// revoked device still holds the old epoch key and would follow the rotation
// straight through to the new one.
func TestARevocationRotationRefusesToChain(t *testing.T) {
	a, _, _, last, v := twoDeviceAccount(t)

	r, err := PrepareRotation(Revocation, a.Root.AccountID, v, last, a.Root.Sign,
		a.Root.Sign.Public().(ed25519.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	wire, err := last.Wire()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.ChainedHandoff(a.Root.AccountID, 2, a.Epoch,
		a.Root.Sign.Public().(ed25519.PublicKey), wire); err == nil {
		t.Fatal("a revocation rotation produced a chained handoff")
	}
}

// And the READER enforces it too, because the writer is not always honest: a
// server that keeps a hygiene rotation's handoff object and serves it against a
// later revocation transition would hand the revoked device exactly what the
// revocation took away.
func TestTheReaderRefusesAChainedHandoffForARevocation(t *testing.T) {
	a, _, _, last, v := twoDeviceAccount(t)
	wire, err := last.Wire()
	if err != nil {
		t.Fatal(err)
	}

	// A legitimate hygiene handoff.
	hyg, err := PrepareRotation(Hygiene, a.Root.AccountID, v, last, a.Epoch.Sign,
		a.Root.Sign.Public().(ed25519.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	obj, err := hyg.ChainedHandoff(a.Root.AccountID, 2, a.Epoch,
		a.Root.Sign.Public().(ed25519.PublicKey), wire)
	if err != nil {
		t.Fatalf("ChainedHandoff: %v", err)
	}
	// It reads back fine against its own transition.
	if _, err := ReadChainedHandoff(obj, hyg.Entry, a.Root.AccountID, 2, a.Epoch); err != nil {
		t.Fatalf("a hygiene handoff did not read back: %v", err)
	}

	// Now the same object offered against a revocation transition.
	rev, err := PrepareRotation(Revocation, a.Root.AccountID, v, last, a.Root.Sign,
		a.Root.Sign.Public().(ed25519.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ReadChainedHandoff(obj, rev.Entry, a.Root.AccountID, 2, a.Epoch); err == nil {
		t.Fatal("a chained handoff was read against a revocation rotation")
	}
}

// A revocation seals the new key individually to each surviving device, and to
// nothing else.
func TestARevocationSealsToEachSurvivingDevice(t *testing.T) {
	a, b, _, last, v := twoDeviceAccount(t)
	wire, err := last.Wire()
	if err != nil {
		t.Fatal(err)
	}
	rootPub := a.Root.Sign.Public().(ed25519.PublicKey)

	r, err := PrepareRotation(Revocation, a.Root.AccountID, v, last, a.Root.Sign, rootPub)
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range v.Devices {
		if err := r.SealTo(d, a.Root.AccountID, 2, rootPub, wire, a.Epoch.AK); err != nil {
			t.Fatalf("SealTo: %v", err)
		}
	}
	if len(r.Handoffs) != 2 {
		t.Fatalf("sealed to %d devices, want 2", len(r.Handoffs))
	}

	// Device B opens its own and reaches the new epoch key.
	obj := r.Handoffs[fingerprintKey(b.Sign.Public().(ed25519.PublicKey))]
	if obj == nil {
		t.Fatal("no handoff was sealed for device B")
	}
	h, err := OpenHandoff(obj, a.Root.AccountID, 2, 2, b.Enc, a.Epoch.AK)
	if err != nil {
		t.Fatalf("OpenHandoff: %v", err)
	}
	if !bytes.Equal(h.AKSeed, r.NewKeys.AK) {
		t.Error("the sealed handoff did not carry the new epoch key")
	}

	// And a device that is NOT in the surviving set cannot open any of them.
	outsider, err := NewDeviceKeys()
	if err != nil {
		t.Fatal(err)
	}
	for _, o := range r.Handoffs {
		if _, err := OpenHandoff(o, a.Root.AccountID, 2, 2, outsider.Enc, a.Epoch.AK); err == nil {
			t.Fatal("a device outside the surviving set opened a handoff")
		}
	}
}

// Rotation protects the future, never the past: the old epoch's objects stay
// readable with the old key, which is exactly why the order of operations puts
// the delete last.
func TestTheOldEpochKeyStillOpensOldObjects(t *testing.T) {
	a, _, _, last, v := twoDeviceAccount(t)

	old, err := SealCollection(Collection{
		Name: "servers", Schema: 1, WriterVersion: "0.48.0", Counter: 1,
		Payload: []byte("before"),
	}, a.Root.AccountID, 1, a.Epoch.Profile)
	if err != nil {
		t.Fatal(err)
	}

	r, err := PrepareRotation(Hygiene, a.Root.AccountID, v, last, a.Epoch.Sign,
		a.Root.Sign.Public().(ed25519.PublicKey))
	if err != nil {
		t.Fatal(err)
	}

	// Still readable at the old epoch.
	if _, err := OpenCollection(old, "servers", a.Root.AccountID, 1, a.Epoch.Profile, 1, 0); err != nil {
		t.Errorf("an epoch 1 object stopped opening after a rotation: %v", err)
	}
	// And not at the new one, since the epoch is in the AAD.
	if _, err := OpenCollection(old, "servers", a.Root.AccountID, 2, r.NewKeys.Profile, 1, 0); err == nil {
		t.Error("an epoch 1 object opened under epoch 2's key")
	}
}
