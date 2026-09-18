// SPDX-License-Identifier: MIT
// Vendored from github.com/opsmaxx/addy internal/pair/code.go @ fe66709
//
// Edit it THERE and copy it here. A fix made only in this copy is a
// protocol divergence with no symptom until an AEAD tag fails on somebody
// else's machine. See VENDORED.md in this directory.
package pair

import (
	"crypto/rand"
	_ "embed"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed wordlists/codewords.txt
var codewordsRaw string

var codewords = splitLines(codewordsRaw)

func splitLines(s string) []string {
	var out []string
	for _, l := range strings.Split(s, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			out = append(out, l)
		}
	}
	return out
}

// A pairing code is NN-word-word: 100 x 256 x 256 possibilities, 22.6 bits.
//
// That number is why this is a PAKE and not a token typed into a box.
// Twenty-two bits is brute-forceable by anything that can try repeatedly, and
// SPAKE2's property is precisely that it cannot be tried repeatedly: a wrong
// guess costs one attempt and yields nothing to work offline with.
const (
	codeNumbers = 100
	codeSpace   = codeNumbers * 256 * 256
)

// NewCode returns a fresh pairing code.
//
// THE NUMBER COMES FIRST, and that is deliberate. A device is named
// quiet-otter-41 and a pairing code is 42-inkwell-flatfoot: the same three
// pieces in a different order, so someone who types their device name into the
// pairing box gets told they typed a device name rather than told their code is
// wrong.
//
// One uniform draw over the whole space, then decomposed -- rather than three
// independent draws -- so the entropy claim above is arithmetic rather than an
// argument about whether three calls compose.
func NewCode() (string, error) {
	if len(codewords) != 256 {
		return "", fmt.Errorf("pair: the code wordlist has %d entries, not 256", len(codewords))
	}
	n, err := rand.Int(rand.Reader, big.NewInt(codeSpace))
	if err != nil {
		return "", fmt.Errorf("pair: generating a pairing code: %w", err)
	}
	v := n.Int64()
	num := v % codeNumbers
	v /= codeNumbers
	first := v % 256
	second := v / 256
	return fmt.Sprintf("%02d-%s-%s", num, codewords[first], codewords[second]), nil
}

var (
	ErrMalformedCode = errors.New("that is not a pairing code")
	ErrLooksLikeName = errors.New("that looks like a device name, not a pairing code")
)

// NormaliseCode accepts what a human actually types.
//
// People paste with surrounding whitespace, capitalise the first letter because
// their phone did, and occasionally use spaces where the hyphens were. None of
// that is a wrong code, and telling someone their code is wrong when they typed
// the right one is how a pairing flow gets abandoned.
func NormaliseCode(in string) (string, error) {
	s := strings.ToLower(strings.TrimSpace(in))
	s = strings.ReplaceAll(s, " ", "-")
	s = strings.ReplaceAll(s, "_", "-")
	for strings.Contains(s, "--") {
		s = strings.ReplaceAll(s, "--", "-")
	}
	s = strings.Trim(s, "-")

	parts := strings.Split(s, "-")
	if len(parts) != 3 {
		return "", ErrMalformedCode
	}

	// A device name is word-word-NN. Saying so is worth more than a generic
	// refusal, because it is the single most likely wrong thing to type.
	if _, err := strconv.Atoi(parts[2]); err == nil {
		if _, err := strconv.Atoi(parts[0]); err != nil {
			return "", ErrLooksLikeName
		}
	}

	num, err := strconv.Atoi(parts[0])
	if err != nil || num < 0 || num >= codeNumbers || len(parts[0]) != 2 {
		return "", ErrMalformedCode
	}
	for _, w := range parts[1:] {
		if w == "" || !isCodeword(w) {
			return "", ErrMalformedCode
		}
	}
	return s, nil
}

func isCodeword(w string) bool {
	// Linear over 256 short strings, on a path a human drives at typing speed.
	// A map would be faster and would also be a second copy of the list to keep
	// in step with the embedded one.
	for _, c := range codewords {
		if c == w {
			return true
		}
	}
	return false
}

// Limiter counts pairing attempts.
//
// IT RUNS ON THE INITIATING DEVICE, NOT THE SERVER, and that is the whole
// point. A pairing code is about 22 bits and SPAKE2 grants one guess per run --
// which is only a defence if somebody trustworthy counts the runs. Letting the
// relay count them hands the attacker its own rate limit, and the relay is
// exactly the party the PAKE exists to defend against.
//
// This is also a regression the sibling codebase already avoided once: its CLI
// pairing counts attempts in the device's own main process, with a six-digit
// code, a sixty-second TTL and five attempts. Same shape, upgraded crypto.
//
// The adversary test runs with the SERVER's limiter disabled, because that is
// the real condition: an attacker who owns the relay does not run our limiter.
type Limiter struct {
	mu       sync.Mutex
	attempts int
	max      int
	expires  time.Time
	burned   bool
}

const (
	// Matching the sibling's CLI pairing flow, which had to resist only a local
	// attacker; this one has to resist the relay, which is why the crypto
	// changed and the numbers did not need to.
	DefaultMaxAttempts = 5
	DefaultCodeTTL     = 60 * time.Second
)

func NewLimiter(max int, ttl time.Duration) *Limiter {
	if max <= 0 {
		max = DefaultMaxAttempts
	}
	if ttl <= 0 {
		ttl = DefaultCodeTTL
	}
	return &Limiter{max: max, expires: time.Now().Add(ttl)}
}

var (
	ErrCodeExpired  = errors.New("the pairing code has expired")
	ErrTooManyTries = errors.New("too many incorrect attempts; start the pairing again")
	ErrCodeBurned   = errors.New("the pairing code has already been used")
)

// Attempt records one try. It returns an error when the code must no longer be
// accepted, and the three reasons are distinct because they need three
// different messages: a user who mistyped, a user who was too slow, and a user
// who is looking at an attack.
func (l *Limiter) Attempt() error {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.burned {
		return ErrCodeBurned
	}
	if time.Now().After(l.expires) {
		return ErrCodeExpired
	}
	if l.attempts >= l.max {
		return ErrTooManyTries
	}
	l.attempts++
	return nil
}

// Burn marks the code used. A successful pairing consumes it, and so does an
// aborted one -- a code that survives a SAS mismatch is a code an attacker gets
// to try again against a user who has already been trained to click through.
func (l *Limiter) Burn() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.burned = true
}

// Remaining is what the UI shows, so "wrong code" and "two tries left" are the
// same message rather than two screens.
func (l *Limiter) Remaining() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.burned || time.Now().After(l.expires) {
		return 0
	}
	if r := l.max - l.attempts; r > 0 {
		return r
	}
	return 0
}
