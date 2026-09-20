// SPDX-License-Identifier: MIT
// Vendored from github.com/opsmaxx/addy internal/protocol/keys.go @ fe66709
//
// Edit it THERE and copy it here. A fix made only in this copy is a
// protocol divergence with no symptom until an AEAD tag fails on somebody
// else's machine. See VENDORED.md in this directory.
package protocol

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
)

// The key hierarchy, as docs/PROTOCOL.md section 3 pins it.
//
// The shape that matters, and the reason the epoch exists at all: the mnemonic
// derives a ROOT key that authorises epoch changes and nothing else, while what
// devices actually hold is a random, ROTATABLE epoch key. An earlier draft of
// the design sealed one account key to every device, which made revocation
// non-cryptographic -- a revoked laptop still held the signing key, so it could
// author a valid roster entry re-admitting itself, and every honest client
// would verify the signature and accept it.

// SaltGenesis is the HKDF salt for every derivation in this document.
//
// One fixed value, deliberately. HKDF's salt is a domain separator rather than
// a secret, so a per-account one would add nothing and create a second thing
// for two implementations to disagree about.
var SaltGenesis = []byte("addy-genesis-v1")

// The info labels. Each is the ASCII label followed by a single 0x00, and --
// for everything below the root -- the account id and the epoch.
const (
	labelRootSign  = "addy-root-sign-v1"
	labelRootEnc   = "addy-root-enc-v1"
	labelEpochSign = "addy-epoch-sign-v1"
	labelEpochEnc  = "addy-epoch-enc-v1"
	labelProfile   = "addy-profile-v1"
	labelAccountID = "addy-account-id-v1"
)

// AccountIDLen is 16 bytes, shown as 32 lowercase hex. It is a name, not a
// capability: the server holds it, it appears in every object path, and the
// threat model already concedes the server knows which account is which.
const AccountIDLen = 16

// AccountID names an account. It is a function of the ROOT key alone, so it
// survives every epoch -- an epoch transition changes the epoch and nothing
// else, and a changing account id would invalidate every object name.
type AccountID [AccountIDLen]byte

func (a AccountID) String() string { return hex.EncodeToString(a[:]) }

// RootKeys are what the recovery phrase reconstructs. They authorise epoch
// changes and open the escrow blob. A device never holds them.
type RootKeys struct {
	Sign      ed25519.PrivateKey
	SignSeed  []byte
	Enc       *ecdh.PrivateKey
	AccountID AccountID
}

// EpochKeys are what devices hold. AK_n itself is random rather than derived,
// which is what makes it rotatable: a new epoch is a fresh draw, not a
// different path through the same hierarchy.
type EpochKeys struct {
	Epoch    uint64
	AK       []byte // the 32 random bytes everything below is derived from
	Sign     ed25519.PrivateKey
	SignSeed []byte
	Enc      *ecdh.PrivateKey
	Profile  []byte // K_profile_n, which seals every T0 collection in this epoch
}

// info builds an HKDF info string: the label, a NUL, and -- below the root --
// the account id and the epoch.
func info(label string, acct *AccountID, epoch uint64) []byte {
	out := make([]byte, 0, len(label)+1+AccountIDLen+8)
	out = append(out, label...)
	out = append(out, 0x00)
	if acct != nil {
		out = append(out, acct[:]...)
		out = binary.BigEndian.AppendUint64(out, epoch)
	}
	return out
}

func derive32(ikm []byte, info []byte) ([]byte, error) {
	out, err := hkdf.Key(sha256.New, ikm, SaltGenesis, string(info), 32)
	if err != nil {
		return nil, fmt.Errorf("protocol: deriving a key: %w", err)
	}
	return out, nil
}

// DeriveRoot builds the root keys from a BIP39 seed.
//
// The root labels carry no account id, and that is deliberate rather than an
// oversight: the account id is derived FROM the root signing key's public half,
// so mixing it into that key's own derivation would be circular.
func DeriveRoot(bip39Seed []byte) (*RootKeys, error) {
	if len(bip39Seed) == 0 {
		return nil, fmt.Errorf("protocol: deriving root keys from an empty seed")
	}

	signSeed, err := derive32(bip39Seed, info(labelRootSign, nil, 0))
	if err != nil {
		return nil, err
	}
	encScalar, err := derive32(bip39Seed, info(labelRootEnc, nil, 0))
	if err != nil {
		return nil, err
	}

	enc, err := ecdh.X25519().NewPrivateKey(encScalar)
	if err != nil {
		return nil, fmt.Errorf("protocol: root X25519 key: %w", err)
	}

	sign := ed25519.NewKeyFromSeed(signSeed)
	return &RootKeys{
		Sign:      sign,
		SignSeed:  signSeed,
		Enc:       enc,
		AccountID: DeriveAccountID(sign.Public().(ed25519.PublicKey)),
	}, nil
}

