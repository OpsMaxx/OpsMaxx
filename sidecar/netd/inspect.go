package main

// The HTTPS traffic inspector.
//
// This is the one part of netd that deliberately breaks the rule the rest of
// the file set is built on. `httpproxy.go` says a tunnel process should move
// bytes and not interpret them, and for a tunnel that is right. An inspector
// exists precisely to interpret them, so the trade is made once, here, behind
// its own listener, its own lifecycle and its own set of caps — and never on
// the tunnel path, which still moves bytes and nothing else.
//
// Four properties are load-bearing:
//
//  1. **The CA private key arrives on stdin and dies with the process.** Like
//     every WireGuard key, it is never in argv, never in the environment and
//     never written to disk by this process. The parent holds it in the vault
//     and hands it over on `inspect.start`. A root CA key is the most
//     dangerous secret this application will ever handle — whoever has it can
//     impersonate every site on the machine — so it gets the strictest
//     handling we have, not the most convenient.
//
//  2. **Bodies are bounded before they are anything else.** Nothing is
//     buffered without a cap, nothing reaches the parent's event stream that
//     was not capped, and a body larger than the inline preview goes to a
//     spill file the parent reads on demand. A 200 MB download must cost the
//     renderer nothing, and it must not cost this process 200 MB either.
//
//  3. **A flow is reported twice: when it starts and when it ends.** A single
//     event at completion loses every request that is still in flight, every
//     server-sent-event stream that never completes, and every connection the
//     client abandons — which are exactly the requests someone opens a traffic
//     inspector to look at.
//
//  4. **Interception is a decision per host, revisable at runtime.** Some
//     clients pin their certificate and cannot be intercepted by anyone; the
//     honest answer is to notice, say so, and let that host through untouched
//     rather than leave the user with an application that simply does not
//     work while OpsMaxx is running.
//
// # Why flow payloads are not run through redact()
//
// Every other string that leaves this process goes through `redact()`. Flow
// events do not, and that is deliberate: the payload IS the product. A user
// who opens a traffic inspector to look at an `Authorization` header is not
// helped by seeing `[redacted]`, and `redact()` matches on shape, so it would
// also mangle any 44-character base64 value in a body — a JWT segment, an
// image, an ETag. Log lines and error messages from this file still redact,
// because those are diagnostics and nobody reads them to see their own token.

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/elazarl/goproxy"
)

const (
	// How much of each body travels inline on the event stream. Everything
	// beyond this is on disk and fetched by `inspect.body` only if someone
	// actually opens that flow. 8 KiB shows a JSON response in full and an
	// image not at all, which is the right split for a list view.
	inspectPreviewBytes = 8 << 10
	// Default ceiling on what is captured per body. Past this the bytes still
	// reach the client — we are a proxy, not a filter — they are simply no
	// longer recorded. Overridable per start; see InspectStartParams.
	inspectDefaultMaxBody = 8 << 20
	// A header block larger than this is not a header block, it is an attack
	// or a bug. The request still proceeds; only the recording is truncated.
	inspectMaxHeaderBytes = 64 << 10
	// Leaf certificates cached in memory. Each is ~1 KB, so this is a bounded
	// megabyte and change, and a browsing session touching more than 512
	// distinct hosts is rare enough that regenerating is fine.
	inspectCertCacheMax = 512
	// Leaf validity. Public CAs are capped at 398 days by every major client;
	// staying far under that keeps a leaked leaf close to worthless and
	// avoids tripping any client-side sanity check on long-dated certs.
	inspectLeafValidity = 30 * 24 * time.Hour
	// Clock skew allowance on the leaf's NotBefore. A machine whose clock is
	// two minutes fast should not reject every certificate we mint.
	inspectLeafBackdate = time.Hour
	// How many MITM attempts a host may make without ever producing a single
	// HTTP request before we call it pinned. One is a coincidence — a client
	// that opened a connection and changed its mind. Three is a policy.
	inspectPinThreshold = 3
	// How long a host that has hit the threshold is given to produce a request
	// before it is reported.
	//
	// This is not politeness, it is correctness. A browser opens six
	// connections to one origin at once, so all six CONNECTs can arrive before
	// the first request comes back on any of them — and without this grace the
	// most ordinary page load on the internet would be reported as certificate
	// pinning. One request from that host inside the window cancels the report.
	inspectPinGrace = 2 * time.Second
	// Upper bound on the in-flight flow table. A flow is removed when it ends;
	// this only bites if a client opens tens of thousands of requests that
	// never complete, and dropping the recording is better than growing without
	// limit.
	inspectMaxLiveFlows = 4096
)

// InspectStartParams is `inspect.start`.
//
// CAKeyPem is the only secret here and it follows the same rule as every
// WireGuard private key: it arrived on stdin, it stays in memory, and it is
// never logged, echoed in a result, or written anywhere by this process.
type InspectStartParams struct {
	// Optional; defaults to 127.0.0.1. Echoed back verbatim in the result so
	// the parent can warn when a proxy was deliberately exposed to the LAN,
	// exactly as ListenerOut does (E25).
	BindHost string `json:"bindHost,omitempty"`
	// 0 asks the OS to choose; the chosen port always comes back in the result.
	BindPort int `json:"bindPort"`
	// PEM. Both are required: an inspector without a CA cannot intercept
	// anything, and refusing at start is far kinder than failing on the first
	// HTTPS request with a TLS error the user has to decode.
	CACertPem string `json:"caCertPem"`
	CAKeyPem  string `json:"caKeyPem"`
	// Optional. When set, every upstream connection is dialled through this
	// live tunnel instead of the host's own stack — which is the whole point
	// of putting the inspector here rather than in the Electron process.
	ViaTunnelID string `json:"viaTunnelId,omitempty"`
	// Hosts that must never be intercepted. Exact (`api.example.com`) or
	// wildcard (`*.example.com`); matching is case-insensitive and ignores the
	// port. These are tunnelled as opaque bytes, exactly like the CONNECT
	// listener in httpproxy.go.
	Passthrough []string `json:"passthrough,omitempty"`
	// Per-body capture ceiling. 0 takes the default; a negative value disables
	// body capture entirely and records headers only.
	MaxBodyBytes int64 `json:"maxBodyBytes,omitempty"`
	// Extra roots to trust when validating the REAL server's certificate.
	// Terminating TLS makes us the only thing left checking that the far side
	// is who it claims to be, so the system trust store is the default and
	// these are added to it, never instead of it. This is what makes an
	// internal service behind a corporate CA inspectable without turning
	// verification off everywhere.
	UpstreamCAsPem []string `json:"upstreamCAsPem,omitempty"`
	// Stop verifying upstream certificates entirely. Off by default and it
	// stays off unless a person deliberately turns it on: an inspector that
	// silently accepts any certificate upstream has quietly downgraded every
	// connection on the machine, which is the one failure a security tool
	// must never introduce by accident. Turning it on says so in the log.
	InsecureUpstream bool `json:"insecureUpstream,omitempty"`
	// Where bodies larger than the inline preview are spilled. Empty disables
	// spilling, which caps every recorded body at the preview size — the right
	// setting for a machine where writing payloads to disk is not acceptable.
	//
	// The parent owns this directory: it creates it with the permissions it
	// wants and it deletes it. We only ever write files directly inside it.
	SpillDir string `json:"spillDir,omitempty"`
}

