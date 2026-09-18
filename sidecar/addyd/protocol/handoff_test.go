// SPDX-License-Identifier: MIT
// Vendored from github.com/opsmaxx/addy internal/protocol/handoff_test.go @ fe66709
//
// Edit it THERE and copy it here. A fix made only in this copy is a
// protocol divergence with no symptom until an AEAD tag fails on somebody
// else's machine. See VENDORED.md in this directory.
package protocol

import (
	"bytes"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"testing"
)

// The end-to-end story this whole package exists for: a first device mints an
// account offline, a second device is handed the account key, and the second
// device verifies the chain FROM GENESIS against keys it was given by the first
// -- never against anything the server said.
// The binding both parties share. In a real pairing this is the PAKE secret;
// in a rotation it is the previous epoch key. A handoff sealed without one does
// not open, which is the point.
var testBinding = bytes.Repeat([]byte{0x9e}, 32)

func TestASecondDeviceIsAdmittedAndVerifiesTheChainItself(t *testing.T) {
	// Device A: genesis.
	a, err := NewAccount("quiet-otter-41")
	if err != nil {
		t.Fatal(err)
	}

	// Device B: mints its own keys, locally. They are derived from nothing.
	b, err := NewDeviceKeys()
	if err != nil {
		t.Fatal(err)
	}
	bPubSign := b.Sign.Public().(ed25519.PublicKey)
	bPubEnc := b.Enc.PublicKey().Bytes()

	// A appends B to the roster, signed by the epoch key.
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
		PubSign: bPubSign, PubEnc: bPubEnc, LabelCT: labelCT, TS: 2,
	}
	body, err := add.Encode()
	if err != nil {
		t.Fatal(err)
	}
	add.Sig = ed25519.Sign(a.Epoch.Sign, body)

	genesisWire, err := a.Genesis.Wire()
	if err != nil {
		t.Fatal(err)
	}
	addWire, err := add.Wire()
	if err != nil {
		t.Fatal(err)
	}
	chain := append(genesisWire, addWire...)

	// A seals the handoff to B's encryption key. Nothing is sealed before the
	// human confirms the emoji; that ordering is the caller's to enforce.
	head, err := add.Hash()
	if err != nil {
		t.Fatal(err)
	}
	_ = head
	obj, err := SealHandoff(Handoff{
		AccountID:   a.Root.AccountID,
		Epoch:       1,
		Counter:     1,
		AKSeed:      a.Epoch.AK,
		RootSignPub: a.Root.Sign.Public().(ed25519.PublicKey),
		HeadEntry:   addWire,
	}, b.Enc.PublicKey(), testBinding)
	if err != nil {
		t.Fatalf("SealHandoff: %v", err)
	}

	// B opens it and adopts.
	h, err := OpenHandoff(obj, a.Root.AccountID, 1, 1, b.Enc, testBinding)
	if err != nil {
		t.Fatalf("OpenHandoff: %v", err)
	}
	keys, v, err := h.Adopt(chain)
	if err != nil {
		t.Fatalf("Adopt: %v", err)
	}

	// B now holds the same epoch key and sees both devices.
	if !bytes.Equal(keys.AK, a.Epoch.AK) {
		t.Error("the joining device did not receive the account's epoch key")
	}
	if !bytes.Equal(keys.Profile, a.Epoch.Profile) {
		t.Error("the joining device derived a different profile key")
	}
	if len(v.Devices) != 2 {
		t.Fatalf("the joining device sees %d devices, want 2", len(v.Devices))
	}

	// And it can read the labels, which is what makes a revoke dialog name a
	// device rather than a key.
	for _, d := range v.Devices {
		if _, err := OpenLabel(d.LabelCT, h.AccountID, 1, d.PubSign, keys.Profile); err != nil {
			t.Errorf("the joining device cannot read a device label: %v", err)
		}
	}
}

// A device must not be handed a valid-looking handoff for a DIFFERENT account
// and go on to verify that account's chain quite happily.
func TestAHandoffWhoseRootKeyDoesNotNameItsAccountIsRefused(t *testing.T) {
	a, err := NewAccount("one")
	if err != nil {
		t.Fatal(err)
	}
	other, err := NewAccount("two")
	if err != nil {
		t.Fatal(err)
	}
	b, err := NewDeviceKeys()
	if err != nil {
		t.Fatal(err)
	}
	wire, err := a.Genesis.Wire()
	if err != nil {
		t.Fatal(err)
	}

	obj, err := SealHandoff(Handoff{
		AccountID: a.Root.AccountID,
		Epoch:     1, Counter: 1,
		AKSeed: a.Epoch.AK,
		// Somebody else's root key.
		RootSignPub: other.Root.Sign.Public().(ed25519.PublicKey),
		HeadEntry:   wire,
	}, b.Enc.PublicKey(), testBinding)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := OpenHandoff(obj, a.Root.AccountID, 1, 1, b.Enc, testBinding); !errors.Is(err, ErrWrongAccount) {
		t.Fatalf("OpenHandoff = %v, want ErrWrongAccount", err)
	}
}

