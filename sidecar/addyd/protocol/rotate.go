package protocol

import (
	"crypto/ed25519"
	"errors"
	"fmt"
)

// Epoch transitions.
//
// A TRANSITION CHANGES THE EPOCH AND NOTHING ELSE. It does not add a device,
// does not remove one, does not change the account id and does not alter any
// collection's contents. Anything else that needs to happen is a separate,
// separately signed entry. A combined operation is one where a verifier has to
// decide which half it is checking, and that decision is where the hole goes.

// RotationKind distinguishes the two, and conflating them is the bug waiting to
// happen.
type RotationKind uint8

const (
	// Hygiene is a routine rotation. It MAY publish an epoch-handoff object so
	// an offline device catches up through the chain without re-pairing.
	Hygiene RotationKind = iota
	// Revocation is a response to compromise. It MUST NOT chain: the revoked
	// device still holds AK_n, and chaining would let it follow the rotation
	// straight through to AK_{n+1} -- the exact thing the rotation exists to
	// prevent. AK_{n+1} is sealed individually to each SURVIVING device.
	Revocation
)

// Rotation is a prepared epoch transition, before anything is written.
//
// It is prepared rather than performed because the ORDER OF OPERATIONS is
// normative and the caller owns the writes: re-seal every collection under the
// new epoch first, write the escrow, seal the handoffs, append the transition
// entry, and only then delete the old epoch's objects. Any other order has a
// window in which a device that reads the chain finds an epoch whose objects do
// not exist yet. A crash between any two steps leaves the account usable at
// epoch n, which is the only acceptable failure mode.
type Rotation struct {
	Kind     RotationKind
	NewKeys  *EpochKeys
	Entry    Entry             // the transition entry, signed and ready to append
	Handoffs map[string][]byte // device pub_sign (hex) -> sealed handoff
}

var (
	ErrRevocationNeedsRoot = errors.New("rotate: a revocation rotation must be signed by the root key")
	ErrNoSurvivors         = errors.New("rotate: a rotation with no surviving devices")
)

// PrepareRotation mints the next epoch and builds its transition entry.
//
// signerKey is AK_n.sign for a hygiene rotation and RK_sign for a revocation.
// The distinction is enforced rather than documented: passing the wrong one is
// refused here, and the chain verifier refuses it again independently.
func PrepareRotation(kind RotationKind, acct AccountID, current *Verified, prev Entry, signerKey ed25519.PrivateKey, rootSignPub ed25519.PublicKey) (*Rotation, error) {
	if current == nil {
		return nil, errors.New("rotate: no verified chain to rotate from")
	}
	if len(current.Devices) == 0 {
		return nil, ErrNoSurvivors
	}

	next := current.Epoch + 1
	keys, err := NewEpochKey(acct, next)
	if err != nil {
		return nil, err
	}

	signer := SignerAK
	var flags uint8
	if kind == Revocation {
		signer = SignerRK
		flags = FlagRevocationRotation
		// THE COMPROMISED EPOCH KEY DOES NOT AUTHORISE THE ESCAPE FROM ITSELF.
		// A device that holds AK_n and is about to be revoked could otherwise
		// sign its own "rotation" to an AK_{n+1} it chose.
		if !signerKey.Public().(ed25519.PublicKey).Equal(rootSignPub) {
			return nil, ErrRevocationNeedsRoot
		}
	}

	prevHash, err := prev.Hash()
	if err != nil {
		return nil, err
	}
	nonce, err := Nonce()
	if err != nil {
		return nil, err
	}

	e := Entry{
		AccountID: acct,
		Epoch:     next,
		Seq:       prev.Seq + 1,
		PrevHash:  prevHash,
		Op:        OpEpoch,
		Signer:    signer,
		Flags:     flags,
		Nonce:     nonce,
		PubSign:   keys.Sign.Public().(ed25519.PublicKey),
		PubEnc:    keys.Enc.PublicKey().Bytes(),
		// A label here would be a covert channel in bytes the server stores
		// verbatim, and the verifier refuses one.
		LabelCT: nil,
		TS:      nowMillis(),
	}
	body, err := e.Encode()
	if err != nil {
		return nil, err
	}
	e.Sig = ed25519.Sign(signerKey, body)

	return &Rotation{Kind: kind, NewKeys: keys, Entry: e, Handoffs: map[string][]byte{}}, nil
}

// SealTo seals the new epoch key to one surviving device.
//
// For a REVOCATION rotation this is the only way AK_{n+1} reaches anybody:
// there is no chained handoff object, because chaining would carry the revoked
// device along with everyone else.
// previousAK is the binding: the recipient is already a roster member holding
// the previous epoch key, and an attacker who can read the roster's public
// DK_enc is not. Without it, anybody could seal a "rotation" to any device in
// any account they can see.
func (r *Rotation) SealTo(d Device, acct AccountID, counter uint64, rootSignPub, headEntry, previousAK []byte) error {
	enc, err := x25519Public(d.PubEnc)
	if err != nil {
		return fmt.Errorf("rotate: device encryption key: %w", err)
	}
	obj, err := SealHandoff(Handoff{
		AccountID:   acct,
		Epoch:       r.NewKeys.Epoch,
		Counter:     counter,
		AKSeed:      r.NewKeys.AK,
		RootSignPub: rootSignPub,
		HeadEntry:   headEntry,
	}, enc, previousAK)
	if err != nil {
		return err
	}
	r.Handoffs[fingerprintKey(d.PubSign)] = obj
	return nil
}

// ChainedHandoff is AK_{n+1} sealed under AK_n's own encryption key, so an
// offline device catches up without re-pairing.
//
// HYGIENE ONLY, and refused outright for a revocation. The rule is enforced by
// the reader as well as the writer, because the writer is not always honest: an
// implementation must refuse to READ a chained handoff for an epoch whose
// transition entry has REVOCATION_ROTATION set, even if the server serves one.
func (r *Rotation) ChainedHandoff(acct AccountID, counter uint64, previous *EpochKeys, rootSignPub, headEntry []byte) ([]byte, error) {
	if r.Kind == Revocation {
		return nil, errors.New("rotate: a revocation rotation must not chain; the revoked device still holds the old key")
	}
	return SealHandoff(Handoff{
		AccountID:   acct,
		Epoch:       r.NewKeys.Epoch,
		Counter:     counter,
		AKSeed:      r.NewKeys.AK,
		RootSignPub: rootSignPub,
		HeadEntry:   headEntry,
	}, previous.Enc.PublicKey(), previous.AK)
}

// ReadChainedHandoff opens a chained handoff, refusing one for a revocation
// rotation.
//
// THE READER ENFORCES THIS TOO. A server that keeps the handoff object from a
// hygiene rotation and serves it against a later revocation transition would
// otherwise hand the revoked device exactly what the revocation took away.
func ReadChainedHandoff(object []byte, transition Entry, acct AccountID, counter uint64, previous *EpochKeys) (*Handoff, error) {
	if transition.Op != OpEpoch {
		return nil, errors.New("rotate: that is not a transition entry")
	}
	if transition.Flags&FlagRevocationRotation != 0 {
		return nil, errors.New("rotate: refusing a chained handoff for a revocation rotation")
	}
	return OpenHandoff(object, acct, transition.Epoch, counter, previous.Enc, previous.AK)
}

func fingerprintKey(pubSign []byte) string {
	const hexit = "0123456789abcdef"
	out := make([]byte, 0, len(pubSign)*2)
	for _, b := range pubSign {
		out = append(out, hexit[b>>4], hexit[b&0x0f])
	}
	return string(out)
}
