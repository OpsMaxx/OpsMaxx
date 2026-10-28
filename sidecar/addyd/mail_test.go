package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"strings"
	"testing"
	"time"

	"github.com/opsmaxx/opsmaxx/sidecar/addyd/protocol"
)

// Three devices on one account. The vault holds one device at a time, so a
// test switches it to play sender and then recipient.
type mailRig struct {
	acct    protocol.AccountID
	a, b, c *protocol.DeviceKeys
}

func newMailRig(t *testing.T) *mailRig {
	t.Helper()
	acct, _ := loadTestAccount(t)
	r := &mailRig{acct: acct}
	for _, d := range []**protocol.DeviceKeys{&r.a, &r.b, &r.c} {
		k, err := protocol.NewDeviceKeys()
		if err != nil {
			t.Fatal(err)
		}
		*d = k
	}
	return r
}

func (r *mailRig) as(d *protocol.DeviceKeys) {
	keys.mu.Lock()
	keys.account, keys.device, keys.loaded = r.acct, d, true
	keys.mu.Unlock()
}

func signHex(d *protocol.DeviceKeys) string {
	return hex.EncodeToString(d.Sign.Public().(ed25519.PublicKey))
}

func (r *mailRig) seal(t *testing.T, from, to *protocol.DeviceKeys, kind, payload string) string {
	t.Helper()
	r.as(from)
	out, err := handleSealMail(Request{Method: "sealMail", Params: params(t, map[string]any{
		"kind": kind, "to": signHex(to), "toEnc": hex.EncodeToString(to.Enc.PublicKey().Bytes()),
		"payload": base64.StdEncoding.EncodeToString([]byte(payload)),
	})})
	if err != nil {
		t.Fatal(err)
	}
	return out.(map[string]any)["sealed"].(string)
}

func (r *mailRig) open(t *testing.T, as *protocol.DeviceKeys, kind, sealed string, senders ...*protocol.DeviceKeys) (map[string]any, error) {
	t.Helper()
	r.as(as)
	hexes := []string{}
	for _, s := range senders {
		hexes = append(hexes, signHex(s))
	}
	out, err := handleOpenMail(Request{Method: "openMail", Params: params(t, map[string]any{
		"kind": kind, "sealed": sealed, "senders": hexes, "maxAgeMs": 10 * 60_000,
	})})
	if err != nil {
		return nil, err
	}
	return out.(map[string]any), nil
}

func TestMailOpensForItsRecipientFromAMember(t *testing.T) {
	r := newMailRig(t)
	sealed := r.seal(t, r.a, r.b, "clipboard", "echo hello")

	got, err := r.open(t, r.b, "clipboard", sealed, r.a, r.c)
	if err != nil {
		t.Fatal(err)
	}
	if got["from"] != signHex(r.a) {
		t.Errorf("from = %v, want the signer", got["from"])
	}
	if p, _ := base64.StdEncoding.DecodeString(got["payload"].(string)); string(p) != "echo hello" {
		t.Errorf("payload = %q", p)
	}
}

// Every other key holder on the account was able to read a clipboard sealed
// under the epoch key. Sealed to b, c cannot open it.
func TestMailDoesNotOpenForAnotherDevice(t *testing.T) {
	r := newMailRig(t)
	sealed := r.seal(t, r.a, r.b, "clipboard", "secret")
	if _, err := r.open(t, r.c, "clipboard", sealed, r.a, r.b); err == nil {
		t.Fatal("a device the mail was not sealed to opened it")
	}
}

// A valid signature from a key the roster does not list -- a removed device,
// which still has a working key -- is refused like a forgery.
func TestMailFromADeviceNotOnTheRosterIsRefused(t *testing.T) {
	r := newMailRig(t)
	sealed := r.seal(t, r.a, r.b, "clipboard", "rm -rf ~")
	_, err := r.open(t, r.b, "clipboard", sealed, r.c)
	if err == nil || !strings.Contains(err.Error(), "not on this account") {
		t.Fatalf("mail signed by a non-member: %v", err)
	}
}

func TestMailIsDeliveredOnce(t *testing.T) {
	r := newMailRig(t)
	sealed := r.seal(t, r.a, r.b, "clipboard", "once")
	if _, err := r.open(t, r.b, "clipboard", sealed, r.a); err != nil {
		t.Fatal(err)
	}
	if _, err := r.open(t, r.b, "clipboard", sealed, r.a); err == nil {
		t.Fatal("the same mail opened twice; a relay can replay it")
	}
}

