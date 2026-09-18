// SPDX-License-Identifier: MIT
// Vendored from github.com/opsmaxx/addy internal/protocol/fingerprint.go @ fe66709
//
// Edit it THERE and copy it here. A fix made only in this copy is a
// protocol divergence with no symptom until an AEAD tag fails on somebody
// else's machine. See VENDORED.md in this directory.
package protocol

import (
	"crypto/hkdf"
	"crypto/sha256"
	_ "embed"
	"encoding/binary"
	"fmt"
	"strings"
)

// The roster head, as five words a human can compare.
//
// HEX IS NOT COMPARED BY PEOPLE. They check the first four characters and the
// last four, which is most of the way to not checking at all -- and this is the
// check the entire anti-fork control rests on, performed between two OpsMaxx
// windows by somebody who is probably already worried.
//
// It is compared BETWEEN TWO OPSMAXX WINDOWS, never read from the portal and
// never from `addy status`. Both are software a compromised instance controls,
// and an integrity check reported by the thing being checked is not a check.

//go:embed wordlists/eff_large.txt
var effRaw string

var effWords = splitEFF(effRaw)

func splitEFF(s string) []string {
	var out []string
	for _, l := range strings.Split(s, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			out = append(out, l)
		}
	}
	return out
}

const (
	fingerprintInfo  = "addy-fingerprint-v1"
	fingerprintWords = 5
	effSize          = 7776
)

// Fingerprint renders a roster head as five words.
//
// The derivation is ours. Bitwarden documents that its fingerprint phrase is
// five EFF words and deliberately does not publish the function that selects
// them, so there is nothing to copy and no reason to try.
//
// mod 7776 on a 16-bit value has a bias under 2^-9 per word. That does not
// matter and the specification says why: this is a DISPLAY ENCODING for human
// comparison, not a key. Rejection sampling here would add a branch to
// something whose only job is to be the same on two screens.
func Fingerprint(head []byte, acct AccountID) ([]string, error) {
	if len(head) == 0 {
		return nil, fmt.Errorf("protocol: fingerprinting an empty roster head")
	}
	if len(effWords) != effSize {
		return nil, fmt.Errorf("protocol: the EFF wordlist has %d entries, not %d", len(effWords), effSize)
	}

	// The account id, and NO epoch. Built explicitly rather than by truncating
	// the general info builder: a slice expression that happens to cut in the
	// right place is a thing that stops cutting in the right place the moment
	// anything else changes.
	//
	// No epoch, because the fingerprint names a chain head and a head is a head
	// regardless of which epoch the chain has reached. Mixing the epoch in would
	// change the phrase on every rotation without the head having changed.
	label := make([]byte, 0, len(fingerprintInfo)+1+AccountIDLen)
	label = append(label, fingerprintInfo...)
	label = append(label, 0x00)
	label = append(label, acct[:]...)

	okm, err := hkdf.Key(sha256.New, head, SaltGenesis, string(label), fingerprintWords*2)
	if err != nil {
		return nil, fmt.Errorf("protocol: deriving a fingerprint: %w", err)
	}

	words := make([]string, fingerprintWords)
	for j := 0; j < fingerprintWords; j++ {
		idx := binary.BigEndian.Uint16(okm[2*j:2*j+2]) % effSize
		words[j] = effWords[idx]
	}
	return words, nil
}

// FingerprintString is what goes on screen and on the printed card.
func FingerprintString(head []byte, acct AccountID) (string, error) {
	words, err := Fingerprint(head, acct)
	if err != nil {
		return "", err
	}
	return strings.Join(words, " "), nil
}
