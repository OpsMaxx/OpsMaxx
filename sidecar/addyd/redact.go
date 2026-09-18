package main

import "regexp"

const placeholder = "[redacted]"

// Everything leaving this process is redacted, because the things addyd handles
// are exactly the things that must not end up in a log:
//
//   - a pairing code, which is 22 bits and the whole security of a pairing;
//   - a recovery phrase, which is a bearer token for the entire estate;
//   - key material of any kind.
//
// Shape-based rather than context-based, deliberately. A redactor that only
// scrubs the fields it was told about misses the one somebody added last week.
var redactions = []*regexp.Regexp{
	// A pairing code: NN-word-word.
	regexp.MustCompile(`\b\d{2}-[a-z]{3,9}-[a-z]{3,9}\b`),
	// Twelve lowercase words in a row is a BIP39 phrase and nothing else.
	regexp.MustCompile(`\b(?:[a-z]{3,8} ){11}[a-z]{3,8}\b`),
	// Base64 or hex long enough to be a key.
	regexp.MustCompile(`\b[A-Za-z0-9+/_-]{43,}={0,2}\b`),
	regexp.MustCompile(`\b[0-9a-f]{64,}\b`),
}

func redact(s string) string {
	for _, re := range redactions {
		s = re.ReplaceAllString(s, placeholder)
	}
	return s
}
