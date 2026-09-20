package main

import (
	"bytes"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
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
		"rootSignPub":    hex.EncodeToString(root.Sign.Public().(ed25519.PublicKey)),
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
		"rootSignPub":    hex.EncodeToString(make([]byte, 32)),
	}
	for _, broken := range []struct {
		name string
		edit func(map[string]any)
	}{
		{"a short account id", func(m map[string]any) { m["accountId"] = "aabb" }},
		{"a short signing seed", func(m map[string]any) { m["deviceSignSeed"] = "aGk=" }},
		{"a short encryption key", func(m map[string]any) { m["deviceEncKey"] = "aGk=" }},
		{"no epoch key at all", func(m map[string]any) { m["epochKeys"] = map[string]string{} }},
		{"a short root signing key", func(m map[string]any) { m["rootSignPub"] = "aabb" }},
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
		"rootSignPub":    hex.EncodeToString(make([]byte, 32)),
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

// Minting an account from nothing.
//
// M1's gate, first half, in the process that will actually do it on a user's
// machine.
func TestItMintsAnAccountAndIsImmediatelyUsable(t *testing.T) {
	keys.reset()
	t.Cleanup(keys.reset)

	v, err := handleCreateAccount(Request{Method: "createAccount", Params: params(t, map[string]any{
		"label": "quiet-otter-41",
	})})
	if err != nil {
		t.Fatalf("createAccount: %v", err)
	}
	out := v.(map[string]any)

	// Twelve words, shown ONCE. There is no call that returns it again, which
	// is not an oversight: a mnemonic a process hands back on request is one
	// that leaks the day something can ask.
	phrase, _ := out["mnemonic"].(string)
	if words := len(strings.Fields(phrase)); words != 12 {
		t.Fatalf("the recovery phrase is %d words", words)
	}

	secrets, ok := out["secrets"].(map[string]string)
	if !ok {
		t.Fatalf("no secrets to store: %T", out["secrets"])
	}
	for _, key := range []string{"deviceSignSeed", "deviceEncKey", "akSeed"} {
		if secrets[key] == "" {
			t.Errorf("the parent was not given %s to store", key)
		}
	}
	if out["genesis"] == "" {
		t.Error("no genesis entry to register with")
	}

	// USABLE IMMEDIATELY. The parent should not have to hand back what it was
	// just given in order for the next call to work.
	sealed, err := handleSeal(Request{Method: "seal", Params: params(t, map[string]any{
		"collection": "servers", "epoch": uint64(1), "schema": 1,
		"writerVersion": "test", "counter": uint64(1),
		"payload": base64.StdEncoding.EncodeToString([]byte("first write")),
	})})
	if err != nil {
		t.Fatalf("a freshly minted account could not seal: %v", err)
	}

	opened, err := handleOpen(Request{Method: "open", Params: params(t, map[string]any{
		"collection": "servers", "epoch": uint64(1),
		"sealed":      sealed.(map[string]any)["sealed"],
		"knownSchema": 1, "seenCounter": uint64(0),
	})})
	if err != nil {
		t.Fatalf("it could not read its own write: %v", err)
	}
	got, _ := base64.StdEncoding.DecodeString(opened.(map[string]any)["payload"].(string))
	if string(got) != "first write" {
		t.Fatalf("round trip gave %q", got)
	}

	// And the account id is the one derived from the root key, not something
	// the server will be asked to accept on trust. Hex, so twice the byte
	// length -- read from the constant rather than written out, because a test
	// that hardcodes it disagrees with the protocol the day the protocol
	// changes.
	if id, _ := out["accountId"].(string); len(id) != protocol.AccountIDLen*2 {
		t.Fatalf("the account id is %q (%d chars, want %d)", id, len(id), protocol.AccountIDLen*2)
	}
}

func TestMintingNeedsALabel(t *testing.T) {
	keys.reset()
	// The label is what every other device's device list shows. An unlabelled
	// device is a row somebody cannot act on when they come to revoke one.
	if _, err := handleCreateAccount(Request{Method: "createAccount", Params: params(t, map[string]any{
		"label": "",
	})}); err == nil {
		t.Fatal("an account was minted with no device label")
	}
}

// EVERY HANDLER IS REACHABLE.
//
// The method table is a map of name to function, and a handler that is written
// but never added to it is a handler that compiles, has passing unit tests --
// because those call it directly -- and answers "unknown method" to the only
// caller that matters.
//
// That happened: `createAccount`, `whoami`, `signRequest` and all seven
// pairing handlers were written, tested and unreachable, because an edit to
// the map silently did nothing and nothing noticed until a real client asked.
//
// This reads the source rather than reflecting, because Go has no way to
// enumerate the functions in a package at runtime -- and the source is what
// the omission is in.
func TestEveryHandlerIsRegistered(t *testing.T) {
	var defined []string
	for _, file := range []string{"crypto.go", "pairing.go", "rtc.go"} {
		src, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("reading %s: %v", file, err)
		}
		for _, line := range strings.Split(string(src), "\n") {
			if !strings.HasPrefix(line, "func handle") {
				continue
			}
			name := strings.TrimPrefix(strings.SplitN(line, "(", 2)[0], "func ")
			defined = append(defined, strings.TrimSpace(name))
		}
	}
	if len(defined) < 10 {
		t.Fatalf("found %d handlers; the parser is wrong, not the code", len(defined))
	}

	registered := map[string]bool{}
	for _, table := range []map[string]func(Request) (any, error){cryptoMethods, rtcMethods} {
		for name := range table {
			// `handleRtcOffer` is registered as `rtcOffer`, `handleLoad` as
			// `load`: the wire name is the handler's without the prefix and
			// with a lowercase first letter.
			registered[name] = true
		}
	}

	for _, fn := range defined {
		bare := strings.TrimPrefix(fn, "handle")
		wire := strings.ToLower(bare[:1]) + bare[1:]
		if !registered[wire] {
			t.Errorf("%s is written but not in any method table, so nothing can call it", fn)
		}
	}
}

