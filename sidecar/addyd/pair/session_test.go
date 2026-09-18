// SPDX-License-Identifier: MIT
// Vendored from github.com/opsmaxx/addy internal/pair/session_test.go @ fe66709
//
// Edit it THERE and copy it here. A fix made only in this copy is a
// protocol divergence with no symptom until an AEAD tag fails on somebody
// else's machine. See VENDORED.md in this directory.
package pair

import (
	"bytes"
	"crypto/ed25519"
	"errors"
	"testing"
)

func devKeys(t *testing.T, n byte) (pubSign, pubEnc []byte) {
	t.Helper()
	k := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{n}, ed25519.SeedSize))
	return k.Public().(ed25519.PublicKey), bytes.Repeat([]byte{n ^ 0xff}, 32)
}

// The whole exchange, honestly relayed.
func TestAPairingCompletesAndBothSidesSeeTheSameEmoji(t *testing.T) {
	code, err := NewCode()
	if err != nil {
		t.Fatal(err)
	}
	aPub, _ := devKeys(t, 1)
	bPub, bEnc := devKeys(t, 2)

	a, f1, err := Begin(code, aPub)
	if err != nil {
		t.Fatalf("Begin: %v", err)
	}
	b, f2, err := Join(code, f1, bPub, bEnc)
	if err != nil {
		t.Fatalf("Join: %v", err)
	}
	f3, err := a.Reply(f2)
	if err != nil {
		t.Fatalf("Reply: %v", err)
	}
	if err := b.Confirm(f3); err != nil {
		t.Fatalf("Confirm: %v", err)
	}

	if !bytes.Equal(a.Secret(), b.Secret()) {
		t.Fatal("the two sides disagree on the shared secret")
	}

	sasA, err := a.SAS()
	if err != nil {
		t.Fatal(err)
	}
	sasB, err := b.SAS()
	if err != nil {
		t.Fatal(err)
	}
	if sasA.Indices != sasB.Indices {
		t.Fatalf("the emoji differ:\n a %s\n b %s", sasA, sasB)
	}
	t.Logf("code %s -> %s (%s)", code, sasA, sasA.Words())

	if !bytes.Equal(a.PeerPubSign(), bPub) || !bytes.Equal(b.PeerPubSign(), aPub) {
		t.Error("the devices did not learn each other's signing keys")
	}
}

// A wrong code must fail at KEY CONFIRMATION, not later and not silently. The
// PAKE gives the guesser one attempt and nothing to work offline with.
func TestAWrongCodeFailsAtKeyConfirmation(t *testing.T) {
	aPub, _ := devKeys(t, 1)
	bPub, bEnc := devKeys(t, 2)

	a, f1, err := Begin("42-amber-cedar", aPub)
	if err != nil {
		t.Fatal(err)
	}
	b, f2, err := Join("42-amber-cypress", f1, bPub, bEnc)
	if err != nil {
		t.Fatal(err)
	}
	_ = b

	if _, err := a.Reply(f2); !errors.Is(err, ErrConfirmFailed) {
		t.Fatalf("Reply = %v, want ErrConfirmFailed", err)
	}
}

// A relay that strips the confirmation must not be believed. An earlier draft
// skipped the comparison when the field was nil, which is a check an attacker
// can turn off.
func TestAStrippedConfirmationIsRefused(t *testing.T) {
	code, err := NewCode()
	if err != nil {
		t.Fatal(err)
	}
	aPub, _ := devKeys(t, 1)
	bPub, bEnc := devKeys(t, 2)

	a, f1, err := Begin(code, aPub)
	if err != nil {
		t.Fatal(err)
	}
	_, f2, err := Join(code, f1, bPub, bEnc)
	if err != nil {
		t.Fatal(err)
	}

	stripped := f2
	stripped.ConfirmB = nil
	if _, err := a.Reply(stripped); !errors.Is(err, ErrConfirmFailed) {
		t.Fatalf("Reply with no confirmation = %v, want ErrConfirmFailed", err)
	}
}

// A relay substituting its own signing key breaks the confirmation, because the
// identity keys are inside the label. Without that binding the PAKE would prove
// a shared password and nothing about who holds it.
func TestASubstitutedIdentityKeyBreaksConfirmation(t *testing.T) {
	code, err := NewCode()
	if err != nil {
		t.Fatal(err)
	}
	aPub, _ := devKeys(t, 1)
	bPub, bEnc := devKeys(t, 2)
	evilPub, _ := devKeys(t, 3)

	a, f1, err := Begin(code, aPub)
	if err != nil {
		t.Fatal(err)
	}
	_, f2, err := Join(code, f1, bPub, bEnc)
	if err != nil {
		t.Fatal(err)
	}

	tampered := f2
	tampered.PubSign = evilPub
	if _, err := a.Reply(tampered); !errors.Is(err, ErrConfirmFailed) {
		t.Fatalf("Reply with a substituted key = %v, want ErrConfirmFailed", err)
	}
}

// Likewise on the joiner's side, for frame 3.
func TestATamperedConfirmationOnFrameThreeIsRefused(t *testing.T) {
	code, err := NewCode()
	if err != nil {
		t.Fatal(err)
	}
	aPub, _ := devKeys(t, 1)
	bPub, bEnc := devKeys(t, 2)

	a, f1, err := Begin(code, aPub)
	if err != nil {
		t.Fatal(err)
	}
	b, f2, err := Join(code, f1, bPub, bEnc)
	if err != nil {
		t.Fatal(err)
	}
	f3, err := a.Reply(f2)
	if err != nil {
		t.Fatal(err)
	}
	f3.ConfirmA[0] ^= 0x01
	if err := b.Confirm(f3); !errors.Is(err, ErrConfirmFailed) {
		t.Fatalf("Confirm = %v, want ErrConfirmFailed", err)
	}
}

