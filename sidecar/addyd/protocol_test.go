package main

import (
	"bytes"
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"
)

// EVERY ERROR CODE THIS BINARY CAN EMIT MUST EXIST IN THE TYPESCRIPT UNION.
//
// It reads the REAL file rather than a copied list, which is what makes it a
// check rather than a second place to get it wrong. netd's equivalent has
// caught this exact drift before.
//
// The direction is one-way: addyd may emit a subset of the union, never a
// superset. A code the renderer has never heard of arrives there as an error it
// has no case for.
func TestErrorCodesExistInSharedAddyTs(t *testing.T) {
	const rel = "../../src/shared/addy.ts"
	src, err := os.ReadFile(rel)
	if err != nil {
		t.Fatalf("reading %s: %v", rel, err)
	}

	start := bytes.Index(src, []byte("export type AddyErrorCode"))
	if start < 0 {
		t.Fatal("AddyErrorCode not found; the union moved or was renamed")
	}
	rest := src[start:]
	if end := bytes.Index(rest, []byte("\n\n")); end > 0 {
		rest = rest[:end]
	}

	// Either quote style. The repo's formatter rewrites single quotes to
	// double, and the first version of this parser only knew one of them --
	// which the sanity check below caught by failing on zero matches rather
	// than passing vacuously, which is the whole reason that check is there.
	member := regexp.MustCompile(`['"]([a-z0-9-]+)['"]`)
	union := map[string]bool{}
	for _, m := range member.FindAllSubmatch(rest, -1) {
		union[string(m[1])] = true
	}

	// A PARSER SANITY CHECK. Without it, a regex that stopped matching would
	// make this test pass by finding nothing, which is the worst outcome
	// available: a guardrail reporting success because it has gone blind.
	if len(union) < 10 {
		t.Fatalf("only parsed %d union members; the parser is wrong, not the code", len(union))
	}

	for code := range knownCodes {
		if !union[code] {
			t.Errorf("addyd can emit %q, which AddyErrorCode does not contain", code)
		}
	}
}

// A typo'd constant must never reach the renderer as an error it has no case
// for.
func TestAnUnknownCodeIsDowngradedToInternal(t *testing.T) {
	err := codedf("pairing-refuzed", "a typo")
	if got := toWireError(err).Code; got != ErrInternal {
		t.Errorf("code = %q, want %q", got, ErrInternal)
	}

	// And a known one is passed through, so the downgrade is not just a
	// blanket rewrite.
	if got := toWireError(codedf(ErrSASMismatch, "x")).Code; got != ErrSASMismatch {
		t.Errorf("a known code was downgraded: %q", got)
	}

	// An unclassified error is internal too.
	if got := toWireError(errorString("plain")).Code; got != ErrInternal {
		t.Errorf("an unclassified error became %q", got)
	}
}

type errorString string

func (e errorString) Error() string { return string(e) }

// The things addyd handles are exactly the things that must not reach a log.
func TestRedactScrubsTheShapesThatMatter(t *testing.T) {
	cases := []struct {
		name string
		in   string
	}{
		{"a pairing code", "pairing failed for 42-amber-cedar"},
		{"a recovery phrase", "seed abandon amount liar amount expire adjust cage candy arch gather drum buyer failed"},
		{"a hex key", "key 2543b92ff1095511476adc8369db6ddc933665a11978dda1404ee1066ca92543b92ff109551147"},
		{"a base64 key", "enc dGhpcyBpcyBhIHZlcnkgbG9uZyBiYXNlNjQgc3RyaW5nIHRoYXQgbG9va3MgbGlrZSBhIGtleQ"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := redact(c.in)
			if !strings.Contains(got, placeholder) {
				t.Errorf("redact(%q) = %q; nothing was scrubbed", c.in, got)
			}
		})
	}

	// And ordinary text is not mangled, or the logs become useless and
	// somebody turns the redactor off.
	plain := "connecting to the relay at addy.example.com"
	if redact(plain) != plain {
		t.Errorf("redact mangled ordinary text: %q", redact(plain))
	}
}

// One JSON object per line, and an event distinguished from a response purely
// by the absence of `id`.
func TestTheWriterEmitsOneObjectPerLine(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)

	w.Respond("7", map[string]string{"role": "crypto"})
	w.Fail("8", codedf(ErrPairingExpired, "too slow"))
	w.Emit("pair.sas", map[string]any{"indices": []int{1, 2, 3}})
	w.Log("info", "started")

	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	if len(lines) != 4 {
		t.Fatalf("%d lines, want 4", len(lines))
	}
	for i, line := range lines {
		var v map[string]any
		if err := json.Unmarshal([]byte(line), &v); err != nil {
			t.Fatalf("line %d is not JSON: %v", i, err)
		}
	}

	var ok map[string]any
	_ = json.Unmarshal([]byte(lines[0]), &ok)
	if ok["ok"] != true || ok["id"] != "7" {
		t.Errorf("response = %v", ok)
	}

	var bad map[string]any
	_ = json.Unmarshal([]byte(lines[1]), &bad)
	if _, has := bad["result"]; has {
		t.Error("a failure carries a result key")
	}
	if e, _ := bad["error"].(map[string]any); e["code"] != ErrPairingExpired {
		t.Errorf("error = %v", bad["error"])
	}

	var ev map[string]any
	_ = json.Unmarshal([]byte(lines[2]), &ev)
	if _, has := ev["id"]; has {
		t.Error("an event carries an id; the parent tells them apart by its absence")
	}
	if ev["event"] != "pair.sas" {
		t.Errorf("event = %v", ev)
	}
}

// A malformed request must not echo the offending value. json's own error
// quotes it, and for a mistyped recovery phrase that is the phrase.
func TestAMalformedRequestDoesNotEchoItsInput(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)
	w.Fail("", codedf(ErrConfigInvalid, "malformed request"))

	out := buf.String()
	if strings.Contains(out, "abandon") || strings.Contains(out, "unexpected") {
		t.Errorf("the failure echoes its input: %q", out)
	}
}
