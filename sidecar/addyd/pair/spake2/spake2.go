// Package spake2 implements SPAKE2 over edwards25519, following RFC 9382.
//
// WHY THIS EXISTS RATHER THAN A DEPENDENCY. The design selected
// salsa.debian.org/vasudev/gospake2, vendored. A security review of the
// vendored copy (docs/spake2-review.md) returned DO NOT USE, and the deciding
// finding was not a bug that could be fixed: its M and N are not the RFC 9382
// constants and have no published derivation. SPAKE2's security rests entirely
// on nobody knowing their discrete logs to the base point, and the standard
// values earn that by being the reproducible output of a fixed derivation
// anyone can recompute. Four unexplained integers in a source file cannot be
// shown to be unknown, which is precisely the assumption this product buys
// SPAKE2 to rely on.
//
// So: RFC 9382's own constants, on filippo.io/edwards25519, which gives
// constant-time scalar arithmetic, a SetBytes that validates curve membership
// and returns an error rather than panicking, and a fixed-width 32-byte
// encoding in which the variable-length bug that review found cannot be
// expressed. (Canonicality it does NOT validate -- see Finish.)
//
// THE ATTACK THE TIMING LEAK ENABLED, stated because it is the reason
// constant-time arithmetic is not a nicety here: the old library's ladder
// branched per bit over math/big, on both the password scalar and the ephemeral
// one, measured at a 1.99x runtime ratio by Hamming weight. Leaking the
// ephemeral scalar x yields w·M = X* - x·B, and from there the pairing code
// falls to an offline dictionary attack over a 22-bit space -- which is the one
// thing a PAKE exists to prevent.
//
// ONE THING THE OLD LIBRARY GOT RIGHT AND THIS KEEPS. Its error paths were
// clean: every early return happened before the password scalar was touched and
// depended only on public or attacker-supplied state, so no refusal was an
// oracle. Finish below preserves that ordering, and a test pins it by refusing
// the same hostile frames under two different passwords and requiring identical
// outcomes.
package spake2

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"

	"filippo.io/edwards25519"
)

// M and N, exactly as RFC 9382 section 4 publishes them for edwards25519.
//
// THE WHOLE PROPERTY IS THAT ANYONE CAN CHECK THESE. They are in the RFC, they
// are the same values every interoperable implementation uses, and their
// derivation is published. A test asserts that they decode to valid points and
// that they are these exact bytes, because a constant that silently changed
// would be the one failure this package exists to avoid.
const (
	mHex = "d048032c6ea0b6d697ddc2e86bda85a33adac920f1bf18e1b0c6d166a5cecdaf"
	nHex = "d3bfb518f44f3430f29d0c92af503865a1ed3281dc69b35dd868ba85f886c4ab"
)

var (
	pointM = mustPoint(mHex)
	pointN = mustPoint(nHex)
)

func mustPoint(h string) *edwards25519.Point {
	raw, err := hex.DecodeString(h)
	if err != nil {
		panic("spake2: constant is not hex: " + err.Error())
	}
	p, err := new(edwards25519.Point).SetBytes(raw)
	if err != nil {
		panic("spake2: constant is not a valid point: " + err.Error())
	}
	return p
}

// Role is which side of the exchange this is.
//
// Asymmetric roles, because the two sides use different constants: the
// initiator blinds with M and the joiner with N. If both used the same constant
// a reflected message would be indistinguishable from a peer's.
type Role uint8

const (
	// Initiator is the device SHOWING the code.
	Initiator Role = iota
	// Joiner is the device the code is TYPED INTO.
	Joiner
)

func (r Role) String() string {
	if r == Initiator {
		return "initiator"
	}
	return "joiner"
}

// Identity strings. Constants rather than device identifiers, because the two
// devices have no shared names yet -- that is what the pairing is for.
const (
	IDInitiator = "addy-pair-init"
	IDJoiner    = "addy-pair-join"
)

// wLabel domain-separates the scalar derivation from every other use of the
// password hash.
const wLabel = "addy-pake-w-v1"

var (
	ErrWrongLength = errors.New("spake2: a peer message is not 32 bytes")
	ErrBadPoint    = errors.New("spake2: a peer message is not a valid curve point")
	ErrReflected   = errors.New("spake2: the peer reflected our own message back")
	ErrLowOrder    = errors.New("spake2: the shared secret is the identity element")
)

// State is one side of an exchange in progress. It is single-use: Finish
// consumes it, because a PAKE that can be run twice against the same secret
// scalar is not a PAKE.
type State struct {
	role     Role
	w        *edwards25519.Scalar
	x        *edwards25519.Scalar
	outbound []byte
	done     bool
}

// deriveW turns the password into a scalar.
//
// SHA-512 then SetUniformBytes rather than reducing a 32-byte hash directly:
// reducing 32 bytes mod the group order is biased, and while the bias is small
// it costs nothing to avoid. The specification defines the password and leaves
// the reduction open; this is the choice, recorded here so a second
// implementation makes the same one.
func deriveW(password []byte) *edwards25519.Scalar {
	h := sha512.New()
	h.Write([]byte(wLabel))
	h.Write([]byte{0x00})
	h.Write(password)
	w, err := new(edwards25519.Scalar).SetUniformBytes(h.Sum(nil))
	if err != nil {
		// SetUniformBytes only errors on a wrong input length, and SHA-512
		// output is always 64 bytes.
		panic("spake2: scalar derivation: " + err.Error())
	}
	return w
}

