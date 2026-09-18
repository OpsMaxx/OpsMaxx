package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

// The --rtc role.
//
// THIS PROCESS NEVER SEES AN ACCOUNT KEY. It speaks WebRTC and nothing else:
// it parses SDP, STUN, DTLS and SRTP straight off the open internet, which is
// exactly the code that should not be loaded in the address space holding the
// account key. The payloads it carries are already sealed by --crypto before
// they get here and it cannot open any of them.
//
// What crosses the boundary in this direction is an offer, an answer, ICE
// candidates and opaque bytes. Nothing else.

// dataChannelLabel is the one channel this opens. A label rather than several
// channels: the parent multiplexes by putting a kind in the sealed payload,
// which keeps the channel count at one and the failure modes with it.
const dataChannelLabel = "addy"

// connectTimeout bounds a dial. ICE gathering against a symmetric NAT can take
// a while and can also never finish; a dial that never returns is a spinner
// nobody can stop.
const connectTimeout = 20 * time.Second

type rtcSession struct {
	pc      *webrtc.PeerConnection
	channel *webrtc.DataChannel
	// inbound buffers what arrived before the parent asked for it. A channel
	// rather than a callback into the parent, because the parent's read is a
	// request/response call and a callback would have to invent a queue
	// anyway.
	inbound chan []byte
	opened  chan struct{}
	once    sync.Once
}

var rtcSessions = struct {
	mu sync.Mutex
	m  map[string]*rtcSession
}{m: map[string]*rtcSession{}}

// rtcConfig builds the ICE configuration from what the parent supplies.
//
// The parent has already asked the relay how to relay and been told
// "embedded", "external" or "none". It passes the answer through rather than
// this process asking, because asking would mean this process holding a
// session token -- and a token is a credential, which is the thing the split
// exists to keep out of here.
func rtcConfig(iceServers []webrtc.ICEServer) webrtc.Configuration {
	return webrtc.Configuration{
		ICEServers: iceServers,
		// All candidate types. A relay-only policy would work on every network
		// and route every byte through somebody's bandwidth; a host-only one
		// is free and fails on the networks this exists for. The ordering pion
		// does by default -- host, srflx, relay -- is decreasing quality and
		// increasing reliability, which is the order to want.
		ICETransportPolicy: webrtc.ICETransportPolicyAll,
	}
}

type iceServerParam struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

func toICEServers(in []iceServerParam) []webrtc.ICEServer {
	out := make([]webrtc.ICEServer, 0, len(in))
	for _, s := range in {
		server := webrtc.ICEServer{URLs: s.URLs}
		if s.Username != "" {
			server.Username = s.Username
			server.Credential = s.Credential
		}
		out = append(out, server)
	}
	return out
}

func newSession(iceServers []webrtc.ICEServer) (*rtcSession, error) {
	pc, err := webrtc.NewPeerConnection(rtcConfig(iceServers))
	if err != nil {
		return nil, err
	}
	s := &rtcSession{
		pc: pc,
		// Buffered. A peer that sends three messages before the parent reads
		// one must not block pion's own goroutine -- which is the shape that
		// wedges a whole peer connection rather than one message.
		inbound: make(chan []byte, 32),
		opened:  make(chan struct{}),
	}
	return s, nil
}

func (s *rtcSession) attach(dc *webrtc.DataChannel) {
	s.channel = dc
	dc.OnOpen(func() { s.once.Do(func() { close(s.opened) }) })
	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		select {
		case s.inbound <- msg.Data:
		default:
			// Dropped rather than blocking pion's goroutine. A full queue means
			// the parent has stopped reading, and blocking here would take the
			// connection down instead of one message.
		}
	})
}

// close releases everything. NEVER CALLED FROM INSIDE A PION CALLBACK: pion
// holds its own locks while a callback runs, and closing the connection from
// one deadlocks it. Every path here is a handler the parent invoked.
func (s *rtcSession) close() {
	if s.channel != nil {
		_ = s.channel.Close()
	}
	if s.pc != nil {
		_ = s.pc.Close()
	}
}

// --- offer ---