type InspectStartResult struct {
	BindHost string `json:"bindHost"`
	BindPort int    `json:"bindPort"`
	// Fingerprint of the CA that was loaded, so the parent can assert the
	// running proxy is signing with the certificate it thinks it installed
	// into the system trust store. SHA-256 over the DER, lowercase hex.
	CAFingerprint string `json:"caFingerprint"`
	CANotAfter    int64  `json:"caNotAfter"`
	ViaTunnelID   string `json:"viaTunnelId,omitempty"`
}

// InspectPassthroughParams is `inspect.passthrough`. The list is replaced
// wholesale rather than added to: a caller that has to reason about what is
// already in the set will eventually get it wrong, and the parent already
// holds the authoritative list.
type InspectPassthroughParams struct {
	Hosts []string `json:"hosts"`
}

type InspectPassthroughResult struct {
	Hosts []string `json:"hosts"`
}

// InspectBodyParams is `inspect.body`: a bounded read out of one spill file.
// Offset and Limit exist so the parent can page a 5 MB response into a viewer
// without either side holding all of it.
type InspectBodyParams struct {
	FlowID string `json:"flowId"`
	// "request" or "response".
	Side   string `json:"side"`
	Offset int64  `json:"offset,omitempty"`
	Limit  int64  `json:"limit,omitempty"`
}

type InspectBodyResult struct {
	// Base64. JSON cannot carry arbitrary bytes and a body is arbitrary bytes;
	// pretending otherwise corrupts every image and every gzip stream.
	Base64 string `json:"base64"`
	Offset int64  `json:"offset"`
	Total  int64  `json:"total"`
	EOF    bool   `json:"eof"`
}

type InspectStatusResult struct {
	Running       bool   `json:"running"`
	BindHost      string `json:"bindHost,omitempty"`
	BindPort      int    `json:"bindPort,omitempty"`
	CAFingerprint string `json:"caFingerprint,omitempty"`
	ViaTunnelID   string `json:"viaTunnelId,omitempty"`
	Flows         int64  `json:"flows"`
	LiveFlows     int    `json:"liveFlows"`
	Passthrough   int    `json:"passthrough"`
}

// FlowBegin is emitted the instant a request is understood, before it is sent
// upstream. Property 3: an inspector that only reports completed exchanges is
// blind to exactly the requests people are looking for.
type FlowBegin struct {
	FlowID      string   `json:"flowId"`
	StartedAt   int64    `json:"startedAt"`
	Method      string   `json:"method"`
	Scheme      string   `json:"scheme"`
	Host        string   `json:"host"`
	Port        int      `json:"port"`
	Path        string   `json:"path"`
	Query       string   `json:"query,omitempty"`
	HTTPVersion string   `json:"httpVersion"`
	Headers     []Header `json:"headers"`
	// True when the recorded header block was truncated at
	// inspectMaxHeaderBytes. The request itself was forwarded whole.
	HeadersTruncated bool `json:"headersTruncated,omitempty"`
}

// FlowEnd closes out a flow. Exactly one is emitted for every FlowBegin,
// including when the exchange failed, because a row that never resolves is a
// bug report waiting to happen.
type FlowEnd struct {
	FlowID  string `json:"flowId"`
	EndedAt int64  `json:"endedAt"`
	// Absent on failure.
	Status      int      `json:"status,omitempty"`
	StatusText  string   `json:"statusText,omitempty"`
	Headers     []Header `json:"headers,omitempty"`
	ContentType string   `json:"contentType,omitempty"`
	// Bytes actually seen on the wire, which is NOT the recorded size: a body
	// past the cap is forwarded in full and recorded in part.
	ReqBodySize int64 `json:"reqBodySize"`
	ResBodySize int64 `json:"resBodySize"`
	// What was captured, and where the rest of it is.
	ReqPreviewBase64 string `json:"reqPreviewBase64,omitempty"`
	ResPreviewBase64 string `json:"resPreviewBase64,omitempty"`
	ReqSpilled       bool   `json:"reqSpilled,omitempty"`
	ResSpilled       bool   `json:"resSpilled,omitempty"`
	ReqTruncated     bool   `json:"reqTruncated,omitempty"`
	ResTruncated     bool   `json:"resTruncated,omitempty"`
	// Set when the exchange did not complete. Redacted, unlike the payload
	// fields above: this one is a diagnostic, not the user's own traffic.
	Error string `json:"error,omitempty"`
}

type Header struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// PinnedHost says a host refused the certificate we minted for it, repeatedly.
// The parent turns this into an offer to stop intercepting that host, which is
// the only remedy that exists short of patching the client binary.
type PinnedHost struct {
	Host     string `json:"host"`
	Attempts int    `json:"attempts"`
	At       int64  `json:"at"`
}

// ------------------------------------------------------------------ inspector

type Inspector struct {
	out *Writer

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	ln       net.Listener
	bindHost string
	bindPort int
	proxy    *goproxy.ProxyHttpServer

	ca            tls.Certificate
	caLeaf        *x509.Certificate
	caFingerprint string
	// One key for every leaf we mint. Generating a fresh P-256 key per host
	// is pure cost: the leaf is thrown away in thirty days, it never leaves
	// this machine, and the CPU it saves on a page with forty origins is the
	// difference between a proxy that feels instant and one that does not.
	leafKey *ecdsa.PrivateKey

	viaTunnelID string
	dial        func(ctx context.Context, host string, port int) (net.Conn, error)

	maxBody  int64
	spillDir string
	// Trust for the upstream half of the connection. Held so buildProxy and
	// the tests can both see exactly what was decided.
	upstreamRoots    *x509.CertPool
	insecureUpstream bool

	mu          sync.RWMutex
	passthrough []string
	// MITM attempts that have not yet produced an HTTP request, per host. The
	// pinning signal: a client that completes our handshake sends a request,
	// and a client that rejects our certificate never does.
	attempts map[string]int
	pinned   map[string]bool
	// Hosts at the threshold, waiting out inspectPinGrace. Cancelled by a
	// request arriving from that host.
	pinTimers map[string]*time.Timer
	certs     map[string]*tls.Certificate
	certLRU   []string
	live      map[string]*flowRec

	flowN atomic.Uint64
	flows atomic.Int64
}

