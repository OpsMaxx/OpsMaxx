package main

import (
	"bytes"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"github.com/opsmaxx/opsmaxx/sidecar/addyd/pair"
	"github.com/opsmaxx/opsmaxx/sidecar/addyd/protocol"
	"strings"
	"testing"
)

// A pairing, both ends, in one process.
//
// Two devices in reality; here the same code driving both sides, which is what
// makes the ordering visible: each step is a separate call and the SAS appears
// only where it is allowed to.

// Takes the handler's two return values as one argument, so a call reads as
// `result(t, handleThing(req))` rather than needing a temporary pair.
func result(t *testing.T, v any, err error) map[string]any {
	t.Helper()
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	m, ok := v.(map[string]any)
	if !ok {
		t.Fatalf("handler returned %T", v)
	}
	return m
}

func nested(t *testing.T, m map[string]any, key string) map[string]string {
	t.Helper()
	sub, ok := m[key].(map[string]string)
	if !ok {
		t.Fatalf("%s is %T", key, m[key])
	}
	return sub
}

// The happy path, and the ORDER in it.
func TestTwoDevicesPairAndSeeTheSameEmoji(t *testing.T) {
	loadTestAccount(t)
	defer func() { pairings.mu.Lock(); pairings.initiator = map[string]*pair.Initiator{}; pairings.mu.Unlock() }()

	begunRaw, begunErr := handlePairBegin(Request{Method: "pairBegin"})
	begun := result(t, begunRaw, begunErr)
	code := begun["code"].(string)
	start := nested(t, begun, "startFrame")
	id := begun["pairingId"].(string)

	// The joiner is a different device with its own key. In this test it is
	// the same process, so the account's key is cleared first -- which also
	// exercises the path where a joining device has no account yet, because
	// it is about to be ADDED to one.
	keys.mu.Lock()
	keys.device = nil
	keys.mu.Unlock()

	joinedRaw, joinedErr := handlePairJoin(Request{Method: "pairJoin", Params: params(t, map[string]any{
		"code":      code,
		"pairingId": id,
		"msgA":      start["msgA"],
		"pubSign":   start["pubSign"],
	})})
	joined := result(t, joinedRaw, joinedErr)
	// NO SAS on the joiner's first answer. It has not verified the
	// initiator's confirmation yet, so any emoji shown now would come from a
	// session nobody has authenticated.
	if _, present := joined["sas"]; present {
		t.Fatal("the joiner produced comparison emoji before confirming the other end")
	}
	reply := nested(t, joined, "replyFrame")

	repliedRaw, repliedErr := handlePairReply(Request{Method: "pairReply", Params: params(t, map[string]any{
		"pairingId": id,
		"msgB":      reply["msgB"],
		"confirmB":  reply["confirmB"],
		"pubSign":   reply["pubSign"],
		"pubEnc":    reply["pubEnc"],
	})})
	replied := result(t, repliedRaw, repliedErr)
	initiatorSAS := replied["sas"].([]string)
	confirm := nested(t, replied, "confirmFrame")

	confirmedRaw, confirmedErr := handlePairConfirm(Request{Method: "pairConfirm", Params: params(t, map[string]any{
		"pairingId": id,
		"confirmA":  confirm["confirmA"],
	})})
	confirmed := result(t, confirmedRaw, confirmedErr)
	joinerSAS := confirmed["sas"].([]string)

	// SEVEN EMOJI, THE SAME ON BOTH ENDS. That is the whole user-visible
	// security of pairing: two people comparing a short list out of band.
	if len(initiatorSAS) != 7 {
		t.Fatalf("the SAS is %d emoji", len(initiatorSAS))
	}
	if strings.Join(initiatorSAS, " ") != strings.Join(joinerSAS, " ") {
		t.Fatalf("the two devices computed different emoji:\n  %v\n  %v", initiatorSAS, joinerSAS)
	}
	// Read aloud as words too, so a phone call works as well as a photograph.
	if replied["sasWords"] == "" || confirmed["sasWords"] != replied["sasWords"] {
		t.Fatalf("the spoken form differs: %q vs %q", replied["sasWords"], confirmed["sasWords"])
	}
}

