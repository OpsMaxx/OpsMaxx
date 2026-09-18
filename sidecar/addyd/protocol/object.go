package protocol

import (
	"crypto/rand"
	"errors"
	"fmt"

	"golang.org/x/crypto/chacha20poly1305"
)

// Sealed collection objects: every T0 collection is one object, sealed to
// K_profile_n.

const (
	domainCollPlaintext = "addy-coll-v1"
	domainObjAAD        = "addy-obj-aad-v1"
	domainObject        = "addy-obj-v1"

	// SuiteXChaCha is the only symmetric suite this version accepts.
	SuiteXChaCha uint8 = 0x01
)

// XChaCha20-Poly1305, NOT ChaCha20-Poly1305, for anything addy nonces itself.
//
// A 12-byte nonce needs a per-key counter, and two devices writing the same
// collection under the same K_profile_n cannot coordinate one -- there is no
// moment at which they agree on whose turn it is. A 24-byte random nonce needs
// no coordination and no state, and the collision probability over any realistic
// number of writes is not a number worth writing down.
const nonceLen = chacha20poly1305.NonceSizeX

// Collection is one T0 document before it is sealed.
type Collection struct {
	Name          string // "servers", "vault", ...
	Schema        uint32
	WriterVersion string
	Counter       uint64 // monotonic per collection, +1 per write
	Payload       []byte
}

// encodePlaintext is what gets sealed.
//
// Schema, writer version and counter are INSIDE the ciphertext. The first two
// because the server must not be able to read or forge them; the counter for
// the same reason and one more: it is the anti-rollback control, and an attacker
// who could edit it would have no control left to defeat.
func (c Collection) encodePlaintext() ([]byte, error) {
	if c.Counter == 0 {
		return nil, errors.New("protocol: collection counters start at 1")
	}
	return NewEncoder(domainCollPlaintext).
		U32(c.Schema).
		Str(c.WriterVersion).
		U64(c.Counter).
		Bytes(c.Payload).
		Out(), nil
}

// objectAAD binds an object to its account, epoch and collection name.
//
// The COLLECTION NAME stops the server answering a request for `servers` with
// the `vault` ciphertext. The EPOCH stops it answering with last epoch's. Both
// are attacks a server can mount with no key at all, by simply handing back a
// different file.
func objectAAD(acct AccountID, epoch uint64, collection string) []byte {
	return NewEncoder(domainObjAAD).
		Fixed(acct[:]).
		U64(epoch).
		Str(collection).
		Out()
}

// SealCollection seals a collection under K_profile_n.
func SealCollection(c Collection, acct AccountID, epoch uint64, kProfile []byte) ([]byte, error) {
	if c.Name == "" {
		return nil, errors.New("protocol: sealing a collection with no name")
	}
	plaintext, err := c.encodePlaintext()
	if err != nil {
		return nil, err
	}

	aead, err := chacha20poly1305.NewX(kProfile)
	if err != nil {
		return nil, fmt.Errorf("protocol: profile key: %w", err)
	}
	nonce := make([]byte, nonceLen)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("protocol: drawing a nonce: %w", err)
	}

	ct := aead.Seal(nil, nonce, plaintext, objectAAD(acct, epoch, c.Name))
	return NewEncoder(domainObject).
		U8(SuiteXChaCha).
		Fixed(nonce).
		Bytes(ct).
		Out(), nil
}

var (
	ErrObjectSuite    = errors.New("object: unknown cipher suite")
	ErrObjectRollback = errors.New("object: the counter is behind one this device has already seen")
	// ErrSchemaTooNew is the read-only case, and it is a feature rather than a
	// failure. See OpenCollection.
	ErrSchemaTooNew = errors.New("object: written by a newer OpsMaxx than this one understands")
)

// OpenCollection opens an object.
//
// knownSchema is the highest schema this build understands, and seenCounter is
// the highest counter this device has accepted for this collection.
func OpenCollection(object []byte, name string, acct AccountID, epoch uint64, kProfile []byte, knownSchema uint32, seenCounter uint64) (*Collection, error) {
	d := NewDecoder(domainObject, object)
	gotSuite := d.U8()
	nonce := d.Fixed(nonceLen)
	ct := d.Bytes()
	if err := d.End(); err != nil {
		return nil, fmt.Errorf("object: %w", err)
	}
	if gotSuite != SuiteXChaCha {
		return nil, fmt.Errorf("%w: %#02x", ErrObjectSuite, gotSuite)
	}

	aead, err := chacha20poly1305.NewX(kProfile)
	if err != nil {
		return nil, fmt.Errorf("object: profile key: %w", err)
	}
	plaintext, err := aead.Open(nil, nonce, ct, objectAAD(acct, epoch, name))
	if err != nil {
		return nil, fmt.Errorf("object: opening %s: %w", name, err)
	}

	pd := NewDecoder(domainCollPlaintext, plaintext)
	c := Collection{Name: name}
	c.Schema = pd.U32()
	c.WriterVersion = pd.Str()
	c.Counter = pd.U64()
	c.Payload = pd.Bytes()
	if err := pd.End(); err != nil {
		return nil, fmt.Errorf("object: %s plaintext: %w", name, err)
	}

	// The anti-rollback control. A malicious server could otherwise serve last
	// month's `vault` or `servers` and nothing would notice: it is validly
	// sealed, validly signed, and simply old.
	if c.Counter < seenCounter {
		return nil, fmt.Errorf("%w: %s is at %d, this device has seen %d",
			ErrObjectRollback, name, c.Counter, seenCounter)
	}

	// READ-ONLY RATHER THAN DEGRADED. Two paired machines will sit on different
	// OpsMaxx versions more or less permanently. Without this, v0.50 writes
	// `servers` with a new per-record field, v0.43 reads it, drops the unknown
	// field on its typed round-trip, edits one unrelated server and writes the
	// whole document back -- and the field is now gone on both machines, with no
	// error and no symptom. So an older client refuses to WRITE rather than
	// silently losing what it cannot represent.
	if c.Schema > knownSchema {
		return &c, fmt.Errorf("%w: %s is schema %d, this build knows %d",
			ErrSchemaTooNew, name, c.Schema, knownSchema)
	}
	return &c, nil
}
