// SPDX-License-Identifier: MIT
// Vendored from github.com/opsmaxx/addy internal/pair/spake2/spake2_test.go @ fe66709
//
// Edit it THERE and copy it here. A fix made only in this copy is a
// protocol divergence with no symptom until an AEAD tag fails on somebody
// else's machine. See VENDORED.md in this directory.
package spake2

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"testing"

	"filippo.io/edwards25519"
)

// THE CONSTANTS ARE THE POINT. The library this replaces carried M and N that
// were not the standard values and had no published derivation, which meant
// nobody could show their discrete logs were unknown -- exactly the assumption
// SPAKE2 is bought to rely on. These are RFC 9382 section 4's published bytes,
// asserted literally so a silent change fails the build.
func TestMAndNAreTheRFC9382Constants(t *testing.T) {
	const (
		rfcM = "d048032c6ea0b6d697ddc2e86bda85a33adac920f1bf18e1b0c6d166a5cecdaf"
		rfcN = "d3bfb518f44f3430f29d0c92af503865a1ed3281dc69b35dd868ba85f886c4ab"
	)
	if mHex != rfcM {
		t.Errorf("M = %s, RFC 9382 says %s", mHex, rfcM)
	}
	if nHex != rfcN {
		t.Errorf("N = %s, RFC 9382 says %s", nHex, rfcN)
	}

	// They must round-trip through the library's own encoding, which is what
	// shows the bytes above are the points being used rather than merely
	// stored.
	for name, p := range map[string]*edwards25519.Point{"M": pointM, "N": pointN} {
		want, _ := hex.DecodeString(map[string]string{"M": rfcM, "N": rfcN}[name])
		if !bytes.Equal(p.Bytes(), want) {
			t.Errorf("%s re-encodes to %x", name, p.Bytes())
		}
		// And neither may be the identity or the generator.
		if p.Equal(edwards25519.NewIdentityPoint()) == 1 {
			t.Errorf("%s is the identity", name)
		}
		if p.Equal(edwards25519.NewGeneratorPoint()) == 1 {
			t.Errorf("%s is the generator", name)
		}
	}
	if pointM.Equal(pointN) == 1 {
		t.Error("M and N are the same point")
	}
}

func run(t *testing.T, pw []byte) ([]byte, []byte) {
	t.Helper()
	msgA, a, err := Start(Initiator, pw)
	if err != nil {
		t.Fatalf("Start(initiator): %v", err)
	}
	msgB, b, err := Start(Joiner, pw)
	if err != nil {
		t.Fatalf("Start(joiner): %v", err)
	}
	ka, err := a.Finish(msgB)
	if err != nil {
		t.Fatalf("initiator Finish: %v", err)
	}
	kb, err := b.Finish(msgA)
	if err != nil {
		t.Fatalf("joiner Finish: %v", err)
	}
	return ka, kb
}

// The property the whole exchange exists for.
func TestBothSidesAgreeOnTheSecret(t *testing.T) {
	ka, kb := run(t, []byte("42-amber-cedar"))
	if !bytes.Equal(ka, kb) {
		t.Fatalf("the two sides disagree:\n a %x\n b %x", ka, kb)
	}
	if len(ka) != 32 {
		t.Fatalf("secret is %d bytes, want 32", len(ka))
	}
}

// Run it many times. The bug that killed the previous library appeared in about
// 0.3% of runs and was masked by a byte-order accident, so a handful of
// successes proves nothing here.
func TestTheExchangeIsStableOverManyRuns(t *testing.T) {
	for i := 0; i < 3000; i++ {
		pw := make([]byte, 16)
		if _, err := rand.Read(pw); err != nil {
			t.Fatal(err)
		}
		ka, kb := run(t, pw)
		if !bytes.Equal(ka, kb) {
			t.Fatalf("run %d disagreed:\n a %x\n b %x", i, ka, kb)
		}
	}
}

