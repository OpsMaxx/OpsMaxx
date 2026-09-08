package main

import (
	"context"
	"net/netip"
	"strings"
	"testing"
	"time"
)

// The probe in `diagnose.go`, against the REAL two-node tunnel `newTestPair`
// stands up: a client and a server wireguard-go device talking over a loopback
// UDP port, with an echo service and a DNS responder living inside the server's
// netstack. Nothing here is a fake: the handshake is a handshake, the lookup
// goes to a DNS server that is only reachable through the tunnel, and the TCP
// connect crosses a real encrypted hop.

func find(t *testing.T, res *DiagnoseResult, name string) DiagnoseCheck {
	t.Helper()
	for _, c := range res.Checks {
		if c.Name == name {
			return c
		}
	}
	t.Fatalf("no %q check in %+v", name, res.Checks)
	return DiagnoseCheck{}
}

func TestDiagnoseReachesAServiceThroughTheTunnel(t *testing.T) {
	p := newTestPair(t, nil)
	waitHandshake(t, p.client)

	res, err := p.client.diagnose(&DiagnoseParams{TunnelID: "test-client", Host: serverIP, Port: echoPort})
	if err != nil {
		t.Fatalf("diagnose: %v", err)
	}
	if got := find(t, res, CheckHandshake).Status; got != CheckOK {
		t.Errorf("handshake = %q, want ok", got)
	}
	if got := find(t, res, CheckTCP).Status; got != CheckOK {
		t.Errorf("tcp = %q, want ok: %+v", got, res.Checks)
	}
}

// An address is not a DNS answer. Reporting a lookup that never happened as a
// passing check is the exact failure this file's header names.
func TestDiagnoseDoesNotClaimALookupItDidNotMake(t *testing.T) {
	p := newTestPair(t, nil)
	waitHandshake(t, p.client)

	res, _ := p.client.diagnose(&DiagnoseParams{TunnelID: "test-client", Host: serverIP, Port: echoPort})
	dns := find(t, res, CheckDNS)
	if dns.Status != CheckSkipped {
		t.Errorf("dns = %q, want skipped for a literal address", dns.Status)
	}
	if dns.Detail == "" {
		t.Error("a skipped check with no reason is a green tick over an unasked question")
	}
}

// The whole point of resolving inside the netstack: `echo.test` exists ONLY on
// the DNS server that lives on the far side of the tunnel. A probe that leaked
// to the host resolver would fail here, which is why this asserts a success.
func TestDiagnoseResolvesANameOnlyTheTunnelKnows(t *testing.T) {
	p := newTestPair(t, nil)
	waitHandshake(t, p.client)

	res, err := p.client.diagnose(&DiagnoseParams{TunnelID: "test-client", Host: "echo.test", Port: echoPort})
	if err != nil {
		t.Fatalf("diagnose: %v", err)
	}
	if got := find(t, res, CheckDNS).Status; got != CheckOK {
		t.Errorf("dns = %q, want ok: %+v", got, res.Checks)
	}
	if got := find(t, res, CheckTCP).Status; got != CheckOK {
		t.Errorf("tcp = %q, want ok: %+v", got, res.Checks)
	}
}

func TestDiagnoseReportsAPortNothingIsListeningOn(t *testing.T) {
	p := newTestPair(t, nil)
	waitHandshake(t, p.client)

	res, err := p.client.diagnose(&DiagnoseParams{TunnelID: "test-client", Host: serverIP, Port: echoPort + 1})
	if err != nil {
		t.Fatalf("diagnose: %v", err)
	}
	tcp := find(t, res, CheckTCP)
	if tcp.Status != CheckFailed {
		t.Errorf("tcp = %q, want failed", tcp.Status)
	}
	// A refusal, a filtered port and a route to nowhere all arrive here and
	// this probe cannot tell them apart, so it must not name one.
	if strings.Contains(tcp.Detail, "down") || strings.Contains(tcp.Detail, "offline") {
		t.Errorf("detail claims more than was measured: %q", tcp.Detail)
	}
	if res.LatencyMs != 0 {
		t.Errorf("latency = %d from a connect that failed", res.LatencyMs)
	}
}