// The head this returns is fed straight back in as `headEntry`, so the two
// have to agree on an encoding. They did not: `verifyRoster` answered hex and
// both `addDevice` and `pairHandoff` decode base64, so pairing died one step
// after the emoji matched -- the worst possible place, because by then the
// user has been told the two devices agree.
//
// Written as a ROUND TRIP rather than as "the head is base64", because that
// assertion would still pass if the two sides drifted to different base64
// alphabets or if `addDevice` later took raw bytes. What matters is that the
// head one call hands out is a head the next call accepts.
func TestTheRosterHeadCanBeFedStraightBackIn(t *testing.T) {
	keys.reset()
	t.Cleanup(keys.reset)

	minted, err := handleCreateAccount(Request{Method: "createAccount", Params: params(t, map[string]any{
		"label": "first device",
	})})
	if err != nil {
		t.Fatalf("createAccount: %v", err)
	}
	acct := minted.(map[string]any)

	verified, err := handleVerifyRoster(Request{Method: "verifyRoster", Params: params(t, map[string]any{
		"chain":       acct["genesis"],
		"rootSignPub": acct["rootSignPub"],
		"epoch1Sign":  acct["epoch1SignPub"],
	})})
	if err != nil {
		t.Fatalf("verifyRoster over the genesis chain: %v", err)
	}
	head := verified.(map[string]any)["headEntry"]
	seq, _ := verified.(map[string]any)["headSeq"].(uint64)

	// A second device's public halves. Their values do not matter here -- only
	// that the head is decodable -- but they have to be the right shape, or
	// the refusal would come from the wrong check and this test would pass
	// while the head stayed broken.
	pubSign, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generating a peer key: %v", err)
	}
	peerEnc, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generating a peer encryption key: %v", err)
	}

	if _, err := handleAddDevice(Request{Method: "addDevice", Params: params(t, map[string]any{
		"headEntry": head,
		"headSeq":   seq,
		"epoch":     uint64(1),
		"pubSign":   hex.EncodeToString(pubSign),
		"pubEnc":    hex.EncodeToString(peerEnc.PublicKey().Bytes()),
		"label":     "second device",
	})}); err != nil {
		t.Fatalf("the head from verifyRoster was not one addDevice could read: %v", err)
	}
}

