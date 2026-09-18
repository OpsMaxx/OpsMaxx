// SPDX-License-Identifier: MIT
// Vendored from github.com/opsmaxx/addy internal/protocol/ace.go @ fe66709
//
// Edit it THERE and copy it here. A fix made only in this copy is a
// protocol divergence with no symptom until an AEAD tag fails on somebody
// else's machine. See VENDORED.md in this directory.
// Package protocol implements addy's canonical encoding, its key hierarchy and
// its signed structures, as specified in docs/PROTOCOL.md.
package protocol

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// ACE-1: addy canonical encoding, version 1.
//
// NOT JSON, and that is the whole point. JSON has more than one encoding of the
// same document, which invites signing over one and verifying over another.
// ACE-1 has exactly one encoding of a given field list, so "re-serialise and
// compare" is a valid implementation of "did this verify".
//
// Big-endian throughout, because every wire format this talks to -- HPKE, TLS,
// WebSocket framing -- already is, and one endianness is one fewer thing to get
// wrong at three in the morning.

// Encoder builds an ACE-1 byte string. The zero value is ready to use, though
// every real structure starts with NewEncoder and a domain prefix.
type Encoder struct{ b []byte }

// NewEncoder starts a structure with its domain prefix.
//
// A domain prefix is ASCII followed by a single 0x00, and the trailing NUL is
// PART OF THE PREFIX. Two structures never share one, so a byte string valid
// under one is not valid under another -- which is what makes a signature over
// one purpose useless against another.
func NewEncoder(domain string) *Encoder {
	e := &Encoder{}
	e.b = append(e.b, domain...)
	e.b = append(e.b, 0x00)
	return e
}

func (e *Encoder) U8(v uint8) *Encoder   { e.b = append(e.b, v); return e }
func (e *Encoder) U32(v uint32) *Encoder { e.b = binary.BigEndian.AppendUint32(e.b, v); return e }
func (e *Encoder) U64(v uint64) *Encoder { e.b = binary.BigEndian.AppendUint64(e.b, v); return e }

// Bool is a u8 that is 0x00 or 0x01 and nothing else.
func (e *Encoder) Bool(v bool) *Encoder {
	if v {
		return e.U8(1)
	}
	return e.U8(0)
}

// Fixed writes exactly len(p) raw bytes with NO length prefix. The width is
// pinned by the field's declaration in the specification, which is why it does
// not travel on the wire.
func (e *Encoder) Fixed(p []byte) *Encoder { e.b = append(e.b, p...); return e }

// Bytes writes a u32 length followed by the bytes.
func (e *Encoder) Bytes(p []byte) *Encoder {
	e.U32(uint32(len(p)))
	e.b = append(e.b, p...)
	return e
}

// Str writes NFC-normalised UTF-8, encoded exactly as Bytes.
//
// Named Str rather than String so that neither side accidentally satisfies
// fmt.Stringer. A Decoder with a String() method does satisfy it, which means
// printing a decoder in a log line or a %v would silently consume a field --
// a debugging aid that corrupts the thing being debugged. go vet catches the
// unused-result half of that; the rename removes the cause.
//
// NFC is normative rather than polite. macOS hands out decomposed strings while
// Windows and Linux use composed ones, so the same device label typed on two
// platforms encodes to different bytes -- and a signature is over bytes. Without
// this, a label round-tripping through a Mac would fail verification on a
// Linux box for reasons neither user could see.
func (e *Encoder) Str(s string) *Encoder { return e.Bytes([]byte(norm.NFC.String(s))) }

// Optional writes a presence tag, then the value if present.
func (e *Encoder) Optional(p []byte) *Encoder {
	if p == nil {
		return e.U8(0)
	}
	return e.U8(1).Bytes(p)
}

// Bytes returns the encoded structure.
func (e *Encoder) Out() []byte { return e.b }

// Decoding, and why it is the security-critical half.
//
// Every rule below is a place where a lenient decoder and a strict one would
// disagree about what was signed. Accepting trailing bytes alone is enough to
// let a malicious server append a second, attacker-chosen entry to a signed
// body and have half the fleet see it -- both halves verifying the signature
// happily, because the signature covers the prefix they agree on.
var (
	ErrTrailing    = errors.New("ace: trailing bytes after the last field")
	ErrTruncated   = errors.New("ace: a length prefix exceeds the bytes remaining")
	ErrBadBool     = errors.New("ace: a bool is neither 0x00 nor 0x01")
	ErrBadEnum     = errors.New("ace: an enum value is not in its declared table")
	ErrBadOptional = errors.New("ace: an optional presence tag is neither 0x00 nor 0x01")
	ErrNotUTF8     = errors.New("ace: a string is not well-formed UTF-8")
	ErrNotNFC      = errors.New("ace: a string is not in NFC")
	ErrBadDomain   = errors.New("ace: the domain prefix is not the expected one")
)

