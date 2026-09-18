package protocol

import (
	"bytes"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/subtle"
	"errors"
	"fmt"

	"crypto/hpke"
)

// The pairing handoff: what an already-trusted device seals to a newly paired
// one.
//
// SPEC CORRECTION, 2026-09-17, found by implementing it. PROTOCOL.md section
// 8.7 says the handoff plaintext is "the addy-escrow-v1\0 structure" with a
// different HPKE info label. Section 10.1 says the joining device "receives
// RK_sign.pub in the same sealed structure". The escrow structure has no field
// for it, so both cannot be true.
//
// Resolved with a structure of its own, addy-handoff-v1\0, rather than by
// adding an optional field to the escrow. Two structures that differ by a field
// and share a domain prefix are two structures a verifier can be confused
// between; two structures with different prefixes are not.
//
// AND WHY A HANDOFF IS BOUND TO WHAT PRODUCED IT.
//
// Sealing one needs only the recipient's PUBLIC DK_enc, and frame 2 of a
// pairing publishes exactly that, in the clear, on a relay the design assumes is
// hostile. So without a binding, a relay can drop frame 3, seal its own handoff
// for an account it controls, and the joining device adopts it cleanly -- it has
// no way to tell, because the account id is something it LEARNS from the
// handoff. The M1 review proved that end to end.
//
// So every handoff carries a BINDING: bytes both parties already share and an
// outsider does not.
//
//   - A PAIRING handoff binds the PAKE shared secret. An attacker who did not
//     run the exchange does not have it, and one who did is the device the human
//     confirmed emoji with.
//   - A ROTATION handoff binds the PREVIOUS epoch key. The recipient is already
//     a roster member holding AK_n, and an attacker is not.
//
// It goes in the HPKE info, so it is bound into the key schedule rather than
// checked afterwards: a handoff sealed without the right binding does not open
// at all.
//
// WHY RK_sign.pub HAS TO TRAVEL. A joining device must verify the roster chain
// from genesis, and step 8 of that algorithm needs the root key to check
// root-signed entries. It cannot take that key from the server -- a chain
// verified against a key the server supplied is not verified. So it comes
// sealed, from a device that already holds it.

const (
	domainHandoffPlaintext = "addy-handoff-v1"
	domainHandoffAAD       = "addy-handoff-aad-v1"
	domainHandoffObject    = "addy-handoff-obj-v1"

	infoHandoffHPKE   = "addy-handoff-hpke-v1"
	infoHandoffCommit = "addy-handoff-commit-v1"
)

// Handoff is everything a newly paired device needs and cannot compute.
type Handoff struct {
	AccountID   AccountID
	Epoch       uint64
	Counter     uint64 // the sealing device's current escrow counter
	AKSeed      []byte // fixed[32]
	RootSignPub []byte // fixed[32]; needed to verify root-signed roster entries
	HeadEntry   []byte // the roster head, body || sig, verbatim
}

func (h Handoff) encodePlaintext() ([]byte, error) {
	if err := fixed("ak_seed", h.AKSeed, 32); err != nil {
		return nil, err
	}
	if err := fixed("rk_sign_pub", h.RootSignPub, ed25519.PublicKeySize); err != nil {
		return nil, err
	}
	if len(h.HeadEntry) == 0 {
		return nil, errors.New("protocol: a handoff with no roster head entry")
	}
	if h.Counter == 0 {
		return nil, errors.New("protocol: handoff counters start at 1")
	}
	return NewEncoder(domainHandoffPlaintext).
		Fixed(h.AccountID[:]).
		U64(h.Epoch).
		U64(h.Counter).
		Fixed(h.AKSeed).
		Fixed(h.RootSignPub).
		Bytes(h.HeadEntry).
		Out(), nil
}

func (h Handoff) aad() []byte {
	return NewEncoder(domainHandoffAAD).
		Fixed(h.AccountID[:]).
		U64(h.Epoch).
		U64(h.Counter).
		Out()
}

