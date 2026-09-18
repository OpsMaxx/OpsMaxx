package main

import (
	"encoding/base64"
	"encoding/hex"
	"github.com/opsmaxx/opsmaxx/sidecar/addyd/pair"
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
