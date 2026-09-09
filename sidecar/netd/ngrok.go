package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"sort"
	"strconv"
	"sync"
	"time"

	ngrok "golang.ngrok.com/ngrok/v2"
)

// ngrok, embedded.
//
// This opens ngrok endpoints from inside this process using ngrok's own Go
// package rather than driving the `ngrok` agent binary. `golang.ngrok.com/ngrok/v2`
// is MIT and needs no agent installed, which is what makes this work on a
// machine that has never heard of ngrok.
//
// The previous design shelled out to the agent, and the reasoning behind it was
// half right in a way worth recording so nobody repeats it: the ngrok AGENT is
// closed-source and genuinely cannot be redistributed. That is true, and it is
// also beside the point, because the library is not the agent. Stopping at the
// agent produced a feature that required the user to install a binary this app
// could not ship — and on Windows, where PATH is never searched, to go and find
// it by hand.
//
// ── What this does with traffic ────────────────────────────────────────────
//
// An endpoint here is a listener in this process. Every connection ngrok
// accepts is proxied to a local address the caller named, byte for byte, and
// nothing is inspected or stored. That is the same shape as the SSH forward in
// forward.go and deliberately so — this is a pipe, not a proxy with opinions.

type ngrokTunnel struct {
	id       string
	agent    ngrok.Agent
	forwards []*ngrokForward
	cancel   context.CancelFunc
}

type ngrokForward struct {
	name      string
	url       string
	proto     string
	localAddr string
	ln        ngrok.EndpointListener
}

type ngrokState struct {
	mu      sync.Mutex
	tunnels map[string]*ngrokTunnel
}

func newNgrokState() *ngrokState { return &ngrokState{tunnels: map[string]*ngrokTunnel{}} }

// NgrokEndpointSpec is one endpoint to publish.
type NgrokEndpointSpec struct {
	Name string `json:"name"`
	/** http, tcp or tls. */
	Proto string `json:"proto"`
	/** The port on THIS machine that gets published. */
	LocalPort int `json:"localPort"`
	/** Where to bind locally. Defaults to 127.0.0.1. */
	LocalHost string `json:"localHost,omitempty"`
	/** A reserved domain or TCP address, for accounts that have one. */
	Domain string `json:"domain,omitempty"`
}

type NgrokUpParams struct {
	TunnelID string `json:"tunnelId"`
	/**
	 * The account authtoken.
	 *
	 * Passed per call rather than read from a file or an environment variable:
	 * it comes from the app's vault, lives in memory for as long as the tunnel
	 * does, and is never written anywhere by this process.
	 */
	Authtoken string              `json:"authtoken"`
	Endpoints []NgrokEndpointSpec `json:"endpoints"`
	TimeoutMs int                 `json:"timeoutMs,omitempty"`
}

type NgrokEndpointResult struct {
	Name      string `json:"name"`
	URL       string `json:"url"`
	Proto     string `json:"proto"`
	LocalAddr string `json:"localAddr"`
}

type NgrokUpResult struct {
	Endpoints []NgrokEndpointResult `json:"endpoints"`
}

type NgrokDownParams struct {
	TunnelID string `json:"tunnelId"`
}

type NgrokStatusParams struct {
	TunnelID string `json:"tunnelId"`
}

func (s *Server) ngrokUp(req *Request) (interface{}, error) {
	var p NgrokUpParams
	if err := decodeParams(req, &p); err != nil {
		return nil, err
	}
	if p.TunnelID == "" {
		return nil, codedf(ErrConfigInvalid, "tunnelId is required")
	}
	if p.Authtoken == "" {
		return nil, codedf(ErrConfigInvalid, "an authtoken is required")
	}
	if len(p.Endpoints) == 0 {
		return nil, codedf(ErrConfigInvalid, "at least one endpoint is required")
	}
	for i, e := range p.Endpoints {
		if e.Name == "" {
			return nil, codedf(ErrConfigInvalid, "endpoint %d has no name", i)
		}
		if e.LocalPort < 1 || e.LocalPort > 65535 {
			return nil, codedf(ErrConfigInvalid, "endpoint %q has no usable port", e.Name)
		}
		switch e.Proto {
		case "http", "tcp", "tls":
		default:
			return nil, codedf(ErrConfigInvalid, "endpoint %q has an unsupported protocol %q", e.Name, e.Proto)
		}
	}

	s.ngrok.mu.Lock()
	if _, live := s.ngrok.tunnels[p.TunnelID]; live {
		s.ngrok.mu.Unlock()
		return nil, codedf(ErrAlreadyRunning, "ngrok tunnel %q is already running", p.TunnelID)
	}
	s.ngrok.mu.Unlock()

	timeout := time.Duration(p.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = 45 * time.Second
	}
	ctx, cancel := context.WithCancel(context.Background())
	startCtx, startCancel := context.WithTimeout(ctx, timeout)
	defer startCancel()

	agent, err := ngrok.NewAgent(ngrok.WithAuthtoken(p.Authtoken))
	if err != nil {
		cancel()
		return nil, wrapCoded(ErrConfigInvalid, err, "the ngrok authtoken was not accepted")
	}
	if err := agent.Connect(startCtx); err != nil {
		cancel()
		return nil, wrapCoded(ErrEngineFailed, err, "could not reach ngrok")
	}

	t := &ngrokTunnel{id: p.TunnelID, agent: agent, cancel: cancel}
	out := &NgrokUpResult{Endpoints: []NgrokEndpointResult{}}

	for _, e := range p.Endpoints {
		opts := []ngrok.EndpointOption{}
		if e.Domain != "" {
			// `url` carries the reserved address for every protocol; the scheme
			// is what distinguishes an http domain from a reserved tcp address.
			opts = append(opts, ngrok.WithURL(ngrokURLFor(e)))
		} else if e.Proto != "http" {
			opts = append(opts, ngrok.WithURL(e.Proto+"://"))
		}

		ln, err := agent.Listen(startCtx, opts...)
		if err != nil {
			// Everything opened so far comes down: a half-published tunnel is
			// worse than a failed one, because the caller believes it failed.
			t.closeAll()
			cancel()
			return nil, wrapCoded(ErrEngineFailed, err, "endpoint %q could not be published", e.Name)
		}

		host := e.LocalHost
		if host == "" {
			host = "127.0.0.1"
		}
		local := net.JoinHostPort(host, strconv.Itoa(e.LocalPort))

		f := &ngrokForward{name: e.Name, url: ln.URL().String(), proto: e.Proto, localAddr: local, ln: ln}
		t.forwards = append(t.forwards, f)
		out.Endpoints = append(out.Endpoints, NgrokEndpointResult{
			Name: f.name, URL: f.url, Proto: f.proto, LocalAddr: f.localAddr,
		})

		go s.ngrokServe(ctx, p.TunnelID, f)
	}

	sort.Slice(out.Endpoints, func(i, j int) bool { return out.Endpoints[i].Name < out.Endpoints[j].Name })

	s.ngrok.mu.Lock()
	s.ngrok.tunnels[p.TunnelID] = t
	s.ngrok.mu.Unlock()
	return out, nil
}