// SEVEN EMOJI SHOWN BEFORE KEY CONFIRMATION WOULD BE SEVEN EMOJI COMPARED
// AGAINST A SESSION THAT HAS PROVED NOTHING.
func TestNoSASBeforeKeyConfirmation(t *testing.T) {
	code, err := NewCode()
	if err != nil {
		t.Fatal(err)
	}
	aPub, _ := devKeys(t, 1)
	bPub, bEnc := devKeys(t, 2)

	a, f1, err := Begin(code, aPub)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.SAS(); err == nil {
		t.Error("the initiator produced a SAS before confirming anything")
	}

	b, f2, err := Join(code, f1, bPub, bEnc)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.SAS(); err == nil {
		t.Error("the joiner produced a SAS before verifying frame 3")
	}

	f3, err := a.Reply(f2)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.SAS(); err != nil {
		t.Errorf("the initiator has no SAS after confirming: %v", err)
	}
	if err := b.Confirm(f3); err != nil {
		t.Fatal(err)
	}
	if _, err := b.SAS(); err != nil {
		t.Errorf("the joiner has no SAS after confirming: %v", err)
	}
}

// A code observed in one session must not be replayable into another. That is
// what binding the pairing id into the password buys.
func TestACodeFromOneSessionDoesNotWorkInAnother(t *testing.T) {
	code, err := NewCode()
	if err != nil {
		t.Fatal(err)
	}
	aPub, _ := devKeys(t, 1)
	bPub, bEnc := devKeys(t, 2)

	a1, f1, err := Begin(code, aPub)
	if err != nil {
		t.Fatal(err)
	}
	// A second session with the SAME code but a different pairing id.
	_, f1b, err := Begin(code, aPub)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(f1.PairingID, f1b.PairingID) {
		t.Fatal("two sessions drew the same pairing id")
	}

	// The joiner answers the second session; the first must not accept it.
	_, f2b, err := Join(code, f1b, bPub, bEnc)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a1.Reply(f2b); err == nil {
		t.Fatal("a reply from another session was accepted")
	}
}

// Frames must not be replayed or reordered.
func TestFramesCannotBeReplayed(t *testing.T) {
	code, err := NewCode()
	if err != nil {
		t.Fatal(err)
	}
	aPub, _ := devKeys(t, 1)
	bPub, bEnc := devKeys(t, 2)

	a, f1, err := Begin(code, aPub)
	if err != nil {
		t.Fatal(err)
	}
	b, f2, err := Join(code, f1, bPub, bEnc)
	if err != nil {
		t.Fatal(err)
	}
	f3, err := a.Reply(f2)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.Reply(f2); !errors.Is(err, ErrOutOfOrder) {
		t.Errorf("frame 2 was accepted twice: %v", err)
	}
	if err := b.Confirm(f3); err != nil {
		t.Fatal(err)
	}
	if err := b.Confirm(f3); !errors.Is(err, ErrOutOfOrder) {
		t.Errorf("frame 3 was accepted twice: %v", err)
	}
}

// The initiator must reject a frame 1 that carries no signing key, since the
// confirmation cannot be computed without it.
func TestAFrameOneWithoutTheInitiatorKeyIsRefused(t *testing.T) {
	code, err := NewCode()
	if err != nil {
		t.Fatal(err)
	}
	aPub, _ := devKeys(t, 1)
	bPub, bEnc := devKeys(t, 2)

	_, f1, err := Begin(code, aPub)
	if err != nil {
		t.Fatal(err)
	}
	f1.PubSign = nil
	if _, _, err := Join(code, f1, bPub, bEnc); err == nil {
		t.Fatal("Join accepted a frame 1 with no initiator key")
	}
}

// M1 REVIEW, MEDIUM: the confirmation and SAS labels were unprefixed
// concatenations, so two different key pairs could produce one label -- shift a
// byte from the end of one key to the start of the next and the bytes are
// identical. Not exploitable here today, because SPAKE2 stops a relay choosing
// the secret and the roster's fixed-width fields stop a key of another width
// reaching this. But "two inputs, one label" is the shape of a real bug.
func TestLabelsCannotBeShiftedIntoOneAnother(t *testing.T) {
	secret := bytes.Repeat([]byte{0x42}, 32)
	id := bytes.Repeat([]byte{0x11}, 16)

	// Two splits of the same concatenated bytes.
	all := bytes.Repeat([]byte{0xab}, 64)
	initA, joinA := all[:32], all[32:]
	initB, joinB := all[:31], all[31:]

	confA1, confB1, err := confirmations(secret, id, initA, joinA)
	if err != nil {
		t.Fatal(err)
	}
	confA2, confB2, err := confirmations(secret, id, initB, joinB)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(confA1, confA2) || bytes.Equal(confB1, confB2) {
		t.Error("two different key splits produced the same confirmation")
	}

	sas1, err := DeriveSAS(secret, id, initA, joinA)
	if err != nil {
		t.Fatal(err)
	}
	sas2, err := DeriveSAS(secret, id, initB, joinB)
	if err != nil {
		t.Fatal(err)
	}
	if sas1.Indices == sas2.Indices {
		t.Error("two different key splits produced the same emoji")
	}
}
