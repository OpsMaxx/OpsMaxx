package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tsnet"
)

// Tailscale, embedded.
//
// This runs a Tailscale node INSIDE this process via tsnet rather than driving
// a `tailscale` binary the user installed. That is the whole point: OpsMaxx
// ships one signed, checksummed sidecar and needs nothing else on the machine.
// Shelling out to a host client meant a PATH search, a version we did not
// choose, an install step the user had to perform first — and, on macOS, an
// app bundle whose single executable decides between opening its GUI window
// and behaving as a CLI by sniffing environment variables an Electron spawn
// does not have. None of that exists here.
//
// tailscale.com is BSD-3-Clause, so shipping it is the same arrangement frpc
// (Apache-2.0) and OpenVPN (GPL-2.0) already have in resources/bin.
//
// ── The consequence worth knowing ──────────────────────────────────────────
//
// A tsnet node is OUR node. It is a separate device on the tailnet with its
// own key and its own name — it does not borrow, reuse or interfere with a
// `tailscaled` the user may also be running. Both can be up at once and they
// do not know about each other.
//
// That is a real trade and it is the right one for a standalone app: the
// alternative is requiring an install, and then not working when it is absent.
// It also means stopping a profile is unambiguous. The old design refused to
// stop anything because the daemon was machine-wide and other software
// depended on it; this one owns its node completely, so `ts.down` means down.

// tsNode is one embedded Tailscale node.
type tsNode struct {
	id     string
	srv    *tsnet.Server
	cancel context.CancelFunc
	// The directory holding this node's identity. Removed on down() only when
	// the node was ephemeral — a persistent node's key is what lets it come
	// back as the same device instead of accumulating duplicates in the admin
	// console every time the app restarts.
	stateDir  string
	ephemeral bool

	// Local listeners this node is serving, by forward id. Closed on down().
	mu       sync.Mutex
	forwards map[string]net.Listener
}

type tsState struct {
	mu    sync.Mutex
	nodes map[string]*tsNode
}

func newTSState() *tsState { return &tsState{nodes: map[string]*tsNode{}} }

// TSUpParams starts (or joins) a tailnet.
type TSUpParams struct {
	TunnelID string `json:"tunnelId"`
	/**
	 * A pre-authorised key, when the caller has one.
	 *
	 * Optional. Without it the node needs interactive login and `ts.up` returns
	 * an AuthURL for the user to open — which is the normal path for a desktop
	 * app, and the reason this never asks for a password.
	 */
	AuthKey string `json:"authKey,omitempty"`
	/** How this device is named in the tailnet admin console. */
	Hostname string `json:"hostname,omitempty"`
	/**
	 * Remove this device from the tailnet when it disconnects.
	 *
	 * Sensible for a desktop client that comes and goes; the alternative fills
	 * an admin console with dead entries. Off by default because an ephemeral
	 * node also loses its stable address between runs.
	 */
	Ephemeral bool `json:"ephemeral,omitempty"`
	/** Where to keep this node's identity. Required for a persistent node. */
	StateDir string `json:"stateDir,omitempty"`
	/** How long to wait for the backend to settle before answering. */
	TimeoutMs int `json:"timeoutMs,omitempty"`
}

// TSPeer is one device on the tailnet, reduced to what a UI needs.
type TSPeer struct {
	Name   string `json:"name"`
	Host   string `json:"host"`
	Online bool   `json:"online"`
	OS     string `json:"os,omitempty"`
}

// TSStatusResult is what both ts.up and ts.status answer with.
type TSStatusResult struct {
	// Tailscale's own word: Running, Starting, NeedsLogin, NeedsMachineAuth,
	// Stopped, NoState. Passed through rather than translated, so the renderer
	// maps it once and this file does not have an opinion about UI vocabulary.
	BackendState string `json:"backendState"`
	/** Present when the node needs a browser login. */
	AuthURL string `json:"authUrl,omitempty"`
	Self    struct {
		Name string   `json:"name,omitempty"`
		IPs  []string `json:"ips,omitempty"`
	} `json:"self"`
	MagicDNSSuffix string   `json:"magicDnsSuffix,omitempty"`
	Peers          []TSPeer `json:"peers"`
	Health         []string `json:"health,omitempty"`
}

type TSDownParams struct {
	TunnelID string `json:"tunnelId"`
}

type TSStatusParams struct {
	TunnelID string `json:"tunnelId"`
}

