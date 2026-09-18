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

func mnemonicSeed(mnemonic string) ([]byte, error) {
	if !bip39.IsMnemonicValid(mnemonic) {
		return nil, fmt.Errorf("protocol: that is not a valid recovery phrase")
	}
	return bip39.NewSeed(mnemonic, noPassphrase), nil
}