// A name that does not resolve leaves nothing to connect TO, and a TCP timeout
// on top of it would send somebody chasing a second problem that is the first.
func TestAFailedLookupSkipsTheConnectRatherThanFailingIt(t *testing.T) {
	p := newTestPair(t, nil)
	waitHandshake(t, p.client)

	res, err := p.client.diagnose(&DiagnoseParams{TunnelID: "test-client", Host: "nothing.test", Port: echoPort})
	if err != nil {
		t.Fatalf("diagnose: %v", err)
	}
	if got := find(t, res, CheckDNS).Status; got != CheckFailed {
		t.Errorf("dns = %q, want failed", got)
	}
	if got := find(t, res, CheckTCP).Status; got != CheckSkipped {
		t.Errorf("tcp = %q, want skipped", got)
	}
}

// There is no address this probe may pick on an operator's behalf, so a
// diagnose with no target still reports the one thing it can read.
func TestDiagnoseWithNoTargetChecksTheHandshakeAndSaysWhyItStopped(t *testing.T) {
	p := newTestPair(t, nil)
	waitHandshake(t, p.client)

	res, err := p.client.diagnose(&DiagnoseParams{TunnelID: "test-client"})
	if err != nil {
		t.Fatalf("diagnose: %v", err)
	}
	if got := find(t, res, CheckHandshake).Status; got != CheckOK {
		t.Errorf("handshake = %q, want ok", got)
	}
	for _, n := range []string{CheckDNS, CheckTCP} {
		c := find(t, res, n)
		if c.Status != CheckSkipped {
			t.Errorf("%s = %q, want skipped", n, c.Status)
		}
		if !strings.Contains(c.Detail, "no target") {
			t.Errorf("%s detail does not say why: %q", n, c.Detail)
		}
	}
}

// The client's peer endpoint is a real listener, but the KEY is not one the
// server knows, so no handshake ever completes. This is the never case, and it
// must not read as a peer that has gone quiet.
func TestATunnelThatNeverHandshakedFailsAndProbesNothing(t *testing.T) {
	if testing.Short() {
		t.Skip("stands up a WireGuard device; skipped under -short")
	}
	priv, _ := genKeypair(t)
	_, otherPub := genKeypair(t)
	cli, err := newTunnel(context.Background(), discardWriter(), &UpParams{
		TunnelID: "lonely",
		Iface:    IfaceParams{PrivateKey: priv, Addresses: []string{clientIP + "/32"}, MTU: 1420},
		Peers: []PeerParams{{
			PublicKey:  otherPub,
			Endpoint:   "127.0.0.1:1",
			AllowedIPs: []string{"10.7.0.0/24"},
		}},
	})
	if err != nil {
		t.Fatalf("tunnel: %v", err)
	}
	t.Cleanup(cli.closeAll)

	res, err := cli.diagnose(&DiagnoseParams{TunnelID: "lonely", Host: serverIP, Port: echoPort})
	if err != nil {
		t.Fatalf("diagnose: %v", err)
	}
	hs := find(t, res, CheckHandshake)
	if hs.Status != CheckFailed {
		t.Errorf("handshake = %q, want failed", hs.Status)
	}
	if !strings.Contains(hs.Detail, "never") {
		t.Errorf("never and long-ago are different failures; got %q", hs.Detail)
	}
	// And the other two are skipped, not failed: one fact reported once.
	for _, n := range []string{CheckDNS, CheckTCP} {
		if got := find(t, res, n).Status; got != CheckSkipped {
			t.Errorf("%s = %q, want skipped", n, got)
		}
	}
}

// The handshake reading, away from any device, because the boundary is the
// interesting part and standing up a tunnel cannot put its handshake at an
// arbitrary age.
func TestHandshakeCheckReadsAgeRatherThanPresence(t *testing.T) {
	const now = 1_700_000_000
	for _, tc := range []struct {
		name   string
		last   int64
		want   string
		detail string
	}{
		{"never", 0, CheckFailed, "never"},
		{"just now", now - 1, CheckOK, "recently"},
		{"at the edge", now - handshakeFreshSec, CheckOK, "recently"},
		{"past the edge", now - handshakeFreshSec - 1, CheckFailed, "stopped answering"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := handshakeCheck(tc.last, now)
			if c.Status != tc.want {
				t.Errorf("status = %q, want %q", c.Status, tc.want)
			}
			if !strings.Contains(c.Detail, tc.detail) {
				t.Errorf("detail = %q, want it to mention %q", c.Detail, tc.detail)
			}
		})
	}
}

