package main

import (
	"errors"
	"strings"
	"testing"
)

// Recorded dev.IpcGet() output. The UAPI socket handler appends `errno=0`;
// dev.IpcGet() itself does not, so both shapes appear below and both must
// parse.

const fixtureOnePeer = `private_key=c809f3e5317e9575c9b5ed78b638b7ce530dabe85ddab6142202418001ddf066
listen_port=58120
public_key=c53201039adba14be71f886da1d8dbe9eefbed08cb111b7534007899aa9ff038
preshared_key=0000000000000000000000000000000000000000000000000000000000000000
protocol_version=1
endpoint=203.0.113.9:51820
last_handshake_time_sec=1717000000
last_handshake_time_nsec=451000000
tx_bytes=148900
rx_bytes=2201316
persistent_keepalive_interval=25
allowed_ip=0.0.0.0/0
allowed_ip=::/0
errno=0
`

// Two peers, the second handshaked more recently. rx/tx aggregate; the
// reported endpoint follows the newest handshake, because "is this tunnel
// alive" is answered by the best peer.
const fixtureTwoPeers = `private_key=c809f3e5317e9575c9b5ed78b638b7ce530dabe85ddab6142202418001ddf066
listen_port=51820
public_key=c53201039adba14be71f886da1d8dbe9eefbed08cb111b7534007899aa9ff038
endpoint=203.0.113.9:51820
last_handshake_time_sec=1716999000
last_handshake_time_nsec=0
tx_bytes=1000
rx_bytes=2000
allowed_ip=10.0.1.0/24
public_key=000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
endpoint=198.51.100.4:51820
last_handshake_time_sec=1717000500
last_handshake_time_nsec=17
tx_bytes=30
rx_bytes=40
allowed_ip=10.0.2.0/24
`

// E22/E27: the peer is configured but has never answered. WireGuard reports
// zeros, and netd must pass that through as "absent" rather than inventing
// an age.
const fixtureNoHandshake = `private_key=c809f3e5317e9575c9b5ed78b638b7ce530dabe85ddab6142202418001ddf066
listen_port=42311
public_key=c53201039adba14be71f886da1d8dbe9eefbed08cb111b7534007899aa9ff038
endpoint=203.0.113.9:51820
last_handshake_time_sec=0
last_handshake_time_nsec=0
tx_bytes=592
rx_bytes=0
persistent_keepalive_interval=25
allowed_ip=0.0.0.0/0
errno=0
`

// No peers at all: a device that was configured and then had its peers
// removed. Must not be mistaken for one peer with zeroed counters.
const fixtureNoPeers = `private_key=c809f3e5317e9575c9b5ed78b638b7ce530dabe85ddab6142202418001ddf066
listen_port=42311
errno=0
`

func TestParseIPCGetOnePeer(t *testing.T) {
	snap, err := parseIPCGet(fixtureOnePeer)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if snap.Peers != 1 {
		t.Errorf("peers = %d, want 1", snap.Peers)
	}
	if snap.RxBytes != 2201316 {
		t.Errorf("rx = %d, want 2201316", snap.RxBytes)
	}
	if snap.TxBytes != 148900 {
		t.Errorf("tx = %d, want 148900", snap.TxBytes)
	}
	if snap.LastHandshakeSec != 1717000000 {
		t.Errorf("handshake sec = %d", snap.LastHandshakeSec)
	}
	if snap.LastHandshakeNsec != 451000000 {
		t.Errorf("handshake nsec = %d", snap.LastHandshakeNsec)
	}
	if snap.Endpoint != "203.0.113.9:51820" {
		t.Errorf("endpoint = %q", snap.Endpoint)
	}
	if snap.ListenPort != 58120 {
		t.Errorf("listen port = %d", snap.ListenPort)
	}
}

func TestParseIPCGetAggregatesPeers(t *testing.T) {
	snap, err := parseIPCGet(fixtureTwoPeers)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if snap.Peers != 2 {
		t.Errorf("peers = %d, want 2", snap.Peers)
	}
	if snap.RxBytes != 2040 {
		t.Errorf("rx = %d, want 2040 (2000+40)", snap.RxBytes)
	}
	if snap.TxBytes != 1030 {
		t.Errorf("tx = %d, want 1030 (1000+30)", snap.TxBytes)
	}
	if snap.LastHandshakeSec != 1717000500 {
		t.Errorf("handshake = %d, want the newest of the two", snap.LastHandshakeSec)
	}
	if snap.Endpoint != "198.51.100.4:51820" {
		t.Errorf("endpoint = %q, want the newest peer's", snap.Endpoint)
	}
}

func TestParseIPCGetNoHandshake(t *testing.T) {
	snap, err := parseIPCGet(fixtureNoHandshake)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if snap.Peers != 1 {
		t.Errorf("peers = %d, want 1", snap.Peers)
	}
	// Zero, not a synthesised age. The parent decides when zero becomes
	// handshake-timeout, and it needs the raw fact to do that.
	if snap.LastHandshakeSec != 0 {
		t.Errorf("handshake = %d, want 0", snap.LastHandshakeSec)
	}
	// The endpoint is still reported: it is what goes in the "no response
	// from <endpoint>" message.
	if snap.Endpoint != "203.0.113.9:51820" {
		t.Errorf("endpoint = %q", snap.Endpoint)
	}
	if snap.TxBytes != 592 || snap.RxBytes != 0 {
		t.Errorf("tx/rx = %d/%d, want 592/0 (we sent, nothing came back)", snap.TxBytes, snap.RxBytes)
	}
}