// A WRONG CODE IS ONE GUESS, not an offline target -- that is SPAKE2's whole
// contribution. The limiter is here so a shoulder-surfed or mistyped code
// fails visibly rather than letting somebody grind quietly.
func TestAWrongCodeIsRefusedAndCounted(t *testing.T) {
	loadTestAccount(t)

	begunRaw, begunErr := handlePairBegin(Request{Method: "pairBegin"})
	begun := result(t, begunRaw, begunErr)
	start := nested(t, begun, "startFrame")
	id := begun["pairingId"].(string)

	keys.mu.Lock()
	keys.device = nil
	keys.mu.Unlock()

	// A WELL-FORMED code that is not the right one, which is the case that
	// matters: a malformed one is rejected by the code parser before SPAKE2 is
	// involved at all, and proves nothing about the protocol. This one gets
	// all the way to the confirmation MAC, which is where a wrong code is
	// supposed to die.
	wrongCode, err := pair.NewCode()
	if err != nil {
		t.Fatal(err)
	}
	if wrongCode == begun["code"].(string) {
		t.Fatal("two draws produced the same code; the generator is broken, not the test")
	}
	joinedRaw, joinedErr := handlePairJoin(Request{Method: "pairJoin", Params: params(t, map[string]any{
		"code":      wrongCode,
		"pairingId": id,
		"msgA":      start["msgA"],
		"pubSign":   start["pubSign"],
	})})
	joined := result(t, joinedRaw, joinedErr)
	reply := nested(t, joined, "replyFrame")

	for i := 0; i < maxAttempts; i++ {
		_, err = handlePairReply(Request{Method: "pairReply", Params: params(t, map[string]any{
			"pairingId": id,
			"msgB":      reply["msgB"],
			"confirmB":  reply["confirmB"],
			"pubSign":   reply["pubSign"],
			"pubEnc":    reply["pubEnc"],
		})})
		if err == nil {
			t.Fatalf("attempt %d with the wrong code succeeded", i)
		}
	}

	// Spent. The session is gone, not merely refusing, so there is nothing
	// left to send frames to.
	_, err = handlePairReply(Request{Method: "pairReply", Params: params(t, map[string]any{
		"pairingId": id, "msgB": reply["msgB"], "confirmB": reply["confirmB"],
		"pubSign": reply["pubSign"], "pubEnc": reply["pubEnc"],
	})})
	if err == nil {
		t.Fatal("a spent pairing still accepted a frame")
	}
}

func TestForgettingAPairingRemovesTheSecret(t *testing.T) {
	loadTestAccount(t)
	begunRaw, begunErr := handlePairBegin(Request{Method: "pairBegin"})
	begun := result(t, begunRaw, begunErr)
	id := begun["pairingId"].(string)

	if _, err := handlePairForget(Request{Method: "pairForget", Params: params(t, map[string]any{
		"pairingId": id,
	})}); err != nil {
		t.Fatal(err)
	}

	// Called when the user says the emoji do not match. A session left in the
	// map is one an attacker can still send frames to, and the map is the only
	// thing holding the shared secret.
	pairings.mu.Lock()
	_, stillThere := pairings.initiator[id]
	pairings.mu.Unlock()
	if stillThere {
		t.Fatal("the pairing survived being forgotten")
	}
}

func TestAnUnknownPairingIsRefused(t *testing.T) {
	_, err := handlePairReply(Request{Method: "pairReply", Params: params(t, map[string]any{
		"pairingId": hex.EncodeToString([]byte("nope")),
		"msgB":      base64.StdEncoding.EncodeToString([]byte("x")),
		"confirmB":  base64.StdEncoding.EncodeToString([]byte("x")),
		"pubSign":   hex.EncodeToString(make([]byte, 32)),
		"pubEnc":    hex.EncodeToString(make([]byte, 32)),
	})})
	if err == nil {
		t.Fatal("a pairing id nobody started was accepted")
	}
	if code := codeOf(err); code != ErrPairingExpired {
		t.Fatalf("an unknown pairing reported as %q", code)
	}
}