// Getting back in with nothing but the twelve words.
//
// THE PATH NOBODY TAKES UNTIL EVERYTHING HAS GONE WRONG, which is exactly why
// it has to be tested rather than reasoned about: a recovery that does not
// work is discovered by somebody who has already lost every device, and there
// is no second chance to find out.
//
// The device keys are deliberately NOT recovered. The phrase does not carry
// them, because a device key re-derivable from something printed on a card
// would make the card sufficient to impersonate a machine. So a recovered
// device is a new device the root key vouches for — and this asserts that the
// entry it authors is ROOT-signed, which is what a person reviewing their
// devices sees as "added with the recovery phrase".
func TestRecoveringAnAccountFromThePhraseAlone(t *testing.T) {
	keys.reset()
	t.Cleanup(func() {
		keys.reset()
		_, _ = handleRecoverForget(Request{Method: "recoverForget"})
	})

	minted, err := handleCreateAccount(Request{Method: "createAccount", Params: params(t, map[string]any{
		"label": "the laptop that is now at the bottom of a canal",
	})})
	if err != nil {
		t.Fatalf("createAccount: %v", err)
	}
	acct := minted.(map[string]any)
	phrase := acct["mnemonic"].(string)
	genesis := acct["genesis"].(string)
	escrow := acct["escrow"].(string)

	// EVERYTHING GONE. Not a fresh process — the same one with its keys
	// zeroed, which is the closest this test can get to a new machine and is
	// strictly harder: a handler that read a leftover field would pass on a
	// new process and fail here.
	keys.reset()

	id, err := handleRecoverIdentity(Request{Method: "recoverIdentity", Params: params(t, map[string]any{
		"mnemonic": "  " + strings.ToUpper(phrase) + "  ",
		"label":    "the replacement",
	})})
	if err != nil {
		t.Fatalf("recoverIdentity: %v", err)
	}
	identity := id.(map[string]any)

	// The account id comes from the PHRASE, not from anything a server said.
	// If this were wrong, recovery would fetch another account's escrow and
	// fail with an AEAD error that names nothing.
	if identity["accountId"] != acct["accountId"] {
		t.Fatalf("the phrase named account %v, not %v", identity["accountId"], acct["accountId"])
	}
	// And a device key it can sign a login with, immediately — which is the
	// only reason recovery is two calls: the escrow cannot be fetched without
	// a session, and a session cannot be had without a key.
	if _, err := handleSignLogin(Request{Method: "signLogin", Params: params(t, map[string]any{
		"serverNonce": hex.EncodeToString(make([]byte, 32)),
		"serverSPKI":  hex.EncodeToString(make([]byte, 32)),
	})}); err != nil {
		t.Fatalf("a recovering device could not sign a login: %v", err)
	}

	opened, err := handleRecoverOpen(Request{Method: "recoverOpen", Params: params(t, map[string]any{
		"escrow": escrow,
		"chain":  genesis,
	})})
	if err != nil {
		t.Fatalf("recoverOpen: %v", err)
	}
	back := opened.(map[string]any)
	if back["epoch1SignPub"] != acct["epoch1SignPub"] {
		t.Fatal("the escrow gave a different epoch key than the account was minted with")
	}
	if n, _ := back["devices"].(int); n != 1 {
		t.Fatalf("the recovered roster holds %d devices", n)
	}

	// The entry is root-signed, and the chain says so. A verifier can tell a
	// recovery from an ordinary pairing by the signer alone, which is what
	// stops a device that merely HAD AK_n from claiming to be one.
	genesisWire, _ := base64.StdEncoding.DecodeString(genesis)
	entryWire, _ := base64.StdEncoding.DecodeString(back["entry"].(string))
	chain := base64.StdEncoding.EncodeToString(append(genesisWire, entryWire...))

	verified, err := handleVerifyRoster(Request{Method: "verifyRoster", Params: params(t, map[string]any{
		"chain": chain, "rootSignPub": acct["rootSignPub"], "epoch1Sign": acct["epoch1SignPub"],
	})})
	if err != nil {
		t.Fatalf("the recovered chain does not verify: %v", err)
	}
	v := verified.(map[string]any)
	devices := v["devices"].([]map[string]any)
	if len(devices) != 2 {
		t.Fatalf("after recovery the roster holds %d devices", len(devices))
	}
	if listed, _ := v["selfListed"].(bool); !listed {
		t.Fatal("the recovered device is not on the roster it just authored itself onto")
	}
	var recoveredRow map[string]any
	for _, d := range devices {
		if d["pubSign"] == identity["devicePub"] {
			recoveredRow = d
		}
	}
	if recoveredRow == nil {
		t.Fatal("the recovered device's key is not the one on the roster")
	}
	if added, _ := recoveredRow["mnemonicAdded"].(bool); !added {
		t.Fatal("the recovered device is not marked as added with the recovery phrase")
	}

	// And it can read the account's data, which is the point of all of it.
	if _, err := handleSeal(Request{Method: "seal", Params: params(t, map[string]any{
		"collection": "servers", "epoch": uint64(1), "schema": 1,
		"writerVersion": "test", "counter": uint64(1),
		"payload": base64.StdEncoding.EncodeToString([]byte("back")),
	})}); err != nil {
		t.Fatalf("a recovered device could not seal: %v", err)
	}
}

