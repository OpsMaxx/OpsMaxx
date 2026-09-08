package main

import (
	"context"
	"net/netip"
	"time"
)

// An active probe THROUGH the tunnel, for a card that today can only say
// "connected" and leave somebody to find out for themselves whether anything
// on the far side answers.
//
// EVERY CHECK RUNS INSIDE THE NETSTACK. `tnet.LookupContextHost` and
// `tnet.DialContextTCPAddrPort` are the same two calls `Tunnel.dial` makes for
// a SOCKS5 client, for the same reason: a lookup on the HOST resolver would
// travel in the clear and leak the very name the tunnel exists to hide, and a
// host `ping` would measure the path to the peer's public endpoint rather than
// the path through the tunnel -- a number that looks like an answer and is
// about a different route. Nothing here shells out, nothing elevates, and
// nothing touches the routing table.
//
// THE CALLER NAMES THE TARGET. There is no default host to probe. A default
// would mean netd deciding, on its own, to open a connection to a third party
// through somebody's VPN, and there is no address that is the right one to
// pick on an operator's behalf.
//
// A SKIPPED CHECK IS NOT A PASSING CHECK. Every check reports one of three
// words and a skip always carries its reason, because a checklist that renders
// "did not run" the same as "fine" is worse than no checklist: it is a green
// tick over an unasked question.
const (
	CheckOK      = "ok"
	CheckFailed  = "failed"
	CheckSkipped = "skipped"
)

// The three checks, in the order they run and the order they render. The order
// is the dependency order: nothing is asked of the tunnel before the handshake
// says there IS one.
const (
	CheckHandshake = "handshake"
	CheckDNS       = "dns"
	CheckTCP       = "tcp"
)

// How long any one probe may take. Deliberately shorter than `dialTimeout`:
// this is a checklist somebody is watching, and three checks that each hang for
// the full dial timeout is a card that appears frozen.
const diagnoseTimeout = 5 * time.Second

// A handshake older than this is not evidence of a working tunnel. It is the
// same threshold the parent's `degraded` reading uses; a probe that called a
// three-minute-old handshake "ok" would disagree with the badge beside it.
const handshakeFreshSec = 180

// diagnose runs the checklist. It returns a result rather than an error for
// anything a check can express: a failed probe IS the answer, and turning it
// into a transport error would lose the other two checks with it.
func (t *Tunnel) diagnose(p *DiagnoseParams) (*DiagnoseResult, error) {
	st, err := t.stats()
	if err != nil {
		// The tunnel is gone rather than unhealthy. There is nothing to probe
		// and no checklist to render.
		return nil, err
	}
	res := &DiagnoseResult{TunnelID: t.id, SampledAt: time.Now().UnixMilli()}

	hs := handshakeCheck(st.LastHandshakeUnixSec, time.Now().Unix())
	res.Checks = append(res.Checks, hs)

	// The netstack path only exists in userspace mode. A real TUN device has no
	// `tnet` to dial through, and the honest answer is that this build cannot
	// probe it -- not that the probe failed.
	if t.tnet == nil {
		res.Checks = append(res.Checks,
			skip(CheckDNS, "this tunnel uses a system network device, which this probe cannot dial through"),
			skip(CheckTCP, "this tunnel uses a system network device, which this probe cannot dial through"))
		return res, nil
	}
	if hs.Status != CheckOK {
		// One fact, reported once. Probing anyway would produce two more
		// timeouts and send somebody chasing three problems that are one.
		res.Checks = append(res.Checks,
			skip(CheckDNS, "nothing was sent, because the tunnel has no usable handshake"),
			skip(CheckTCP, "nothing was sent, because the tunnel has no usable handshake"))
		return res, nil
	}
	if p.Host == "" {
		res.Checks = append(res.Checks,
			skip(CheckDNS, "no target was given, and there is no address this probe may pick for you"),
			skip(CheckTCP, "no target was given, and there is no address this probe may pick for you"))
		return res, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), diagnoseTimeout)
	defer cancel()

	// A failed lookup leaves nothing to connect TO. This is the ONLY thing
	// standing between a resolve failure and a second, redundant timeout --
	// `connectCheck` does not re-check the address, because a second guard
	// reads as though it were the one keeping the invariant and it silently
	// absorbed the mutation that deleted this one.
	addr, dns := t.resolveCheck(ctx, p.Host)
	res.Checks = append(res.Checks, dns)
	if dns.Status == CheckFailed {
		res.Checks = append(res.Checks, skip(CheckTCP, "the name could not be resolved, so there was no address to connect to"))
		return res, nil
	}
	tcp, ms := t.connectCheck(ctx, addr, p.Port)
	res.Checks = append(res.Checks, tcp)
	if ms >= 0 {
		res.LatencyMs = ms
	}
	return res, nil
}