// PAIRING THAT ACTUALLY JOINS AN ACCOUNT.
//
// Confirming the emoji proves who the other device is. It does not make the
// joiner a member of anything -- until the handoff ran, a device could complete
// a pairing, see matching emoji, and then find it could not read a single
// object, which looks like broken sync rather than an unfinished pairing.
func TestAJoinedDeviceEndsUpOnTheAccount(t *testing.T) {
	acct, epoch := loadTestAccount(t)

	// The initiator's AK_n. Held by the parent and handed in for this one
	// operation, which is why it is a parameter rather than something the
	// sidecar digs out of its own state.
	akSeed := bytes.Repeat([]byte{0x42}, 32)
	head := []byte("a roster head, verbatim")

	begunRaw, begunErr := handlePairBegin(Request{Method: "pairBegin"})
	begun := result(t, begunRaw, begunErr)
	code := begun["code"].(string)
	id := begun["pairingId"].(string)
	start := nested(t, begun, "startFrame")

	// The joiner: a different device, so no account and its own fresh key.
	initiatorDevice := keys.device
	keys.mu.Lock()
	keys.device = nil
	keys.mu.Unlock()

	joinedRaw, joinedErr := handlePairJoin(Request{Method: "pairJoin", Params: params(t, map[string]any{
		"code": code, "pairingId": id, "msgA": start["msgA"], "pubSign": start["pubSign"],
	})})
	joined := result(t, joinedRaw, joinedErr)
	reply := nested(t, joined, "replyFrame")

	// Back on the initiator for the reply, which is where the emoji appear.
	joinerDevice := keys.device
	keys.mu.Lock()
	keys.device = initiatorDevice
	keys.loaded = true
	keys.mu.Unlock()

	repliedRaw, repliedErr := handlePairReply(Request{Method: "pairReply", Params: params(t, map[string]any{
		"pairingId": id, "msgB": reply["msgB"], "confirmB": reply["confirmB"],
		"pubSign": reply["pubSign"], "pubEnc": reply["pubEnc"],
	})})
	replied := result(t, repliedRaw, repliedErr)
	confirm := nested(t, replied, "confirmFrame")

	// The human says the emoji match. ONLY NOW is anything sealed.
	handoffRaw, handoffErr := handlePairHandoff(Request{Method: "pairHandoff", Params: params(t, map[string]any{
		"pairingId":  id,
		"epoch":      epoch,
		"akSeed":     base64.StdEncoding.EncodeToString(akSeed),
		"headEntry":  base64.StdEncoding.EncodeToString(head),
		"peerPubEnc": nested(t, replied, "peer")["pubEnc"],
		"counter":    1,
	})})
	handoff := result(t, handoffRaw, handoffErr)

	// Back on the joiner, which confirms and then opens.
	keys.mu.Lock()
	keys.device = joinerDevice
	keys.account = protocol.AccountID{}
	keys.epochs = map[uint64]*protocol.EpochKeys{}
	keys.loaded = false
	keys.mu.Unlock()

	if _, err := handlePairConfirm(Request{Method: "pairConfirm", Params: params(t, map[string]any{
		"pairingId": id, "confirmA": confirm["confirmA"],
	})}); err != nil {
		t.Fatalf("the joiner could not confirm: %v", err)
	}

	acceptedRaw, acceptedErr := handlePairAccept(Request{Method: "pairAccept", Params: params(t, map[string]any{
		"pairingId": id, "handoff": handoff["handoff"], "epoch": epoch, "counter": 1,
		"accountId": start["accountId"],
	})})
	accepted := result(t, acceptedRaw, acceptedErr)

	// THE ACCOUNT, not a claim about it: the id came out of the sealed
	// handoff, which only the holder of the joiner's key could open.
	if accepted["accountId"] != acct.String() {
		t.Fatalf("the joiner landed on account %v, not %s", accepted["accountId"], acct)
	}

	// And it can now actually read: sealing and opening under the epoch it was
	// handed is the whole point of having been given it.
	sealedRaw, sealedErr := handleSeal(Request{Method: "seal", Params: params(t, map[string]any{
		"collection": "servers", "epoch": epoch, "schema": 1,
		"writerVersion": "test", "counter": 1,
		"payload": base64.StdEncoding.EncodeToString([]byte("visible to a joined device")),
	})})
	sealed := result(t, sealedRaw, sealedErr)
	openedRaw, openedErr := handleOpen(Request{Method: "open", Params: params(t, map[string]any{
		"collection": "servers", "epoch": epoch, "sealed": sealed["sealed"],
		"knownSchema": 1, "seenCounter": 0,
	})})
	opened := result(t, openedRaw, openedErr)
	got, _ := base64.StdEncoding.DecodeString(opened["payload"].(string))
	if string(got) != "visible to a joined device" {
		t.Fatalf("the joined device read %q", got)
	}
}