// flowRec is the mutable half of one exchange, alive between begin and end.
type flowRec struct {
	id  string
	req *bodyRecorder
	res *bodyRecorder
	// Guards the one-shot end: a failed round trip and a closed body can race
	// to finish the same flow, and two FlowEnds for one FlowBegin is worse
	// than none.
	once sync.Once
}

func (s *Server) inspectStart(req *Request) (interface{}, error) {
	var p InspectStartParams
	if err := decodeParams(req, &p); err != nil {
		return nil, err
	}

	s.mu.Lock()
	if s.stopping {
		s.mu.Unlock()
		return nil, codedf(ErrInternal, "the sidecar is shutting down")
	}
	if s.inspector != nil {
		s.mu.Unlock()
		return nil, codedf(ErrAlreadyRunning, "the traffic inspector is already running")
	}
	// Reserve the slot before the slow part (key parse, bind) so two
	// concurrent starts cannot both build an inspector, the same way
	// s.starting reserves a tunnelId in wg.up.
	s.inspectorStarting = true
	var via *Tunnel
	if p.ViaTunnelID != "" {
		via = s.tunnels[p.ViaTunnelID]
	}
	s.mu.Unlock()

	release := func() {
		s.mu.Lock()
		s.inspectorStarting = false
		s.mu.Unlock()
	}

	if p.ViaTunnelID != "" && via == nil {
		release()
		return nil, codedf(ErrConfigInvalid, "no tunnel %q is running to inspect through", p.ViaTunnelID)
	}

	ins, err := newInspector(s.ctx, s.out, &p, via)
	if err != nil {
		release()
		return nil, err
	}

	s.mu.Lock()
	s.inspectorStarting = false
	if s.stopping {
		s.mu.Unlock()
		ins.close()
		return nil, codedf(ErrInternal, "the sidecar is shutting down")
	}
	s.inspector = ins
	s.mu.Unlock()

	ins.start()
	return &InspectStartResult{
		BindHost:      ins.bindHost,
		BindPort:      ins.bindPort,
		CAFingerprint: ins.caFingerprint,
		CANotAfter:    ins.caLeaf.NotAfter.Unix(),
		ViaTunnelID:   ins.viaTunnelID,
	}, nil
}

func (s *Server) inspectStop(_ *Request) (interface{}, error) {
	s.mu.Lock()
	ins := s.inspector
	s.inspector = nil
	s.mu.Unlock()
	if ins == nil {
		// Stopping something that is not running is a success, not an error:
		// the caller wanted no inspector and there is no inspector. Every
		// teardown path in this binary is idempotent for the same reason.
		return &InspectStatusResult{Running: false}, nil
	}
	ins.close()
	return &InspectStatusResult{Running: false, Flows: ins.flows.Load()}, nil
}

func (s *Server) inspectStatus(_ *Request) (interface{}, error) {
	s.mu.Lock()
	ins := s.inspector
	s.mu.Unlock()
	if ins == nil {
		return &InspectStatusResult{Running: false}, nil
	}
	ins.mu.RLock()
	pt, live := len(ins.passthrough), len(ins.live)
	ins.mu.RUnlock()
	return &InspectStatusResult{
		Running:       true,
		BindHost:      ins.bindHost,
		BindPort:      ins.bindPort,
		CAFingerprint: ins.caFingerprint,
		ViaTunnelID:   ins.viaTunnelID,
		Flows:         ins.flows.Load(),
		LiveFlows:     live,
		Passthrough:   pt,
	}, nil
}

func (s *Server) inspectPassthrough(req *Request) (interface{}, error) {
	var p InspectPassthroughParams
	if err := decodeParams(req, &p); err != nil {
		return nil, err
	}
	s.mu.Lock()
	ins := s.inspector
	s.mu.Unlock()
	if ins == nil {
		return nil, codedf(ErrConfigInvalid, "the traffic inspector is not running")
	}
	list := normalisePassthrough(p.Hosts)
	ins.mu.Lock()
	ins.passthrough = list
	// A host the user has just decided to let through is no longer a host we
	// are failing to intercept: clear its strike count so that if they turn
	// interception back on later, it gets a fresh hearing rather than being
	// declared pinned on the first attempt.
	for _, h := range list {
		host := strings.TrimPrefix(h, "*.")
		delete(ins.attempts, host)
		delete(ins.pinned, host)
		if t := ins.pinTimers[host]; t != nil {
			t.Stop()
			delete(ins.pinTimers, host)
		}
	}
	ins.mu.Unlock()
	return &InspectPassthroughResult{Hosts: list}, nil
}

func (s *Server) inspectBody(req *Request) (interface{}, error) {
	var p InspectBodyParams
	if err := decodeParams(req, &p); err != nil {
		return nil, err
	}
	s.mu.Lock()
	ins := s.inspector
	s.mu.Unlock()
	if ins == nil {
		return nil, codedf(ErrConfigInvalid, "the traffic inspector is not running")
	}
	return ins.readBody(&p)
}

// newInspector validates everything that can be validated before a single byte
// is accepted. A traffic inspector that starts and then cannot sign is worse
// than one that refuses to start.
func newInspector(parent context.Context, out *Writer, p *InspectStartParams, via *Tunnel) (*Inspector, error) {
	ca, leaf, err := parseCA(p.CACertPem, p.CAKeyPem)
	if err != nil {
		return nil, err
	}
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "could not generate a leaf key")
	}

	bindHost := strings.TrimSpace(p.BindHost)
	if bindHost == "" {
		bindHost = "127.0.0.1"
	}
	spill := strings.TrimSpace(p.SpillDir)
	if spill != "" {
		// Fail now rather than on the first large body. An unwritable spill
		// directory is a packaging or permissions bug and it should surface
		// at the point the user pressed Start.
		if err := os.MkdirAll(spill, 0o700); err != nil {
			return nil, wrapCoded(ErrPermissionDenied, err, "cannot use the capture directory")
		}
	}
	maxBody := p.MaxBodyBytes
	if maxBody == 0 {
		maxBody = inspectDefaultMaxBody
	}

	roots, err := upstreamPool(p.UpstreamCAsPem)
	if err != nil {
		return nil, err
	}

	ln, err := bindLocal(bindHost, p.BindPort)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithCancel(parent)
	ins := &Inspector{
		out:              out,
		ctx:              ctx,
		cancel:           cancel,
		ln:               ln,
		bindHost:         bindHost,
		bindPort:         ln.Addr().(*net.TCPAddr).Port,
		ca:               ca,
		caLeaf:           leaf,
		caFingerprint:    fingerprint(leaf.Raw),
		leafKey:          leafKey,
		maxBody:          maxBody,
		spillDir:         spill,
		upstreamRoots:    roots,
		insecureUpstream: p.InsecureUpstream,
		passthrough:      normalisePassthrough(p.Passthrough),
		attempts:         map[string]int{},
		pinned:           map[string]bool{},
		certs:            map[string]*tls.Certificate{},
		pinTimers:        map[string]*time.Timer{},
		live:             map[string]*flowRec{},
	}
	if via != nil {
		ins.viaTunnelID = via.id
		ins.dial = via.dial
	} else {
		d := &net.Dialer{Timeout: 30 * time.Second}
		ins.dial = func(ctx context.Context, host string, port int) (net.Conn, error) {
			return d.DialContext(ctx, "tcp", hostPort(host, port))
		}
	}
	ins.proxy = ins.buildProxy()
	return ins, nil
}