func TestAMistypedPhraseIsRefusedWithoutEchoingIt(t *testing.T) {
	keys.reset()
	t.Cleanup(keys.reset)

	_, err := handleRecoverIdentity(Request{Method: "recoverIdentity", Params: params(t, map[string]any{
		"mnemonic": "cattle regret sponsor buffalo fossil cage barely gate detail elephant taxi wrongword",
		"label":    "the replacement",
	})})
	if err == nil {
		t.Fatal("an invalid phrase was accepted")
	}
	// NOT ECHOED. A recovery phrase is a bearer token for the entire estate,
	// and this process redacts it out of its own log — an error message that
	// quoted it back would put it in the parent's log instead.
	if strings.Contains(err.Error(), "wrongword") || strings.Contains(err.Error(), "cattle") {
		t.Fatalf("the refusal echoed the phrase back: %v", err)
	}
}

func TestRecoveryRefusesAnEscrowForAnotherAccount(t *testing.T) {
	keys.reset()
	t.Cleanup(func() {
		keys.reset()
		_, _ = handleRecoverForget(Request{Method: "recoverForget"})
	})

	mine, err := handleCreateAccount(Request{Method: "createAccount", Params: params(t, map[string]any{"label": "mine"})})
	if err != nil {
		t.Fatal(err)
	}
	a := mine.(map[string]any)
	keys.reset()
	theirs, err := handleCreateAccount(Request{Method: "createAccount", Params: params(t, map[string]any{"label": "theirs"})})
	if err != nil {
		t.Fatal(err)
	}
	b := theirs.(map[string]any)
	keys.reset()

	if _, err := handleRecoverIdentity(Request{Method: "recoverIdentity", Params: params(t, map[string]any{
		"mnemonic": a["mnemonic"], "label": "the replacement",
	})}); err != nil {
		t.Fatal(err)
	}

	// The relay handing over somebody else's escrow, which it can do: it holds
	// both and cannot read either. Refused as a REFUSAL rather than reported
	// as a bad phrase, because the card is fine and sending the user to hunt
	// for a better one would waste the worst afternoon of their year.
	_, err = handleRecoverOpen(Request{Method: "recoverOpen", Params: params(t, map[string]any{
		"escrow": b["escrow"], "chain": b["genesis"],
	})})
	if err == nil {
		t.Fatal("an escrow belonging to another account was opened")
	}
	if strings.Contains(err.Error(), "recovery phrase") {
		t.Fatalf("a relay-supplied escrow was blamed on the user's phrase: %v", err)
	}
}