// Decoder reads an ACE-1 byte string. Every method returns the first error
// encountered and every subsequent call is a no-op, so a caller may decode a
// whole structure and check once -- which is what stops a half-decoded
// structure being acted on.
type Decoder struct {
	b   []byte
	i   int
	err error
}

// NewDecoder checks the domain prefix and positions the decoder after it.
//
// The prefix is checked FIRST and the decoder refuses to produce anything if it
// does not match, because a structure decoded under the wrong schema is how a
// signature over one purpose gets accepted for another.
func NewDecoder(domain string, b []byte) *Decoder {
	d := &Decoder{b: b}
	want := append([]byte(domain), 0x00)
	if len(b) < len(want) || string(b[:len(want)]) != string(want) {
		d.err = fmt.Errorf("%w: wanted %q", ErrBadDomain, domain)
		return d
	}
	d.i = len(want)
	return d
}

func (d *Decoder) fail(err error) {
	if d.err == nil {
		d.err = err
	}
}

func (d *Decoder) take(n int) []byte {
	if d.err != nil {
		return nil
	}
	if n < 0 || d.i+n > len(d.b) {
		d.fail(fmt.Errorf("%w: wanted %d bytes, %d remain", ErrTruncated, n, len(d.b)-d.i))
		return nil
	}
	out := d.b[d.i : d.i+n]
	d.i += n
	return out
}

func (d *Decoder) U8() uint8 {
	p := d.take(1)
	if p == nil {
		return 0
	}
	return p[0]
}

func (d *Decoder) U32() uint32 {
	p := d.take(4)
	if p == nil {
		return 0
	}
	return binary.BigEndian.Uint32(p)
}

func (d *Decoder) U64() uint64 {
	p := d.take(8)
	if p == nil {
		return 0
	}
	return binary.BigEndian.Uint64(p)
}

func (d *Decoder) Bool() bool {
	v := d.U8()
	if d.err != nil {
		return false
	}
	switch v {
	case 0:
		return false
	case 1:
		return true
	default:
		d.fail(fmt.Errorf("%w: got 0x%02x", ErrBadBool, v))
		return false
	}
}

// Enum reads a u8 and checks it against a closed table. The table is passed in
// rather than inferred, because the point of a closed table is that the decoder
// knows what it is.
func (d *Decoder) Enum(max uint8) uint8 {
	v := d.U8()
	if d.err != nil {
		return 0
	}
	if v > max {
		d.fail(fmt.Errorf("%w: got %d, table ends at %d", ErrBadEnum, v, max))
		return 0
	}
	return v
}

func (d *Decoder) Fixed(n int) []byte { return d.take(n) }

func (d *Decoder) Bytes() []byte {
	n := d.U32()
	if d.err != nil {
		return nil
	}
	// A u32 length on a 32-bit platform could overflow an int. Checked rather
	// than assumed, because the length is attacker-chosen.
	if uint64(n) > uint64(math.MaxInt) {
		d.fail(ErrTruncated)
		return nil
	}
	return d.take(int(n))
}

// Str reads NFC-normalised UTF-8. See Encoder.Str for the naming.
func (d *Decoder) Str() string {
	p := d.Bytes()
	if d.err != nil {
		return ""
	}
	if !utf8.Valid(p) {
		d.fail(ErrNotUTF8)
		return ""
	}
	s := string(p)
	// NFC is checked, not applied. Silently normalising would mean the bytes
	// verified are not the bytes decoded, which is the entire class of bug the
	// canonical encoding exists to close.
	if !norm.NFC.IsNormalString(s) {
		d.fail(ErrNotNFC)
		return ""
	}
	return s
}

func (d *Decoder) Optional() []byte {
	tag := d.U8()
	if d.err != nil {
		return nil
	}
	switch tag {
	case 0:
		return nil
	case 1:
		return d.Bytes()
	default:
		d.fail(fmt.Errorf("%w: got 0x%02x", ErrBadOptional, tag))
		return nil
	}
}

// End asserts that every byte was consumed and returns the first error.
//
// A caller that forgets this has a decoder that accepts trailing bytes, which
// is the single cheapest way to break the chain.
func (d *Decoder) End() error {
	if d.err != nil {
		return d.err
	}
	if d.i != len(d.b) {
		return fmt.Errorf("%w: %d bytes unread", ErrTrailing, len(d.b)-d.i)
	}
	return nil
}

// Err returns the first error without asserting that the input was consumed.
func (d *Decoder) Err() error { return d.err }

// Offset is how many bytes have been consumed.
//
// Needed because a roster entry is `body || sig` with no length prefix: the
// body is variable-length, so the only way to find where the signature starts
// is to decode the body and ask. The split is unambiguous because the signature
// is fixed-width and last.
func (d *Decoder) Offset() int { return d.i }

// Rest returns the unconsumed bytes without consuming them.
func (d *Decoder) Rest() []byte {
	if d.err != nil {
		return nil
	}
	return d.b[d.i:]
}