func (ins *Inspector) start() {
	if ins.insecureUpstream {
		// Said every time it starts, not once at configuration time. A
		// setting that silently persists is how a machine ends up running
		// unverified for months because of a debugging session in March.
		ins.out.Log("warn", "",
			"the traffic inspector is NOT verifying upstream certificates; every connection through it is unauthenticated")
	}
	srv := &http.Server{
		Handler: ins.proxy,
		// A client that opens a connection and says nothing must not hold a
		// goroutine and a file descriptor forever.
		ReadHeaderTimeout: httpHeaderTimeout,
		MaxHeaderBytes:    inspectMaxHeaderBytes,
		BaseContext:       func(net.Listener) context.Context { return ins.ctx },
	}
	ins.wg.Add(1)
	go func() {
		defer ins.wg.Done()
		<-ins.ctx.Done()
		// Close(), not Shutdown(): a CONNECT tunnel is a hijacked connection
		// that http.Server's graceful shutdown will wait on forever, and an
		// inspector that will not stop is worse than one that drops a request.
		_ = srv.Close()
	}()
	ins.wg.Add(1)
	go func() {
		defer ins.wg.Done()
		if err := srv.Serve(ins.ln); err != nil && !errors.Is(err, http.ErrServerClosed) && ins.ctx.Err() == nil {
			ins.out.Log("error", "", "traffic inspector stopped: "+redact(err.Error()))
		}
	}()
}

func (ins *Inspector) close() {
	ins.cancel()
	_ = ins.ln.Close()
	// Bounded, for the same reason main's gracefulDrain is: a hijacked
	// CONNECT to a server that never answers must not stop the sidecar from
	// exiting.
	waitTimeout(&ins.wg, gracefulDrain)
	ins.mu.Lock()
	for host, t := range ins.pinTimers {
		t.Stop()
		delete(ins.pinTimers, host)
	}
	ins.certs = map[string]*tls.Certificate{}
	ins.certLRU = nil
	live := ins.live
	ins.live = map[string]*flowRec{}
	ins.mu.Unlock()
	// Every FlowBegin gets a FlowEnd, including the ones interrupted by the
	// inspector being switched off. A row that stays "in flight" forever in
	// the UI is indistinguishable from a hang.
	for _, f := range live {
		ins.finish(f, 0, "", nil, "", errors.New("the traffic inspector was stopped"))
	}
}

// ------------------------------------------------------------------ proxy

func (ins *Inspector) buildProxy() *goproxy.ProxyHttpServer {
	proxy := goproxy.NewProxyHttpServer()
	// goproxy's default logger writes to stderr. Ours goes on the protocol
	// stream as a log event like everything else, redacted on the way.
	proxy.Logger = inspectLogger{ins}
	proxy.Verbose = false
	// We terminate TLS ourselves and re-originate it, so the transport is the
	// only thing that validates the real server's certificate — turning that
	// off would silently make every intercepted connection insecure, which is
	// the exact failure a traffic inspector must not introduce.
	proxy.Tr = &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return ins.dialAddr(ctx, addr)
		},
		TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
			RootCAs:    ins.upstreamRoots,
			//nolint:gosec // G402: never true unless a person set insecureUpstream.
			InsecureSkipVerify: ins.insecureUpstream,
		},
		ForceAttemptHTTP2:     false,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   30 * time.Second,
		ExpectContinueTimeout: time.Second,
		// The host's own HTTP_PROXY must not apply to us. We ARE the proxy;
		// inheriting the environment here is how an inspector ends up looping
		// into itself the moment the user turns the system proxy on.
		Proxy: nil,
	}
	proxy.ConnectDialWithReq = func(_ *http.Request, _ string, addr string) (net.Conn, error) {
		return ins.dialAddr(context.Background(), addr)
	}
	proxy.ConnectionErrHandler = func(w io.Writer, ctx *goproxy.ProxyCtx, err error) {
		host := ""
		if ctx != nil && ctx.Req != nil {
			host = ctx.Req.URL.Host
		}
		ins.out.Log("warn", "", "inspector could not reach "+redact(host)+": "+redact(err.Error()))
		_, _ = io.WriteString(w, "HTTP/1.1 502 Bad Gateway\r\n\r\n")
	}

	proxy.OnRequest().HandleConnectFunc(ins.onConnect)
	proxy.OnRequest().DoFunc(ins.onRequest)
	proxy.OnResponse().DoFunc(ins.onResponse)
	return proxy
}

type inspectLogger struct{ ins *Inspector }

func (l inspectLogger) Printf(format string, v ...interface{}) {
	l.ins.out.Log("debug", "", "inspector: "+redact(fmt.Sprintf(format, v...)))
}

// dialAddr is the single upstream door. Everything — MITM'd requests, opaque
// CONNECT tunnels, WebSocket upgrades — leaves through here, which is what
// makes "inspect through my tunnel" a property of the design rather than a
// feature that works on some paths.
func (ins *Inspector) dialAddr(ctx context.Context, addr string) (net.Conn, error) {
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, fmt.Errorf("malformed upstream address %q", addr)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port <= 0 || port > 65535 {
		return nil, fmt.Errorf("malformed upstream port in %q", addr)
	}
	if ctx == nil {
		ctx = ins.ctx
	}
	return ins.dial(ctx, host, port)
}

// onConnect decides, per host, whether this connection is intercepted or
// tunnelled untouched.
func (ins *Inspector) onConnect(host string, ctx *goproxy.ProxyCtx) (*goproxy.ConnectAction, string) {
	name := hostOnly(host)
	if ins.isPassthrough(name) {
		return goproxy.OkConnect, host
	}
	ins.noteAttempt(name)
	return &goproxy.ConnectAction{
		Action:    goproxy.ConnectMitm,
		TLSConfig: ins.tlsConfigFor,
	}, host
}

