package protocol

import (
	"crypto/ecdh"
	"crypto/hpke"
	"crypto/subtle"
	"errors"
	"fmt"
)

// The escrow blob.
//
// It exists because AK_n IS RANDOM AND CANNOT BE DERIVED FROM THE MNEMONIC.
// Everything else the mnemonic needs, it can compute. Putting derivable
// material in escrow would hand the server a second chain to choose between, so
// the blob holds exactly what is not derivable, plus the two things that make
// serving an old copy detectable: the signed roster head and a monotonic
// counter.

const (
	domainEscrowPlaintext = "addy-escrow-v1"
	domainEscrowAAD       = "addy-escrow-aad-v1"
	domainEscrowObject    = "addy-escrow-obj-v1"

	infoEscrowHPKE   = "addy-escrow-hpke-v1"
	infoEscrowCommit = "addy-escrow-commit-v1"
)

// SuitePinned is the only cipher suite this version accepts. Any other value is
// refused rather than negotiated: a suite an attacker can choose is a
// downgrade waiting to happen.
const SuitePinned uint8 = 0x01

const commitLen = 32

// Escrow is what a recovering device needs and cannot compute.
type Escrow struct {
	AccountID AccountID
	Epoch     uint64
	Counter   uint64 // monotonic, +1 per write, starts at 1
	AKSeed    []byte // fixed[32], the epoch key's random bytes
	HeadEntry []byte // the roster head entry, body || sig, verbatim
}

// encodePlaintext is what gets sealed.
//
// HeadEntry is the WHOLE entry rather than just its hash, so a recovering
// device can verify the head's signature itself instead of taking the server's
// word for where the chain ends.
func (e Escrow) encodePlaintext() ([]byte, error) {
	if err := fixed("ak_seed", e.AKSeed, 32); err != nil {
		return nil, err
	}
	if len(e.HeadEntry) == 0 {
		return nil, errors.New("protocol: an escrow with no roster head entry")
	}
	if e.Counter == 0 {
		return nil, errors.New("protocol: escrow counters start at 1")
	}
	return NewEncoder(domainEscrowPlaintext).
		Fixed(e.AccountID[:]).
		U64(e.Epoch).
		U64(e.Counter).
		Fixed(e.AKSeed).
		Bytes(e.HeadEntry).
		Out(), nil
}

// The account id, epoch and counter appear in BOTH the AAD and the plaintext.
// That is deliberate: a mismatch between them means tampering rather than a
// convention somebody forgot.
func (e Escrow) aad() []byte {
	return NewEncoder(domainEscrowAAD).
		Fixed(e.AccountID[:]).
		U64(e.Epoch).
		U64(e.Counter).
		Out()
}

func escrowInfo(acct AccountID, epoch uint64) []byte {
	return info(infoEscrowHPKE, &acct, epoch)
}

func commitContext(acct AccountID, epoch, counter uint64) string {
	e := NewEncoder(infoEscrowCommit).
		Fixed(acct[:]).
		U64(epoch).
		U64(counter)
	return string(e.Out())
}

func suite() (hpke.KDF, hpke.AEAD) { return hpke.HKDFSHA256(), hpke.ChaCha20Poly1305() }

// SealEscrow seals to RK_enc's public half.
func SealEscrow(e Escrow, recipient *ecdh.PublicKey) ([]byte, error) {
	plaintext, err := e.encodePlaintext()
	if err != nil {
		return nil, err
	}

	pk, err := hpke.NewDHKEMPublicKey(recipient)
	if err != nil {
		return nil, fmt.Errorf("protocol: escrow recipient key: %w", err)
	}
	kdf, aead := suite()
	enc, sender, err := hpke.NewSender(pk, kdf, aead, escrowInfo(e.AccountID, e.Epoch))
	if err != nil {
		return nil, fmt.Errorf("protocol: escrow sender: %w", err)
	}

	ct, err := sender.Seal(e.aad(), plaintext)
	if err != nil {
		return nil, fmt.Errorf("protocol: sealing the escrow: %w", err)
	}

	// The commitment. See OpenEscrow for why it exists and why it is this one.
	commit, err := sender.Export(commitContext(e.AccountID, e.Epoch, e.Counter), commitLen)
	if err != nil {
		return nil, fmt.Errorf("protocol: escrow commitment: %w", err)
	}

	return NewEncoder(domainEscrowObject).
		U8(SuitePinned).
		Bytes(enc).
		Fixed(commit).
		Bytes(ct).
		Out(), nil
}