func TestATamperedMailIsRefused(t *testing.T) {
	r := newMailRig(t)
	raw, _ := base64.StdEncoding.DecodeString(r.seal(t, r.a, r.b, "clipboard", "ls"))
	raw[len(raw)-1] ^= 1
	if _, err := r.open(t, r.b, "clipboard", base64.StdEncoding.EncodeToString(raw), r.a); err == nil {
		t.Fatal("a tampered mail opened")
	}
}

func TestAClipboardDoesNotOpenAsAFileNotice(t *testing.T) {
	r := newMailRig(t)
	sealed := r.seal(t, r.a, r.b, "clipboard", "{}")
	if _, err := r.open(t, r.b, "transfer", sealed, r.a); err == nil {
		t.Fatal("a clipboard opened as a transfer notice")
	}
}

// The sender's clock is inside the signature, so the relay cannot re-date a
// mail; this bounds how long one it kept can be served.
func TestStaleAndFutureMailIsRefused(t *testing.T) {
	r := newMailRig(t)
	for name, at := range map[string]time.Time{
		"stale":  time.Now().Add(-time.Hour),
		"future": time.Now().Add(time.Hour),
	} {
		nonce, _ := protocol.Nonce()
		obj, err := protocol.SealMail(protocol.Mail{
			AccountID: r.acct, Kind: "clipboard",
			From: r.a.Sign.Public().(ed25519.PublicKey), To: r.b.Sign.Public().(ed25519.PublicKey),
			Nonce: nonce, TS: uint64(at.UnixMilli()),
		}, []byte("x"), r.a.Sign, r.b.Enc.PublicKey())
		if err != nil {
			t.Fatal(err)
		}
		if _, err := r.open(t, r.b, "clipboard", base64.StdEncoding.EncodeToString(obj), r.a); err == nil {
			t.Errorf("%s mail opened", name)
		}
	}
}

// What a 0.59.0 sender leaves: a collection object under the epoch key. It
// must be refused, not opened some other way.
func TestAnEpochSealedClipboardIsRefused(t *testing.T) {
	r := newMailRig(t)
	r.as(r.a)
	old, err := handleSeal(Request{Method: "seal", Params: params(t, map[string]any{
		"collection": "clipboard:" + signHex(r.b), "epoch": 1, "schema": 1,
		"writerVersion": "0.59.0", "counter": 1,
		"payload": base64.StdEncoding.EncodeToString([]byte(`{"kind":"text","text":"x"}`)),
	})})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.open(t, r.b, "clipboard", old.(map[string]any)["sealed"].(string), r.a); err == nil {
		t.Fatal("an epoch-sealed clipboard opened as mail")
	}
}

// The client caps a file transfer so the sealed, base64-encoded PUT fits the
// relay's 8 MiB request limit, and it does that arithmetic with a constant:
// TRANSFER_SEAL_OVERHEAD in src/main/services/addy/transfer.ts. This is the
// check that the constant is what sealing a transfer actually adds -- now a
// one-time-key blob rather than an epoch-sealed object. If the layout changes,
// this fails before a user's file starts failing with 413 at 99% of the limit.
func TestTransferSealOverhead(t *testing.T) {
	for _, n := range []int{0, 1, 4096} {
		out, err := handleSealBlob(Request{Method: "sealBlob", Params: params(t, map[string]any{
			"payload": base64.StdEncoding.EncodeToString(make([]byte, n)),
		})})
		if err != nil {
			t.Fatal(err)
		}
		m := out.(map[string]any)
		sealed, _ := base64.StdEncoding.DecodeString(m["sealed"].(string))
		if got := len(sealed) - n; got != 58 {
			t.Fatalf("sealing %d bytes added %d; transfer.ts assumes 58", n, got)
		}
		back, err := handleOpenBlob(Request{Method: "openBlob", Params: params(t, map[string]any{
			"key": m["key"], "sealed": m["sealed"],
		})})
		if err != nil {
			t.Fatal(err)
		}
		if p, _ := base64.StdEncoding.DecodeString(back.(map[string]any)["payload"].(string)); len(p) != n {
			t.Fatalf("round trip of %d bytes gave %d", n, len(p))
		}
	}
}