// A clock that jumped backwards produces a negative age. Reporting that as
// fresh would be luck rather than a reading.
func TestAClockJumpDoesNotProduceANegativeAge(t *testing.T) {
	c := handshakeCheck(1_700_000_060, 1_700_000_000)
	if c.Elapsed < 0 {
		t.Errorf("elapsed = %d", c.Elapsed)
	}
}

// A port nobody supplied is not port zero, and a probe that guessed one would
// be reporting a connection the operator never asked for.
func TestConnectCheckWillNotGuessAPort(t *testing.T) {
	tun := &Tunnel{}
	c, ms := tun.connectCheck(context.Background(), netip.MustParseAddr("10.7.0.1"), 0)
	if c.Status != CheckSkipped {
		t.Errorf("status = %q, want skipped", c.Status)
	}
	if ms != -1 {
		t.Errorf("ms = %d, want no measurement", ms)
	}
}

// System mode has no netstack to dial through. "This build cannot probe it" is
// a different sentence from "the probe failed", and the second would have
// somebody debugging a working tunnel.
func TestASystemDeviceIsSaidToBeUnprobableRatherThanBroken(t *testing.T) {
	p := newTestPair(t, nil)
	waitHandshake(t, p.client)
	p.client.tnet = nil

	res, err := p.client.diagnose(&DiagnoseParams{TunnelID: "test-client", Host: serverIP, Port: echoPort})
	if err != nil {
		t.Fatalf("diagnose: %v", err)
	}
	for _, n := range []string{CheckDNS, CheckTCP} {
		c := find(t, res, n)
		if c.Status != CheckSkipped {
			t.Errorf("%s = %q, want skipped", n, c.Status)
		}
		if !strings.Contains(c.Detail, "system network device") {
			t.Errorf("%s detail does not say why: %q", n, c.Detail)
		}
	}
}

func TestDiagnoseOnAClosedTunnelIsAnErrorRatherThanAFailingChecklist(t *testing.T) {
	p := newTestPair(t, nil)
	p.client.closeAll()
	if _, err := p.client.diagnose(&DiagnoseParams{TunnelID: "test-client"}); err == nil {
		t.Fatal("want an error for a tunnel that is not running")
	}
}

// Latency is only ever the time of a connect that SUCCEEDED, and it is a TCP
// connect time rather than a round trip.
func TestLatencyIsPresentOnlyWhenTheConnectSucceeded(t *testing.T) {
	p := newTestPair(t, nil)
	waitHandshake(t, p.client)

	ok, err := p.client.diagnose(&DiagnoseParams{TunnelID: "test-client", Host: serverIP, Port: echoPort})
	if err != nil {
		t.Fatalf("diagnose: %v", err)
	}
	if ok.LatencyMs < 0 {
		t.Errorf("latency = %d", ok.LatencyMs)
	}
	if find(t, ok, CheckTCP).Status == CheckOK && ok.LatencyMs != find(t, ok, CheckTCP).Elapsed {
		t.Errorf("latency %d disagrees with the check that measured it %d", ok.LatencyMs, find(t, ok, CheckTCP).Elapsed)
	}
}

// Every check carries words, including the passing ones: a checklist whose
// green rows say nothing teaches people the text only matters when it breaks.
func TestEveryCheckCarriesItsOwnSentence(t *testing.T) {
	p := newTestPair(t, nil)
	waitHandshake(t, p.client)
	res, err := p.client.diagnose(&DiagnoseParams{TunnelID: "test-client", Host: "echo.test", Port: echoPort})
	if err != nil {
		t.Fatalf("diagnose: %v", err)
	}
	if len(res.Checks) != 3 {
		t.Fatalf("got %d checks, want 3", len(res.Checks))
	}
	for _, c := range res.Checks {
		if c.Detail == "" {
			t.Errorf("%s has no detail", c.Name)
		}
		switch c.Status {
		case CheckOK, CheckFailed, CheckSkipped:
		default:
			t.Errorf("%s has status %q, which is outside the vocabulary", c.Name, c.Status)
		}
	}
}

// The probe is watched by somebody. Three checks that each hang for the full
// dial timeout is a card that appears frozen.
func TestTheProbeTimeoutIsShorterThanTheDialTimeout(t *testing.T) {
	if diagnoseTimeout >= dialTimeout {
		t.Errorf("diagnoseTimeout %v is not shorter than dialTimeout %v", diagnoseTimeout, dialTimeout)
	}
	if diagnoseTimeout > 10*time.Second {
		t.Errorf("diagnoseTimeout %v is too long for a checklist somebody is watching", diagnoseTimeout)
	}
}