func (s *Server) tsUp(req *Request) (interface{}, error) {
	var p TSUpParams
	if err := decodeParams(req, &p); err != nil {
		return nil, err
	}
	if p.TunnelID == "" {
		return nil, codedf(ErrConfigInvalid, "tunnelId is required")
	}
	if !p.Ephemeral && p.StateDir == "" {
		return nil, codedf(ErrConfigInvalid, "stateDir is required for a persistent node")
	}

	s.ts.mu.Lock()
	if _, live := s.ts.nodes[p.TunnelID]; live {
		s.ts.mu.Unlock()
		return nil, codedf(ErrAlreadyRunning, "tailscale node %q is already running", p.TunnelID)
	}
	s.ts.mu.Unlock()

	stateDir := p.StateDir
	if stateDir == "" {
		d, err := os.MkdirTemp("", "opsmaxx-tsnet-")
		if err != nil {
			return nil, wrapCoded(ErrInternal, err, "could not create a state directory")
		}
		stateDir = d
	}
	// 0700: this directory holds the node's private key.
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return nil, wrapCoded(ErrInternal, err, "could not prepare the state directory")
	}

	hostname := p.Hostname
	if hostname == "" {
		hostname = "opsmaxx"
	}

	srv := &tsnet.Server{
		Dir:      filepath.Clean(stateDir),
		Hostname: hostname,
		AuthKey:  p.AuthKey,
		// Ephemeral nodes disappear from the admin console when they go away.
		Ephemeral: p.Ephemeral,
		// tsnet logs verbosely by default and this process's stdout is the
		// protocol channel — anything written there that is not a protocol
		// frame corrupts the stream. Routed to the log sink instead.
		Logf: func(format string, args ...interface{}) {
			s.out.Log("debug", p.TunnelID, strings.TrimRight(fmt.Sprintf(format, args...), "\n"))
		},
	}

	ctx, cancel := context.WithCancel(context.Background())
	node := &tsNode{
		id:       p.TunnelID,
		srv:      srv,
		cancel:   cancel,
		stateDir: stateDir,
		ephemeral: p.Ephemeral,
		forwards:  map[string]net.Listener{},
	}

	timeout := time.Duration(p.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = 45 * time.Second
	}
	waitCtx, waitCancel := context.WithTimeout(ctx, timeout)
	defer waitCancel()

	// Start() brings the node up far enough to have a LocalClient. It does NOT
	// wait for the tailnet to be reachable, which is why the wait below exists.
	if err := srv.Start(); err != nil {
		cancel()
		_ = srv.Close()
		return nil, wrapCoded(ErrEngineFailed, err, "the Tailscale node could not start")
	}

	s.ts.mu.Lock()
	s.ts.nodes[p.TunnelID] = node
	s.ts.mu.Unlock()

	st, err := waitForBackend(waitCtx, srv)
	if err != nil {
		// Not torn down: NeedsLogin is the normal first-run answer, and the
		// caller wants the AuthURL rather than a dead node it has to restart.
		if st == nil {
			s.tsRemove(p.TunnelID)
			cancel()
			_ = srv.Close()
			return nil, wrapCoded(ErrEngineFailed, err, "the Tailscale node did not come up")
		}
	}
	return tsStatusFrom(st), nil
}

/**
 * Wait until the backend reaches a state worth answering with.
 *
 * Running is the goal. NeedsLogin and NeedsMachineAuth are also answers rather
 * than failures — the first carries the URL the user has to open, and blocking
 * until a timeout instead of returning it would leave them with no way to
 * proceed. Everything else keeps waiting.
 */
func waitForBackend(ctx context.Context, srv *tsnet.Server) (*ipnstate.Status, error) {
	lc, err := srv.LocalClient()
	if err != nil {
		return nil, err
	}
	ticker := time.NewTicker(300 * time.Millisecond)
	defer ticker.Stop()
	var last *ipnstate.Status
	askedToLogIn := false
	for {
		st, err := lc.Status(ctx)
		if err == nil {
			last = st
			switch st.BackendState {
			case ipn.Running.String():
				return st, nil
			case ipn.NeedsMachineAuth.String():
				// Waiting on a tailnet administrator. There is no URL for the
				// user to open; somebody else has to approve the device.
				return st, nil
			case ipn.NeedsLogin.String():
				/**
				 * NeedsLogin arrives with an EMPTY AuthURL.
				 *
				 * The URL does not exist until an interactive login has actually
				 * been started — the backend has nothing to hand out before
				 * then. Returning here on the first sight of NeedsLogin, which
				 * is what this did, produced "authorise this node" with nothing
				 * to click: a dead end that looks like a bug in the app.
				 *
				 * So: ask once, then keep polling until the URL appears.
				 */
				if st.AuthURL != "" {
					return st, nil
				}
				if !askedToLogIn {
					askedToLogIn = true
					if err := lc.StartLoginInteractive(ctx); err != nil {
						return st, err
					}
				}
			}
		}
		select {
		case <-ctx.Done():
			if last != nil {
				return last, ctx.Err()
			}
			return nil, ctx.Err()
		case <-ticker.C:
		}
	}
}

