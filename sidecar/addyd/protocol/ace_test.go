package protocol

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"testing"
)

// The vector file pins the encoding byte for byte, so this rebuilds the
// specification's demo structure with our encoder and compares. If it fails,
// either the encoder changed or the specification did, and both are worth
// stopping for.
func TestTheEncoderReproducesTheSpecificationsVectorExactly(t *testing.T) {
	b, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatalf("reading vectors: %v", err)
	}
	var v struct {
		CanonicalEncoding struct {
			EncodedHex string `json:"encoded_hex"`
			EncodedLen int    `json:"encoded_len"`
			SHA256Hex  string `json:"sha256_hex"`
			Fields     []struct {
				Name string `json:"name"`
				Type string `json:"type"`
				Hex  string `json:"hex"`
			} `json:"fields"`
		} `json:"canonical_encoding"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("parsing vectors: %v", err)
	}
	ce := v.CanonicalEncoding
	want, err := hex.DecodeString(ce.EncodedHex)
	if err != nil {
		t.Fatalf("encoded_hex is not hex: %v", err)
	}

	// The demo structure, field for field, as PROTOCOL.md section 2.7 declares
	// it. Written out rather than driven from the JSON, because a test that
	// derives its input from the file it is checking checks nothing.
	got := NewEncoder("addy-ace-demo-v1").
		U8(1).
		U32(42).
		U64(0x0123456789abcdef).
		Bytes([]byte("addy")).
		Str("quiet-otter-41").
		Optional(nil).
		Optional([]byte{0xde, 0xad}).
		Fixed([]byte{0xf0, 0xf1, 0xf2, 0xf3}).
		Out()

	if !bytes.Equal(got, want) {
		t.Fatalf("encoder output does not match the vector\n got %x\nwant %x", got, want)
	}
	if len(got) != ce.EncodedLen {
		t.Errorf("length %d, vector says %d", len(got), ce.EncodedLen)
	}
	if ce.SHA256Hex != "" {
		sum := sha256.Sum256(got)
		if hex.EncodeToString(sum[:]) != ce.SHA256Hex {
			t.Errorf("sha256 = %x, vector says %s", sum, ce.SHA256Hex)
		}
	}

	// Each field's own hex must also concatenate to the whole, which catches a
	// vector that was edited in one place and not the other.
	var joined []byte
	for _, f := range ce.Fields {
		p, err := hex.DecodeString(f.Hex)
		if err != nil {
			t.Fatalf("field %q hex: %v", f.Name, err)
		}
		joined = append(joined, p...)
	}
	if !bytes.Equal(joined, want) {
		t.Error("the vector's per-field hex does not concatenate to its encoded_hex")
	}
}

// Round-tripping is the property the whole encoding exists for: exactly one
// encoding of a given field list, so "re-serialise and compare" is a valid
// implementation of "did this verify".
func TestEveryPrimitiveRoundTrips(t *testing.T) {
	const domain = "addy-test-v1"
	label := "quiet-otter-41"

	enc := NewEncoder(domain).
		U8(0xff).
		U32(0xdeadbeef).
		U64(0x0102030405060708).
		Bool(true).
		Bool(false).
		Fixed([]byte{1, 2, 3, 4}).
		Bytes([]byte("hello")).
		Str(label).
		Optional(nil).
		Optional([]byte("present"))

	d := NewDecoder(domain, enc.Out())
	if got := d.U8(); got != 0xff {
		t.Errorf("u8 = %#x", got)
	}
	if got := d.U32(); got != 0xdeadbeef {
		t.Errorf("u32 = %#x", got)
	}
	if got := d.U64(); got != 0x0102030405060708 {
		t.Errorf("u64 = %#x", got)
	}
	if got := d.Bool(); !got {
		t.Error("bool true did not round-trip")
	}
	if got := d.Bool(); got {
		t.Error("bool false did not round-trip")
	}
	if got := d.Fixed(4); !bytes.Equal(got, []byte{1, 2, 3, 4}) {
		t.Errorf("fixed = %v", got)
	}
	if got := d.Bytes(); string(got) != "hello" {
		t.Errorf("bytes = %q", got)
	}
	if got := d.Str(); got != label {
		t.Errorf("string = %q", got)
	}
	if got := d.Optional(); got != nil {
		t.Errorf("absent optional = %v", got)
	}
	if got := d.Optional(); string(got) != "present" {
		t.Errorf("present optional = %q", got)
	}
	if err := d.End(); err != nil {
		t.Fatalf("End: %v", err)
	}
}

// THE SEVEN REJECTIONS. Each is a place where a lenient decoder and a strict
// one would disagree about what was signed, and each gets its own test because
// "the decoder is strict" is not a claim, it is seven claims.
func TestTheDecoderRejectsEverythingTheSpecificationSaysItMust(t *testing.T) {
	const domain = "addy-test-v1"

	t.Run("trailing bytes", func(t *testing.T) {
		// The cheapest way to break the chain: append an attacker-chosen entry
		// to a signed body and have half the fleet see it, both halves happily
		// verifying the signature over the prefix they agree on.
		b := NewEncoder(domain).U8(1).Out()
		d := NewDecoder(domain, append(b, 0xff))
		d.U8()
		if err := d.End(); !errors.Is(err, ErrTrailing) {
			t.Fatalf("End = %v, want ErrTrailing", err)
		}
	})

	t.Run("length prefix beyond the input", func(t *testing.T) {
		b := NewEncoder(domain).Out()
		b = append(b, 0xff, 0xff, 0xff, 0xff) // claims 4GiB
		d := NewDecoder(domain, b)
		d.Bytes()
		if err := d.Err(); !errors.Is(err, ErrTruncated) {
			t.Fatalf("Err = %v, want ErrTruncated", err)
		}
	})

	t.Run("a bool that is not 0 or 1", func(t *testing.T) {
		b := append(NewEncoder(domain).Out(), 0x02)
		d := NewDecoder(domain, b)
		d.Bool()
		if err := d.Err(); !errors.Is(err, ErrBadBool) {
			t.Fatalf("Err = %v, want ErrBadBool", err)
		}
	})

	t.Run("an enum outside its table", func(t *testing.T) {
		b := append(NewEncoder(domain).Out(), 0x09)
		d := NewDecoder(domain, b)
		d.Enum(3)
		if err := d.Err(); !errors.Is(err, ErrBadEnum) {
			t.Fatalf("Err = %v, want ErrBadEnum", err)
		}
	})

	t.Run("an optional tag that is not 0 or 1", func(t *testing.T) {
		b := append(NewEncoder(domain).Out(), 0x07)
		d := NewDecoder(domain, b)
		d.Optional()
		if err := d.Err(); !errors.Is(err, ErrBadOptional) {
			t.Fatalf("Err = %v, want ErrBadOptional", err)
		}
	})

	t.Run("a string that is not UTF-8", func(t *testing.T) {
		b := NewEncoder(domain).Bytes([]byte{0xff, 0xfe}).Out()
		d := NewDecoder(domain, b)
		d.Str()
		if err := d.Err(); !errors.Is(err, ErrNotUTF8) {
			t.Fatalf("Err = %v, want ErrNotUTF8", err)
		}
	})

	t.Run("a string that is not NFC", func(t *testing.T) {
		// "é" decomposed: e + combining acute. macOS hands these out, so this
		// is the realistic case rather than a contrived one.
		decomposed := "é"
		b := NewEncoder(domain).Bytes([]byte(decomposed)).Out()
		d := NewDecoder(domain, b)
		d.Str()
		if err := d.Err(); !errors.Is(err, ErrNotNFC) {
			t.Fatalf("Err = %v, want ErrNotNFC", err)
		}
	})

	t.Run("the wrong domain prefix", func(t *testing.T) {
		b := NewEncoder("addy-roster-v1").U8(1).Out()
		d := NewDecoder("addy-login-v1", b)
		if err := d.Err(); !errors.Is(err, ErrBadDomain) {
			t.Fatalf("Err = %v, want ErrBadDomain", err)
		}
	})
}

// The decoder must be refusing rather than normalising. Silently normalising
// would mean the bytes verified are not the bytes decoded, which is the entire
// class of bug the canonical encoding exists to close.
func TestTheEncoderNormalisesAndTheDecoderRefuses(t *testing.T) {
	const domain = "addy-test-v1"
	decomposed := "é"
	composed := "é"

	// The encoder normalises on the way in, so two platforms typing the same
	// label produce the same bytes -- which they must, because a signature is
	// over bytes.
	a := NewEncoder(domain).Str(decomposed).Out()
	b := NewEncoder(domain).Str(composed).Out()
	if !bytes.Equal(a, b) {
		t.Fatal("the encoder produced different bytes for the same string in two normal forms")
	}

	d := NewDecoder(domain, a)
	if got := d.Str(); got != composed {
		t.Errorf("decoded %q, want the composed form", got)
	}
	if err := d.End(); err != nil {
		t.Errorf("End: %v", err)
	}
}

// A failed decode must poison everything after it, so a caller that checks once
// at the end cannot act on a half-decoded structure.
func TestAnErrorPoisonsEverySubsequentRead(t *testing.T) {
	const domain = "addy-test-v1"
	d := NewDecoder(domain, NewEncoder(domain).Out())

	d.U32() // past the end
	if d.Err() == nil {
		t.Fatal("reading past the end did not fail")
	}
	first := d.Err()

	// Subsequent reads return zero values and must not overwrite the first
	// error with a later, less informative one.
	d.U8()
	d.Bytes()
	d.Str()
	if !errors.Is(d.Err(), first) {
		t.Errorf("the first error was replaced: %v then %v", first, d.Err())
	}
}

// Two structures never share a prefix, which is what makes a signature over one
// purpose useless against another.
func TestAStructureDoesNotDecodeUnderAnotherDomain(t *testing.T) {
	body := NewEncoder("addy-roster-v1").U64(7).Out()

	for _, other := range []string{"addy-login-v1", "addy-authz-v1", "addy-signal-v1"} {
		d := NewDecoder(other, body)
		if err := d.Err(); !errors.Is(err, ErrBadDomain) {
			t.Errorf("a roster body decoded under %s: %v", other, err)
		}
	}
}