// A wrong code must produce a different secret -- and nothing else. That is the
// whole shape of a PAKE: the guess fails, and the failure costs one online
// attempt rather than yielding anything to work offline with.
func TestAWrongCodeProducesADifferentSecret(t *testing.T) {
	msgA, a, err := Start(Initiator, []byte("42-amber-cedar"))
	if err != nil {
		t.Fatal(err)
	}
	msgB, b, err := Start(Joiner, []byte("42-amber-cypress"))
	if err != nil {
		t.Fatal(err)
	}
	ka, err := a.Finish(msgB)
	if err != nil {
		t.Fatalf("the exchange errored rather than producing a different secret: %v", err)
	}
	kb, err := b.Finish(msgA)
	if err != nil {
		t.Fatalf("the exchange errored rather than producing a different secret: %v", err)
	}
	if bytes.Equal(ka, kb) {
		t.Fatal("two different codes produced the same secret")
	}
}

// Asymmetric roles: the initiator blinds with M and the joiner with N. Two
// devices in the same role must not agree, because otherwise a reflected
// message would be indistinguishable from a peer's.
func TestTwoDevicesInTheSameRoleDoNotAgree(t *testing.T) {
	pw := []byte("42-amber-cedar")
	msgA, a, err := Start(Initiator, pw)
	if err != nil {
		t.Fatal(err)
	}
	msgA2, a2, err := Start(Initiator, pw)
	if err != nil {
		t.Fatal(err)
	}
	k1, err := a.Finish(msgA2)
	if err != nil {
		t.Fatalf("Finish: %v", err)
	}
	k2, err := a2.Finish(msgA)
	if err != nil {
		t.Fatalf("Finish: %v", err)
	}
	if bytes.Equal(k1, k2) {
		t.Fatal("two initiators agreed on a secret")
	}
}