func TestParseIPCGetNoPeers(t *testing.T) {
	snap, err := parseIPCGet(fixtureNoPeers)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if snap.Peers != 0 {
		t.Errorf("peers = %d, want 0", snap.Peers)
	}
	if snap.Endpoint != "" {
		t.Errorf("endpoint = %q, want empty", snap.Endpoint)
	}
}

func TestParseIPCGetWithoutErrnoLine(t *testing.T) {
	// dev.IpcGet() returns no errno; only the socket handler adds one.
	stripped := strings.ReplaceAll(fixtureOnePeer, "errno=0\n", "")
	snap, err := parseIPCGet(stripped)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if snap.Peers != 1 || snap.RxBytes != 2201316 {
		t.Fatalf("parse differed without the errno line: %+v", snap)
	}
}

func TestParseIPCGetSurfacesErrno(t *testing.T) {
	_, err := parseIPCGet("private_key=00\nerrno=1\n")
	if err == nil {
		t.Fatal("a non-zero errno must be an error, not a zeroed snapshot")
	}
	var ce *codedError
	if !errors.As(err, &ce) || ce.code != ErrInternal {
		t.Fatalf("want internal, got %v", err)
	}
	if !strings.Contains(err.Error(), "1") {
		t.Fatalf("errno value lost: %v", err)
	}
}

// E63: a clock that moved backwards must never produce a negative handshake.
func TestParseIPCGetClampsNegativeHandshake(t *testing.T) {
	snap, err := parseIPCGet("public_key=aa\nlast_handshake_time_sec=-5\n")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if snap.LastHandshakeSec != 0 {
		t.Fatalf("handshake = %d, want it clamped to 0", snap.LastHandshakeSec)
	}
}

func TestParseIPCGetIgnoresJunkLines(t *testing.T) {
	in := "private_key=00\n\nnot-a-kv-line\r\npublic_key=aa\r\nrx_bytes=7\r\nerrno=0\r\n"
	snap, err := parseIPCGet(in)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if snap.Peers != 1 || snap.RxBytes != 7 {
		t.Fatalf("snapshot = %+v", snap)
	}
}

// Interface-level counters must not be mistaken for peer counters. Only lines
// after a public_key belong to a peer.
func TestParseIPCGetIgnoresPrePeerCounters(t *testing.T) {
	in := "private_key=00\nrx_bytes=999999\npublic_key=aa\nrx_bytes=5\ntx_bytes=6\n"
	snap, err := parseIPCGet(in)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if snap.RxBytes != 5 || snap.TxBytes != 6 {
		t.Fatalf("rx/tx = %d/%d, want 5/6", snap.RxBytes, snap.TxBytes)
	}
}

// ---------------------------------------------------------------------------
// Per-peer rows. The aggregate answers "is this tunnel alive"; these answer
// "which peer", which is the question somebody asks when a site-to-site link
// is half up and the aggregate looks fine.
// ---------------------------------------------------------------------------

func TestPerPeerRowsCarryEachPeersOwnNumbers(t *testing.T) {
	snap, err := parseIPCGet(fixtureTwoPeers)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(snap.PeerRows) != 2 {
		t.Fatalf("want 2 rows, got %d", len(snap.PeerRows))
	}
	// Not the aggregate, and not the best peer's: each row is its own.
	if snap.PeerRows[0].RxBytes != 2000 || snap.PeerRows[0].TxBytes != 1000 {
		t.Errorf("first peer rx/tx = %d/%d", snap.PeerRows[0].RxBytes, snap.PeerRows[0].TxBytes)
	}
	if snap.PeerRows[1].RxBytes != 40 || snap.PeerRows[1].TxBytes != 30 {
		t.Errorf("second peer rx/tx = %d/%d", snap.PeerRows[1].RxBytes, snap.PeerRows[1].TxBytes)
	}
	// And the aggregate is still the sum, unchanged.
	if snap.RxBytes != 2040 || snap.TxBytes != 1030 {
		t.Errorf("aggregate rx/tx = %d/%d", snap.RxBytes, snap.TxBytes)
	}
}

func TestPerPeerRowsKeepEachPeersEndpointAndHandshake(t *testing.T) {
	snap, err := parseIPCGet(fixtureTwoPeers)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if snap.PeerRows[0].Endpoint != "203.0.113.9:51820" {
		t.Errorf("first endpoint = %q", snap.PeerRows[0].Endpoint)
	}
	if snap.PeerRows[1].Endpoint != "198.51.100.4:51820" {
		t.Errorf("second endpoint = %q", snap.PeerRows[1].Endpoint)
	}
	// The aggregate follows the NEWEST handshake; the rows keep their own, so
	// "this peer last spoke on Tuesday" is answerable.
	if snap.PeerRows[0].LastHandshakeSec != 1716999000 {
		t.Errorf("first handshake = %d", snap.PeerRows[0].LastHandshakeSec)
	}
	if snap.PeerRows[1].LastHandshakeSec != 1717000500 {
		t.Errorf("second handshake = %d", snap.PeerRows[1].LastHandshakeSec)
	}
}

