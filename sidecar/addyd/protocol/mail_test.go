// SPDX-License-Identifier: MIT
// Vendored from github.com/opsmaxx/addy internal/protocol/mail_test.go
//
// Edit it THERE and copy it here. A fix made only in this copy is a
// protocol divergence with no symptom until an AEAD tag fails on somebody
// else's machine. See VENDORED.md in this directory.
package protocol

import (
	"bytes"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hpke"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"
)

// The same fixed inputs and the same expected bytes in both copies of this
// package: a mail signed by one OpsMaxx must verify on another.
func TestMailVector(t *testing.T) {
	key := ed25519.NewKeyFromSeed(make([]byte, 32))
	var acct AccountID
	copy(acct[:], []byte("0123456789abcdef"))
	sum := sha256.Sum256([]byte("clipboard payload"))
	m := Mail{
		AccountID:   acct,
		Kind:        "clipboard",
		From:        key.Public().(ed25519.PublicKey),
		To:          bytes.Repeat([]byte{0x22}, 32),
		Nonce:       bytes.Repeat([]byte{0x33}, 32),
		TS:          1_761_000_000_000,
		PayloadHash: sum[:],
	}
	msg, err := m.Encode()
	if err != nil {
		t.Fatal(err)
	}
	const wantMsg = "616464792d6d61696c2d7631003031323334353637383961626364656600000009636c6970626f6172643b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29222222222222222222222222222222222222222222222222222222222222222233333333333333333333333333333333333333333333333333333333333333330000019a03c78a00f42ac849087457e9e0e8128eecc390baeca3d301d72a17006982bdd2b4669b65"
	if got := hex.EncodeToString(msg); got != wantMsg {
		t.Fatalf("encoding changed:\n got %s\nwant %s", got, wantMsg)
	}
	sig, err := Sign(key, m)
	if err != nil {
		t.Fatal(err)
	}
	const wantSig = "35d93c21386e2d83eeb283c9324b7e6638bb1eb7f8be188f9073b65583bba443982ced3eacde51a3e8bb47c8806972d3b5de5843e30ed576fb47f857509d4b06"
	if got := hex.EncodeToString(sig); got != wantSig {
		t.Fatalf("signature changed:\n got %s\nwant %s", got, wantSig)
	}
}

type mailDevice struct {
	sign ed25519.PrivateKey
	enc  *ecdh.PrivateKey
}

func newMailDevice(t *testing.T) mailDevice {
	t.Helper()
	_, sign, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	enc, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return mailDevice{sign, enc}
}

func (d mailDevice) pub() ed25519.PublicKey { return d.sign.Public().(ed25519.PublicKey) }

func sealTestMail(t *testing.T, acct AccountID, kind string, from, to mailDevice, payload []byte) []byte {
	t.Helper()
	nonce, _ := Nonce()
	obj, err := SealMail(Mail{AccountID: acct, Kind: kind, From: from.pub(), To: to.pub(), Nonce: nonce, TS: 1},
		payload, from.sign, to.enc.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	return obj
}

func TestMailOpensForItsRecipientOnly(t *testing.T) {
	var acct AccountID
	copy(acct[:], "account-one-xxxx")
	a, b, c := newMailDevice(t), newMailDevice(t), newMailDevice(t)
	obj := sealTestMail(t, acct, "clipboard", a, b, []byte("ls -la"))

	m, payload, err := OpenMail(obj, acct, "clipboard", b.pub(), b.enc)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(m.From, a.pub()) || string(payload) != "ls -la" {
		t.Fatalf("opened as from %x: %q", m.From, payload)
	}

	// Another device on the account, a different kind, a different account:
	// none of them opens it.
	if _, _, err := OpenMail(obj, acct, "clipboard", c.pub(), c.enc); err == nil {
		t.Error("a mail opened for a device it was not sealed to")
	}
	if _, _, err := OpenMail(obj, acct, "transfer", b.pub(), b.enc); err == nil {
		t.Error("a clipboard opened as a file notice")
	}
	var other AccountID
	if _, _, err := OpenMail(obj, other, "clipboard", b.pub(), b.enc); err == nil {
		t.Error("a mail opened under another account")
	}

	// A flipped byte anywhere fails.
	for i := range obj {
		bad := bytes.Clone(obj)
		bad[i] ^= 1
		if _, _, err := OpenMail(bad, acct, "clipboard", b.pub(), b.enc); err == nil {
			t.Fatalf("a mail with byte %d flipped still opened", i)
		}
	}
}

// A recipient cannot pass a mail on as though it had been addressed to a third
// device: the signature names the device it was written for.
func TestAForwardedMailDoesNotVerify(t *testing.T) {
	var acct AccountID
	a, b, c := newMailDevice(t), newMailDevice(t), newMailDevice(t)
	nonce, _ := Nonce()
	m := Mail{AccountID: acct, Kind: "clipboard", From: a.pub(), To: b.pub(), Nonce: nonce, TS: 1}
	sum := sha256.Sum256([]byte("x"))
	m.PayloadHash = sum[:]
	sig, err := Sign(a.sign, m)
	if err != nil {
		t.Fatal(err)
	}
	// b re-seals a's signed plaintext to c, by hand.
	forged := forgeMail(t, acct, "clipboard", a.pub(), m.Nonce, sig, []byte("x"), c)
	if _, _, err := OpenMail(forged, acct, "clipboard", c.pub(), c.enc); !errors.Is(err, ErrMailForged) {
		t.Fatalf("a forwarded mail: %v, want ErrMailForged", err)
	}
	// And a mail naming a sender whose key did not sign it.
	forged = forgeMail(t, acct, "clipboard", b.pub(), m.Nonce, sig, []byte("x"), c)
	if _, _, err := OpenMail(forged, acct, "clipboard", c.pub(), c.enc); !errors.Is(err, ErrMailForged) {
		t.Fatalf("a mail with a borrowed signature: %v, want ErrMailForged", err)
	}
}

func forgeMail(t *testing.T, acct AccountID, kind string, from, nonce, sig, payload []byte, to mailDevice) []byte {
	t.Helper()
	pt := NewEncoder(domainMailPlaintext).Fixed(from).Fixed(nonce).U64(1).Fixed(sig).Bytes(payload).Out()
	pk, err := hpke.NewDHKEMPublicKey(to.enc.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	kdf, aead := suite()
	enc, s, err := hpke.NewSender(pk, kdf, aead, mailInfo(acct, to.pub(), kind))
	if err != nil {
		t.Fatal(err)
	}
	ct, _ := s.Seal(nil, pt)
	return NewEncoder(domainMailObject).U8(SuitePinned).Bytes(enc).Bytes(ct).Out()
}

func TestMailBlobRoundTrip(t *testing.T) {
	key, sealed, err := SealMailBlob([]byte("file bytes"))
	if err != nil {
		t.Fatal(err)
	}
	if len(sealed)-len("file bytes") != 58 {
		t.Fatalf("a blob adds %d bytes; OpsMaxx sizes transfers by 58 (transfer.ts)", len(sealed)-len("file bytes"))
	}
	got, err := OpenMailBlob(key, sealed)
	if err != nil || string(got) != "file bytes" {
		t.Fatalf("%q, %v", got, err)
	}
	other, _, _ := SealMailBlob(nil)
	if _, err := OpenMailBlob(other, sealed); err == nil {
		t.Error("a blob opened under another key")
	}
}