func (ins *Inspector) tlsConfigFor(host string, _ *goproxy.ProxyCtx) (*tls.Config, error) {
	name := hostOnly(host)
	cert, err := ins.leafFor(name)
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		Certificates: []tls.Certificate{*cert},
		MinVersion:   tls.VersionTLS12,
		// HTTP/2 is deliberately absent from NextProtos. goproxy parses
		// HTTP/1.1 off the hijacked connection; advertising h2 to the client
		// would have it speak a framing nothing here reads. The client falls
		// back to HTTP/1.1 on its own, which is exactly what every other
		// intercepting proxy does.
		NextProtos: []string{"http/1.1"},
	}, nil
}

// ------------------------------------------------------------------ flows

func (ins *Inspector) onRequest(req *http.Request, ctx *goproxy.ProxyCtx) (*http.Request, *http.Response) {
	if req == nil || req.URL == nil {
		return req, nil
	}
	host := hostOnly(req.URL.Host)
	if host == "" {
		host = hostOnly(req.Host)
	}
	// A request arriving on this host is proof the client accepted our
	// certificate, so its strike count goes back to zero.
	ins.clearAttempt(host)

	id := "f" + strconv.FormatUint(ins.flowN.Add(1), 10)
	rec := &flowRec{id: id}
	rec.req = ins.newRecorder(id, "request")
	if req.Body != nil && ins.maxBody >= 0 {
		req.Body = rec.req.wrap(req.Body)
	}

	headers, truncated := snapshotHeaders(req.Header)
	scheme := req.URL.Scheme
	if scheme == "" {
		if ctx != nil && ctx.Req != nil && ctx.Req.TLS != nil {
			scheme = "https"
		} else {
			scheme = "http"
		}
	}
	ins.mu.Lock()
	if len(ins.live) >= inspectMaxLiveFlows {
		ins.mu.Unlock()
		// Recording stops; proxying does not. Dropping the user's traffic to
		// protect our own bookkeeping would be the wrong way round.
		ins.out.Log("warn", "", "traffic inspector is at its in-flight limit; this request was not recorded")
		return req, nil
	}
	ins.live[id] = rec
	ins.mu.Unlock()
	ins.flows.Add(1)

	if ctx != nil {
		ctx.UserData = rec
	}
	ins.out.Emit("inspect.flow.begin", &FlowBegin{
		FlowID:           id,
		StartedAt:        time.Now().UnixMilli(),
		Method:           req.Method,
		Scheme:           scheme,
		Host:             host,
		Port:             portFor(req.URL, scheme),
		Path:             req.URL.Path,
		Query:            req.URL.RawQuery,
		HTTPVersion:      req.Proto,
		Headers:          headers,
		HeadersTruncated: truncated,
	})
	return req, nil
}

func (ins *Inspector) onResponse(resp *http.Response, ctx *goproxy.ProxyCtx) *http.Response {
	if ctx == nil {
		return resp
	}
	rec, _ := ctx.UserData.(*flowRec)
	if rec == nil {
		return resp
	}
	if resp == nil {
		// goproxy calls the response handler with a nil response when the
		// round trip failed. ctx.Error is the only account of why, and
		// without this branch the flow would never end.
		err := ctx.Error
		if err == nil {
			err = errors.New("the request did not complete")
		}
		ins.finish(rec, 0, "", nil, "", err)
		// goproxy's own answer to a failed round trip is a 500, which tells
		// the client that WE broke. We did not: the upstream did, and 502 is
		// the status that says so. A developer reading their own traffic log
		// should not have to learn that our 500 means their server's failure.
		if ctx.Req != nil {
			return goproxy.NewResponse(ctx.Req, goproxy.ContentTypeText, http.StatusBadGateway,
				"OpsMaxx could not reach the upstream server.")
		}
		return resp
	}

	headers, _ := snapshotHeaders(resp.Header)
	status, statusText := resp.StatusCode, resp.Status
	ctype := resp.Header.Get("Content-Type")

	if resp.Body == nil || ins.maxBody < 0 {
		ins.finish(rec, status, statusText, headers, ctype, nil)
		return resp
	}
	rec.res = ins.newRecorder(rec.id, "response")
	// The flow ends when the body is closed, not when the headers arrive.
	// That is what makes a server-sent-event stream show up as one long-lived
	// row rather than a row that claims to be finished while bytes are still
	// arriving.
	rec.res.onClose = func() {
		ins.finish(rec, status, statusText, headers, ctype, nil)
	}
	resp.Body = rec.res.wrap(resp.Body)
	return resp
}

// finish emits exactly one FlowEnd and releases everything the flow held.
func (ins *Inspector) finish(rec *flowRec, status int, statusText string, headers []Header, ctype string, cause error) {
	rec.once.Do(func() {
		ins.mu.Lock()
		delete(ins.live, rec.id)
		ins.mu.Unlock()

		end := &FlowEnd{
			FlowID:     rec.id,
			EndedAt:    time.Now().UnixMilli(),
			Status:     status,
			StatusText: statusText,
			Headers:    headers,
			// Content-Type is duplicated out of the header list because every
			// consumer needs it to choose a viewer, and none of them should
			// have to scan a header array to find it.
			ContentType: ctype,
		}
		if cause != nil {
			end.Error = redact(cause.Error())
		}
		if rec.req != nil {
			rec.req.close()
			end.ReqBodySize = rec.req.seen
			end.ReqPreviewBase64 = rec.req.previewBase64()
			end.ReqSpilled = rec.req.spilled
			end.ReqTruncated = rec.req.truncated
		}
		if rec.res != nil {
			rec.res.close()
			end.ResBodySize = rec.res.seen
			end.ResPreviewBase64 = rec.res.previewBase64()
			end.ResSpilled = rec.res.spilled
			end.ResTruncated = rec.res.truncated
		}
		ins.out.Emit("inspect.flow.end", end)
	})
}

// ------------------------------------------------------------------ pinning

func (ins *Inspector) noteAttempt(host string) {
	if host == "" {
		return
	}
	ins.mu.Lock()
	if ins.pinned[host] || ins.pinTimers[host] != nil {
		ins.mu.Unlock()
		return
	}
	ins.attempts[host]++
	n := ins.attempts[host]
	if n < inspectPinThreshold {
		ins.mu.Unlock()
		return
	}
	// Armed, not fired. A request from this host inside the grace window
	// cancels it — see clearAttempt and the constant above.
	ins.pinTimers[host] = time.AfterFunc(inspectPinGrace, func() { ins.firePin(host, n) })
	ins.mu.Unlock()
}