// SealHandoff seals to the joining device's DK_enc.
//
// NOTHING IS SEALED BEFORE THE HUMAN CONFIRMS THE EMOJI. That ordering is the
// whole value of the confirmation step, and it is the caller's to enforce --
// this function is what must not be called early.
func SealHandoff(h Handoff, recipient *ecdh.PublicKey, binding []byte) ([]byte, error) {
	if len(binding) == 0 {
		return nil, errors.New("protocol: a handoff must be bound to the exchange that produced it")
	}
	plaintext, err := h.encodePlaintext()
	if err != nil {
		return nil, err
	}
	pk, err := hpke.NewDHKEMPublicKey(recipient)
	if err != nil {
		return nil, fmt.Errorf("protocol: handoff recipient key: %w", err)
	}
	kdf, aead := suite()
	enc, sender, err := hpke.NewSender(pk, kdf, aead, handoffInfo(h.AccountID, h.Epoch, binding))
	if err != nil {
		return nil, fmt.Errorf("protocol: handoff sender: %w", err)
	}
	ct, err := sender.Seal(h.aad(), plaintext)
	if err != nil {
		return nil, fmt.Errorf("protocol: sealing the handoff: %w", err)
	}
	commit, err := sender.Export(handoffCommitContext(h.AccountID, h.Epoch, h.Counter), commitLen)
	if err != nil {
		return nil, fmt.Errorf("protocol: handoff commitment: %w", err)
	}
	return NewEncoder(domainHandoffObject).
		U8(SuitePinned).
		Bytes(enc).
		Fixed(commit).
		Bytes(ct).
		Out(), nil
}

// handoffInfo length-prefixes the binding, so a binding cannot be shifted into
// the account id or the epoch by choosing its length.
func handoffInfo(acct AccountID, epoch uint64, binding []byte) []byte {
	return NewEncoder(infoHandoffHPKE).
		Fixed(acct[:]).
		U64(epoch).
		Bytes(binding).
		Out()
}

func handoffCommitContext(acct AccountID, epoch, counter uint64) string {
	return string(NewEncoder(infoHandoffCommit).
		Fixed(acct[:]).
		U64(epoch).
		U64(counter).
		Out())
}

// OpenHandoff opens what a trusted device sealed, on the joining device.
//
// Same commitment discipline as the escrow: the exporter tag is compared in
// constant time BEFORE the AEAD, so a chosen ciphertext fails before it
// produces any plaintext at all rather than being noticed afterwards.
func OpenHandoff(object []byte, acct AccountID, epoch, counter uint64, recipient *ecdh.PrivateKey, binding []byte) (*Handoff, error) {
	if counter == 0 {
		return nil, errors.New("handoff: counters start at 1")
	}
	if len(binding) == 0 {
		return nil, errors.New("handoff: no binding; an unbound handoff is one a relay could have sealed")
	}

	d := NewDecoder(domainHandoffObject, object)
	gotSuite := d.U8()
	enc := d.Bytes()
	commit := d.Fixed(commitLen)
	ct := d.Bytes()
	if err := d.End(); err != nil {
		return nil, fmt.Errorf("handoff: %w", err)
	}
	if gotSuite != SuitePinned {
		return nil, fmt.Errorf("%w: %#02x", ErrEscrowSuite, gotSuite)
	}

	sk, err := hpke.NewDHKEMPrivateKey(recipient)
	if err != nil {
		return nil, fmt.Errorf("handoff: recipient key: %w", err)
	}
	kdf, aead := suite()
	r, err := hpke.NewRecipient(enc, sk, kdf, aead, handoffInfo(acct, epoch, binding))
	if err != nil {
		return nil, fmt.Errorf("handoff: recipient context: %w", err)
	}

	want, err := r.Export(handoffCommitContext(acct, epoch, counter), commitLen)
	if err != nil {
		return nil, fmt.Errorf("handoff: commitment: %w", err)
	}
	if subtle.ConstantTimeCompare(want, commit) != 1 {
		return nil, ErrEscrowCommit
	}

	plaintext, err := r.Open(Handoff{AccountID: acct, Epoch: epoch, Counter: counter}.aad(), ct)
	if err != nil {
		return nil, fmt.Errorf("handoff: opening: %w", err)
	}

	pd := NewDecoder(domainHandoffPlaintext, plaintext)
	var out Handoff
	copy(out.AccountID[:], pd.Fixed(AccountIDLen))
	out.Epoch = pd.U64()
	out.Counter = pd.U64()
	out.AKSeed = pd.Fixed(32)
	out.RootSignPub = pd.Fixed(ed25519.PublicKeySize)
	out.HeadEntry = pd.Bytes()
	if err := pd.End(); err != nil {
		return nil, fmt.Errorf("handoff: plaintext: %w", err)
	}
	if out.AccountID != acct || out.Epoch != epoch || out.Counter != counter {
		return nil, ErrEscrowMismatch
	}

	// The account id must be the one this root key names. Without this a device
	// could be handed a valid-looking handoff for a DIFFERENT account and would
	// go on to verify that account's chain quite happily.
	if DeriveAccountID(out.RootSignPub) != out.AccountID {
		return nil, fmt.Errorf("%w: the root key does not name this account", ErrWrongAccount)
	}
	return &out, nil
}

