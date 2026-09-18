package protocol

import (
	"bytes"
	"errors"
	"fmt"
	"slices"
	"strings"
)

// The printed recovery card, and the one mechanical check in the ceremony.
//
// §5.6 describes the roster head phrase as something a human compares between
// two windows. For the ANTI-FORK check that is right -- there is no second
// party for software to ask. But on a RECOVERY the user is holding a printed
// card with the phrase on it, and asking them to eyeball five words against a
// screen wastes the only check in the whole ceremony that a machine can do
// perfectly.
//
// So the recovery flow takes the five words as INPUT and refuses outright on no
// match, rather than displaying them and falling through to a judgement call.
//
// WHY IT WALKS THE CHAIN. The card was printed at some earlier point, so its
// phrase names an entry that is probably not the current head. Checking only
// against the head would reject every card older than the last device that was
// added -- which is nearly all of them. So the phrase is matched against the
// fingerprint of EVERY entry, and the result says how far back it matched.

var (
	// ErrCardNotInChain is the finding that matters: the card names a chain
	// this is not. A server serving a different account's chain, or a forked
	// one, produces exactly this.
	ErrCardNotInChain = errors.New("card: that phrase names no entry in this chain")
	ErrCardMalformed  = errors.New("card: a recovery phrase from the card is five words")
)

// CardMatch is where a card's phrase matched.
type CardMatch struct {
	Seq uint64
	// Behind is how many entries have been appended since the card was
	// printed. Zero means the card names the current head.
	Behind uint64
}

// CheckCardPhrase matches a printed phrase against a verified chain.
//
// A match anywhere is a pass, and the position is returned rather than judged:
// a card from three devices ago is not suspicious, it is a card. What IS
// suspicious is no match at all, and that is the refusal.
//
// The chain must already have been verified -- this is a check on top of
// verification rather than a substitute for one. A phrase matching an entry in
// a chain whose signatures do not verify means nothing.
func CheckCardPhrase(chain []byte, acct AccountID, phrase string) (*CardMatch, error) {
	words := strings.Fields(strings.ToLower(strings.TrimSpace(phrase)))
	if len(words) != fingerprintWords {
		return nil, fmt.Errorf("%w, and this has %d", ErrCardMalformed, len(words))
	}

	var entries []Entry
	rest := chain
	for len(rest) > 0 {
		e, next, err := DecodeEntry(rest)
		if err != nil {
			return nil, fmt.Errorf("card: reading the chain: %w", err)
		}
		entries = append(entries, e)
		rest = next
	}
	if len(entries) == 0 {
		return nil, ErrEmptyChain
	}

	for i, e := range entries {
		h, err := e.Hash()
		if err != nil {
			return nil, err
		}
		got, err := Fingerprint(h, acct)
		if err != nil {
			return nil, err
		}
		if slices.Equal(got, words) {
			return &CardMatch{
				Seq:    e.Seq,
				Behind: uint64(len(entries)-1) - uint64(i),
			}, nil
		}
	}
	return nil, ErrCardNotInChain
}

// CardText is what gets printed.
//
// It carries the phrase, the device count and the PRINT DATE, and deliberately
// not the device names.
//
// The argument against names is staleness rather than privacy -- the card is
// already a bearer token for the whole estate, so a name adds little to what
// losing it costs. What it adds is a mismatch: a genesis card lists one device,
// the user later has four, shrugs, and has been trained to dismiss a
// discrepancy on the one screen where dismissing one is the attack. The print
// date turns a difference the date explains into something that is not a
// discrepancy at all.
type CardText struct {
	Phrase      []string
	DeviceCount int
	HeadSeq     uint64
	PrintedAt   string // RFC 3339 date, no time: the day is the useful part
}

// NewCardText builds the card's non-secret half from a verified chain.
//
// The twelve words are the caller's: they never pass through a structure that
// might be logged, serialised or held longer than the print dialog.
func NewCardText(v *Verified, acct AccountID, printedAt string) (*CardText, error) {
	if v == nil {
		return nil, errors.New("card: no verified chain")
	}
	phrase, err := Fingerprint(v.Head, acct)
	if err != nil {
		return nil, err
	}
	return &CardText{
		Phrase:      phrase,
		DeviceCount: len(v.Devices),
		HeadSeq:     v.HeadSeq,
		PrintedAt:   printedAt,
	}, nil
}

// String renders the card's checkable half.
func (c CardText) String() string {
	var b bytes.Buffer
	fmt.Fprintf(&b, "%s\n", strings.Join(c.Phrase, " "))
	fmt.Fprintf(&b, "%d device", c.DeviceCount)
	if c.DeviceCount != 1 {
		b.WriteString("s")
	}
	fmt.Fprintf(&b, " as of %s\n", c.PrintedAt)
	return b.String()
}