// firePin reports a host as pinning, unless the grace window was won.
func (ins *Inspector) firePin(host string, attempts int) {
	ins.mu.Lock()
	// Gone from the map means clearAttempt cancelled us, or the inspector is
	// closing. Either way there is nothing to report.
	if ins.pinTimers[host] == nil || ins.pinned[host] || ins.ctx.Err() != nil {
		ins.mu.Unlock()
		return
	}
	delete(ins.pinTimers, host)
	ins.pinned[host] = true
	ins.mu.Unlock()
	// Said once per host per run. Repeating it every third failed handshake
	// would turn a browser tab retrying in the background into a notification
	// storm.
	ins.out.Emit("inspect.pinned", &PinnedHost{
		Host: host, Attempts: attempts, At: time.Now().UnixMilli(),
	})
}

func (ins *Inspector) clearAttempt(host string) {
	if host == "" {
		return
	}
	ins.mu.RLock()
	n, armed := ins.attempts[host], ins.pinTimers[host]
	ins.mu.RUnlock()
	if n == 0 && armed == nil {
		return
	}
	ins.mu.Lock()
	delete(ins.attempts, host)
	if t := ins.pinTimers[host]; t != nil {
		t.Stop()
		delete(ins.pinTimers, host)
	}
	ins.mu.Unlock()
}

func (ins *Inspector) isPassthrough(host string) bool {
	ins.mu.RLock()
	defer ins.mu.RUnlock()
	return matchHostList(ins.passthrough, host)
}

// matchHostList implements the only two forms of match there are: the exact
// host, and a `*.` wildcard that covers subdomains but NOT the bare domain.
// `*.example.com` does not match `example.com`, because that is what every
// certificate, every CDN config and every firewall rule means by it, and an
// inspector that invents its own matching rule will be wrong in the one case
// the user cared about.
func matchHostList(list []string, host string) bool {
	if host == "" {
		return false
	}
	host = strings.ToLower(host)
	for _, entry := range list {
		if entry == host {
			return true
		}
		if suffix, ok := strings.CutPrefix(entry, "*."); ok {
			if strings.HasSuffix(host, "."+suffix) {
				return true
			}
		}
	}
	return false
}

func normalisePassthrough(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, raw := range in {
		h := strings.ToLower(strings.TrimSpace(raw))
		if h == "" {
			continue
		}
		// A user pasting a host from the flow list will paste `host:443`, and
		// a rule that silently fails to match because of a port they could
		// not see is the worst kind of configuration bug.
		if wildcard, ok := strings.CutPrefix(h, "*."); ok {
			h = "*." + hostOnly(wildcard)
		} else {
			h = hostOnly(h)
		}
		if h == "" || h == "*." || seen[h] {
			continue
		}
		seen[h] = true
		out = append(out, h)
	}
	sort.Strings(out)
	return out
}

// ------------------------------------------------------------------ certs

// leafFor returns a certificate for one host, minting it if necessary.
func (ins *Inspector) leafFor(host string) (*tls.Certificate, error) {
	ins.mu.RLock()
	cached := ins.certs[host]
	ins.mu.RUnlock()
	if cached != nil {
		return cached, nil
	}
	cert, err := ins.signHost(host)
	if err != nil {
		return nil, err
	}
	ins.mu.Lock()
	// Another goroutine may have minted the same host while we were signing.
	// Keeping theirs rather than replacing it means a handshake in progress
	// never sees the certificate swapped underneath it.
	if existing := ins.certs[host]; existing != nil {
		ins.mu.Unlock()
		return existing, nil
	}
	if len(ins.certLRU) >= inspectCertCacheMax {
		oldest := ins.certLRU[0]
		ins.certLRU = ins.certLRU[1:]
		delete(ins.certs, oldest)
	}
	ins.certs[host] = cert
	ins.certLRU = append(ins.certLRU, host)
	ins.mu.Unlock()
	return cert, nil
}

// signHost mints one leaf. It exists instead of goproxy's TLSConfigFromCA for
// one reason: an IP literal has to go in IPAddresses, not DNSNames. A
// certificate for `https://192.168.1.10` with the address in DNSNames is
// rejected by every modern client, and a developer inspecting a device on
// their LAN is not an exotic case.
func (ins *Inspector) signHost(host string) (*tls.Certificate, error) {
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "could not generate a certificate serial")
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkixNameFor(host),
		NotBefore:             now.Add(-inspectLeafBackdate),
		NotAfter:              now.Add(inspectLeafValidity),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	if ip := net.ParseIP(host); ip != nil {
		tmpl.IPAddresses = []net.IP{ip}
	} else {
		tmpl.DNSNames = []string{host}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ins.caLeaf, &ins.leafKey.PublicKey, ins.ca.PrivateKey)
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "could not sign a certificate for this host")
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "signed an unparseable certificate")
	}
	return &tls.Certificate{
		// The CA's own DER is appended so the client is offered the full chain
		// it needs to build a path to the root it trusts. Without it, a client
		// that has the root in a store it does not consult during chain
		// building — which is most of them — fails for no visible reason.
		Certificate: [][]byte{der, ins.ca.Certificate[0]},
		PrivateKey:  ins.leafKey,
		Leaf:        leaf,
	}, nil
}

func pkixNameFor(host string) pkix.Name {
	return pkix.Name{CommonName: host, Organization: []string{"OpsMaxx Traffic Inspector"}}
}