func (s *Server) tsStatus(req *Request) (interface{}, error) {
	var p TSStatusParams
	if err := decodeParams(req, &p); err != nil {
		return nil, err
	}
	s.ts.mu.Lock()
	node := s.ts.nodes[p.TunnelID]
	s.ts.mu.Unlock()
	if node == nil {
		return nil, codedf(ErrEngineStopped, "no Tailscale node %q is running", p.TunnelID)
	}
	lc, err := node.srv.LocalClient()
	if err != nil {
		return nil, wrapCoded(ErrEngineFailed, err, "the Tailscale node is not answering")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	st, err := lc.Status(ctx)
	if err != nil {
		return nil, wrapCoded(ErrEngineFailed, err, "could not read Tailscale status")
	}
	return tsStatusFrom(st), nil
}

/**
 * A local listener whose connections are dialled THROUGH this node.
 *
 * The reason this exists at all: tsnet is a userspace node. It installs no
 * routes on the host and no resolver, so nothing outside this process can
 * reach the tailnet through it — `100.64.0.0/10` is not routed and a MagicDNS
 * name is not resolvable. The app was relying on `vpnDial`'s "system mode
 * routes for real, so there is nothing to forward" fallback, which is true of
 * WireGuard and OpenVPN in system mode and is exactly wrong here: a server
 * marked "reach through Tailscale" was dialled straight from the host, where
 * the name gave ENOTFOUND and the address had no route.
 *
 * `srv.Dial` is the whole fix. It resolves through the tailnet's own DNS and
 * carries the connection over the node, so both a MagicDNS name and a 100.x
 * address work — and they work whether or not the machine also runs a
 * Tailscale client of its own.
 */
func (s *Server) tsForwardOpen(req *Request) (interface{}, error) {
	var p ForwardOpenParams
	if err := decodeParams(req, &p); err != nil {
		return nil, err
	}
	if strings.TrimSpace(p.Host) == "" || p.Port <= 0 || p.Port > 65535 {
		return nil, codedf(ErrConfigInvalid, "a forward needs a host and a port in 1-65535")
	}

	s.ts.mu.Lock()
	node := s.ts.nodes[p.TunnelID]
	s.ts.mu.Unlock()
	if node == nil {
		return nil, codedf(ErrEngineStopped, "no Tailscale node %q is running", p.TunnelID)
	}

	bindHost := strings.TrimSpace(p.BindHost)
	if bindHost == "" {
		// An ephemeral forward has no business being reachable from the LAN.
		bindHost = "127.0.0.1"
	}
	ln, err := bindLocal(bindHost, p.BindPort)
	if err != nil {
		return nil, err
	}
	actual := ln.Addr().(*net.TCPAddr).Port
	id := "tsfwd-" + strconv.FormatUint(s.forwardN.Add(1), 10)

	node.mu.Lock()
	node.forwards[id] = ln
	node.mu.Unlock()

	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				// A closed listener is tsForwardClose or down(), not a fault.
				if errors.Is(err, net.ErrClosed) {
					return
				}
				s.out.Log("warn", p.TunnelID, "forward accept: "+redact(err.Error()))
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				// Dialled through the NODE, which is what makes MagicDNS and
				// the 100.x address resolvable at all.
				up, err := node.srv.Dial(context.Background(), "tcp", hostPort(p.Host, p.Port))
				if err != nil {
					s.out.Log("warn", p.TunnelID,
						"forward to "+hostPort(p.Host, p.Port)+": "+redact(err.Error()))
					return
				}
				defer up.Close()
				relay(context.Background(), c, up)
			}(c)
		}
	}()

	return &ForwardOpenResult{ForwardID: id, BindHost: bindHost, ListenPort: actual}, nil
}

func (s *Server) tsForwardClose(req *Request) (interface{}, error) {
	var p ForwardCloseParams
	if err := decodeParams(req, &p); err != nil {
		return nil, err
	}
	s.ts.mu.Lock()
	nodes := make([]*tsNode, 0, len(s.ts.nodes))
	for _, n := range s.ts.nodes {
		nodes = append(nodes, n)
	}
	s.ts.mu.Unlock()
	// Closing the listener stops NEW connections; ones already relaying end on
	// their own or when the node goes down. That is what "close the forward"
	// means to the caller, and it matches the WireGuard side exactly.
	for _, n := range nodes {
		n.mu.Lock()
		ln, ok := n.forwards[p.ForwardID]
		delete(n.forwards, p.ForwardID)
		n.mu.Unlock()
		if ok {
			_ = ln.Close()
			break
		}
	}
	// A forward whose node already went down is not an error: ts.down closed
	// it, and the caller catching up is the normal ordering.
	return map[string]string{"forwardId": p.ForwardID}, nil
}

