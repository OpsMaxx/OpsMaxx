package main

import (
	"bytes"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"

	"github.com/opsmaxx/opsmaxx/sidecar/addyd/protocol"
)

// The --crypto role's surface.
//
// THE PARENT NEVER SEES A KEY and this process never writes one. What these
// check is the boundary that makes that true: what `load` accepts, what the
// roles can reach, and that a seal made here opens here and nowhere else.

func params(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// loadTestAccount puts a real account into the vault and returns its facts.
func loadTestAccount(t *testing.T) (protocol.AccountID, uint64) {
	t.Helper()
	keys.reset()

	signSeed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(signSeed); err != nil {
		t.Fatal(err)
	}
	encKey, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	rootSeed := make([]byte, 64)
	if _, err := rand.Read(rootSeed); err != nil {
		t.Fatal(err)
	}
	root, err := protocol.DeriveRoot(rootSeed)
	if err != nil {
		t.Fatal(err)
	}
	acct := protocol.DeriveAccountID(root.Sign.Public().(ed25519.PublicKey))

	ak := make([]byte, 32)
	if _, err := rand.Read(ak); err != nil {
		t.Fatal(err)
	}

	_, err = handleLoad(Request{Method: "load", Params: params(t, map[string]any{
		"accountId":      acct.String(),
		"deviceSignSeed": base64.StdEncoding.EncodeToString(signSeed),
		"deviceEncKey":   base64.StdEncoding.EncodeToString(encKey.Bytes()),
		"epochKeys":      map[string]string{"1": base64.StdEncoding.EncodeToString(ak)},
	})})
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	t.Cleanup(keys.reset)
	return acct, 1
}

func TestASealedCollectionOpensAgain(t *testing.T) {
	_, epoch := loadTestAccount(t)

	payload := []byte(`{"servers":[{"id":"s-1"}]}`)
	sealed, err := handleSeal(Request{Method: "seal", Params: params(t, map[string]any{
		"collection":    "servers",
		"epoch":         epoch,
		"schema":        1,
		"writerVersion": "0.48.0",
		"counter":       1,
		"payload":       base64.StdEncoding.EncodeToString(payload),
	})})
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	blob := sealed.(map[string]any)["sealed"].(string)

	opened, err := handleOpen(Request{Method: "open", Params: params(t, map[string]any{
		"collection":  "servers",
		"epoch":       epoch,
		"sealed":      blob,
		"knownSchema": 1,
		"seenCounter": 0,
	})})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	got, err := base64.StdEncoding.DecodeString(opened.(map[string]any)["payload"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("round trip gave %q", got)
	}
}

// The collection name is in the AAD, so a relay cannot answer a request for
// `servers` with the `vault` ciphertext -- an attack it can mount with no key
// at all, by simply handing back a different file.
func TestAnotherCollectionsCiphertextWillNotOpen(t *testing.T) {
	_, epoch := loadTestAccount(t)

	sealed, err := handleSeal(Request{Method: "seal", Params: params(t, map[string]any{
		"collection": "vault", "epoch": epoch, "schema": 1,
		"writerVersion": "0.48.0", "counter": 1,
		"payload": base64.StdEncoding.EncodeToString([]byte("the vault")),
	})})
	if err != nil {
		t.Fatal(err)
	}

	_, err = handleOpen(Request{Method: "open", Params: params(t, map[string]any{
		"collection": "servers", // the lie
		"epoch":      epoch, "sealed": sealed.(map[string]any)["sealed"],
		"knownSchema": 1, "seenCounter": 0,
	})})
	if err == nil {
		t.Fatal("the vault ciphertext opened as `servers`")
	}
}

// A counter that goes backwards is a replayed object, and the client must
// refuse rather than apply it.
func TestARewoundCounterIsRefusedWithItsOwnCode(t *testing.T) {
	_, epoch := loadTestAccount(t)

	sealed, _ := handleSeal(Request{Method: "seal", Params: params(t, map[string]any{
		"collection": "servers", "epoch": epoch, "schema": 1,
		"writerVersion": "0.48.0", "counter": 3,
		"payload": base64.StdEncoding.EncodeToString([]byte("older")),
	})})

	_, err := handleOpen(Request{Method: "open", Params: params(t, map[string]any{
		"collection": "servers", "epoch": epoch,
		"sealed": sealed.(map[string]any)["sealed"],
		// This device has already seen counter 7.
		"knownSchema": 1, "seenCounter": 7,
	})})
	if err == nil {
		t.Fatal("a rewound counter was accepted")
	}
	// The code matters: the remedies differ, and a caller that cannot tell a
	// rollback from a corrupt blob will retry the one it should refuse.
	if code := codeOf(err); code != ErrRosterRewound {
		t.Fatalf("a rollback reported as %q", code)
	}
}

func TestASchemaFromTheFutureHasItsOwnCode(t *testing.T) {
	_, epoch := loadTestAccount(t)

	sealed, _ := handleSeal(Request{Method: "seal", Params: params(t, map[string]any{
		"collection": "servers", "epoch": epoch, "schema": 9,
		"writerVersion": "1.0.0", "counter": 1,
		"payload": base64.StdEncoding.EncodeToString([]byte("newer")),
	})})

	_, err := handleOpen(Request{Method: "open", Params: params(t, map[string]any{
		"collection": "servers", "epoch": epoch,
		"sealed": sealed.(map[string]any)["sealed"],
		// This client understands schema 1.
		"knownSchema": 1, "seenCounter": 0,
	})})
	if err == nil {
		t.Fatal("a document from a newer client was opened anyway")
	}
	// Distinct, because the right answer is to go READ-ONLY for that
	// collection rather than to treat the data as damaged.
	if code := codeOf(err); code != ErrSchemaTooNew {
		t.Fatalf("a future schema reported as %q", code)
	}
}

func TestAnEpochThisDeviceDoesNotHoldIsNamed(t *testing.T) {
	_, _ = loadTestAccount(t)

	_, err := handleSeal(Request{Method: "seal", Params: params(t, map[string]any{
		"collection": "servers", "epoch": 4, "schema": 1,
		"writerVersion": "0.48.0", "counter": 1,
		"payload": base64.StdEncoding.EncodeToString([]byte("x")),
	})})
	if err == nil {
		t.Fatal("sealing under an epoch this device has no key for succeeded")
	}
	// A client asking for an epoch it does not hold has usually missed a
	// rotation, and the remedy is to fetch the roster rather than to retry.
	if !strings.Contains(err.Error(), "epoch 4") {
		t.Fatalf("the refusal does not name the epoch: %v", err)
	}
}

// THE SPLIT THE TWO SUBCOMMANDS EXIST FOR.
//
// `--rtc` links a WebRTC stack and must never reach a key. A method reachable
// from both roles collapses the distinction the two processes are for.
func TestTheRtcRoleCannotReachAnyCryptoMethod(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)

	for method := range cryptoMethods {
		buf.Reset()
		dispatch(t.Context(), w, "rtc", Request{ID: "1", Method: method})
		if !strings.Contains(buf.String(), "unknown method") {
			t.Errorf("the rtc role reached %q: %s", method, buf.String())
		}
	}
}

func TestResetForgetsEverything(t *testing.T) {
	_, epoch := loadTestAccount(t)
	keys.reset()

	_, err := handleSeal(Request{Method: "seal", Params: params(t, map[string]any{
		"collection": "servers", "epoch": epoch, "schema": 1,
		"writerVersion": "0.48.0", "counter": 1,
		"payload": base64.StdEncoding.EncodeToString([]byte("x")),
	})})
	if err == nil {
		t.Fatal("sealing worked after reset")
	}
	// Nothing here is on disk, so forgetting is all there is to do -- which is
	// what makes killing the sidecar a real remediation rather than a gesture.
	if code := codeOf(err); code != ErrNotPaired {
		t.Fatalf("after reset the sidecar answered %q", code)
	}
}

func TestLoadRefusesKeysOfTheWrongShape(t *testing.T) {
	keys.reset()
	good := map[string]any{
		"accountId":      hex.EncodeToString(bytes.Repeat([]byte{1}, protocol.AccountIDLen)),
		"deviceSignSeed": base64.StdEncoding.EncodeToString(make([]byte, ed25519.SeedSize)),
		"deviceEncKey":   base64.StdEncoding.EncodeToString(make([]byte, 32)),
		"epochKeys":      map[string]string{"1": base64.StdEncoding.EncodeToString(make([]byte, 32))},
	}
	for _, broken := range []struct {
		name string
		edit func(map[string]any)
	}{
		{"a short account id", func(m map[string]any) { m["accountId"] = "aabb" }},
		{"a short signing seed", func(m map[string]any) { m["deviceSignSeed"] = "aGk=" }},
		{"a short encryption key", func(m map[string]any) { m["deviceEncKey"] = "aGk=" }},
		{"no epoch key at all", func(m map[string]any) { m["epochKeys"] = map[string]string{} }},
	} {
		in := map[string]any{}
		for k, v := range good {
			in[k] = v
		}
		broken.edit(in)
		if _, err := handleLoad(Request{Method: "load", Params: params(t, in)}); err == nil {
			t.Errorf("load accepted %s", broken.name)
		}
	}
}

// A parameter the sidecar does not know is a parent and a sidecar that
// disagree about the protocol, and ignoring it silently is how that survives
// to the point where it matters.
func TestAnUnknownParameterIsRefused(t *testing.T) {
	keys.reset()
	_, err := handleLoad(Request{Method: "load", Params: params(t, map[string]any{
		"accountId":      hex.EncodeToString(bytes.Repeat([]byte{1}, protocol.AccountIDLen)),
		"deviceSignSeed": base64.StdEncoding.EncodeToString(make([]byte, ed25519.SeedSize)),
		"deviceEncKey":   base64.StdEncoding.EncodeToString(make([]byte, 32)),
		"epochKeys":      map[string]string{"1": base64.StdEncoding.EncodeToString(make([]byte, 32))},
		"deviceSeed":     "the old name for one of these",
	})})
	if err == nil {
		t.Fatal("an unknown parameter was ignored")
	}
}

// codeOf digs the wire code out of an error the handlers returned.
func codeOf(err error) string {
	we := toWireError(err)
	if we == nil {
		return ""
	}
	return we.Code
}
