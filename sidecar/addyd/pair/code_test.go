package pair

import (
	"errors"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

var codeShape = regexp.MustCompile(`^[0-9]{2}-[a-z]+-[a-z]+$`)

// The wordlist being exactly 256 is load-bearing, not tidy: it makes the
// entropy claim arithmetic and means a draw needs no rejection sampling that
// could skew the distribution.
func TestTheCodeWordlistIsExactlyAPowerOfTwo(t *testing.T) {
	if len(codewords) != 256 {
		t.Fatalf("the wordlist has %d entries, want exactly 256", len(codewords))
	}
	seen := make(map[string]bool, 256)
	for _, w := range codewords {
		if seen[w] {
			t.Errorf("duplicate entry %q skews the distribution", w)
		}
		seen[w] = true
		if w != strings.ToLower(w) || strings.ContainsAny(w, "-0123456789 ") {
			t.Errorf("%q is not a usable code word", w)
		}
	}
}

func TestEveryCodeHasTheSameShapeWithTheNumberFirst(t *testing.T) {
	for i := 0; i < 500; i++ {
		code, err := NewCode()
		if err != nil {
			t.Fatalf("NewCode: %v", err)
		}
		if !codeShape.MatchString(code) {
			t.Fatalf("code %q does not match NN-word-word", code)
		}
	}
}

// The single most likely wrong thing for a user to type is their own device
// name, which is the same three pieces in the other order. Telling them that is
// worth more than telling them the code is wrong.
func TestADeviceNameIsRecognisedAsSuchRatherThanJustRefused(t *testing.T) {
	_, err := NormaliseCode("quiet-otter-41")
	if !errors.Is(err, ErrLooksLikeName) {
		t.Fatalf("NormaliseCode(device name) = %v, want ErrLooksLikeName", err)
	}
}

// People paste with whitespace, capitalise because their phone did, and use
// spaces where the hyphens were. None of that is a wrong code, and saying it is
// how a pairing flow gets abandoned.
func TestWhatPeopleActuallyTypeIsAccepted(t *testing.T) {
	code, err := NewCode()
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(code, "-")

	// The last one is the phone-autocapitalised spelling, which is the variant
	// that actually turns up in support threads.
	variants := []string{
		code,
		"  " + code + "  ",
		strings.ToUpper(code),
		strings.Join(parts, " "),
		strings.Join(parts, "_"),
		parts[0] + "-" + strings.ToUpper(parts[1][:1]) + parts[1][1:] + "-" + parts[2],
	}

	for _, v := range variants {
		got, err := NormaliseCode(v)
		if err != nil {
			t.Errorf("NormaliseCode(%q) = %v, want it accepted", v, err)
			continue
		}
		if got != code {
			t.Errorf("NormaliseCode(%q) = %q, want %q", v, got, code)
		}
	}
}

func TestNonsenseIsRefused(t *testing.T) {
	for _, in := range []string{
		"", "-", "42", "42-amber", "42-amber-cedar-extra",
		"420-amber-cedar", // three digits
		"4-amber-cedar",   // one digit: the shape is fixed so a typo is caught
		"42-notaword-cedar",
		"42-amber-notaword",
	} {
		if _, err := NormaliseCode(in); err == nil {
			t.Errorf("NormaliseCode(%q) was accepted", in)
		}
	}
}

// THE assertion about the limiter: it stops after its budget, and the three
// refusals are distinct because they need three different messages -- a user
// who mistyped, a user who was too slow, and a user looking at an attack.
func TestTheLimiterStopsAtItsBudget(t *testing.T) {
	l := NewLimiter(3, time.Minute)
	for i := 0; i < 3; i++ {
		if err := l.Attempt(); err != nil {
			t.Fatalf("attempt %d refused early: %v", i+1, err)
		}
		if got, want := l.Remaining(), 2-i; got != want {
			t.Errorf("after attempt %d, Remaining() = %d, want %d", i+1, got, want)
		}
	}
	if err := l.Attempt(); !errors.Is(err, ErrTooManyTries) {
		t.Fatalf("the fourth attempt returned %v, want ErrTooManyTries", err)
	}
	if l.Remaining() != 0 {
		t.Errorf("Remaining() = %d after exhaustion", l.Remaining())
	}
}

func TestAnExpiredCodeIsRefusedWithItsOwnReason(t *testing.T) {
	l := NewLimiter(5, time.Nanosecond)
	// Deliberately not sleeping: the deadline is already in the past.
	if err := l.Attempt(); !errors.Is(err, ErrCodeExpired) {
		t.Fatalf("Attempt on an expired code = %v, want ErrCodeExpired", err)
	}
}

// A code that survives a SAS mismatch is a code an attacker gets to try again
// against a user who has already been trained to click through.
func TestBurningACodeEndsItEvenWithAttemptsLeft(t *testing.T) {
	l := NewLimiter(5, time.Minute)
	if err := l.Attempt(); err != nil {
		t.Fatal(err)
	}
	l.Burn()
	if err := l.Attempt(); !errors.Is(err, ErrCodeBurned) {
		t.Fatalf("Attempt after Burn = %v, want ErrCodeBurned", err)
	}
	if l.Remaining() != 0 {
		t.Errorf("Remaining() = %d after Burn", l.Remaining())
	}
}

// Run with -race. The limiter is read by a UI and written by the pairing
// exchange at the same time, and a limiter with a race in it is a limiter that
// can be raced past.
func TestTheLimiterIsSafeUnderConcurrentAttempts(t *testing.T) {
	const budget = 50
	l := NewLimiter(budget, time.Minute)

	var wg sync.WaitGroup
	var mu sync.Mutex
	allowed := 0
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := l.Attempt(); err == nil {
				mu.Lock()
				allowed++
				mu.Unlock()
			}
			l.Remaining()
		}()
	}
	wg.Wait()

	if allowed != budget {
		t.Errorf("%d attempts were allowed against a budget of %d", allowed, budget)
	}
}