func (s *Server) tsDown(req *Request) (interface{}, error) {
	var p TSDownParams
	if err := decodeParams(req, &p); err != nil {
		return nil, err
	}
	node := s.tsRemove(p.TunnelID)
	if node == nil {
		// Idempotent: stopping something already stopped is not an error, and
		// the caller frequently cannot know which it is.
		return map[string]bool{"stopped": true}, nil
	}
	node.cancel()
	// The listeners first: a forward outliving its node would accept
	// connections it can no longer dial anywhere.
	node.mu.Lock()
	for id, ln := range node.forwards {
		_ = ln.Close()
		delete(node.forwards, id)
	}
	node.mu.Unlock()
	if err := node.srv.Close(); err != nil {
		return nil, wrapCoded(ErrEngineFailed, err, "the Tailscale node did not stop cleanly")
	}
	// Only an ephemeral node's directory goes. A persistent node's key is what
	// lets it return as the SAME device rather than adding a new one to the
	// admin console on every restart.
	if node.ephemeral {
		_ = os.RemoveAll(node.stateDir)
	}
	return map[string]bool{"stopped": true}, nil
}

func (s *Server) tsRemove(id string) *tsNode {
	s.ts.mu.Lock()
	defer s.ts.mu.Unlock()
	node := s.ts.nodes[id]
	delete(s.ts.nodes, id)
	return node
}

// tsCloseAll stops every node, for process shutdown.
func (s *Server) tsCloseAll() {
	// Tolerates a nil registry. A Server is built as a literal in several
	// places, and a teardown path that dereferences a field one of them forgot
	// is a panic at the worst possible moment — during shutdown, where there is
	// nothing left to report it to.
	if s.ts == nil {
		return
	}
	s.ts.mu.Lock()
	nodes := make([]*tsNode, 0, len(s.ts.nodes))
	for _, n := range s.ts.nodes {
		nodes = append(nodes, n)
	}
	s.ts.nodes = map[string]*tsNode{}
	s.ts.mu.Unlock()
	for _, n := range nodes {
		n.cancel()
		_ = n.srv.Close()
		if n.ephemeral {
			_ = os.RemoveAll(n.stateDir)
		}
	}
}

// tsStatusFrom reduces Tailscale's status to what the app renders.
func tsStatusFrom(st *ipnstate.Status) *TSStatusResult {
	out := &TSStatusResult{Peers: []TSPeer{}}
	if st == nil {
		out.BackendState = "NoState"
		return out
	}
	out.BackendState = st.BackendState
	out.AuthURL = st.AuthURL
	out.MagicDNSSuffix = st.MagicDNSSuffix
	out.Health = append(out.Health, st.Health...)

	if st.Self != nil {
		out.Self.Name = trimMagicSuffix(st.Self.DNSName, st.MagicDNSSuffix)
		for _, ip := range st.Self.TailscaleIPs {
			out.Self.IPs = append(out.Self.IPs, ip.String())
		}
	}

	for _, p := range st.Peer {
		if p == nil || len(p.TailscaleIPs) == 0 {
			// A peer with no address cannot be dialled, so it cannot become a
			// connection — and a row nobody can use is worse than no row.
			continue
		}
		name := trimMagicSuffix(p.DNSName, st.MagicDNSSuffix)
		if name == "" {
			name = p.HostName
		}
		if name == "" {
			continue
		}
		out.Peers = append(out.Peers, TSPeer{
			Name:   name,
			Host:   p.TailscaleIPs[0].String(),
			Online: p.Online,
			OS:     p.OS,
		})
	}
	// Online first, then by name, so the same tailnet reads the same way twice.
	sort.Slice(out.Peers, func(i, j int) bool {
		if out.Peers[i].Online != out.Peers[j].Online {
			return out.Peers[i].Online
		}
		return out.Peers[i].Name < out.Peers[j].Name
	})
	return out
}

/**
 * `host.tailXXXX.ts.net.` -> `host`.
 *
 * The short name is what a person types and what MagicDNS resolves, so it is
 * what a device list should show. The trailing dot is part of a fully-qualified
 * name and is never wanted here.
 */
func trimMagicSuffix(dnsName, suffix string) string {
	n := strings.TrimSuffix(dnsName, ".")
	if suffix == "" {
		return n
	}
	return strings.TrimSuffix(n, "."+strings.TrimSuffix(suffix, "."))
}
