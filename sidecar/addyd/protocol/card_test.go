package protocol

import (
	"errors"
	"strings"
	"testing"
)

// A card printed at genesis must still match after devices have been added.
// Checking only against the head would reject every card older than the last
// device added -- which is nearly all of them.
func TestACardFromGenesisStillMatchesLater(t *testing.T) {
	b := newBuilder(t)
	b.addDevice(1)

	v, err := b.verify(b.raw(), nil)
	if err != nil {
		t.Fatal(err)
	}
	card, err := NewCardText(v, b.acct, "2026-09-18")
	if err != nil {
		t.Fatal(err)
	}
	phrase := strings.Join(card.Phrase, " ")

	// The card names the current head, so zero entries behind.
	m, err := CheckCardPhrase(b.raw(), b.acct, phrase)
	if err != nil {
		t.Fatalf("a freshly printed card did not match: %v", err)
	}
	if m.Behind != 0 {
		t.Errorf("Behind = %d for a fresh card, want 0", m.Behind)
	}

	// Three more devices later it must still match, and say how far back.
	b.addDevice(2)
	b.addDevice(3)
	b.addDevice(4)

	m2, err := CheckCardPhrase(b.raw(), b.acct, phrase)
	if err != nil {
		t.Fatalf("a card from three devices ago was refused: %v", err)
	}
	if m2.Seq != m.Seq {
		t.Errorf("matched seq %d, want %d", m2.Seq, m.Seq)
	}
	if m2.Behind != 3 {
		t.Errorf("Behind = %d, want 3", m2.Behind)
	}
}

// THE FINDING THAT MATTERS: the card names a chain this is not. A server
// serving a different account's chain, or a forked one, produces exactly this
// -- and the answer is a refusal rather than a judgement call.
func TestACardFromAnotherChainIsRefused(t *testing.T) {
	mine := newBuilder(t)
	mine.addDevice(1)

	// A different account entirely.
	theirs := newBuilderSeeded(t, 0x77)
	theirs.addDevice(1)
	theirsChain := theirs.raw()
	tv, err := theirs.verify(theirsChain, nil)
	if err != nil {
		t.Fatal(err)
	}
	theirCard, err := NewCardText(tv, theirs.acct, "2026-09-18")
	if err != nil {
		t.Fatal(err)
	}

	_, err = CheckCardPhrase(mine.raw(), mine.acct, strings.Join(theirCard.Phrase, " "))
	if !errors.Is(err, ErrCardNotInChain) {
		t.Fatalf("CheckCardPhrase = %v, want ErrCardNotInChain", err)
	}
}

// A forked chain: same account, but the entries after the fork point differ, so
// their hashes do and the card's phrase names none of them.
func TestACardDoesNotMatchAForkedChain(t *testing.T) {
	b := newBuilder(t)
	b.addDevice(1)
	b.addDevice(2)

	v, err := b.verify(b.raw(), nil)
	if err != nil {
		t.Fatal(err)
	}
	card, err := NewCardText(v, b.acct, "2026-09-18")
	if err != nil {
		t.Fatal(err)
	}

	// The server rebuilds from seq 1 with a different device.
	b.entries = b.entries[:1]
	b.addDevice(9)

	if _, err := CheckCardPhrase(b.raw(), b.acct, strings.Join(card.Phrase, " ")); !errors.Is(err, ErrCardNotInChain) {
		t.Fatalf("a card matched a forked chain: %v", err)
	}
}

// What people actually type off a printed card.
func TestWhatPeopleTypeOffTheCardIsAccepted(t *testing.T) {
	b := newBuilder(t)
	b.addDevice(1)
	v, err := b.verify(b.raw(), nil)
	if err != nil {
		t.Fatal(err)
	}
	card, err := NewCardText(v, b.acct, "2026-09-18")
	if err != nil {
		t.Fatal(err)
	}
	phrase := strings.Join(card.Phrase, " ")

	for _, in := range []string{
		phrase,
		"  " + phrase + "\n",
		strings.ToUpper(phrase),
		strings.Join(card.Phrase, "   "),
		strings.Join(card.Phrase, "\n"),
	} {
		if _, err := CheckCardPhrase(b.raw(), b.acct, in); err != nil {
			t.Errorf("CheckCardPhrase(%q...) = %v", in[:min(20, len(in))], err)
		}
	}
}

func TestAMalformedPhraseIsRefused(t *testing.T) {
	b := newBuilder(t)
	b.addDevice(1)
	for _, in := range []string{"", "one two three", "a b c d e f g"} {
		if _, err := CheckCardPhrase(b.raw(), b.acct, in); !errors.Is(err, ErrCardMalformed) {
			t.Errorf("CheckCardPhrase(%q) = %v, want ErrCardMalformed", in, err)
		}
	}
}

// The card carries a count and a date, and NOT device names. The argument is
// staleness: a genesis card listing one device against a screen showing four
// trains the user to dismiss a mismatch on the one screen where dismissing one
// is the attack.
func TestTheCardCarriesACountAndADateAndNoNames(t *testing.T) {
	b := newBuilder(t)
	b.addDevice(1)
	b.addDevice(2)
	v, err := b.verify(b.raw(), nil)
	if err != nil {
		t.Fatal(err)
	}
	card, err := NewCardText(v, b.acct, "2026-09-18")
	if err != nil {
		t.Fatal(err)
	}

	if card.DeviceCount != 2 {
		t.Errorf("DeviceCount = %d, want 2", card.DeviceCount)
	}
	out := card.String()
	if !strings.Contains(out, "2 devices") {
		t.Errorf("the card does not state its device count: %q", out)
	}
	if !strings.Contains(out, "2026-09-18") {
		t.Errorf("the card does not carry its print date: %q", out)
	}
	// Nothing that could be a device label.
	for _, d := range v.Devices {
		if strings.Contains(out, string(d.LabelCT)) {
			t.Error("the card carries device label material")
		}
	}
}