// A handoff outside a live pairing has no binding to bind to, and sealing one
// anyway would be sealing to whoever asked.
func TestAHandoffNeedsAConfirmedPairing(t *testing.T) {
	loadTestAccount(t)
	_, err := handlePairHandoff(Request{Method: "pairHandoff", Params: params(t, map[string]any{
		"pairingId": "0000", "epoch": uint64(1),
		"akSeed":     base64.StdEncoding.EncodeToString(make([]byte, 32)),
		"headEntry":  base64.StdEncoding.EncodeToString([]byte("x")),
		"peerPubEnc": hex.EncodeToString(make([]byte, 32)),
		"counter":    uint64(1),
	})})
	if err == nil {
		t.Fatal("a handoff was sealed with no pairing behind it")
	}
	if code := codeOf(err); code != ErrPairingExpired {
		t.Fatalf("reported as %q", code)
	}
}

// THE HALF THAT USED TO BE MISSING, in one process.
//
// `TestTwoDevicesPairAndSeeTheSameEmoji` stops where the app used to stop: the
// emoji match and nothing else happens. The app then said "Device added" and
// the account still held one device. This carries on past the comparison --
// handoff, roster entry, accept -- and finishes by asking the JOINER to verify
// the chain under the keys it was handed, which is the only statement worth
// making: the second device can read the account, and the roster says so.
//
// The two roles share one process and one `keys`, so the vault is swapped
// between them. That is not a shortcut around the test: a pairing where both
// ends have the same device key would pass a weaker test and fail this one at
// `pairAccept`, because the handoff is sealed to the joiner's X25519 key.
func TestPairingPutsTheSecondDeviceOnTheRoster(t *testing.T) {
	keys.reset()
	t.Cleanup(func() {
		keys.reset()
		pairings.mu.Lock()
		pairings.initiator = map[string]*pair.Initiator{}
		pairings.joiner = map[string]*pair.Joiner{}
		pairings.mu.Unlock()
	})

	initiatorVault := keys
	joinerVault := &vault{epochs: map[uint64]*protocol.EpochKeys{}}
	as := func(v *vault) { keys = v }
	t.Cleanup(func() { keys = initiatorVault })

	// Go will not spread a two-value call into `result(t, ...)` when it is not
	// the only argument, so the handler and its params go in instead.
	run := func(h func(Request) (any, error), method string, p map[string]any) map[string]any {
		t.Helper()
		v, err := h(Request{Method: method, Params: params(t, p)})
		return result(t, v, err)
	}

	minted := run(handleCreateAccount, "createAccount", map[string]any{"label": "laptop"})
	secrets := nested(t, minted, "secrets")
	genesis := minted["genesis"].(string)

	verify := func(chain string, root, epoch1 any) map[string]any {
		t.Helper()
		return run(handleVerifyRoster, "verifyRoster", map[string]any{
			"chain": chain, "rootSignPub": root, "epoch1Sign": epoch1,
		})
	}
	before := verify(genesis, minted["rootSignPub"], minted["epoch1SignPub"])
	if n := len(before["devices"].([]map[string]any)); n != 1 {
		t.Fatalf("a fresh account starts with %d devices", n)
	}

	// --- SPAKE2 and the comparison, as the other test covers -------------
	begun := run(handlePairBegin, "pairBegin", map[string]any{})
	id := begun["pairingId"].(string)
	start := nested(t, begun, "startFrame")

	as(joinerVault)
	joined := run(handlePairJoin, "pairJoin", map[string]any{
		"code": begun["code"], "pairingId": id,
		"msgA": start["msgA"], "pubSign": start["pubSign"],
	})
	reply := nested(t, joined, "replyFrame")

	as(initiatorVault)
	replied := run(handlePairReply, "pairReply", map[string]any{
		"pairingId": id, "msgB": reply["msgB"], "confirmB": reply["confirmB"],
		"pubSign": reply["pubSign"], "pubEnc": reply["pubEnc"],
	})
	confirmFrame := nested(t, replied, "confirmFrame")

	as(joinerVault)
	confirmed := run(handlePairConfirm, "pairConfirm", map[string]any{
		"pairingId": id, "confirmA": confirmFrame["confirmA"],
	})
	self := nested(t, confirmed, "self")

	// --- past the comparison ---------------------------------------------
	as(initiatorVault)
	sealed := run(handlePairHandoff, "pairHandoff", map[string]any{
		"pairingId":  id,
		"epoch":      uint64(1),
		"akSeed":     secrets["akSeed"],
		"headEntry":  before["headEntry"],
		"peerPubEnc": self["pubEnc"],
		"counter":    uint64(1),
	})

	entry := run(handleAddDevice, "addDevice", map[string]any{
		"headEntry": before["headEntry"],
		"headSeq":   before["headSeq"],
		"epoch":     uint64(1),
		"pubSign":   self["pubSign"],
		"pubEnc":    self["pubEnc"],
		"label":     "desktop",
	})
	if seq, _ := entry["seq"].(uint64); seq != 1 {
		t.Fatalf("the new entry is seq %v, not the one after genesis", entry["seq"])
	}

	// The relay stores entries and serves them back concatenated; appending is
	// exactly what it does with the bytes it is given.
	genesisWire, _ := base64.StdEncoding.DecodeString(genesis)
	entryWire, err := base64.StdEncoding.DecodeString(entry["entry"].(string))
	if err != nil {
		t.Fatalf("the new entry is not base64: %v", err)
	}
	chain := base64.StdEncoding.EncodeToString(append(genesisWire, entryWire...))

	after := verify(chain, minted["rootSignPub"], minted["epoch1SignPub"])
	if n := len(after["devices"].([]map[string]any)); n != 2 {
		t.Fatalf("after pairing the roster holds %d device(s)", n)
	}

	// --- and the joiner can read it --------------------------------------
	as(joinerVault)
	accepted := run(handlePairAccept, "pairAccept", map[string]any{
		"pairingId": id,
		"handoff":   sealed["handoff"],
		"epoch":     uint64(1),
		"counter":   uint64(1),
		"accountId": minted["accountId"],
	})
	if accepted["accountId"] != minted["accountId"] {
		t.Fatalf("the joiner joined %v, not %v", accepted["accountId"], minted["accountId"])
	}

	// THE CLAIM THE TOAST MAKES, checked under the joiner's own keys: it is a
	// member of this account and the signed chain says so. Verified with the
	// keys the HANDOFF carried, never with the ones the initiator happens to
	// have in the same process -- that distinction is the whole test.
	joinerView := verify(chain, accepted["rootSignPub"], accepted["epoch1SignPub"])
	if n := len(joinerView["devices"].([]map[string]any)); n != 2 {
		t.Fatalf("the joiner reads %d device(s) from the chain", n)
	}
	if listed, _ := joinerView["selfListed"].(bool); !listed {
		t.Fatal("the joining device is not listed in the roster it just verified")
	}
}

