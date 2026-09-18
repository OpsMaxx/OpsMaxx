// SPDX-License-Identifier: MIT
// Vendored from github.com/opsmaxx/addy internal/protocol/fingerprint_test.go @ fe66709
//
// Edit it THERE and copy it here. A fix made only in this copy is a
// protocol divergence with no symptom until an AEAD tag fails on somebody
// else's machine. See VENDORED.md in this directory.
package protocol

import (
	"bytes"
	"crypto/rand"
	"slices"
	"strings"
	"testing"
)

func TestTheWordlistIsIntact(t *testing.T) {
	if len(effWords) != effSize {
		t.Fatalf("the wordlist has %d entries, want %d", len(effWords), effSize)
	}
	// Both ends, so a truncation or a reversal is caught.
	if effWords[0] != "abacus" {
		t.Errorf("first word is %q, want abacus", effWords[0])
	}
	if effWords[effSize-1] != "zoom" {
		t.Errorf("last word is %q, want zoom", effWords[effSize-1])
	}
	seen := make(map[string]bool, effSize)
	for i, w := range effWords {
		if seen[w] {
			t.Errorf("duplicate entry %q at %d", w, i)
		}
		seen[w] = true
		if w != strings.ToLower(w) || strings.ContainsAny(w, " \t") {
			t.Errorf("entry %d is not a bare lowercase word: %q", i, w)
		}
	}
}

// The property the whole thing rests on: the same head produces the same five
// words, every time, on every machine. A phrase that differs between the two
// windows being compared is worse than no phrase at all.
func TestTheSameHeadAlwaysProducesTheSamePhrase(t *testing.T) {
	head := bytes.Repeat([]byte{0xa1}, 32)
	var acct AccountID
	acct[0] = 9

	first, err := Fingerprint(head, acct)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != fingerprintWords {
		t.Fatalf("got %d words, want %d", len(first), fingerprintWords)
	}
	for i := 0; i < 20; i++ {
		again, err := Fingerprint(head, acct)
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(first, again) {
			t.Fatalf("the same head produced %v then %v", first, again)
		}
	}
	t.Logf("head %x -> %s", head[:4], strings.Join(first, " "))
}

// A fork is a different head, and a different head must be a visibly different
// phrase. If it were not, the anti-fork check would be decorative.
func TestADifferentHeadProducesADifferentPhrase(t *testing.T) {
	var acct AccountID
	a := bytes.Repeat([]byte{0x00}, 32)
	b := bytes.Clone(a)
	b[31] ^= 0x01 // one bit

	pa, err := Fingerprint(a, acct)
	if err != nil {
		t.Fatal(err)
	}
	pb, err := Fingerprint(b, acct)
	if err != nil {
		t.Fatal(err)
	}
	if slices.Equal(pa, pb) {
		t.Fatalf("a one-bit change to the head left the phrase unchanged: %v", pa)
	}
}

// Two accounts that somehow shared a head must not share a phrase.
func TestTheAccountIsMixedIn(t *testing.T) {
	head := bytes.Repeat([]byte{0x5a}, 32)
	var a, b AccountID
	a[0], b[0] = 1, 2

	pa, err := Fingerprint(head, a)
	if err != nil {
		t.Fatal(err)
	}
	pb, err := Fingerprint(head, b)
	if err != nil {
		t.Fatal(err)
	}
	if slices.Equal(pa, pb) {
		t.Error("two accounts with the same head produced the same phrase")
	}
}

// The whole word space must be reachable, or the effective entropy is lower
// than the 7,776-word list implies.
func TestTheWholeWordlistIsReachable(t *testing.T) {
	var acct AccountID
	seen := make(map[string]bool)
	for i := 0; i < 40000; i++ {
		head := make([]byte, 32)
		if _, err := rand.Read(head); err != nil {
			t.Fatal(err)
		}
		words, err := Fingerprint(head, acct)
		if err != nil {
			t.Fatal(err)
		}
		for _, w := range words {
			seen[w] = true
		}
	}
	// 200,000 draws over 7,776 words: a coupon-collector bound puts full
	// coverage far inside that, so anything materially short of it means the
	// index derivation is masking part of the list away.
	if len(seen) < effSize*99/100 {
		t.Errorf("only %d of %d words are reachable", len(seen), effSize)
	}
}

func TestAnEmptyHeadIsRefused(t *testing.T) {
	var acct AccountID
	if _, err := Fingerprint(nil, acct); err == nil {
		t.Error("Fingerprint accepted an empty head")
	}
}

// What goes on screen and on the printed card.
func TestTheStringFormIsFiveSpacedWords(t *testing.T) {
	var acct AccountID
	s, err := FingerprintString(bytes.Repeat([]byte{7}, 32), acct)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Fields(s); len(got) != fingerprintWords {
		t.Errorf("FingerprintString = %q, want %d words", s, fingerprintWords)
	}
}