// handshakeCheck reads the one number that says whether this tunnel is
// carrying traffic at all.
//
// Never and long-ago are DIFFERENT failures with different fixes -- a key or
// endpoint that was never right, against a peer that has gone away -- so they
// are two sentences rather than one.
func handshakeCheck(lastSec int64, nowSec int64) DiagnoseCheck {
	if lastSec <= 0 {
		return DiagnoseCheck{
			Name:   CheckHandshake,
			Status: CheckFailed,
			Detail: "this tunnel has never completed a handshake, so the key, the endpoint or the route to it is wrong",
		}
	}
	age := nowSec - lastSec
	if age < 0 {
		// The system clock moved backwards under us. Reporting a negative age
		// as "fresh" would be luck rather than a reading.
		age = 0
	}
	if age > handshakeFreshSec {
		return DiagnoseCheck{
			Name:    CheckHandshake,
			Status:  CheckFailed,
			Detail:  "the last handshake is older than this tunnel's keepalive, so the peer has stopped answering",
			Elapsed: age,
		}
	}
	return DiagnoseCheck{
		Name:    CheckHandshake,
		Status:  CheckOK,
		Detail:  "the peer completed a handshake recently",
		Elapsed: age,
	}
}

// resolveCheck turns the caller's host into an address, INSIDE the tunnel.
//
// An address that is already an address is not a DNS result and does not
// pretend to be one: it skips, with the reason, rather than reporting a lookup
// that never happened.
func (t *Tunnel) resolveCheck(ctx context.Context, host string) (netip.Addr, DiagnoseCheck) {
	if a, err := netip.ParseAddr(host); err == nil {
		return a.Unmap(), skip(CheckDNS, "the target is already an address, so no name was looked up")
	}
	start := time.Now()
	ips, err := t.tnet.LookupContextHost(ctx, host)
	ms := time.Since(start).Milliseconds()
	if err != nil || len(ips) == 0 {
		return netip.Addr{}, DiagnoseCheck{
			Name:    CheckDNS,
			Status:  CheckFailed,
			Detail:  "the tunnel's own DNS server did not answer for this name",
			Elapsed: ms,
		}
	}
	for _, s := range ips {
		if a, perr := netip.ParseAddr(s); perr == nil {
			return a.Unmap(), DiagnoseCheck{
				Name:    CheckDNS,
				Status:  CheckOK,
				Detail:  "the name resolved through the tunnel's DNS server, not the host resolver",
				Elapsed: ms,
			}
		}
	}
	return netip.Addr{}, DiagnoseCheck{
		Name:    CheckDNS,
		Status:  CheckFailed,
		Detail:  "the tunnel's DNS server answered, but with nothing that parses as an address",
		Elapsed: ms,
	}
}

// connectCheck opens and immediately closes one TCP connection through the
// netstack, and times it.
//
// THE NUMBER IS A TCP CONNECT TIME, NOT A PING. It includes the round trip to
// the peer, the peer's own forwarding, and the far service's accept. Calling it
// latency is fair; calling it RTT would not be, and this is the reason the
// field is named for what was measured.
func (t *Tunnel) connectCheck(ctx context.Context, addr netip.Addr, port int) (DiagnoseCheck, int64) {
	if port <= 0 || port > 65535 {
		return DiagnoseCheck{
			Name:   CheckTCP,
			Status: CheckSkipped,
			Detail: "no port was given, and a probe that guesses one is not a reading",
		}, -1
	}
	start := time.Now()
	c, err := t.tnet.DialContextTCPAddrPort(ctx, netip.AddrPortFrom(addr, uint16(port)))
	ms := time.Since(start).Milliseconds()
	if err != nil {
		return DiagnoseCheck{
			Name:   CheckTCP,
			Status: CheckFailed,
			// Deliberately does NOT say the host is down: a refusal, a filtered
			// port and a route that goes nowhere all arrive here, and this
			// probe cannot tell them apart.
			Detail:  "nothing accepted a connection on this port through the tunnel",
			Elapsed: ms,
		}, -1
	}
	// Closed at once. This measures reach, and holding the connection open
	// would leave a socket on somebody's server for the sake of a checklist.
	_ = c.Close()
	return DiagnoseCheck{
		Name:    CheckTCP,
		Status:  CheckOK,
		Detail:  "a TCP connection was accepted through the tunnel and closed again",
		Elapsed: ms,
	}, ms
}

func skip(name string, why string) DiagnoseCheck {
	return DiagnoseCheck{Name: name, Status: CheckSkipped, Detail: why}
}