var (
	ErrEscrowSuite    = errors.New("escrow: unknown cipher suite")
	ErrEscrowCommit   = errors.New("escrow: the commitment does not match; this blob was not sealed for this key")
	ErrEscrowMismatch = errors.New("escrow: the sealed fields disagree with the authenticated ones")
	ErrEscrowRollback = errors.New("escrow: the counter is behind one this device has already seen")
)

// OpenEscrow opens a blob, in the order the specification makes normative.
//
// WHY A COMMITMENT, AND WHY THIS ONE. ChaCha20-Poly1305 is not key-committing: a
// ciphertext can be constructed that decrypts successfully under two different
// keys, to two different plaintexts. HPKE inherits that. It matters here more
// than anywhere else in the system, because recovery is a person typing twelve
// words off a printed card into a machine, against a server that chooses which
// blob to serve. A wrong key has to fail LOUDLY -- plausible garbage that parses
// as an AK_n would have the user re-seal the whole estate under a key an
// attacker chose.
//
// The commitment is the HPKE exporter, checked in constant time BEFORE the
// AEAD. The exporter secret derives from the KEM shared secret, the info string
// and the mode, so the tag commits to the recipient key, the account, the epoch
// and the counter in one value. An implementation that opens first and checks
// afterwards is non-conforming: the point is to fail before a chosen ciphertext
// produces any plaintext at all, not to notice once it has.
//
// counter is the one the object was stored under. It is T1 metadata the server
// already holds, so the caller has it -- and a server that LIES about it is
// caught by the commitment, because the counter is inside the exporter context.
// That is the check doing exactly what it is for.
//
// seenCounter is the highest counter this device has accepted for this account;
// zero if it has never seen one.
func OpenEscrow(object []byte, acct AccountID, epoch, counter uint64, recipient *ecdh.PrivateKey, seenCounter uint64) (*Escrow, error) {
	if counter == 0 {
		return nil, errors.New("escrow: counters start at 1")
	}

	// Step 1: decode, strictly, and refuse an unknown suite.
	d := NewDecoder(domainEscrowObject, object)
	gotSuite := d.U8()
	enc := d.Bytes()
	commit := d.Fixed(commitLen)
	ct := d.Bytes()
	if err := d.End(); err != nil {
		return nil, fmt.Errorf("escrow: %w", err)
	}
	if gotSuite != SuitePinned {
		return nil, fmt.Errorf("%w: %#02x", ErrEscrowSuite, gotSuite)
	}

	// Step 2: set up the receiving context.
	sk, err := hpke.NewDHKEMPrivateKey(recipient)
	if err != nil {
		return nil, fmt.Errorf("escrow: recipient key: %w", err)
	}
	kdf, aead := suite()
	r, err := hpke.NewRecipient(enc, sk, kdf, aead, escrowInfo(acct, epoch))
	if err != nil {
		return nil, fmt.Errorf("escrow: recipient context: %w", err)
	}

	// Step 3: the commitment, in constant time, BEFORE the AEAD.
	want, err := r.Export(commitContext(acct, epoch, counter), commitLen)
	if err != nil {
		return nil, fmt.Errorf("escrow: commitment: %w", err)
	}
	if subtle.ConstantTimeCompare(want, commit) != 1 {
		return nil, ErrEscrowCommit
	}

	// Step 4: only now open.
	plaintext, err := r.Open(Escrow{AccountID: acct, Epoch: epoch, Counter: counter}.aad(), ct)
	if err != nil {
		return nil, fmt.Errorf("escrow: opening: %w", err)
	}

	// Step 5: decode and cross-check against the authenticated fields.
	pd := NewDecoder(domainEscrowPlaintext, plaintext)
	var out Escrow
	copy(out.AccountID[:], pd.Fixed(AccountIDLen))
	out.Epoch = pd.U64()
	out.Counter = pd.U64()
	out.AKSeed = pd.Fixed(32)
	out.HeadEntry = pd.Bytes()
	if err := pd.End(); err != nil {
		return nil, fmt.Errorf("escrow: plaintext: %w", err)
	}
	if out.AccountID != acct || out.Epoch != epoch || out.Counter != counter {
		return nil, ErrEscrowMismatch
	}

	// Step 6: the counter must not go backwards. A lower one is the server
	// serving an old escrow.
	if out.Counter < seenCounter {
		return nil, fmt.Errorf("%w: %d < %d", ErrEscrowRollback, out.Counter, seenCounter)
	}

	// Step 7 -- verifying head_entry's signature and checking it against the
	// served chain -- is the caller's, because it needs the chain.
	return &out, nil
}