// Same commitment discipline as the escrow: a wrong key fails at the
// commitment, before the AEAD produces any plaintext.
func TestAHandoffSealedToAnotherDeviceFailsAtTheCommitment(t *testing.T) {
	a, err := NewAccount("one")
	if err != nil {
		t.Fatal(err)
	}
	b, err := NewDeviceKeys()
	if err != nil {
		t.Fatal(err)
	}
	wire, err := a.Genesis.Wire()
	if err != nil {
		t.Fatal(err)
	}
	obj, err := SealHandoff(Handoff{
		AccountID: a.Root.AccountID, Epoch: 1, Counter: 1,
		AKSeed:      a.Epoch.AK,
		RootSignPub: a.Root.Sign.Public().(ed25519.PublicKey),
		HeadEntry:   wire,
	}, b.Enc.PublicKey(), testBinding)
	if err != nil {
		t.Fatal(err)
	}

	stranger, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := OpenHandoff(obj, a.Root.AccountID, 1, 1, stranger, testBinding); !errors.Is(err, ErrEscrowCommit) {
		t.Fatalf("OpenHandoff = %v, want ErrEscrowCommit", err)
	}
}

// A handoff and an escrow must not be interchangeable. They carry different
// fields and have different domain prefixes precisely so a verifier cannot be
// confused between them.
func TestAHandoffIsNotAnEscrow(t *testing.T) {
	a, err := NewAccount("one")
	if err != nil {
		t.Fatal(err)
	}
	b, err := NewDeviceKeys()
	if err != nil {
		t.Fatal(err)
	}
	wire, err := a.Genesis.Wire()
	if err != nil {
		t.Fatal(err)
	}
	handoff, err := SealHandoff(Handoff{
		AccountID: a.Root.AccountID, Epoch: 1, Counter: 1,
		AKSeed:      a.Epoch.AK,
		RootSignPub: a.Root.Sign.Public().(ed25519.PublicKey),
		HeadEntry:   wire,
	}, b.Enc.PublicKey(), testBinding)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := OpenEscrow(handoff, a.Root.AccountID, 1, 1, b.Enc, 0); err == nil {
		t.Fatal("a handoff opened as an escrow")
	}
	if _, err := OpenHandoff(a.Escrow, a.Root.AccountID, 1, 1, a.Root.Enc, testBinding); err == nil {
		t.Fatal("an escrow opened as a handoff")
	}
}

// The joining device must verify the chain against the key the HANDOFF carried,
// so a server serving a different chain is caught.
func TestTheJoiningDeviceRefusesAnotherAccountsChain(t *testing.T) {
	a, err := NewAccount("one")
	if err != nil {
		t.Fatal(err)
	}
	other, err := NewAccount("two")
	if err != nil {
		t.Fatal(err)
	}
	b, err := NewDeviceKeys()
	if err != nil {
		t.Fatal(err)
	}
	wire, err := a.Genesis.Wire()
	if err != nil {
		t.Fatal(err)
	}
	obj, err := SealHandoff(Handoff{
		AccountID: a.Root.AccountID, Epoch: 1, Counter: 1,
		AKSeed:      a.Epoch.AK,
		RootSignPub: a.Root.Sign.Public().(ed25519.PublicKey),
		HeadEntry:   wire,
	}, b.Enc.PublicKey(), testBinding)
	if err != nil {
		t.Fatal(err)
	}
	h, err := OpenHandoff(obj, a.Root.AccountID, 1, 1, b.Enc, testBinding)
	if err != nil {
		t.Fatal(err)
	}

	theirChain, err := other.Genesis.Wire()
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.Adopt(theirChain); err == nil {
		t.Fatal("the joining device adopted another account's chain")
	}
}