func handleRtcOffer(req Request) (any, error) {
	var in struct {
		SessionID  string           `json:"sessionId"`
		ICEServers []iceServerParam `json:"iceServers"`
	}
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}
	if in.SessionID == "" {
		return nil, codedf(ErrConfigInvalid, "a session id is required")
	}

	s, err := newSession(toICEServers(in.ICEServers))
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "creating a peer connection")
	}

	dc, err := s.pc.CreateDataChannel(dataChannelLabel, nil)
	if err != nil {
		s.close()
		return nil, wrapCoded(ErrInternal, err, "creating the data channel")
	}
	s.attach(dc)

	offer, err := s.pc.CreateOffer(nil)
	if err != nil {
		s.close()
		return nil, wrapCoded(ErrInternal, err, "creating the offer")
	}
	// Gathering completes before the offer is returned, so the parent sends
	// ONE frame rather than an offer followed by a trickle of candidates. That
	// costs a second or two on a good network and removes a whole class of
	// signalling bug -- the relay carries one message per step, and a lost
	// candidate is not a partially-connected peer.
	gathered := webrtc.GatheringCompletePromise(s.pc)
	if err := s.pc.SetLocalDescription(offer); err != nil {
		s.close()
		return nil, wrapCoded(ErrInternal, err, "setting the local description")
	}
	select {
	case <-gathered:
	case <-time.After(connectTimeout):
		// Not fatal: what has been gathered may be enough, and a network that
		// never finishes gathering is common behind a corporate firewall.
	}

	rtcSessions.mu.Lock()
	rtcSessions.m[in.SessionID] = s
	rtcSessions.mu.Unlock()

	return map[string]any{"sdp": encodeSDP(s.pc.LocalDescription())}, nil
}

// --- answer ---

func handleRtcAnswer(req Request) (any, error) {
	var in struct {
		SessionID  string           `json:"sessionId"`
		SDP        string           `json:"sdp"`
		ICEServers []iceServerParam `json:"iceServers"`
	}
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}

	offer, err := decodeSDP(in.SDP)
	if err != nil {
		return nil, wrapCoded(ErrConfigInvalid, err, "reading the offer")
	}

	s, err := newSession(toICEServers(in.ICEServers))
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "creating a peer connection")
	}
	// The answering side does not create the channel; it receives one. A side
	// that created its own would end up with two channels and neither end
	// agreeing which to use.
	s.pc.OnDataChannel(func(dc *webrtc.DataChannel) { s.attach(dc) })

	if err := s.pc.SetRemoteDescription(offer); err != nil {
		s.close()
		return nil, wrapCoded(ErrConfigInvalid, err, "the offer was not usable")
	}
	answer, err := s.pc.CreateAnswer(nil)
	if err != nil {
		s.close()
		return nil, wrapCoded(ErrInternal, err, "creating the answer")
	}
	gathered := webrtc.GatheringCompletePromise(s.pc)
	if err := s.pc.SetLocalDescription(answer); err != nil {
		s.close()
		return nil, wrapCoded(ErrInternal, err, "setting the local description")
	}
	select {
	case <-gathered:
	case <-time.After(connectTimeout):
	}

	rtcSessions.mu.Lock()
	rtcSessions.m[in.SessionID] = s
	rtcSessions.mu.Unlock()

	return map[string]any{"sdp": encodeSDP(s.pc.LocalDescription())}, nil
}

// --- accept the answer ---

func handleRtcAccept(req Request) (any, error) {
	var in struct {
		SessionID string `json:"sessionId"`
		SDP       string `json:"sdp"`
	}
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}
	s, err := session(in.SessionID)
	if err != nil {
		return nil, err
	}
	answer, err := decodeSDP(in.SDP)
	if err != nil {
		return nil, wrapCoded(ErrConfigInvalid, err, "reading the answer")
	}
	if err := s.pc.SetRemoteDescription(answer); err != nil {
		return nil, wrapCoded(ErrConfigInvalid, err, "the answer was not usable")
	}

	select {
	case <-s.opened:
		return map[string]any{"open": true}, nil
	case <-time.After(connectTimeout):
		// The honest failure, with its own code so the caller falls back to
		// store-and-forward rather than reporting an error. Two devices that
		// cannot reach each other directly is the ordinary case this whole
		// design has a second path for.
		return nil, codedf(ErrPeerUnreachable,
			"no direct path to that device within %s; it may be asleep, or behind a network that needs a relay",
			connectTimeout)
	}
}

