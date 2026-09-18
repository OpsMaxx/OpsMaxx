package main

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

// Two peer connections, one data channel, one payload.
//
// THE M4 GATE, as far as one machine can prove it: the store-and-forward path
// carries a clipboard when the far end is asleep, and this is the other half --
// bytes going device to device without the relay carrying them. Both ends run
// in this process, which means the network is loopback and the NAT traversal
// is trivial; what it does prove is that the offer/answer/accept sequence
// completes, the channel opens, and what arrives is what was sent.
//
// What it cannot prove is the case the whole feature exists for: two symmetric
// NATs and a relay. That needs two machines and is a manual check.

func rtcCall(t *testing.T, handler func(Request) (any, error), params any) map[string]any {
	t.Helper()
	v, err := handler(Request{Method: "rtc", Params: paramsOf(t, params)})
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	m, ok := v.(map[string]any)
	if !ok {
		t.Fatalf("handler returned %T", v)
	}
	return m
}

func paramsOf(t *testing.T, v any) []byte {
	t.Helper()
	return params(t, v)
}

func TestTwoPeersExchangeAPayloadDirectly(t *testing.T) {
	t.Cleanup(func() {
		for _, id := range []string{"a", "b"} {
			_, _ = handleRtcClose(Request{Params: paramsOf(t, map[string]any{"sessionId": id})})
		}
	})

	// No ICE servers: on loopback there is nothing to traverse, and a test
	// that reached for a public STUN server would be a test that fails when
	// the network does.
	offer := rtcCall(t, handleRtcOffer, map[string]any{"sessionId": "a", "iceServers": []any{}})
	sdpOffer, _ := offer["sdp"].(string)
	if sdpOffer == "" {
		t.Fatal("no offer was produced")
	}

	answer := rtcCall(t, handleRtcAnswer, map[string]any{
		"sessionId": "b", "sdp": sdpOffer, "iceServers": []any{},
	})
	sdpAnswer, _ := answer["sdp"].(string)
	if sdpAnswer == "" {
		t.Fatal("no answer was produced")
	}

	accepted := rtcCall(t, handleRtcAccept, map[string]any{"sessionId": "a", "sdp": sdpAnswer})
	if accepted["open"] != true {
		t.Fatalf("the channel did not open: %v", accepted)
	}

	// The payload is opaque here by construction: --crypto sealed it and this
	// process cannot open it. What matters is that the bytes are unchanged.
	payload := []byte("sealed clipboard bytes that --rtc cannot read")
	sent := rtcCall(t, handleRtcSend, map[string]any{
		"sessionId": "a", "payload": base64.StdEncoding.EncodeToString(payload),
	})
	if sent["sent"] != len(payload) {
		t.Fatalf("sent %v of %d bytes", sent["sent"], len(payload))
	}

	got := rtcCall(t, handleRtcReceive, map[string]any{"sessionId": "b", "waitMs": 5000})
	encoded, _ := got["payload"].(string)
	if encoded == "" {
		t.Fatal("nothing arrived on the other side")
	}
	arrived, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if string(arrived) != string(payload) {
		t.Fatalf("the payload changed in flight: %q", arrived)
	}
}

// A quiet channel is the normal state of a clipboard nobody is using. A caller
// that treated silence as a failure would back off from a working connection.
func TestAQuietChannelIsNotAnError(t *testing.T) {
	t.Cleanup(func() {
		_, _ = handleRtcClose(Request{Params: paramsOf(t, map[string]any{"sessionId": "quiet"})})
	})
	rtcCall(t, handleRtcOffer, map[string]any{"sessionId": "quiet", "iceServers": []any{}})

	got := rtcCall(t, handleRtcReceive, map[string]any{"sessionId": "quiet", "waitMs": 50})
	if got["payload"] != nil {
		t.Fatalf("something arrived on a channel nobody wrote to: %v", got["payload"])
	}
}

// THE FALLBACK HINGE. A peer that cannot be reached directly is the ordinary
// case this design has store-and-forward for, so it gets its own code rather
// than a generic failure -- a caller that could not tell them apart would
// report an error where it should have left a message.
func TestAnUnreachablePeerHasItsOwnCode(t *testing.T) {
	_, err := handleRtcSend(Request{Params: paramsOf(t, map[string]any{
		"sessionId": "nobody", "payload": base64.StdEncoding.EncodeToString([]byte("x")),
	})})
	if err == nil {
		t.Fatal("sending to a session that does not exist succeeded")
	}
	if code := codeOf(err); code != ErrPeerUnreachable {
		t.Fatalf("an unknown session reported as %q", code)
	}
}

// THE LEAK BUDGET, from the first commit rather than after the first report.
//
// A peer connection that is never closed holds goroutines, a UDP socket and an
// ICE agent. The symptom is an app that is fine for an hour and unusable by
// the evening, which is the hardest kind of bug to attribute.
func TestClosingASessionReleasesIt(t *testing.T) {
	before := rtcCall(t, handleRtcStats, map[string]any{})

	for i := 0; i < 5; i++ {
		id := "leak-" + string(rune('a'+i))
		rtcCall(t, handleRtcOffer, map[string]any{"sessionId": id, "iceServers": []any{}})
		rtcCall(t, handleRtcClose, map[string]any{"sessionId": id})
	}

	after := rtcCall(t, handleRtcStats, map[string]any{})
	if after["sessions"] != before["sessions"] {
		t.Fatalf("sessions went from %v to %v; five were opened and five closed",
			before["sessions"], after["sessions"])
	}

	// Goroutines settle asynchronously -- pion's own shutdown is not
	// instantaneous -- so this allows a window rather than demanding zero.
	// What it catches is a leak per connection, which is what five of them
	// would show.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		now := rtcCall(t, handleRtcStats, map[string]any{})
		if now["goroutines"].(int)-before["goroutines"].(int) < 20 {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	final := rtcCall(t, handleRtcStats, map[string]any{})
	t.Fatalf("goroutines went from %v to %v after five open/close cycles",
		before["goroutines"], final["goroutines"])
}

// The split the two subcommands exist for, in the other direction.
func TestTheCryptoRoleCannotReachAnyRtcMethod(t *testing.T) {
	var buf strings.Builder
	w := NewWriter(&buf)
	for method := range rtcMethods {
		buf.Reset()
		dispatch(t.Context(), w, "crypto", Request{ID: "1", Method: method})
		if !strings.Contains(buf.String(), "unknown method") {
			t.Errorf("the crypto role reached %q: %s", method, buf.String())
		}
	}
}
