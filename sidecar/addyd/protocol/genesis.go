// SPDX-License-Identifier: MIT
// Vendored from github.com/opsmaxx/addy internal/protocol/genesis.go @ fe66709
//
// Edit it THERE and copy it here. A fix made only in this copy is a
// protocol divergence with no symptom until an AEAD tag fails on somebody
// else's machine. See VENDORED.md in this directory.
package protocol

import (
	"crypto/ed25519"
)

// Genesis: how the first device and the account come to exist.
//
// IDENTITY IS CLIENT-ASSERTED. The server validates nothing about who you are;
// it stores a public key it has never seen and cannot vouch for. That is the
// point. An admin does not create an identity -- an admin issues an invite token
// that grants a quota slot, and the token is spent by an account the user minted
// themselves. A stolen invite costs the admin disk space, not a user's data,
// because the thief cannot author entries into anyone else's roster.

// Account is everything a first device holds after genesis.
type Account struct {
	Mnemonic string
	Root     *RootKeys
	Epoch    *EpochKeys
	Device   *DeviceKeys
	Genesis  Entry
	Escrow   []byte // sealed to RK_enc
	Head     []byte // H(genesis entry)
}

// SealLabel is how a device's pseudonym is sealed into a roster entry.
//
// pub_sign is in the AAD, which binds the label to the device it names: two
// labels cannot be swapped between two entries by an attacker who cannot
// decrypt either.
func SealLabel(label string, acct AccountID, epoch uint64, pubSign, kProfile []byte) ([]byte, error) {
	aad := NewEncoder("addy-label-aad-v1").
		Fixed(acct[:]).
		U64(epoch).
		Fixed(pubSign).
		Out()
	return sealXChaCha(kProfile, []byte(label), aad)
}

// OpenLabel reverses SealLabel.
//
// A device that is mid-pairing does not yet hold K_profile_n and cannot call
// this. That case falls back to displaying the pub_sign fingerprint, and it is
// the one place a roster notification names a key rather than a device.
func OpenLabel(ct []byte, acct AccountID, epoch uint64, pubSign, kProfile []byte) (string, error) {
	aad := NewEncoder("addy-label-aad-v1").
		Fixed(acct[:]).
		U64(epoch).
		Fixed(pubSign).
		Out()
	pt, err := openXChaCha(kProfile, ct, aad)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}

// NewAccount performs the genesis ceremony, entirely offline.
//
// Nothing here touches the network. The server is told afterwards, and it is
// told a public key and a signed entry it cannot forge -- which is why there is
// no password reset, no email verification and no account recovery in this
// system. There is no account in the usual sense; there is a signing key the
// server was handed once.
func NewAccount(label string) (*Account, error) {
	// 1-2. The phrase, then the root keys.
	mnemonic, err := newMnemonic()
	if err != nil {
		return nil, err
	}
	seed, err := mnemonicSeed(mnemonic)
	if err != nil {
		return nil, err
	}
	root, err := DeriveRoot(seed)
	if err != nil {
		return nil, err
	}

	// 3-4. The account id comes from the root key; epoch 1 is a fresh draw.
	epoch, err := NewEpochKey(root.AccountID, 1)
	if err != nil {
		return nil, err
	}

	// 5. This device's own keys, two independent draws.
	dev, err := NewDeviceKeys()
	if err != nil {
		return nil, err
	}

	// 6. The genesis entry: seq 0, epoch 1, prev_hash all zeroes, signed by
	// AK_1.sign.
	pubSign := dev.Sign.Public().(ed25519.PublicKey)
	pubEnc := dev.Enc.PublicKey().Bytes()

	labelCT, err := SealLabel(label, root.AccountID, 1, pubSign, epoch.Profile)
	if err != nil {
		return nil, err
	}
	nonce, err := Nonce()
	if err != nil {
		return nil, err
	}

	g := Entry{
		AccountID: root.AccountID,
		Epoch:     1,
		Seq:       0,
		PrevHash:  make([]byte, 32),
		Op:        OpAdd,
		Signer:    SignerAK,
		Nonce:     nonce,
		PubSign:   pubSign,
		PubEnc:    pubEnc,
		LabelCT:   labelCT,
		TS:        nowMillis(),
	}
	body, err := g.Encode()
	if err != nil {
		return nil, err
	}
	g.Sig = ed25519.Sign(epoch.Sign, body)

	wire, err := g.Wire()
	if err != nil {
		return nil, err
	}
	head, err := g.Hash()
	if err != nil {
		return nil, err
	}

	// 7. The escrow, at counter 1, carrying the genesis entry as the head.
	escrow, err := SealEscrow(Escrow{
		AccountID: root.AccountID,
		Epoch:     1,
		Counter:   1,
		AKSeed:    epoch.AK,
		HeadEntry: wire,
	}, root.Enc.PublicKey())
	if err != nil {
		return nil, err
	}

	// 8. The printed card is the caller's: it needs a print dialog, and it is a
	// PRINTABLE CARD RATHER THAN A FILE. A .txt in ~/Downloads holding the keys
	// to the estate is the product committing its own worst ick on day one.
	//
	// 9. Registering with the server is also the caller's, and happens last.
	return &Account{
		Mnemonic: mnemonic,
		Root:     root,
		Epoch:    epoch,
		Device:   dev,
		Genesis:  g,
		Escrow:   escrow,
		Head:     head,
	}, nil
}

// Chain is the serialised roster as it stands after genesis.
func (a *Account) Chain() ([]byte, error) {
	return a.Genesis.Wire()
}

// Verify re-verifies this account's own chain, as a client would.
//
// Not ceremony: the genesis ceremony and the verifier are two different pieces
// of code, and an account whose own first entry does not verify is one that
// would fail on the second device rather than the first. Checking at the moment
// of creation is where that is cheapest to notice.
func (a *Account) Verify() (*Verified, error) {
	chain, err := a.Chain()
	if err != nil {
		return nil, err
	}
	return VerifyChain(chain, a.Root.AccountID,
		a.Root.Sign.Public().(ed25519.PublicKey),
		a.Epoch.Sign.Public().(ed25519.PublicKey), nil)
}

func nowMillis() uint64 { return uint64(timeNow().UnixMilli()) }