// --- send and receive ---

func handleRtcSend(req Request) (any, error) {
	var in struct {
		SessionID string `json:"sessionId"`
		Payload   string `json:"payload"`
	}
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}
	s, err := session(in.SessionID)
	if err != nil {
		return nil, err
	}
	body, err := base64.StdEncoding.DecodeString(in.Payload)
	if err != nil {
		return nil, codedf(ErrConfigInvalid, "payload is not base64")
	}
	if s.channel == nil {
		return nil, codedf(ErrPeerUnreachable, "the data channel is not open")
	}
	// ALREADY SEALED. This process could not open it if it wanted to, which is
	// the point of sending it from here rather than sealing here.
	if err := s.channel.Send(body); err != nil {
		return nil, wrapCoded(ErrPeerUnreachable, err, "sending")
	}
	return map[string]any{"sent": len(body)}, nil
}

func handleRtcReceive(req Request) (any, error) {
	var in struct {
		SessionID string `json:"sessionId"`
		WaitMs    int    `json:"waitMs"`
	}
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}
	s, err := session(in.SessionID)
	if err != nil {
		return nil, err
	}
	wait := time.Duration(in.WaitMs) * time.Millisecond
	if wait <= 0 || wait > 60*time.Second {
		wait = 5 * time.Second
	}
	select {
	case body := <-s.inbound:
		return map[string]any{"payload": base64.StdEncoding.EncodeToString(body)}, nil
	case <-time.After(wait):
		// Nothing arrived. NOT an error: a quiet channel is the normal state
		// of a clipboard nobody is using, and a caller that treated silence as
		// a failure would back off from a working connection.
		return map[string]any{"payload": nil}, nil
	}
}

func handleRtcClose(req Request) (any, error) {
	var in struct {
		SessionID string `json:"sessionId"`
	}
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}
	rtcSessions.mu.Lock()
	s, ok := rtcSessions.m[in.SessionID]
	delete(rtcSessions.m, in.SessionID)
	rtcSessions.mu.Unlock()
	if ok {
		s.close()
	}
	return map[string]any{"ok": true}, nil
}

// rtcStats is the leak budget, readable.
//
// pion leaks are the failure this design is most likely to have: a peer
// connection that is never closed holds goroutines, a UDP socket and an ICE
// agent, and the symptom is an app that is fine for an hour and unusable by
// the evening. Exporting the count means a test can assert it returns to zero
// and an operator can see it climbing.
func handleRtcStats(Request) (any, error) {
	rtcSessions.mu.Lock()
	n := len(rtcSessions.m)
	rtcSessions.mu.Unlock()
	return map[string]any{"sessions": n, "goroutines": goroutineCount()}, nil
}

func session(id string) (*rtcSession, error) {
	rtcSessions.mu.Lock()
	defer rtcSessions.mu.Unlock()
	s, ok := rtcSessions.m[id]
	if !ok {
		return nil, codedf(ErrPeerUnreachable, "no session %q", id)
	}
	return s, nil
}

func encodeSDP(d *webrtc.SessionDescription) string {
	if d == nil {
		return ""
	}
	raw, _ := json.Marshal(d)
	return base64.StdEncoding.EncodeToString(raw)
}

func decodeSDP(encoded string) (webrtc.SessionDescription, error) {
	var out webrtc.SessionDescription
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return out, errors.New("the description is not base64")
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return out, fmt.Errorf("the description is not a session description: %w", err)
	}
	return out, nil
}

// rtcMethods is the --rtc role's surface. Separate from cryptoMethods, and
// neither role can reach the other's.
var rtcMethods = map[string]func(Request) (any, error){
	"rtcOffer":   handleRtcOffer,
	"rtcAnswer":  handleRtcAnswer,
	"rtcAccept":  handleRtcAccept,
	"rtcSend":    handleRtcSend,
	"rtcReceive": handleRtcReceive,
	"rtcClose":   handleRtcClose,
	"rtcStats":   handleRtcStats,
}