// Adopt turns a handoff into the keys and the verified chain a joining device
// needs, and is where the joiner stops trusting the device that paired it.
//
// The chain is verified from genesis against the root key and the epoch key the
// HANDOFF carried, never against anything the server said.
//
// AND AGAINST THE HANDOFF'S OWN HEAD ENTRY, which is the anti-truncation
// anchor and which an earlier version of this function ignored entirely. The M1
// review proved the consequence: a chain truncated one entry before a revoke
// verified cleanly, and the revoked device was still in the adopted set. The
// head entry is signed, so a server cannot forge one -- it can only serve a
// chain that stops short of it, and that is exactly what this catches.
func (h *Handoff) Adopt(chain []byte) (*EpochKeys, *Verified, error) {
	keys, err := DeriveEpoch(h.AKSeed, h.AccountID, h.Epoch)
	if err != nil {
		return nil, nil, err
	}

	// Epoch 1's signing key is what genesis was signed with. When the handoff
	// is for epoch 1, the key derived above IS that key; for a later epoch the
	// chain establishes the earlier ones as it is verified, and the root key
	// covers every transition.
	var epoch1 ed25519.PublicKey
	if h.Epoch == 1 {
		epoch1 = keys.Sign.Public().(ed25519.PublicKey)
	}

	// The head entry gives a pin, so the rollback check has something to
	// compare against even though this device has no history of its own.
	head, _, err := DecodeEntry(h.HeadEntry)
	if err != nil {
		return nil, nil, fmt.Errorf("handoff: its head entry does not decode: %w", err)
	}
	headHash, err := head.Hash()
	if err != nil {
		return nil, nil, err
	}

	v, err := VerifyChain(chain, h.AccountID, h.RootSignPub, epoch1,
		&Pin{Seq: head.Seq, Hash: headHash})
	if err != nil {
		return nil, nil, fmt.Errorf("handoff: the chain did not verify: %w", err)
	}

	// The chain must actually have reached the epoch the handoff is for. A
	// handoff for epoch 3 against a chain that ends in epoch 2 means the server
	// is serving a chain older than the key it also served, which is not a
	// state an honest one can be in.
	if v.Epoch != h.Epoch {
		return nil, nil, fmt.Errorf("handoff: it carries epoch %d but the chain ends in epoch %d",
			h.Epoch, v.Epoch)
	}

	// And the derived epoch key must be the one the chain names, so a handoff
	// carrying somebody else's AK is caught rather than adopted.
	if v.EpochSign != nil {
		derived := keys.Sign.Public().(ed25519.PublicKey)
		if !bytes.Equal(v.EpochSign, derived) {
			return nil, nil, errors.New("handoff: its epoch key is not the one the chain names")
		}
	}

	return keys, v, nil
}