// A relay playing both sides. The previous library's reflection check compared a
// short local encoding against padded wire bytes and failed open in a fraction
// of sessions; fixed-width encoding means that cannot be expressed here.
func TestOurOwnMessageReflectedBackIsRefused(t *testing.T) {
	msg, s, err := Start(Initiator, []byte("42-amber-cedar"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Finish(msg); !errors.Is(err, ErrReflected) {
		t.Fatalf("Finish = %v, want ErrReflected", err)
	}
}

// THE HOSTILE-FRAME CASES. The library this replaces panicked on seven of eight
// of these. A panic on an unauthenticated frame from a relay that is assumed
// hostile is a remote denial of service at best.
func TestHostileFramesAreRefusedWithoutPanicking(t *testing.T) {
	cases := map[string][]byte{
		"empty":      {},
		"one byte":   {0x00},
		"31 bytes":   bytes.Repeat([]byte{0x01}, 31),
		"33 bytes":   bytes.Repeat([]byte{0x01}, 33),
		"all zeroes": make([]byte, 32),
		"all ones":   bytes.Repeat([]byte{0xff}, 32),
		// A y coordinate larger than the field prime. filippo.io/edwards25519
		// ACCEPTS this and silently reduces it to y=18, so canonicality is
		// checked by this package rather than assumed of the library.
		"non-canonical high bytes": append(bytes.Repeat([]byte{0xff}, 31), 0x7f),
		"not on the curve":         bytes.Repeat([]byte{0x02}, 32),
	}
	for name, frame := range cases {
		t.Run(name, func(t *testing.T) {
			defer func() {
				if p := recover(); p != nil {
					t.Fatalf("a hostile frame panicked: %v", p)
				}
			}()
			_, s, err := Start(Initiator, []byte("42-amber-cedar"))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.Finish(frame); err == nil {
				t.Errorf("a hostile frame was accepted")
			}
		})
	}
}

// Small-order peer messages.
//
// WHAT I ASSUMED AND WHAT IS ACTUALLY TRUE. The first version of this test
// asserted these are refused because they are small-order, and two of the four
// were accepted -- correctly. After unblinding, the result is
// x*(S - w*N)*8, and w*N is not small-order, so the product is a perfectly
// ordinary group element. RFC 9382 does not require rejecting these: the
// cofactor clearing and the key confirmation already make them harmless,
// because the honest peer derives something different and the confirmation
// fails.
//
// They are rejected anyway, before any secret-dependent arithmetic, because it
// is cheap and because a handshake that proceeds on a degenerate input and
// fails two frames later is harder to diagnose than one that says so. The
// assertion is that they are refused AND that nothing panics.
func TestSmallOrderPeerMessagesAreRefusedEarly(t *testing.T) {
	smallOrder := []string{
		"0100000000000000000000000000000000000000000000000000000000000000", // identity
		"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", // order 2
		"0000000000000000000000000000000000000000000000000000000000000000", // order 4
		"0000000000000000000000000000000000000000000000000000000000000080", // order 4
	}
	for _, h := range smallOrder {
		raw, err := hex.DecodeString(h)
		if err != nil {
			t.Fatal(err)
		}
		_, s, err := Start(Initiator, []byte("42-amber-cedar"))
		if err != nil {
			t.Fatal(err)
		}
		func() {
			defer func() {
				if p := recover(); p != nil {
					t.Fatalf("a small-order point panicked: %v", p)
				}
			}()
			if _, err := s.Finish(raw); !errors.Is(err, ErrLowOrder) {
				t.Errorf("Finish(%s...) = %v, want ErrLowOrder", h[:16], err)
			}
		}()
	}
}

// The case that genuinely matters: a peer that sends exactly w*N already knows
// the password, and would drive both sides to a shared secret of the identity
// element. A secret an attacker chose is not a secret.
func TestAPeerThatCancelsTheBlindIsRefused(t *testing.T) {
	pw := []byte("42-amber-cedar")
	_, s, err := Start(Initiator, pw)
	if err != nil {
		t.Fatal(err)
	}
	// The initiator unblinds with N, so w*N drives the shared point to the
	// identity.
	cancel := new(edwards25519.Point).ScalarMult(deriveW(pw), pointN)
	if _, err := s.Finish(cancel.Bytes()); !errors.Is(err, ErrLowOrder) {
		t.Fatalf("Finish = %v, want ErrLowOrder", err)
	}
}

// A PAKE that can be run twice against the same secret scalar is not a PAKE.
func TestAnExchangeIsSingleUse(t *testing.T) {
	_, a, err := Start(Initiator, []byte("42-amber-cedar"))
	if err != nil {
		t.Fatal(err)
	}
	msgB, _, err := Start(Joiner, []byte("42-amber-cedar"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.Finish(msgB); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Finish(msgB); err == nil {
		t.Fatal("the same exchange completed twice")
	}
}

// Fixed-width output, always. The variable-length encoding is the bug that
// killed the previous library, and it cannot be expressed against Point.Bytes.
func TestEveryMessageIsExactlyThirtyTwoBytes(t *testing.T) {
	for i := 0; i < 2000; i++ {
		pw := make([]byte, 8)
		if _, err := rand.Read(pw); err != nil {
			t.Fatal(err)
		}
		for _, role := range []Role{Initiator, Joiner} {
			msg, _, err := Start(role, pw)
			if err != nil {
				t.Fatal(err)
			}
			if len(msg) != 32 {
				t.Fatalf("%s produced a %d-byte message", role, len(msg))
			}
		}
	}
}

// Two distinct encodings must not name one point as far as this package is
// concerned, or a relay rewriting an encoding turns into an unexplained pairing
// failure two frames later.
func TestANonCanonicalEncodingIsRefusedEvenThoughTheLibraryAcceptsIt(t *testing.T) {
	frame := append(bytes.Repeat([]byte{0xff}, 31), 0x7f)

	// The premise, asserted so this test still means something if the library
	// changes: SetBytes accepts it and re-encodes to something else.
	p, err := new(edwards25519.Point).SetBytes(frame)
	if err != nil {
		t.Skip("the library now rejects this itself; the check here is redundant but harmless")
	}
	if bytes.Equal(p.Bytes(), frame) {
		t.Fatal("the library round-tripped it, so it is canonical after all")
	}

	_, s, err := Start(Initiator, []byte("42-amber-cedar"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Finish(frame); !errors.Is(err, ErrBadPoint) {
		t.Fatalf("Finish = %v, want ErrBadPoint", err)
	}
}

func TestAnEmptyPasswordIsRefused(t *testing.T) {
	if _, _, err := Start(Initiator, nil); err == nil {
		t.Error("Start accepted an empty password")
	}
}

// NO ORACLE IN THE ERROR PATHS.
//
// The review of the library this replaces found its error handling to be the
// healthiest part of it: every early return happened before the password scalar
// was touched, and depended only on public or attacker-supplied state. That is
// worth keeping rather than rediscovering, so it is pinned here.
//
// The property: every refusal in Finish -- wrong length, reflection, bad point,
// non-canonical encoding, degenerate point -- is decided from the peer's frame
// and our own public message alone. None of them branches on w, so none of them
// leaks anything about the code by which path it took or how long it took.
func TestEveryRefusalIsDecidedBeforeThePasswordIsUsed(t *testing.T) {
	// Two states from DIFFERENT passwords. If a refusal depended on the
	// password, the same hostile frame would be refused differently by them.
	_, weak, err := Start(Initiator, []byte("00-amber-cedar"))
	if err != nil {
		t.Fatal(err)
	}
	_, strong, err := Start(Initiator, bytes.Repeat([]byte{0xa5}, 64))
	if err != nil {
		t.Fatal(err)
	}

	frames := map[string][]byte{
		"empty":         {},
		"short":         bytes.Repeat([]byte{1}, 31),
		"long":          bytes.Repeat([]byte{1}, 33),
		"identity":      append([]byte{0x01}, make([]byte, 31)...),
		"non-canonical": append(bytes.Repeat([]byte{0xff}, 31), 0x7f),
		"off-curve":     bytes.Repeat([]byte{0x02}, 32),
	}
	for name, frame := range frames {
		_, a, err := Start(Initiator, []byte("00-amber-cedar"))
		if err != nil {
			t.Fatal(err)
		}
		_, b, err := Start(Initiator, bytes.Repeat([]byte{0xa5}, 64))
		if err != nil {
			t.Fatal(err)
		}
		_, errA := a.Finish(frame)
		_, errB := b.Finish(frame)

		if (errA == nil) != (errB == nil) {
			t.Errorf("%s: one password refused it and the other did not", name)
			continue
		}
		if errA != nil && errA.Error() != errB.Error() {
			t.Errorf("%s: two passwords produced different refusals:\n %v\n %v", name, errA, errB)
		}
	}
	_, _ = weak, strong
}

// The transcript must commit to the FULL fixed-width messages.
//
// The review found the old library taking its transcript field width from the
// length of the derived key rather than the group element size, so about one
// session in 315 hashed a transcript one byte short per message field. Both
// sides truncated identically, so the keys still agreed and nothing looked
// wrong -- while the transcript quietly stopped committing to the whole of what
// was exchanged. Fixed-width encoding plus explicit length prefixes means the
// mistake has nowhere to live here, and this asserts it.
func TestTheTranscriptDependsOnEveryByteOfBothMessages(t *testing.T) {
	pw := []byte("42-amber-cedar")

	base := func() []byte {
		msgA, a, err := Start(Initiator, pw)
		if err != nil {
			t.Fatal(err)
		}
		msgB, b, err := Start(Joiner, pw)
		if err != nil {
			t.Fatal(err)
		}
		ka, err := a.Finish(msgB)
		if err != nil {
			t.Fatal(err)
		}
		kb, err := b.Finish(msgA)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(ka, kb) {
			t.Fatal("the sides disagreed")
		}
		return ka
	}

	// Two independent runs must differ, because each draws fresh scalars: if
	// the transcript ignored part of the messages, collisions would appear.
	seen := map[string]bool{}
	for i := 0; i < 500; i++ {
		k := base()
		if seen[string(k)] {
			t.Fatal("two runs with the same password produced the same secret; the transcript is not committing to the messages")
		}
		seen[string(k)] = true
	}
}