// M1 REVIEW, HIGH 2: nothing bound a handoff to the pairing that produced it.
//
// Sealing one needs only the recipient's PUBLIC encryption key, and frame 2 of
// a pairing publishes exactly that in the clear on a relay the design assumes
// is hostile. So a relay could drop frame 3, seal its own handoff for an
// account it controls, and the joining device would adopt it cleanly -- it has
// no way to tell, because the account id is something it LEARNS from the
// handoff.
func TestAHandoffSealedWithTheWrongBindingDoesNotOpen(t *testing.T) {
	a, err := NewAccount("one")
	if err != nil {
		t.Fatal(err)
	}
	b, err := NewDeviceKeys()
	if err != nil {
		t.Fatal(err)
	}
	wire, err := a.Genesis.Wire()
	if err != nil {
		t.Fatal(err)
	}

	h := Handoff{
		AccountID: a.Root.AccountID, Epoch: 1, Counter: 1,
		AKSeed:      a.Epoch.AK,
		RootSignPub: a.Root.Sign.Public().(ed25519.PublicKey),
		HeadEntry:   wire,
	}
	obj, err := SealHandoff(h, b.Enc.PublicKey(), testBinding)
	if err != nil {
		t.Fatal(err)
	}

	// The relay's binding is not the one the PAKE produced.
	relayBinding := bytes.Repeat([]byte{0x01}, 32)
	if _, err := OpenHandoff(obj, a.Root.AccountID, 1, 1, b.Enc, relayBinding); err == nil {
		t.Fatal("a handoff opened under a binding that did not seal it")
	}

	// And an unbound handoff cannot even be made.
	if _, err := SealHandoff(h, b.Enc.PublicKey(), nil); err == nil {
		t.Fatal("SealHandoff produced an unbound handoff")
	}
	if _, err := OpenHandoff(obj, a.Root.AccountID, 1, 1, b.Enc, nil); err == nil {
		t.Fatal("OpenHandoff accepted a handoff with no binding")
	}
}

// M1 REVIEW, HIGH 1: Adopt ignored the handoff's own head entry, so a chain
// truncated one entry before a revoke verified cleanly and the revoked device
// was still in the adopted set.
func TestAdoptRefusesAChainTruncatedBeforeTheHandoffsHead(t *testing.T) {
	a, b, chain, last, _ := twoDeviceAccount(t)

	// A third device is being paired, and the handoff names the current head.
	joiner, err := NewDeviceKeys()
	if err != nil {
		t.Fatal(err)
	}
	lastWire, err := last.Wire()
	if err != nil {
		t.Fatal(err)
	}
	obj, err := SealHandoff(Handoff{
		AccountID: a.Root.AccountID, Epoch: 1, Counter: 1,
		AKSeed:      a.Epoch.AK,
		RootSignPub: a.Root.Sign.Public().(ed25519.PublicKey),
		HeadEntry:   lastWire,
	}, joiner.Enc.PublicKey(), testBinding)
	if err != nil {
		t.Fatal(err)
	}
	h, err := OpenHandoff(obj, a.Root.AccountID, 1, 1, joiner.Enc, testBinding)
	if err != nil {
		t.Fatal(err)
	}

	// The full chain adopts.
	if _, _, err := h.Adopt(chain); err != nil {
		t.Fatalf("the full chain did not adopt: %v", err)
	}

	// A chain truncated before the head the handoff names must not.
	genesisOnly, err := a.Genesis.Wire()
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.Adopt(genesisOnly); err == nil {
		t.Fatal("a chain truncated before the handoff's own head entry was adopted")
	}
	_ = b
}

// A handoff for a later epoch than the chain reaches means the server served a
// key newer than the chain it also served, which is not a state an honest one
// can be in.
func TestAdoptRefusesAChainBehindTheHandoffsEpoch(t *testing.T) {
	a, _, chain, last, _ := twoDeviceAccount(t)
	joiner, err := NewDeviceKeys()
	if err != nil {
		t.Fatal(err)
	}
	lastWire, err := last.Wire()
	if err != nil {
		t.Fatal(err)
	}

	obj, err := SealHandoff(Handoff{
		AccountID:   a.Root.AccountID,
		Epoch:       2, // the chain is still at epoch 1
		Counter:     1,
		AKSeed:      bytes.Repeat([]byte{0x5c}, 32),
		RootSignPub: a.Root.Sign.Public().(ed25519.PublicKey),
		HeadEntry:   lastWire,
	}, joiner.Enc.PublicKey(), testBinding)
	if err != nil {
		t.Fatal(err)
	}
	h, err := OpenHandoff(obj, a.Root.AccountID, 2, 1, joiner.Enc, testBinding)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.Adopt(chain); err == nil {
		t.Fatal("a handoff for epoch 2 adopted a chain that ends in epoch 1")
	}
}
