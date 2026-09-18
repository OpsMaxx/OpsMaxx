// SPDX-License-Identifier: MIT
// Vendored from github.com/opsmaxx/addy internal/pair/sas.go @ fe66709
//
// Edit it THERE and copy it here. A fix made only in this copy is a
// protocol divergence with no symptom until an AEAD tag fails on somebody
// else's machine. See VENDORED.md in this directory.
// Package pair implements addy's device pairing: the PAKE, its key
// confirmation, and the short authentication string a human compares.
package pair

import (
	"crypto/sha256"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"golang.org/x/crypto/hkdf"
)

//go:embed vendor/sas-emoji.json
var emojiRaw []byte

type emojiEntry struct {
	Number      int    `json:"number"`
	Emoji       string `json:"emoji"`
	Description string `json:"description"`
	Unicode     string `json:"unicode"`
}

var emojiTable = loadEmoji()

func loadEmoji() []emojiEntry {
	var doc struct {
		Emoji []emojiEntry `json:"emoji"`
	}
	if err := json.Unmarshal(emojiRaw, &doc); err != nil {
		// A build that cannot parse its own embedded table would otherwise
		// produce a pairing flow that fails at the moment a human is watching.
		panic("pair: the vendored SAS emoji table does not parse: " + err.Error())
	}
	return doc.Emoji
}

// sasInfo is the ASCII half of the HKDF info label; the full label also carries
// the pairing id and both devices' signing keys. See DeriveSAS.
//
// OURS, NOT MATRIX'S. The ENCODING is copied from Matrix -- six bytes, the
// first forty-two bits, seven groups of six -- because a homegrown SAS encoding
// is a bug waiting to bias the output, and theirs has been looked at by people
// whose job that is. The LABEL is ours because addy ships its own clients and
// needs wire compatibility with Matrix nowhere, and sharing a domain-separation
// string with an unrelated protocol is how a transcript from one ends up
// meaning something in the other.
const sasInfo = "addy-sas-v1"

// SAS is what the two humans compare.
type SAS struct {
	Indices     [7]int
	Emoji       [7]string
	Description [7]string
}

func (s SAS) String() string { return strings.Join(s.Emoji[:], " ") }

// Words renders the SAS as its descriptions, for reading aloud down a phone and
// for anyone whose terminal or screen reader does not render the emoji.
//
// Comma-separated, not space-separated: several descriptions are two words
// ("Thumbs Up", "Light Bulb"), so spaces leave the reader unable to tell where
// one symbol ends and the next begins -- which, for a check whose entire job is
// two people agreeing on a sequence, is the whole failure.
func (s SAS) Words() string { return strings.Join(s.Description[:], ", ") }

// DeriveSAS turns a completed PAKE's shared secret into seven emoji.
//
// WHAT THE SEVEN EMOJI ARE FOR, relabelled after review, because the labelling
// decides what the adversary test is testing:
//
//	SPAKE2 is the defence against a relay in the middle. The emoji are a
//	TRIPWIRE. A completed PAKE cannot produce mismatched SAS -- Matrix's
//	construction exists for unauthenticated Diffie-Hellman, which this is not.
//	Both stay, because the emoji catch an implementation error or a downgrade
//	that the PAKE alone would not surface, and that is a real thing to catch.
//
// So the case worth testing is "an injected transcript fault produces
// mismatched SAS, and the abort happens BEFORE the account key is sealed" --
// which is testable. "A PAKE peer that fails SAS" was not.
//
// Seven emoji from a 64-entry table is 42 bits, which is the number that
// matters: an attacker who has to produce a matching SAS is guessing one in
// four trillion, and they get one guess because the PAKE burns the code.
func DeriveSAS(sharedSecret, pairingID, initiatorPubSign, joinerPubSign []byte) (SAS, error) {
	if len(sharedSecret) == 0 {
		return SAS{}, fmt.Errorf("pair: deriving a SAS from an empty secret")
	}
	if len(pairingID) == 0 || len(initiatorPubSign) == 0 || len(joinerPubSign) == 0 {
		// The identity keys are in the label so the emoji bind the PAKE result
		// to the two keys the devices are about to trust. Without that binding
		// the PAKE proves a shared password and nothing about who holds it,
		// and the emoji would be confirming a fact nobody needed.
		return SAS{}, fmt.Errorf("pair: a SAS must bind the pairing id and both signing keys")
	}
	if len(emojiTable) != 64 {
		return SAS{}, fmt.Errorf("pair: the emoji table has %d entries, not 64", len(emojiTable))
	}

	// No salt, deliberately, and this follows Matrix rather than improvising.
	// The shared secret is already high-entropy and unique to this exchange, so
	// a salt adds nothing; and a salt that the two sides derive differently is
	// a mismatch a user reads as an attack.
	var out [6]byte
	if _, err := io.ReadFull(hkdf.New(sha256.New, sharedSecret, nil,
		sasLabel(pairingID, initiatorPubSign, joinerPubSign)), out[:]); err != nil {
		return SAS{}, fmt.Errorf("pair: deriving the SAS: %w", err)
	}

	// Six bytes is 48 bits; only the FIRST 42 are used, in seven groups of six,
	// most significant first. The trailing six bits are discarded rather than
	// folded in, because that is what Matrix does and because folding them
	// would make two implementations that both look right disagree.
	//
	// The >>6 is the part that is easy to get wrong and was got wrong here
	// first: applying the 42-bit shift schedule to the un-shifted 48-bit value
	// reads bits 0-41 instead of the first 42, which is a different SAS that
	// still looks plausible. A test that recomputes the extraction a second way
	// is what caught it.
	bits := uint64(out[0])<<40 | uint64(out[1])<<32 | uint64(out[2])<<24 |
		uint64(out[3])<<16 | uint64(out[4])<<8 | uint64(out[5])
	bits >>= 6

	var s SAS
	for i := 0; i < 7; i++ {
		shift := uint(42 - 6*(i+1))
		idx := int((bits >> shift) & 0x3f)
		s.Indices[i] = idx
		s.Emoji[i] = emojiTable[idx].Emoji
		s.Description[i] = emojiTable[idx].Description
	}
	return s, nil
}

// sasLabel is the ASCII label, a NUL, then the pairing id and both signing
// keys. Order is fixed: initiator then joiner, so the two sides build the same
// bytes without negotiating.
// Length-prefixed for the same reason the confirmation label is: an unprefixed
// concatenation lets two different key pairs produce one label, which for a SAS
// would mean two different pairings showing the same emoji.
func sasLabel(pairingID, initiatorPubSign, joinerPubSign []byte) []byte {
	return lengthPrefixed(sasInfo, pairingID, initiatorPubSign, joinerPubSign)
}

// sasBytesForTest exposes the six derived bytes so a test can recompute the bit
// extraction independently. Two expressions of the same rule agreeing is worth
// more than one expression agreeing with itself.
func sasBytesForTest(sharedSecret, pairingID, initiatorPubSign, joinerPubSign []byte) ([6]byte, error) {
	var out [6]byte
	_, err := io.ReadFull(hkdf.New(sha256.New, sharedSecret, nil,
		sasLabel(pairingID, initiatorPubSign, joinerPubSign)), out[:])
	return out, err
}