// parseCA turns the PEM pair from the parent into something that can sign, and
// refuses anything that cannot. Every check here has a failure mode that would
// otherwise surface as an unexplained TLS error in someone's browser hours
// later.
func parseCA(certPem, keyPem string) (tls.Certificate, *x509.Certificate, error) {
	if strings.TrimSpace(certPem) == "" || strings.TrimSpace(keyPem) == "" {
		return tls.Certificate{}, nil, codedf(ErrConfigInvalid,
			"the traffic inspector needs a CA certificate and its private key")
	}
	pair, err := tls.X509KeyPair([]byte(certPem), []byte(keyPem))
	if err != nil {
		// The error from X509KeyPair can quote key bytes on some failure
		// paths, so it is deliberately not wrapped into the message.
		return tls.Certificate{}, nil, codedf(ErrConfigInvalid,
			"the CA certificate and key do not form a valid pair")
	}
	if len(pair.Certificate) == 0 {
		return tls.Certificate{}, nil, codedf(ErrConfigInvalid, "the CA certificate is empty")
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return tls.Certificate{}, nil, codedf(ErrConfigInvalid, "the CA certificate could not be parsed")
	}
	if !leaf.IsCA || !leaf.BasicConstraintsValid {
		return tls.Certificate{}, nil, codedf(ErrConfigInvalid,
			"that certificate is not a certificate authority, so it cannot sign for other hosts")
	}
	if leaf.KeyUsage != 0 && leaf.KeyUsage&x509.KeyUsageCertSign == 0 {
		return tls.Certificate{}, nil, codedf(ErrConfigInvalid,
			"that certificate authority is not allowed to sign certificates")
	}
	now := time.Now()
	if now.After(leaf.NotAfter) {
		return tls.Certificate{}, nil, codedf(ErrConfigInvalid,
			"the certificate authority expired on %s; generate a new one and install it",
			leaf.NotAfter.UTC().Format("2 January 2006"))
	}
	if now.Before(leaf.NotBefore) {
		return tls.Certificate{}, nil, codedf(ErrConfigInvalid,
			"the certificate authority is not valid until %s; check this machine's clock",
			leaf.NotBefore.UTC().Format("2 January 2006"))
	}
	switch pair.PrivateKey.(type) {
	case *ecdsa.PrivateKey, *rsa.PrivateKey:
	default:
		return tls.Certificate{}, nil, codedf(ErrConfigInvalid,
			"that certificate authority uses a key type the inspector cannot sign with")
	}
	pair.Leaf = leaf
	return pair, leaf, nil
}

// upstreamPool builds the trust store used to validate the real server. It
// starts from the system pool and adds to it, so opting into one private CA
// never means opting out of every public one.
func upstreamPool(pems []string) (*x509.CertPool, error) {
	if len(pems) == 0 {
		return nil, nil
	}
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		// Windows before Go 1.18 and some minimal containers have no readable
		// system store. An empty pool plus the caller's roots is still a
		// working, if narrow, trust store — and far better than silently
		// falling back to trusting everything.
		pool = x509.NewCertPool()
	}
	for i, p := range pems {
		if strings.TrimSpace(p) == "" {
			continue
		}
		if !pool.AppendCertsFromPEM([]byte(p)) {
			return nil, codedf(ErrConfigInvalid,
				"additional certificate authority %d is not a valid PEM certificate", i+1)
		}
	}
	return pool, nil
}

func fingerprint(der []byte) string {
	sum := sha256.Sum256(der)
	return hex.EncodeToString(sum[:])
}

// ------------------------------------------------------------------ bodies

// bodyRecorder is the whole of property 2. It sits between the client and the
// server, counts every byte, keeps the first `preview` of them in memory,
// streams up to `max` of them to a spill file, and passes all of them through
// untouched.
type bodyRecorder struct {
	ins     *Inspector
	path    string
	preview bytes.Buffer
	file    *os.File
	// Bytes that crossed the wire, which is the number the user cares about.
	seen int64
	// Bytes recorded, which is capped and therefore usually smaller.
	kept      int64
	spilled   bool
	truncated bool
	onClose   func()
	closeOnce sync.Once
	inner     io.ReadCloser
	mu        sync.Mutex
}

func (ins *Inspector) newRecorder(flowID, side string) *bodyRecorder {
	r := &bodyRecorder{ins: ins}
	if ins.spillDir != "" {
		r.path = filepath.Join(ins.spillDir, flowID+"."+side)
	}
	return r
}

func (r *bodyRecorder) wrap(inner io.ReadCloser) io.ReadCloser {
	r.inner = inner
	return r
}

func (r *bodyRecorder) Read(p []byte) (int, error) {
	n, err := r.inner.Read(p)
	if n > 0 {
		r.record(p[:n])
	}
	if err != nil {
		// io.EOF here means the body is complete. Closing on EOF rather than
		// waiting for Close() means a caller that reads to the end and forgets
		// to close still produces a FlowEnd.
		if errors.Is(err, io.EOF) {
			r.finishRecording()
		}
	}
	return n, err
}

func (r *bodyRecorder) record(b []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.seen += int64(len(b))
	max := r.ins.maxBody
	if r.kept >= max {
		r.truncated = true
		return
	}
	room := max - r.kept
	if int64(len(b)) > room {
		b = b[:room]
		r.truncated = true
	}
	r.kept += int64(len(b))

	if r.preview.Len() < inspectPreviewBytes {
		take := inspectPreviewBytes - r.preview.Len()
		if take > len(b) {
			take = len(b)
		}
		r.preview.Write(b[:take])
	}
	if r.path == "" {
		return
	}
	if r.file == nil {
		f, err := os.OpenFile(r.path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
		if err != nil {
			// Losing the spill copy is not worth failing the user's request
			// over. The preview and the byte counts survive; the file does not.
			r.path = ""
			r.ins.out.Log("warn", "", "could not record a body to disk: "+redact(err.Error()))
			return
		}
		r.file = f
		r.spilled = true
	}
	if _, err := r.file.Write(b); err != nil {
		_ = r.file.Close()
		r.file = nil
		r.path = ""
		r.spilled = false
		r.ins.out.Log("warn", "", "stopped recording a body to disk: "+redact(err.Error()))
	}
}

func (r *bodyRecorder) Close() error {
	err := r.inner.Close()
	r.finishRecording()
	return err
}

func (r *bodyRecorder) finishRecording() {
	r.closeOnce.Do(func() {
		r.close()
		if r.onClose != nil {
			r.onClose()
		}
	})
}

// close releases the spill handle. Safe to call more than once, because both
// the body's own Close and the flow's teardown reach it.
func (r *bodyRecorder) close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.file != nil {
		_ = r.file.Close()
		r.file = nil
	}
}

func (r *bodyRecorder) previewBase64() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.preview.Len() == 0 {
		return ""
	}
	return base64.StdEncoding.EncodeToString(r.preview.Bytes())
}