// ngrokURLFor spells a reserved address the way each protocol wants it.
func ngrokURLFor(e NgrokEndpointSpec) string {
	switch e.Proto {
	case "tcp":
		return "tcp://" + e.Domain
	case "tls":
		return "tls://" + e.Domain
	default:
		return "https://" + e.Domain
	}
}

/**
 * Accept from ngrok and pipe to the local address.
 *
 * One goroutine per endpoint, one more per connection. Nothing is buffered
 * beyond io.Copy's own window and nothing is inspected: this is a pipe.
 */
func (s *Server) ngrokServe(ctx context.Context, tunnelID string, f *ngrokForward) {
	for {
		conn, err := f.ln.Accept()
		if err != nil {
			if ctx.Err() == nil {
				s.out.Log("warn", tunnelID, fmt.Sprintf("endpoint %s stopped accepting: %v", f.name, err))
			}
			return
		}
		go func() {
			defer conn.Close()
			local, err := net.DialTimeout("tcp", f.localAddr, 10*time.Second)
			if err != nil {
				// The published address is up and nothing is listening behind
				// it. Worth a line: it is the difference between "ngrok is
				// broken" and "your service is not running".
				s.out.Log("warn", tunnelID, fmt.Sprintf("%s: nothing is listening on %s", f.name, f.localAddr))
				return
			}
			defer local.Close()
			done := make(chan struct{}, 2)
			go func() { _, _ = io.Copy(local, conn); done <- struct{}{} }()
			go func() { _, _ = io.Copy(conn, local); done <- struct{}{} }()
			<-done
		}()
	}
}

func (t *ngrokTunnel) closeAll() {
	for _, f := range t.forwards {
		_ = f.ln.Close()
	}
	if t.agent != nil {
		_ = t.agent.Disconnect()
	}
}

func (s *Server) ngrokStatus(req *Request) (interface{}, error) {
	var p NgrokStatusParams
	if err := decodeParams(req, &p); err != nil {
		return nil, err
	}
	s.ngrok.mu.Lock()
	t := s.ngrok.tunnels[p.TunnelID]
	s.ngrok.mu.Unlock()
	if t == nil {
		return nil, codedf(ErrEngineStopped, "no ngrok tunnel %q is running", p.TunnelID)
	}
	out := &NgrokUpResult{Endpoints: []NgrokEndpointResult{}}
	for _, f := range t.forwards {
		out.Endpoints = append(out.Endpoints, NgrokEndpointResult{
			Name: f.name, URL: f.url, Proto: f.proto, LocalAddr: f.localAddr,
		})
	}
	return out, nil
}

func (s *Server) ngrokDown(req *Request) (interface{}, error) {
	var p NgrokDownParams
	if err := decodeParams(req, &p); err != nil {
		return nil, err
	}
	s.ngrok.mu.Lock()
	t := s.ngrok.tunnels[p.TunnelID]
	delete(s.ngrok.tunnels, p.TunnelID)
	s.ngrok.mu.Unlock()
	if t == nil {
		// Idempotent, like ts.down: the caller often cannot know.
		return map[string]bool{"stopped": true}, nil
	}
	t.closeAll()
	t.cancel()
	return map[string]bool{"stopped": true}, nil
}

// ngrokCloseAll stops every tunnel, for process shutdown. A published URL must
// not outlive the process that promised to serve it.
func (s *Server) ngrokCloseAll() {
	// Tolerates a nil registry, for the reason tsCloseAll does.
	if s.ngrok == nil {
		return
	}
	s.ngrok.mu.Lock()
	ts := make([]*ngrokTunnel, 0, len(s.ngrok.tunnels))
	for _, t := range s.ngrok.tunnels {
		ts = append(ts, t)
	}
	s.ngrok.tunnels = map[string]*ngrokTunnel{}
	s.ngrok.mu.Unlock()
	for _, t := range ts {
		t.closeAll()
		t.cancel()
	}
}