// Start begins an exchange and returns this side's 32-byte message.
func Start(role Role, password []byte) (msg []byte, s *State, err error) {
	if len(password) == 0 {
		return nil, nil, errors.New("spake2: an empty password")
	}

	var seed [64]byte
	if _, err := rand.Read(seed[:]); err != nil {
		return nil, nil, fmt.Errorf("spake2: drawing a scalar: %w", err)
	}
	x, err := new(edwards25519.Scalar).SetUniformBytes(seed[:])
	if err != nil {
		return nil, nil, fmt.Errorf("spake2: scalar: %w", err)
	}

	w := deriveW(password)

	// pA = x*B + w*M   (initiator)
	// pB = y*B + w*N   (joiner)
	blind := pointM
	if role == Joiner {
		blind = pointN
	}
	share := new(edwards25519.Point).ScalarBaseMult(x)
	masked := new(edwards25519.Point).ScalarMult(w, blind)
	out := new(edwards25519.Point).Add(share, masked)

	return out.Bytes(), &State{role: role, w: w, x: x, outbound: out.Bytes()}, nil
}

// Finish completes the exchange and returns the shared secret.
//
// The returned value is SHA-256 of RFC 9382's transcript, not the raw group
// element. The transcript binds both identity strings, both messages, the group
// element AND the password scalar, so two sessions that agree on the secret
// agree on everything that produced it.
func (s *State) Finish(peer []byte) ([]byte, error) {
	if s.done {
		return nil, errors.New("spake2: this exchange has already completed")
	}
	s.done = true

	if len(peer) != 32 {
		return nil, fmt.Errorf("%w: got %d", ErrWrongLength, len(peer))
	}

	// A reflected message means the relay is playing both sides. The roles use
	// different constants, so this cannot happen by accident.
	//
	// Constant-time, and over FIXED-WIDTH values on both sides -- the review
	// found the previous library comparing a short local encoding against
	// padded wire bytes, so its reflection check failed open in a fraction of
	// sessions. Point.Bytes() is always 32 bytes, so that cannot be expressed
	// here.
	if subtle.ConstantTimeCompare(peer, s.outbound) == 1 {
		return nil, ErrReflected
	}

	// SetBytes validates CURVE MEMBERSHIP and returns an error rather than
	// panicking, which is what makes this safe against the hostile frames that
	// crashed the library this replaces.
	//
	// IT DOES NOT VALIDATE CANONICALITY, and that surprised me, so it is
	// checked here rather than assumed. The encoding ff…ff7f -- a y coordinate
	// of 2^255-1, which is larger than the field prime -- is accepted and
	// silently reduced to y=18. Two distinct byte strings therefore name one
	// point.
	//
	// That is not a break, because each side hashes the bytes it actually
	// exchanged: a relay rewriting an encoding makes the two transcripts
	// disagree and the confirmation fail. But it is a malleability that turns
	// into an unexplained pairing failure, and re-encoding to compare costs one
	// allocation.
	peerPoint, err := new(edwards25519.Point).SetBytes(peer)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadPoint, err)
	}
	if subtle.ConstantTimeCompare(peerPoint.Bytes(), peer) != 1 {
		return nil, fmt.Errorf("%w: the encoding is not canonical", ErrBadPoint)
	}

	// A peer point with NO prime-order component carries no key agreement at
	// all. RFC 9382 does not require rejecting it -- the cofactor clearing
	// below plus the key confirmation already make it harmless, because the
	// honest peer derives something different and the confirmation fails.
	//
	// It is rejected anyway, here, for one reason: it is cheap, and a
	// handshake that proceeds on a degenerate input and fails two frames later
	// is harder to diagnose than one that says what happened. Checked BEFORE
	// any secret-dependent arithmetic touches it.
	if new(edwards25519.Point).MultByCofactor(peerPoint).Equal(edwards25519.NewIdentityPoint()) == 1 {
		return nil, fmt.Errorf("%w: the peer message has no prime-order component", ErrLowOrder)
	}

	// Unblind with the OTHER side's constant, then multiply by the cofactor.
	//
	// MultByCofactor is what neutralises a small-order component in the peer's
	// point: edwards25519 has cofactor 8, so a peer can add a torsion point and
	// both sides would otherwise derive different secrets. Clearing it makes the
	// result independent of any such component.
	unblind := pointN
	if s.role == Joiner {
		unblind = pointM
	}
	negMask := new(edwards25519.Point).ScalarMult(s.w, unblind)
	negMask.Negate(negMask)

	shared := new(edwards25519.Point).Add(peerPoint, negMask)
	shared.ScalarMult(s.x, shared)
	shared.MultByCofactor(shared)

	// The identity here means the peer sent exactly w*<our unblinding constant>
	// -- which requires already knowing the password, and yields a shared
	// secret of the identity element for both sides. Refused rather than
	// hashed, because a "shared secret" that an attacker chose is not one.
	if shared.Equal(edwards25519.NewIdentityPoint()) == 1 {
		return nil, fmt.Errorf("%w: the shared secret is the identity element", ErrLowOrder)
	}

	pA, pB := s.outbound, peer
	if s.role == Joiner {
		pA, pB = peer, s.outbound
	}

	// RFC 9382's transcript. Every component is length-prefixed with an 8-byte
	// little-endian length, which is what stops one field's bytes being read as
	// the next field's -- the fixed-offset scheme the previous library used is
	// exactly what let its encoding bug corrupt a transcript silently.
	h := sha256.New()
	writeLen(h, []byte(IDInitiator))
	writeLen(h, []byte(IDJoiner))
	writeLen(h, pA)
	writeLen(h, pB)
	writeLen(h, shared.Bytes())
	writeLen(h, s.w.Bytes())
	return h.Sum(nil), nil
}

func writeLen(h interface{ Write([]byte) (int, error) }, b []byte) {
	var n [8]byte
	binary.LittleEndian.PutUint64(n[:], uint64(len(b)))
	_, _ = h.Write(n[:])
	_, _ = h.Write(b)
}
