// SPDX-License-Identifier: MIT
// Vendored from github.com/opsmaxx/addy internal/protocol/mnemonic.go @ fe66709
//
// Edit it THERE and copy it here. A fix made only in this copy is a
// protocol divergence with no symptom until an AEAD tag fails on somebody
// else's machine. See VENDORED.md in this directory.
package protocol

import (
	"fmt"

	bip39 "github.com/blinklabs-io/go-bip39"
)

// The recovery phrase, as the key hierarchy needs it.
//
// internal/recovery owns the human-facing half -- per-word validation,
// autocomplete, the error messages someone holding a printed card can act on.
// This is the two lines the key derivation needs, kept here so `protocol` does
// not import a package that exists to talk to a person.

const (
	entropyBits  = 128
	noPassphrase = ""
)

func newMnemonic() (string, error) {
	entropy, err := bip39.NewEntropy(entropyBits)
	if err != nil {
		return "", fmt.Errorf("protocol: generating entropy: %w", err)
	}
	m, err := bip39.NewMnemonic(entropy)
	if err != nil {
		return "", fmt.Errorf("protocol: generating a phrase: %w", err)
	}
	return m, nil
}

// RootFromMnemonic is recovery's one entry point into the key hierarchy.
//
// Exported where `mnemonicSeed` is not, and the difference is deliberate: a
// caller outside this package has no business holding the BIP39 seed. The seed
// derives RK_sign AND RK_enc, so handing it out would hand out the ability to
// authorise an epoch change and to open the escrow, which is the whole estate.
// A recovering device needs the keys; it never needs the material they came
// from.
func RootFromMnemonic(mnemonic string) (*RootKeys, error) {
	seed, err := mnemonicSeed(mnemonic)
	if err != nil {
		return nil, err
	}
	return DeriveRoot(seed)
}

func mnemonicSeed(mnemonic string) ([]byte, error) {
	if !bip39.IsMnemonicValid(mnemonic) {
		return nil, fmt.Errorf("protocol: that is not a valid recovery phrase")
	}
	return bip39.NewSeed(mnemonic, noPassphrase), nil
}