// readBody serves `inspect.body` out of the spill directory.
func (ins *Inspector) readBody(p *InspectBodyParams) (*InspectBodyResult, error) {
	side := strings.ToLower(strings.TrimSpace(p.Side))
	if side != "request" && side != "response" {
		return nil, codedf(ErrConfigInvalid, "side must be \"request\" or \"response\"")
	}
	if ins.spillDir == "" {
		return nil, codedf(ErrConfigInvalid, "this inspector is not recording bodies to disk")
	}
	// The flow id is used to build a path, so it is checked as a name and not
	// merely trimmed: `..` in an id must not be able to read a file outside
	// the capture directory, even though the only caller is our own parent.
	id := strings.TrimSpace(p.FlowID)
	if id == "" || id != filepath.Base(id) || strings.ContainsAny(id, `/\`) || id == "." || id == ".." {
		return nil, codedf(ErrConfigInvalid, "that is not a valid flow id")
	}
	path := filepath.Join(ins.spillDir, id+"."+side)
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, codedf(ErrConfigInvalid, "no recorded body for that flow")
		}
		return nil, wrapCoded(ErrInternal, err, "could not read the recorded body")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "could not measure the recorded body")
	}
	total := info.Size()
	offset := p.Offset
	if offset < 0 {
		offset = 0
	}
	if offset > total {
		offset = total
	}
	limit := p.Limit
	if limit <= 0 || limit > inspectDefaultMaxBody {
		limit = inspectPreviewBytes * 8
	}
	if offset+limit > total {
		limit = total - offset
	}
	buf := make([]byte, limit)
	n, err := f.ReadAt(buf, offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, wrapCoded(ErrInternal, err, "could not read the recorded body")
	}
	return &InspectBodyResult{
		Base64: base64.StdEncoding.EncodeToString(buf[:n]),
		Offset: offset,
		Total:  total,
		EOF:    offset+int64(n) >= total,
	}, nil
}

// ------------------------------------------------------------------ helpers

// snapshotHeaders flattens a header map into the wire shape, in a stable
// order, bounded. Sorted because Go randomises map iteration and a flow whose
// headers reshuffle every time the UI re-renders looks broken.
func snapshotHeaders(h http.Header) ([]Header, bool) {
	if len(h) == 0 {
		return nil, false
	}
	names := make([]string, 0, len(h))
	for name := range h {
		names = append(names, name)
	}
	sort.Strings(names)

	out := make([]Header, 0, len(h))
	size := 0
	truncated := false
	for _, name := range names {
		for _, v := range h[name] {
			size += len(name) + len(v) + 4
			if size > inspectMaxHeaderBytes {
				return out, true
			}
			out = append(out, Header{Name: name, Value: v})
		}
	}
	return out, truncated
}

// hostOnly strips a port and IPv6 brackets. `net.SplitHostPort` is not enough
// on its own: a bare `example.com` is an error to it, and a bare `[::1]` is
// too, and both are things a client will send.
func hostOnly(hostport string) string {
	h := strings.TrimSpace(hostport)
	if h == "" {
		return ""
	}
	if host, _, err := net.SplitHostPort(h); err == nil {
		h = host
	}
	h = strings.TrimPrefix(h, "[")
	h = strings.TrimSuffix(h, "]")
	return strings.ToLower(strings.TrimSuffix(h, "."))
}

func portFor(u *url.URL, scheme string) int {
	if u != nil {
		if p := u.Port(); p != "" {
			if n, err := strconv.Atoi(p); err == nil {
				return n
			}
		}
	}
	if scheme == "https" {
		return 443
	}
	return 80
}

// stopInspectorOn tears down the inspector if — and only if — it was riding
// the tunnel that is going away. Called from wg.down, where the alternative is
// a proxy that stays up and answers everything with 502.
func (s *Server) stopInspectorOn(tunnelID, reason string) {
	s.mu.Lock()
	ins := s.inspector
	if ins == nil || ins.viaTunnelID != tunnelID {
		s.mu.Unlock()
		return
	}
	s.inspector = nil
	s.mu.Unlock()
	ins.close()
	s.out.Emit("inspect.stopped", map[string]string{"reason": reason})
}

// ------------------------------------------------------------------ CA mint

// InspectCAParams is `inspect.ca.generate`.
type InspectCAParams struct {
	// What the certificate calls itself in the operating system's trust UI.
	// A person scrolling Keychain Access or certmgr.msc has to be able to see
	// what this is and where it came from, or they cannot make an informed
	// decision about removing it.
	CommonName string `json:"commonName,omitempty"`
	// Days of validity. Bounded below by a day and above by five years: an
	// authority that never expires is one nobody ever revisits, and one that
	// expires next week is a support ticket.
	ValidDays int `json:"validDays,omitempty"`
}

type InspectCAResult struct {
	CertPem string `json:"certPem"`
	// The one field in this protocol that must never be logged, echoed or
	// written to disk by this process. It goes straight into the response and
	// nowhere else, exactly like KeygenResult's private key.
	KeyPem      string `json:"keyPem"`
	Fingerprint string `json:"fingerprint"`
	NotAfter    int64  `json:"notAfter"`
	NotBefore   int64  `json:"notBefore"`
}

const (
	inspectCADefaultDays = 365
	inspectCAMaxDays     = 5 * 365
)

// generateCA mints the root the inspector signs with.
//
// It lives here rather than in the Electron process for the same reason
// keygen.go exists: the X.509 code is already linked into this binary, and a
// second implementation in another language is a second thing to get wrong
// about the most dangerous key this application handles.
//
// P-256 rather than RSA: every platform trust store, every browser and every
// TLS library shipped this decade accepts it, it is an order of magnitude
// faster to sign with — which matters when a single page load asks for forty
// leaves — and there is no legacy client on the far side to appease, because
// the far side is this machine.
func (s *Server) inspectCAGenerate(req *Request) (interface{}, error) {
	var p InspectCAParams
	if len(req.Params) > 0 {
		if err := decodeParams(req, &p); err != nil {
			return nil, err
		}
	}
	name := strings.TrimSpace(p.CommonName)
	if name == "" {
		name = "OpsMaxx Traffic Inspector"
	}
	if len(name) > 64 {
		// RFC 5280 caps a CommonName at 64 characters and some trust stores
		// reject a longer one outright rather than truncating.
		return nil, codedf(ErrConfigInvalid, "the certificate name must be 64 characters or fewer")
	}
	days := p.ValidDays
	if days == 0 {
		days = inspectCADefaultDays
	}
	if days < 1 || days > inspectCAMaxDays {
		return nil, codedf(ErrConfigInvalid, "validDays must be between 1 and %d", inspectCAMaxDays)
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "could not generate a certificate authority key")
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "could not generate a certificate serial")
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName:   name,
			Organization: []string{"OpsMaxx"},
		},
		NotBefore:             now.Add(-inspectLeafBackdate),
		NotAfter:              now.AddDate(0, 0, days),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		// This authority signs server certificates and nothing else. A trust
		// store that honours the constraint will refuse to accept a leaf it
		// signed for code signing or email, which narrows the blast radius of
		// a stolen key from "everything" to "TLS servers on this machine".
		MaxPathLen:     0,
		MaxPathLenZero: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "could not sign the certificate authority")
	}
	keyDer, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "could not encode the certificate authority key")
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "generated an unparseable certificate")
	}
	return &InspectCAResult{
		CertPem:     string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})),
		KeyPem:      string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDer})),
		Fingerprint: fingerprint(der),
		NotAfter:    leaf.NotAfter.Unix(),
		NotBefore:   leaf.NotBefore.Unix(),
	}, nil
}