// A peer has no other stable name. A row nobody can identify is not worth a
// round trip.
func TestPerPeerRowsNameThePeer(t *testing.T) {
	snap, err := parseIPCGet(fixtureTwoPeers)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	want := "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
	if snap.PeerRows[1].PublicKey != want {
		t.Errorf("second public key = %q", snap.PeerRows[1].PublicKey)
	}
	if snap.PeerRows[0].PublicKey == snap.PeerRows[1].PublicKey {
		t.Error("both rows carry the same key")
	}
}

// Zero means never, and it must survive into the row: a caller that read it as
// "a long time ago" would age a peer that has never once answered.
func TestPerPeerRowKeepsNeverHandshakedAsZero(t *testing.T) {
	snap, err := parseIPCGet(fixtureNoHandshake)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(snap.PeerRows) != 1 {
		t.Fatalf("want 1 row, got %d", len(snap.PeerRows))
	}
	if snap.PeerRows[0].LastHandshakeSec != 0 {
		t.Errorf("handshake = %d, want 0", snap.PeerRows[0].LastHandshakeSec)
	}
	// It still has an endpoint and a tx count: configured, and never answered.
	if snap.PeerRows[0].Endpoint == "" || snap.PeerRows[0].TxBytes == 0 {
		t.Error("a peer that never answered still has an endpoint and sent bytes")
	}
}

// A device whose peers were removed is not one peer with zeroed counters.
func TestNoPeersProducesNoRows(t *testing.T) {
	snap, err := parseIPCGet(fixtureNoPeers)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(snap.PeerRows) != 0 {
		t.Errorf("want no rows, got %d", len(snap.PeerRows))
	}
	if snap.Peers != 0 {
		t.Errorf("peers = %d", snap.Peers)
	}
}

// `Peers` is kept rather than derived, because every existing caller reads it.
func TestPeerCountStillMatchesTheRows(t *testing.T) {
	for name, fixture := range map[string]string{
		"one":  fixtureOnePeer,
		"two":  fixtureTwoPeers,
		"none": fixtureNoPeers,
	} {
		snap, err := parseIPCGet(fixture)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if snap.Peers != len(snap.PeerRows) {
			t.Errorf("%s: peers=%d rows=%d", name, snap.Peers, len(snap.PeerRows))
		}
	}
}

// A corrupt device response must not reach a caller as a negative age, in a row
// any more than in the aggregate.
func TestPerPeerNegativeHandshakeIsClamped(t *testing.T) {
	bad := strings.Replace(fixtureOnePeer, "last_handshake_time_sec=1717000000", "last_handshake_time_sec=-5", 1)
	snap, err := parseIPCGet(bad)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if snap.PeerRows[0].LastHandshakeSec != 0 {
		t.Errorf("row handshake = %d, want clamped to 0", snap.PeerRows[0].LastHandshakeSec)
	}
	if snap.LastHandshakeSec != 0 {
		t.Errorf("aggregate handshake = %d", snap.LastHandshakeSec)
	}
}

// CONSTRUCTED: no recorded device output omits a counter, so nothing above
// distinguishes a per-peer reset from none. The bug it guards is real and would
// be silent -- a peer block that leaves a field out inherits the PREVIOUS
// peer's, and a row reading "2.2 MB" for a peer that has moved nothing is worse
// than no row.
const fixturePeerOmitsCounters = `private_key=c809f3e5317e9575c9b5ed78b638b7ce530dabe85ddab6142202418001ddf066
listen_port=51820
public_key=c53201039adba14be71f886da1d8dbe9eefbed08cb111b7534007899aa9ff038
endpoint=203.0.113.9:51820
last_handshake_time_sec=1716999000
tx_bytes=1000
rx_bytes=2000
public_key=000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
errno=0
`

func TestAPeerBlockDoesNotInheritThePreviousPeersNumbers(t *testing.T) {
	snap, err := parseIPCGet(fixturePeerOmitsCounters)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(snap.PeerRows) != 2 {
		t.Fatalf("want 2 rows, got %d", len(snap.PeerRows))
	}
	second := snap.PeerRows[1]
	if second.RxBytes != 0 || second.TxBytes != 0 {
		t.Errorf("second peer inherited rx/tx = %d/%d", second.RxBytes, second.TxBytes)
	}
	if second.Endpoint != "" {
		t.Errorf("second peer inherited endpoint %q", second.Endpoint)
	}
	if second.LastHandshakeSec != 0 {
		t.Errorf("second peer inherited handshake %d", second.LastHandshakeSec)
	}
	// And its own identity survived.
	if second.PublicKey != "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" {
		t.Errorf("second public key = %q", second.PublicKey)
	}
}