// DeriveAccountID is SHA-256("addy-account-id-v1\0" || RK_sign.pub) truncated
// to 16 bytes.
func DeriveAccountID(rootSignPub ed25519.PublicKey) AccountID {
	h := sha256.New()
	h.Write([]byte(labelAccountID))
	h.Write([]byte{0x00})
	h.Write(rootSignPub)
	var id AccountID
	copy(id[:], h.Sum(nil))
	return id
}

// NewEpochKey draws a fresh AK_n. Epochs start at 1, so a zeroed or absent
// field can never be mistaken for a legitimate epoch.
func NewEpochKey(acct AccountID, epoch uint64) (*EpochKeys, error) {
	if epoch == 0 {
		return nil, fmt.Errorf("protocol: epoch 0 is not a valid epoch")
	}
	ak := make([]byte, 32)
	if _, err := rand.Read(ak); err != nil {
		return nil, fmt.Errorf("protocol: drawing an epoch key: %w", err)
	}
	return DeriveEpoch(ak, acct, epoch)
}

// DeriveEpoch expands a given AK_n. Separate from NewEpochKey because recovery
// and pairing both arrive with an AK they did not draw.
func DeriveEpoch(ak []byte, acct AccountID, epoch uint64) (*EpochKeys, error) {
	if epoch == 0 {
		return nil, fmt.Errorf("protocol: epoch 0 is not a valid epoch")
	}
	if len(ak) != 32 {
		return nil, fmt.Errorf("protocol: an epoch key is 32 bytes, got %d", len(ak))
	}

	signSeed, err := derive32(ak, info(labelEpochSign, &acct, epoch))
	if err != nil {
		return nil, err
	}
	encScalar, err := derive32(ak, info(labelEpochEnc, &acct, epoch))
	if err != nil {
		return nil, err
	}
	profile, err := derive32(ak, info(labelProfile, &acct, epoch))
	if err != nil {
		return nil, err
	}

	enc, err := ecdh.X25519().NewPrivateKey(encScalar)
	if err != nil {
		return nil, fmt.Errorf("protocol: epoch X25519 key: %w", err)
	}

	return &EpochKeys{
		Epoch: epoch,
		// COPIED, not aliased. A caller that hands in a decoded buffer and
		// then wipes it -- which is the right thing for a caller to do with
		// key material it no longer needs -- would otherwise zero the AK
		// inside this struct along with it. The symptom is silent and
		// delayed: every derived key is already computed and correct, so the
		// keys keep working, and only the operations that use AK ITSELF as a
		// binding fail -- an epoch handoff that cannot be opened by the device
		// it was sealed for, long after the load that broke it.
		AK:       append([]byte(nil), ak...),
		Sign:     ed25519.NewKeyFromSeed(signSeed),
		SignSeed: signSeed,
		Enc:      enc,
		Profile:  profile,
	}, nil
}

// DeviceKeys are generated on the device and never transmitted.
//
// TWO INDEPENDENT DRAWS, and not derived from anything. A device key derivable
// from the account key would make every device's identity recoverable by anyone
// holding the mnemonic, which is the opposite of the pseudonym property the
// design commits to. Nothing host-derived enters either draw, so a device wiped
// and re-paired is a new device to everyone.
type DeviceKeys struct {
	Sign     ed25519.PrivateKey
	SignSeed []byte
	Enc      *ecdh.PrivateKey
}

// NewDeviceKeys mints a device identity.
func NewDeviceKeys() (*DeviceKeys, error) {
	signSeed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(signSeed); err != nil {
		return nil, fmt.Errorf("protocol: drawing a device signing key: %w", err)
	}
	// A SECOND, INDEPENDENT draw. Not the same bytes, and not converted from
	// the signing key: birational maps between Ed25519 and X25519 exist and are
	// exactly the shortcut this forbids. Keys that share bytes make every
	// cross-protocol attack on the pair live in a system that otherwise has
	// none.
	enc, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("protocol: drawing a device encryption key: %w", err)
	}
	return &DeviceKeys{
		Sign:     ed25519.NewKeyFromSeed(signSeed),
		SignSeed: signSeed,
		Enc:      enc,
	}, nil
}

// x25519Public turns 32 raw bytes into an X25519 public key, validating them.
func x25519Public(b []byte) (*ecdh.PublicKey, error) {
	return ecdh.X25519().NewPublicKey(b)
}