// Taking a device back off the account.
//
// The entry `revoke.ts` has been waiting for since it was written. What makes
// it worth a test beyond "an entry came back" is the two refusals: a revoke
// that names a substituted encryption key would be a way to REWRITE a live
// device's key, and a device that revokes itself wipes the machine the user is
// sitting at, one press away, on a list where one row is "this device".
func TestRevokingADeviceRemovesItAndRefusesSelfRevocation(t *testing.T) {
	keys.reset()
	t.Cleanup(keys.reset)

	run := func(h func(Request) (any, error), method string, p map[string]any) map[string]any {
		t.Helper()
		v, err := h(Request{Method: method, Params: params(t, p)})
		return result(t, v, err)
	}

	minted := run(handleCreateAccount, "createAccount", map[string]any{"label": "laptop"})
	genesis := minted["genesis"].(string)
	verify := func(chain string) map[string]any {
		t.Helper()
		return run(handleVerifyRoster, "verifyRoster", map[string]any{
			"chain": chain, "rootSignPub": minted["rootSignPub"], "epoch1Sign": minted["epoch1SignPub"],
		})
	}

	// A second device on the chain, authored the way pairing authors it.
	peerSign, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	peerEnc, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	before := verify(genesis)
	added := run(handleAddDevice, "addDevice", map[string]any{
		"headEntry": before["headEntry"], "headSeq": before["headSeq"], "epoch": uint64(1),
		"pubSign": hex.EncodeToString(peerSign),
		"pubEnc":  hex.EncodeToString(peerEnc.PublicKey().Bytes()),
		"label":   "desktop",
	})
	genesisWire, _ := base64.StdEncoding.DecodeString(genesis)
	addWire, _ := base64.StdEncoding.DecodeString(added["entry"].(string))
	two := base64.StdEncoding.EncodeToString(append(genesisWire, addWire...))

	withBoth := verify(two)
	if n := len(withBoth["devices"].([]map[string]any)); n != 2 {
		t.Fatalf("the chain holds %d devices before the revoke", n)
	}

	// ---- the revoke ------------------------------------------------------
	revoked := run(handleRevokeDevice, "revokeDevice", map[string]any{
		"headEntry": withBoth["headEntry"], "headSeq": withBoth["headSeq"], "epoch": uint64(1),
		"pubSign": hex.EncodeToString(peerSign),
		"pubEnc":  hex.EncodeToString(peerEnc.PublicKey().Bytes()),
	})
	revWire, _ := base64.StdEncoding.DecodeString(revoked["entry"].(string))
	three := base64.StdEncoding.EncodeToString(append(append(genesisWire, addWire...), revWire...))

	after := verify(three)
	devices := after["devices"].([]map[string]any)
	if len(devices) != 1 {
		t.Fatalf("after the revoke the chain holds %d devices", len(devices))
	}
	// The verifier applies revocations as it walks, so the removed device is
	// ABSENT rather than flagged — there is no field a forged entry could set
	// to claim otherwise.
	if devices[0]["pubSign"] == hex.EncodeToString(peerSign) {
		t.Fatal("the revoked device is the one still listed")
	}
	if listed, _ := after["selfListed"].(bool); !listed {
		t.Fatal("the revoking device removed itself")
	}

	// ---- and the two refusals -------------------------------------------
	_, err = handleRevokeDevice(Request{Method: "revokeDevice", Params: params(t, map[string]any{
		"headEntry": after["headEntry"], "headSeq": after["headSeq"], "epoch": uint64(1),
		"pubSign": devices[0]["pubSign"],
		"pubEnc":  devices[0]["pubEnc"],
	})})
	if err == nil {
		t.Fatal("a device was allowed to revoke itself, which wipes the machine the user is on")
	}
	if !strings.Contains(err.Error(), "cannot revoke itself") {
		t.Fatalf("self-revocation was refused for the wrong reason: %v", err)
	}

	// A revoke naming a DIFFERENT encryption key than the chain has. Refused
	// by the verifier rather than here, because otherwise "revoke" would be a
	// way to rewrite a live device's encryption key — so what this asserts is
	// that such an entry does not verify, not that it cannot be authored.
	other, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	bad := run(handleRevokeDevice, "revokeDevice", map[string]any{
		"headEntry": withBoth["headEntry"], "headSeq": withBoth["headSeq"], "epoch": uint64(1),
		"pubSign": hex.EncodeToString(peerSign),
		"pubEnc":  hex.EncodeToString(other.PublicKey().Bytes()),
	})
	badWire, _ := base64.StdEncoding.DecodeString(bad["entry"].(string))
	_, err = handleVerifyRoster(Request{Method: "verifyRoster", Params: params(t, map[string]any{
		"chain":       base64.StdEncoding.EncodeToString(append(append(genesisWire, addWire...), badWire...)),
		"rootSignPub": minted["rootSignPub"], "epoch1Sign": minted["epoch1SignPub"],
	})})
	if err == nil {
		t.Fatal("a revoke with a substituted encryption key verified")
	}
}
