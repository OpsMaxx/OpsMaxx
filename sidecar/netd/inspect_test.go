package main

// These tests stand up a real origin server with its own CA, a real inspector
// with a different CA, and a real http.Client that trusts one or the other,
// and make them talk over loopback. That is deliberate: every mistake worth
// catching here — a leaf without the CA in its chain, a passthrough rule that
// silently never matches, a body recorder that deadlocks a streaming
// response, a flow that never ends — is invisible to a test that stubs the
// TLS layer, and all of them would reach a user as "the proxy just hangs".

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// ------------------------------------------------------------------ harness

// eventSink is main_test.go's syncBuf with a parser on top: the proxy writes
// events from its own goroutines while the test reads them, so the buffer has
// to be the synchronised one.
type eventSink struct{ syncBuf }

// events returns every event of one name emitted so far, as decoded maps.
func (s *eventSink) events(name string) []map[string]any {
	raw := s.String()

	var out []map[string]any
	for _, line := range strings.Split(raw, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var ev struct {
			Event string         `json:"event"`
			Data  map[string]any `json:"data"`
		}
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			continue
		}
		if ev.Event == name {
			out = append(out, ev.Data)
		}
	}
	return out
}

// waitFor polls until cond holds or the deadline passes. Every wait in this
// file is on a condition rather than a sleep: the flows are emitted from proxy
// goroutines and a fixed sleep is either flaky or slow, usually both.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// newCA mints a self-signed CA and returns it as the PEM pair the protocol
// takes, plus the parsed certificate for building client trust pools.
func newCA(t *testing.T, opts ...func(*x509.Certificate)) (certPem, keyPem string, cert *x509.Certificate) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("ca key: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "OpsMaxx Test CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
	}
	for _, o := range opts {
		o(tmpl)
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("ca sign: %v", err)
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("ca parse: %v", err)
	}
	keyDer, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatalf("ca key marshal: %v", err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})),
		string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDer})),
		parsed
}

// originServer is an HTTPS server on 127.0.0.1 with its own CA, standing in
// for "some site on the internet". Its CA is deliberately NOT the inspector's:
// that is what makes the pinning test meaningful.
type originServer struct {
	url  string
	host string
	pool *x509.CertPool
	// The origin's CA as PEM, handed to the inspector as an extra upstream
	// root. Without it the inspector correctly refuses to validate a private
	// CA — which is the behaviour, not a test problem.
	caPem  string
	listen net.Listener
}

// newOriginH2 is newOrigin with h2 offered in ALPN, for the HTTP/2 path.
func newOriginH2(t *testing.T, handler http.Handler) *originServer {
	t.Helper()
	return newOriginWith(t, handler, []string{"h2", "http/1.1"})
}

func newOrigin(t *testing.T, handler http.Handler) *originServer {
	t.Helper()
	return newOriginWith(t, handler, []string{"http/1.1"})
}

func newOriginWith(t *testing.T, handler http.Handler, alpn []string) *originServer {
	t.Helper()
	caCertPem, caKeyPem, caCert := newCA(t)
	caPair, err := tls.X509KeyPair([]byte(caCertPem), []byte(caKeyPem))
	if err != nil {
		t.Fatalf("origin ca pair: %v", err)
	}
	caLeaf, err := x509.ParseCertificate(caPair.Certificate[0])
	if err != nil {
		t.Fatalf("origin ca leaf: %v", err)
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("origin key: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "localhost"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, caLeaf, &key.PublicKey, caPair.PrivateKey)
	if err != nil {
		t.Fatalf("origin sign: %v", err)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("origin listen: %v", err)
	}
	srv := &http.Server{
		Handler: handler,
		TLSConfig: &tls.Config{
			Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}},
			MinVersion:   tls.VersionTLS12,
			NextProtos:   alpn,
		},
	}
	go func() { _ = srv.ServeTLS(ln, "", "") }()
	t.Cleanup(func() { _ = srv.Close() })

	pool := x509.NewCertPool()
	pool.AddCert(caCert)
	port := ln.Addr().(*net.TCPAddr).Port
	return &originServer{
		url:    fmt.Sprintf("https://localhost:%d", port),
		host:   "localhost",
		pool:   pool,
		caPem:  caCertPem,
		listen: ln,
	}
}

// newTestInspector builds an inspector on a free port with a fresh CA.
func newTestInspector(t *testing.T, mutate func(*InspectStartParams)) (*Inspector, *eventSink, *x509.CertPool) {
	t.Helper()
	certPem, keyPem, caCert := newCA(t)
	sink := &eventSink{}
	p := &InspectStartParams{
		BindHost:  "127.0.0.1",
		BindPort:  0,
		CACertPem: certPem,
		CAKeyPem:  keyPem,
		SpillDir:  t.TempDir(),
	}
	if mutate != nil {
		mutate(p)
	}
	ins, err := newInspector(context.Background(), NewWriter(sink), p, nil)
	if err != nil {
		t.Fatalf("newInspector: %v", err)
	}
	ins.start()
	t.Cleanup(ins.close)

	pool := x509.NewCertPool()
	pool.AddCert(caCert)
	return ins, sink, pool
}

// trusting makes the inspector accept one test origin's private CA on the
// upstream half, which is exactly what a user does for an internal service.
func trusting(o *originServer) func(*InspectStartParams) {
	return func(p *InspectStartParams) { p.UpstreamCAsPem = []string{o.caPem} }
}

// clientThrough returns an http.Client that proxies through the inspector and
// trusts exactly the roots given. Passing only the origin's pool models a
// client that pins: it will refuse anything the inspector signs.
func clientThrough(t *testing.T, ins *Inspector, roots *x509.CertPool) *http.Client {
	t.Helper()
	proxyURL, err := url.Parse(fmt.Sprintf("http://%s:%d", ins.bindHost, ins.bindPort))
	if err != nil {
		t.Fatalf("proxy url: %v", err)
	}
	return &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			Proxy:           http.ProxyURL(proxyURL),
			TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12},
		},
	}
}

// ------------------------------------------------------------------ CA gate

func TestParseCARejectsWhatCannotSign(t *testing.T) {
	goodCert, goodKey, _ := newCA(t)
	otherCert, _, _ := newCA(t)

	notCA := func(c *x509.Certificate) {
		c.IsCA = false
		c.KeyUsage = x509.KeyUsageDigitalSignature
	}
	leafCert, leafKey, _ := newCA(t, notCA)

	expired := func(c *x509.Certificate) {
		c.NotBefore = time.Now().Add(-48 * time.Hour)
		c.NotAfter = time.Now().Add(-24 * time.Hour)
	}
	expiredCert, expiredKey, _ := newCA(t, expired)

	future := func(c *x509.Certificate) {
		c.NotBefore = time.Now().Add(24 * time.Hour)
		c.NotAfter = time.Now().Add(48 * time.Hour)
	}
	futureCert, futureKey, _ := newCA(t, future)

	cases := []struct {
		name     string
		cert     string
		key      string
		wantWord string
	}{
		{"empty cert", "", goodKey, "needs a CA certificate"},
		{"empty key", goodCert, "", "needs a CA certificate"},
		{"garbage", "not a pem", "not a pem either", "valid pair"},
		{"mismatched pair", otherCert, goodKey, "valid pair"},
		{"not a CA", leafCert, leafKey, "not a certificate authority"},
		{"expired", expiredCert, expiredKey, "expired on"},
		{"not yet valid", futureCert, futureKey, "not valid until"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, _, err := parseCA(tc.cert, tc.key)
			if err == nil {
				t.Fatal("expected a refusal")
			}
			if !strings.Contains(err.Error(), tc.wantWord) {
				t.Fatalf("error %q does not mention %q", err.Error(), tc.wantWord)
			}
			var ce *codedError
			if !asCoded(err, &ce) || ce.code != ErrConfigInvalid {
				t.Fatalf("want config-invalid, got %v", err)
			}
		})
	}
}

func TestParseCAAcceptsAWorkingPair(t *testing.T) {
	certPem, keyPem, cert := newCA(t)
	pair, leaf, err := parseCA(certPem, keyPem)
	if err != nil {
		t.Fatalf("parseCA: %v", err)
	}
	if pair.PrivateKey == nil {
		t.Fatal("no private key on the pair")
	}
	if !leaf.Equal(cert) {
		t.Fatal("parsed a different certificate than the one supplied")
	}
}

// The CA private key must never reach the event stream, in any form. This is
// the single most damaging string this process handles.
func TestCAKeyNeverReachesTheEventStream(t *testing.T) {
	certPem, keyPem, _ := newCA(t)
	sink := &eventSink{}
	ins, err := newInspector(context.Background(), NewWriter(sink), &InspectStartParams{
		CACertPem: certPem,
		CAKeyPem:  keyPem,
		SpillDir:  t.TempDir(),
	}, nil)
	if err != nil {
		t.Fatalf("newInspector: %v", err)
	}
	ins.start()
	ins.close()

	out := sink.String()

	// The whole PEM, and the base64 body of it with the armour stripped —
	// a naive "%v" of a key struct would print neither, but a naive echo of
	// the params would print both.
	body := strings.ReplaceAll(keyPem, "\n", "")
	body = strings.TrimPrefix(body, "-----BEGIN EC PRIVATE KEY-----")
	body = strings.TrimSuffix(body, "-----END EC PRIVATE KEY-----")
	for _, needle := range []string{keyPem, body} {
		if needle != "" && strings.Contains(out, needle) {
			t.Fatal("the CA private key appeared on the protocol stream")
		}
	}
}

// ------------------------------------------------------------------ matching

func TestPassthroughMatching(t *testing.T) {
	list := normalisePassthrough([]string{
		" API.Example.com:443 ", "*.internal.dev", "api.example.com", "", "*.", "host:8443",
	})
	want := []string{"*.internal.dev", "api.example.com", "host"}
	if strings.Join(list, ",") != strings.Join(want, ",") {
		t.Fatalf("normalised to %v, want %v", list, want)
	}

	cases := map[string]bool{
		"api.example.com":     true,
		"API.EXAMPLE.COM":     true,
		"a.internal.dev":      true,
		"deep.a.internal.dev": true,
		// A wildcard covers subdomains and not the bare domain. Every
		// certificate and every firewall rule means it this way; inventing a
		// different rule here would be wrong exactly when it mattered.
		"internal.dev":           false,
		"notapi.example.com":     false,
		"example.com":            false,
		"host":                   true,
		"evil-internal.dev":      false,
		"":                       false,
		"xinternal.dev":          false,
		"a.internal.dev.evil.co": false,
	}
	for host, want := range cases {
		if got := matchHostList(list, host); got != want {
			t.Errorf("matchHostList(%q) = %v, want %v", host, got, want)
		}
	}
}

func TestHostOnly(t *testing.T) {
	cases := map[string]string{
		"example.com":      "example.com",
		"example.com:443":  "example.com",
		"EXAMPLE.com.":     "example.com",
		"[::1]:8443":       "::1",
		"[2001:db8::1]":    "2001:db8::1",
		"127.0.0.1:8080":   "127.0.0.1",
		"  spaced.io:80  ": "spaced.io",
		"":                 "",
	}
	for in, want := range cases {
		if got := hostOnly(in); got != want {
			t.Errorf("hostOnly(%q) = %q, want %q", in, got, want)
		}
	}
}

// ------------------------------------------------------------------ round trip

func TestInterceptsHTTPSAndReportsBothEnds(t *testing.T) {
	origin := newOrigin(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if string(body) != "ping" {
			t.Errorf("origin saw request body %q, want %q", body, "ping")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Origin", "yes")
		w.WriteHeader(201)
		_, _ = w.Write([]byte(`{"pong":true}`))
	}))

	ins, sink, insPool := newTestInspector(t, trusting(origin))
	// The client trusts the inspector (installed CA) but reaches an origin
	// whose real certificate it never sees — which is the point.
	client := clientThrough(t, ins, insPool)

	resp, err := client.Post(origin.url+"/echo?q=1", "text/plain", strings.NewReader("ping"))
	if err != nil {
		t.Fatalf("request through the inspector: %v", err)
	}
	defer resp.Body.Close()
	got, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 201 || string(got) != `{"pong":true}` {
		t.Fatalf("got %d %q", resp.StatusCode, got)
	}

	waitFor(t, "the flow to end", func() bool { return len(sink.events("inspect.flow.end")) == 1 })

	begins := sink.events("inspect.flow.begin")
	if len(begins) != 1 {
		t.Fatalf("want 1 begin event, got %d", len(begins))
	}
	b := begins[0]
	if b["method"] != "POST" || b["path"] != "/echo" || b["query"] != "q=1" {
		t.Fatalf("begin event has the wrong request line: %v", b)
	}
	if b["scheme"] != "https" || b["host"] != "localhost" {
		t.Fatalf("begin event has the wrong target: %v", b)
	}

	e := sink.events("inspect.flow.end")[0]
	if e["flowId"] != b["flowId"] {
		t.Fatal("the end event does not name the flow the begin event opened")
	}
	if int(e["status"].(float64)) != 201 {
		t.Fatalf("end event status %v", e["status"])
	}
	if e["contentType"] != "application/json" {
		t.Fatalf("end event content type %v", e["contentType"])
	}
	if got := decodePreview(t, e, "resPreviewBase64"); got != `{"pong":true}` {
		t.Fatalf("response preview %q", got)
	}
	if got := decodePreview(t, e, "reqPreviewBase64"); got != "ping" {
		t.Fatalf("request preview %q", got)
	}
	// The header the origin set must survive the round trip through us.
	if !hasHeader(e["headers"], "X-Origin", "yes") {
		t.Fatalf("response headers lost X-Origin: %v", e["headers"])
	}
}

func TestInterceptsPlainHTTP(t *testing.T) {
	var seen string
	origin := httpOrigin(t, func(w http.ResponseWriter, r *http.Request) {
		seen = r.URL.Path
		_, _ = w.Write([]byte("plain"))
	})

	ins, sink, insPool := newTestInspector(t, nil)
	client := clientThrough(t, ins, insPool)

	resp, err := client.Get(origin + "/over-http")
	if err != nil {
		t.Fatalf("plain http through the inspector: %v", err)
	}
	defer resp.Body.Close()
	_, _ = io.ReadAll(resp.Body)

	waitFor(t, "the http flow to end", func() bool { return len(sink.events("inspect.flow.end")) == 1 })
	if seen != "/over-http" {
		t.Fatalf("origin saw %q", seen)
	}
	if b := sink.events("inspect.flow.begin")[0]; b["scheme"] != "http" {
		t.Fatalf("plain http recorded as %v", b["scheme"])
	}
}

// A passthrough host is tunnelled, not intercepted: the client sees the
// origin's own certificate and we record nothing about the exchange.
func TestPassthroughHostIsNotIntercepted(t *testing.T) {
	origin := newOrigin(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("direct"))
	}))

	ins, sink, _ := newTestInspector(t, func(p *InspectStartParams) {
		trusting(origin)(p)
		p.Passthrough = []string{"localhost"}
	})
	// Trusting only the origin's CA proves the connection was never
	// intercepted: an inspector-signed certificate would fail this client.
	client := clientThrough(t, ins, origin.pool)

	resp, err := client.Get(origin.url + "/direct")
	if err != nil {
		t.Fatalf("passthrough request: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "direct" {
		t.Fatalf("body %q", body)
	}
	if n := len(sink.events("inspect.flow.begin")); n != 0 {
		t.Fatalf("a passthrough host produced %d flow events", n)
	}
}

// The remedy for a pinning client: add the host at runtime and it starts
// working, without restarting the inspector or the client.
func TestPassthroughCanBeAddedAtRuntime(t *testing.T) {
	origin := newOrigin(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("later"))
	}))
	ins, _, _ := newTestInspector(t, trusting(origin))
	client := clientThrough(t, ins, origin.pool)

	if _, err := client.Get(origin.url + "/first"); err == nil {
		t.Fatal("a client that does not trust the inspector should have failed")
	}

	ins.mu.Lock()
	ins.passthrough = normalisePassthrough([]string{"localhost"})
	ins.mu.Unlock()

	resp, err := client.Get(origin.url + "/second")
	if err != nil {
		t.Fatalf("after passthrough was added: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "later" {
		t.Fatalf("body %q", body)
	}
}

// ------------------------------------------------------------------ pinning

func TestPinningIsDetectedAndReportedOnce(t *testing.T) {
	origin := newOrigin(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("never reached"))
	}))
	ins, sink, _ := newTestInspector(t, trusting(origin))
	// This client trusts only the origin's CA, so it rejects everything we
	// sign — exactly what a pinning client does.
	client := clientThrough(t, ins, origin.pool)

	for i := 0; i < inspectPinThreshold+2; i++ {
		resp, err := client.Get(origin.url + "/pinned")
		if err == nil {
			resp.Body.Close()
			t.Fatal("the pinning client should not have completed a request")
		}
		client.CloseIdleConnections()
	}

	waitFor(t, "the pinned event", func() bool { return len(sink.events("inspect.pinned")) >= 1 })
	events := sink.events("inspect.pinned")
	if len(events) != 1 {
		t.Fatalf("want exactly one pinned event, got %d — a retrying client must not storm the UI", len(events))
	}
	if events[0]["host"] != "localhost" {
		t.Fatalf("pinned event named %v", events[0]["host"])
	}
}

// A host that works must never be reported as pinned, however many
// connections it opens.
func TestSuccessfulHostIsNeverReportedPinned(t *testing.T) {
	origin := newOrigin(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	}))
	ins, sink, insPool := newTestInspector(t, trusting(origin))
	client := clientThrough(t, ins, insPool)

	for i := 0; i < inspectPinThreshold+3; i++ {
		resp, err := client.Get(origin.url + "/fine")
		if err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
		_, _ = io.ReadAll(resp.Body)
		resp.Body.Close()
		client.CloseIdleConnections()
	}
	if n := len(sink.events("inspect.pinned")); n != 0 {
		t.Fatalf("a working host was reported pinned %d times", n)
	}
}

// ------------------------------------------------------------------ bodies

func TestLargeBodyIsCappedSpilledAndPageable(t *testing.T) {
	const size = 300 * 1024
	payload := bytes.Repeat([]byte("abcdefgh"), size/8)
	origin := newOrigin(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(payload)
	}))

	const cap = 64 * 1024
	ins, sink, insPool := newTestInspector(t, func(p *InspectStartParams) {
		trusting(origin)(p)
		p.MaxBodyBytes = cap
	})
	client := clientThrough(t, ins, insPool)

	resp, err := client.Get(origin.url + "/big")
	if err != nil {
		t.Fatalf("big request: %v", err)
	}
	got, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		t.Fatalf("reading the big body: %v", err)
	}
	// Property: capping the RECORDING must never truncate the TRANSFER.
	if !bytes.Equal(got, payload) {
		t.Fatalf("the client received %d bytes, want %d — capping recording must not cap delivery", len(got), len(payload))
	}

	waitFor(t, "the big flow to end", func() bool { return len(sink.events("inspect.flow.end")) == 1 })
	e := sink.events("inspect.flow.end")[0]
	if int64(e["resBodySize"].(float64)) != int64(len(payload)) {
		t.Fatalf("resBodySize %v, want %d", e["resBodySize"], len(payload))
	}
	if e["resTruncated"] != true {
		t.Fatal("a body past the cap must be marked truncated")
	}
	if e["resSpilled"] != true {
		t.Fatal("a body past the preview must be spilled")
	}

	flowID := e["flowId"].(string)
	page, err := ins.readBody(&InspectBodyParams{FlowID: flowID, Side: "response", Offset: 0, Limit: 1024})
	if err != nil {
		t.Fatalf("readBody: %v", err)
	}
	if page.Total != cap {
		t.Fatalf("spilled %d bytes, want the cap %d", page.Total, cap)
	}
	first, err := base64.StdEncoding.DecodeString(page.Base64)
	if err != nil {
		t.Fatalf("page not base64: %v", err)
	}
	if !bytes.Equal(first, payload[:1024]) {
		t.Fatal("the first page does not match the start of the body")
	}
	if page.EOF {
		t.Fatal("a 1 KiB page of a 64 KiB body is not the end")
	}

	last, err := ins.readBody(&InspectBodyParams{FlowID: flowID, Side: "response", Offset: cap - 10, Limit: 1024})
	if err != nil {
		t.Fatalf("readBody tail: %v", err)
	}
	if !last.EOF {
		t.Fatal("the tail page should report EOF")
	}
	tail, _ := base64.StdEncoding.DecodeString(last.Base64)
	if len(tail) != 10 {
		t.Fatalf("tail page returned %d bytes, want 10", len(tail))
	}
}

func TestBodyCaptureCanBeDisabled(t *testing.T) {
	origin := newOrigin(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("secret payload"))
	}))
	ins, sink, insPool := newTestInspector(t, func(p *InspectStartParams) {
		trusting(origin)(p)
		p.MaxBodyBytes = -1
	})
	client := clientThrough(t, ins, insPool)

	resp, err := client.Get(origin.url + "/nobody")
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "secret payload" {
		t.Fatalf("the client must still receive the body, got %q", body)
	}

	waitFor(t, "the flow to end", func() bool { return len(sink.events("inspect.flow.end")) == 1 })
	e := sink.events("inspect.flow.end")[0]
	if e["resPreviewBase64"] != nil {
		t.Fatal("body capture was disabled but a preview was recorded")
	}
	if len(ls(t, ins.spillDir)) != 0 {
		t.Fatal("body capture was disabled but something was written to disk")
	}
}

func TestReadBodyRefusesToEscapeTheCaptureDirectory(t *testing.T) {
	ins, _, _ := newTestInspector(t, nil)
	outside := filepath.Join(filepath.Dir(ins.spillDir), "escaped.response")
	if err := os.WriteFile(outside, []byte("do not read me"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	for _, id := range []string{"../escaped", "..", ".", "", "a/b", `a\b`} {
		if _, err := ins.readBody(&InspectBodyParams{FlowID: id, Side: "response"}); err == nil {
			t.Fatalf("flow id %q was accepted", id)
		}
	}
	if _, err := ins.readBody(&InspectBodyParams{FlowID: "f1", Side: "sideways"}); err == nil {
		t.Fatal("an unknown side was accepted")
	}
}

// A streaming response must produce its begin event immediately, not when the
// stream finally ends. This is the whole reason flows are reported twice.
func TestStreamingResponseBeginsBeforeItEnds(t *testing.T) {
	release := make(chan struct{})
	origin := newOrigin(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		_, _ = w.Write([]byte("data: first\n\n"))
		w.(http.Flusher).Flush()
		<-release
		_, _ = w.Write([]byte("data: last\n\n"))
	}))

	ins, sink, insPool := newTestInspector(t, trusting(origin))
	client := clientThrough(t, ins, insPool)

	resp, err := client.Get(origin.url + "/stream")
	if err != nil {
		t.Fatalf("stream request: %v", err)
	}
	buf := make([]byte, len("data: first\n\n"))
	if _, err := io.ReadFull(resp.Body, buf); err != nil {
		t.Fatalf("reading the first chunk: %v", err)
	}

	waitFor(t, "the stream to be reported as begun", func() bool {
		return len(sink.events("inspect.flow.begin")) == 1
	})
	if n := len(sink.events("inspect.flow.end")); n != 0 {
		t.Fatal("a stream that is still open must not be reported as ended")
	}

	close(release)
	_, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	waitFor(t, "the stream to end", func() bool { return len(sink.events("inspect.flow.end")) == 1 })
}

// ------------------------------------------------------------------ lifecycle

// Every begin gets an end, including when the inspector is stopped with
// requests in flight. A row stuck at "in flight" forever reads as a hang.
func TestStoppingEndsFlowsThatAreStillOpen(t *testing.T) {
	hold := make(chan struct{})
	origin := newOrigin(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		<-hold
	}))
	t.Cleanup(func() { close(hold) })

	ins, sink, insPool := newTestInspector(t, trusting(origin))
	client := clientThrough(t, ins, insPool)

	go func() {
		resp, err := client.Get(origin.url + "/hang")
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
		}
	}()

	waitFor(t, "the hanging flow to begin", func() bool {
		return len(sink.events("inspect.flow.begin")) == 1
	})
	ins.close()

	waitFor(t, "the hanging flow to be ended by the stop", func() bool {
		return len(sink.events("inspect.flow.end")) == 1
	})
	e := sink.events("inspect.flow.end")[0]
	if e["error"] == nil || !strings.Contains(e["error"].(string), "stopped") {
		t.Fatalf("the interrupted flow should say why it ended, got %v", e["error"])
	}
}

func TestCloseIsIdempotent(t *testing.T) {
	ins, _, _ := newTestInspector(t, nil)
	ins.close()
	ins.close()
}

func TestUnreachableUpstreamEndsTheFlowWithAnError(t *testing.T) {
	// A port nothing is listening on: dialling it fails fast and locally.
	dead, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	addr := dead.Addr().String()
	_ = dead.Close()

	ins, sink, insPool := newTestInspector(t, nil)
	client := clientThrough(t, ins, insPool)

	resp, err := client.Get("http://" + addr + "/gone")
	if err == nil {
		// A plain-HTTP request to a dead upstream comes back as a 502 from
		// the proxy rather than a transport error, which is also correct.
		if resp.StatusCode != http.StatusBadGateway {
			t.Fatalf("want 502 for a dead upstream, got %d", resp.StatusCode)
		}
		resp.Body.Close()
	}
	waitFor(t, "the failed flow to end", func() bool { return len(sink.events("inspect.flow.end")) == 1 })
	e := sink.events("inspect.flow.end")[0]
	if e["error"] == nil {
		t.Fatal("a failed exchange must record why it failed")
	}
}

// ------------------------------------------------------------------ certs

func TestLeafForIPLiteralUsesAnIPSAN(t *testing.T) {
	ins, _, _ := newTestInspector(t, nil)
	cert, err := ins.leafFor("192.168.1.10")
	if err != nil {
		t.Fatalf("leafFor: %v", err)
	}
	if len(cert.Leaf.IPAddresses) != 1 || cert.Leaf.IPAddresses[0].String() != "192.168.1.10" {
		t.Fatalf("an IP host must get an IP SAN, got DNS=%v IP=%v", cert.Leaf.DNSNames, cert.Leaf.IPAddresses)
	}
	if len(cert.Leaf.DNSNames) != 0 {
		t.Fatalf("an IP host must not get a DNS SAN, got %v", cert.Leaf.DNSNames)
	}

	named, err := ins.leafFor("example.com")
	if err != nil {
		t.Fatalf("leafFor: %v", err)
	}
	if len(named.Leaf.DNSNames) != 1 || named.Leaf.DNSNames[0] != "example.com" {
		t.Fatalf("a named host must get a DNS SAN, got %v", named.Leaf.DNSNames)
	}
	// The chain must carry the CA so a client can build a path to the root it
	// trusts without having to guess.
	if len(named.Certificate) != 2 {
		t.Fatalf("leaf chain has %d certificates, want leaf + CA", len(named.Certificate))
	}
}

func TestLeafCacheIsBoundedAndStable(t *testing.T) {
	ins, _, _ := newTestInspector(t, nil)
	first, err := ins.leafFor("stable.example")
	if err != nil {
		t.Fatalf("leafFor: %v", err)
	}
	again, _ := ins.leafFor("stable.example")
	if first != again {
		t.Fatal("the same host must reuse the same certificate")
	}
	for i := 0; i < inspectCertCacheMax+16; i++ {
		if _, err := ins.leafFor(fmt.Sprintf("h%d.example", i)); err != nil {
			t.Fatalf("leafFor: %v", err)
		}
	}
	ins.mu.RLock()
	n := len(ins.certs)
	ins.mu.RUnlock()
	if n > inspectCertCacheMax {
		t.Fatalf("cert cache grew to %d, past its %d cap", n, inspectCertCacheMax)
	}
}

// ------------------------------------------------------------------ server

func TestServerRefusesASecondInspector(t *testing.T) {
	certPem, keyPem, _ := newCA(t)
	s := newInspectorServer(t)
	params, _ := json.Marshal(&InspectStartParams{
		CACertPem: certPem, CAKeyPem: keyPem, SpillDir: t.TempDir(),
	})

	if _, err := s.inspectStart(&Request{ID: "1", Method: "inspect.start", Params: params}); err != nil {
		t.Fatalf("first start: %v", err)
	}
	_, err := s.inspectStart(&Request{ID: "2", Method: "inspect.start", Params: params})
	if err == nil {
		t.Fatal("a second inspector was allowed")
	}
	var ce *codedError
	if !asCoded(err, &ce) || ce.code != ErrAlreadyRunning {
		t.Fatalf("want already-running, got %v", err)
	}

	// Stopping twice is a success both times: every teardown in this binary
	// is idempotent.
	if _, err := s.inspectStop(&Request{ID: "3"}); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if _, err := s.inspectStop(&Request{ID: "4"}); err != nil {
		t.Fatalf("second stop: %v", err)
	}
	st, err := s.inspectStatus(&Request{ID: "5"})
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if st.(*InspectStatusResult).Running {
		t.Fatal("status says running after stop")
	}
}

func TestInspectStartRejectsAMissingTunnel(t *testing.T) {
	certPem, keyPem, _ := newCA(t)
	s := newInspectorServer(t)
	params, _ := json.Marshal(&InspectStartParams{
		CACertPem: certPem, CAKeyPem: keyPem, ViaTunnelID: "nope", SpillDir: t.TempDir(),
	})
	_, err := s.inspectStart(&Request{ID: "1", Method: "inspect.start", Params: params})
	if err == nil {
		t.Fatal("starting through a tunnel that is not running was allowed")
	}
	if !strings.Contains(err.Error(), "no tunnel") {
		t.Fatalf("unhelpful error: %v", err)
	}
	// The reservation must be released, or every later start fails too.
	s.mu.Lock()
	starting := s.inspectorStarting
	s.mu.Unlock()
	if starting {
		t.Fatal("a failed start left the inspector slot reserved")
	}
}

func TestPassthroughUpdateClearsPinnedState(t *testing.T) {
	certPem, keyPem, _ := newCA(t)
	s := newInspectorServer(t)
	params, _ := json.Marshal(&InspectStartParams{
		CACertPem: certPem, CAKeyPem: keyPem, SpillDir: t.TempDir(),
	})
	if _, err := s.inspectStart(&Request{ID: "1", Method: "inspect.start", Params: params}); err != nil {
		t.Fatalf("start: %v", err)
	}
	s.mu.Lock()
	ins := s.inspector
	s.mu.Unlock()

	for i := 0; i < inspectPinThreshold; i++ {
		ins.noteAttempt("pinned.example")
	}
	// The report is armed rather than immediate — see inspectPinGrace — so the
	// host is only actually pinned once the window has passed.
	waitFor(t, "the host to be marked pinned", func() bool {
		ins.mu.RLock()
		defer ins.mu.RUnlock()
		return ins.pinned["pinned.example"]
	})

	upd, _ := json.Marshal(&InspectPassthroughParams{Hosts: []string{"pinned.example"}})
	res, err := s.inspectPassthrough(&Request{ID: "2", Method: "inspect.passthrough", Params: upd})
	if err != nil {
		t.Fatalf("passthrough: %v", err)
	}
	if got := res.(*InspectPassthroughResult).Hosts; len(got) != 1 || got[0] != "pinned.example" {
		t.Fatalf("passthrough result %v", got)
	}
	ins.mu.RLock()
	stillPinned := ins.pinned["pinned.example"]
	attempts := ins.attempts["pinned.example"]
	ins.mu.RUnlock()
	if stillPinned || attempts != 0 {
		t.Fatal("letting a host through must clear its strike record")
	}
}

func TestStoppingATunnelStopsAnInspectorRidingIt(t *testing.T) {
	s := newInspectorServer(t)
	certPem, keyPem, _ := newCA(t)
	sink := &eventSink{}
	s.out = NewWriter(sink)

	ins, err := newInspector(s.ctx, s.out, &InspectStartParams{
		CACertPem: certPem, CAKeyPem: keyPem, SpillDir: t.TempDir(),
	}, nil)
	if err != nil {
		t.Fatalf("newInspector: %v", err)
	}
	ins.viaTunnelID = "t1"
	ins.start()
	s.mu.Lock()
	s.inspector = ins
	s.mu.Unlock()

	// A different tunnel going down must not touch it.
	s.stopInspectorOn("t2", "unrelated")
	s.mu.Lock()
	survived := s.inspector != nil
	s.mu.Unlock()
	if !survived {
		t.Fatal("an unrelated tunnel stopped the inspector")
	}

	s.stopInspectorOn("t1", "the tunnel it was inspecting through was stopped")
	s.mu.Lock()
	gone := s.inspector == nil
	s.mu.Unlock()
	if !gone {
		t.Fatal("the inspector survived the tunnel it was riding")
	}
	if len(sink.events("inspect.stopped")) != 1 {
		t.Fatal("stopping the transport must say so, not fail silently later")
	}
}

// ------------------------------------------------------------------ helpers

func newInspectorServer(t *testing.T) *Server {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	s := &Server{
		out:      discardWriter(),
		tunnels:  map[string]*Tunnel{},
		starting: map[string]bool{},
		forwards: map[string]string{},
		ctx:      ctx,
		cancel:   cancel,
		stopped:  make(chan struct{}),
	}
	t.Cleanup(func() {
		s.mu.Lock()
		ins := s.inspector
		s.inspector = nil
		s.mu.Unlock()
		if ins != nil {
			ins.close()
		}
		cancel()
	})
	return s
}

func httpOrigin(t *testing.T, h http.HandlerFunc) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("http origin listen: %v", err)
	}
	srv := &http.Server{Handler: h}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return "http://" + ln.Addr().String()
}

func decodePreview(t *testing.T, ev map[string]any, key string) string {
	t.Helper()
	raw, ok := ev[key].(string)
	if !ok {
		return ""
	}
	b, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		t.Fatalf("%s is not base64: %v", key, err)
	}
	return string(b)
}

func hasHeader(raw any, name, value string) bool {
	list, ok := raw.([]any)
	if !ok {
		return false
	}
	for _, item := range list {
		h, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if strings.EqualFold(h["name"].(string), name) && h["value"] == value {
			return true
		}
	}
	return false
}

func ls(t *testing.T, dir string) []os.DirEntry {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	return entries
}

// ------------------------------------------------------------------ CA mint

func TestGeneratedCACanSignAndIsBounded(t *testing.T) {
	s := newInspectorServer(t)
	res, err := s.inspectCAGenerate(&Request{ID: "1", Method: "inspect.ca.generate"})
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	ca := res.(*InspectCAResult)

	// The whole point: what it mints must be loadable by the inspector.
	pair, leaf, err := parseCA(ca.CertPem, ca.KeyPem)
	if err != nil {
		t.Fatalf("the generated CA is not usable by the inspector: %v", err)
	}
	if pair.PrivateKey == nil {
		t.Fatal("no private key")
	}
	if !leaf.IsCA {
		t.Fatal("the generated certificate is not a CA")
	}
	if leaf.KeyUsage&x509.KeyUsageCertSign == 0 {
		t.Fatal("the generated CA cannot sign certificates")
	}
	// A CA that can mint intermediates is a CA that can be chained onward.
	if !leaf.MaxPathLenZero || leaf.MaxPathLen != 0 {
		t.Fatal("the generated CA should not be able to issue intermediates")
	}
	if ca.Fingerprint != fingerprint(leaf.Raw) {
		t.Fatal("the reported fingerprint is not the certificate's")
	}
	want := time.Now().AddDate(0, 0, inspectCADefaultDays)
	if got := time.Unix(ca.NotAfter, 0); got.Before(want.Add(-time.Hour)) || got.After(want.Add(time.Hour)) {
		t.Fatalf("default validity is %v, want about %v", got, want)
	}
}

func TestGeneratedCARejectsUnreasonableInput(t *testing.T) {
	s := newInspectorServer(t)
	for _, tc := range []struct{ name, params string }{
		{"too long a name", `{"commonName":"` + strings.Repeat("x", 65) + `"}`},
		{"negative validity", `{"validDays":-1}`},
		{"a century", `{"validDays":36500}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := s.inspectCAGenerate(&Request{
				ID: "1", Method: "inspect.ca.generate", Params: json.RawMessage(tc.params),
			})
			if err == nil {
				t.Fatal("accepted")
			}
			var ce *codedError
			if !asCoded(err, &ce) || ce.code != ErrConfigInvalid {
				t.Fatalf("want config-invalid, got %v", err)
			}
		})
	}
}

// A freshly minted CA, used by a live inspector, must actually satisfy a real
// TLS client. This is the one assertion that covers the whole chain: mint,
// load, sign a leaf, present it, have a stranger verify it.
func TestMintedCAWorksEndToEnd(t *testing.T) {
	origin := newOrigin(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("verified"))
	}))
	s := newInspectorServer(t)
	res, err := s.inspectCAGenerate(&Request{ID: "1", Method: "inspect.ca.generate"})
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	ca := res.(*InspectCAResult)

	sink := &eventSink{}
	ins, err := newInspector(context.Background(), NewWriter(sink), &InspectStartParams{
		CACertPem:      ca.CertPem,
		CAKeyPem:       ca.KeyPem,
		UpstreamCAsPem: []string{origin.caPem},
		SpillDir:       t.TempDir(),
	}, nil)
	if err != nil {
		t.Fatalf("newInspector with the minted CA: %v", err)
	}
	ins.start()
	t.Cleanup(ins.close)

	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM([]byte(ca.CertPem)) {
		t.Fatal("the minted certificate is not loadable as a root")
	}
	resp, err := clientThrough(t, ins, pool).Get(origin.url + "/verify")
	if err != nil {
		t.Fatalf("a client trusting the minted CA was refused: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "verified" {
		t.Fatalf("body %q", body)
	}
}

// The failure this guards against is the most ordinary thing on the internet:
// a browser opening six connections to one origin at once. All six CONNECTs
// can land before the first request comes back on any of them, and a naive
// strike counter reports a perfectly working site as pinning.
func TestParallelConnectionsAreNotMistakenForPinning(t *testing.T) {
	ins, sink, _ := newTestInspector(t, nil)

	// Six handshake attempts, no requests yet — exactly what a page load looks
	// like in its first few milliseconds.
	for i := 0; i < 6; i++ {
		ins.noteAttempt("busy.example")
	}
	if n := len(sink.events("inspect.pinned")); n != 0 {
		t.Fatalf("reported pinning after %d parallel attempts and no grace period", n)
	}

	// Then the first request arrives, as it does on a site that works.
	ins.clearAttempt("busy.example")

	// Well past the grace window: the report must never fire.
	waitFor(t, "the grace window to pass", func() bool {
		return time.Since(time.Now().Add(-inspectPinGrace-200*time.Millisecond)) > 0
	})
	time.Sleep(inspectPinGrace + 200*time.Millisecond)
	if n := len(sink.events("inspect.pinned")); n != 0 {
		t.Fatal("a host that produced a request inside the grace window was still reported as pinning")
	}

	ins.mu.RLock()
	armed, strikes := len(ins.pinTimers), ins.attempts["busy.example"]
	ins.mu.RUnlock()
	if armed != 0 || strikes != 0 {
		t.Fatalf("a successful request must clear the record, got %d timers and %d strikes", armed, strikes)
	}
}

// The other half: a host that really never answers is still reported, once.
func TestSilentHostIsStillReportedAfterTheGrace(t *testing.T) {
	ins, sink, _ := newTestInspector(t, nil)
	for i := 0; i < inspectPinThreshold; i++ {
		ins.noteAttempt("silent.example")
	}
	waitFor(t, "the pinned report", func() bool { return len(sink.events("inspect.pinned")) == 1 })

	// Further attempts must not produce a second report.
	for i := 0; i < 5; i++ {
		ins.noteAttempt("silent.example")
	}
	time.Sleep(inspectPinGrace + 100*time.Millisecond)
	if n := len(sink.events("inspect.pinned")); n != 1 {
		t.Fatalf("a retrying client produced %d reports; one host is one report", n)
	}
}

// Stopping while a report is armed must not fire it afterwards.
func TestClosingCancelsAnArmedPinReport(t *testing.T) {
	ins, sink, _ := newTestInspector(t, nil)
	for i := 0; i < inspectPinThreshold; i++ {
		ins.noteAttempt("armed.example")
	}
	ins.close()
	time.Sleep(inspectPinGrace + 200*time.Millisecond)
	if n := len(sink.events("inspect.pinned")); n != 0 {
		t.Fatal("an inspector that has stopped must not report anything afterwards")
	}
}

// A WebSocket handshake must close its flow at the 101, not sit "in flight"
// for as long as the socket is open — which, on a WebSocket, is exactly as
// long as the user is looking at it.
func TestWebSocketUpgradeEndsTheFlowAtTheHandshake(t *testing.T) {
	origin := newOrigin(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The handshake alone. Hijacking and speaking frames is not needed to
		// prove the point: what matters is that a 101 with no body does not
		// strand the flow.
		w.Header().Set("Upgrade", "websocket")
		w.Header().Set("Connection", "Upgrade")
		w.WriteHeader(http.StatusSwitchingProtocols)
	}))

	ins, sink, insPool := newTestInspector(t, trusting(origin))
	client := clientThrough(t, ins, insPool)

	req, err := http.NewRequest("GET", origin.url+"/socket", nil)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	resp, err := client.Do(req)
	if err == nil {
		resp.Body.Close()
	}

	waitFor(t, "the upgrade flow to end", func() bool {
		return len(sink.events("inspect.flow.end")) == 1
	})
	e := sink.events("inspect.flow.end")[0]
	if int(e["status"].(float64)) != http.StatusSwitchingProtocols {
		t.Fatalf("status %v, want 101", e["status"])
	}
	if e["upgraded"] != true {
		t.Fatal("a 101 must be reported as an upgrade so the UI can say the frames are not recorded")
	}
	if e["error"] != nil {
		t.Fatalf("an upgrade is not a failure, got error %v", e["error"])
	}
}

// The capture directory must not grow without limit. Before this, the only
// thing that ever deleted a spill file was stopping the inspector.
func TestSpillFilesAreEvictedOnceOverBudget(t *testing.T) {
	ins, _, _ := newTestInspector(t, nil)

	// Three files, the third of which pushes the total past a budget shrunk
	// for the test by charging sizes directly.
	dir := ins.spillDir
	paths := make([]string, 3)
	for i := range paths {
		paths[i] = filepath.Join(dir, fmt.Sprintf("f%d.response", i))
		if err := os.WriteFile(paths[i], []byte("body"), 0o600); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	// Charge each as if it were a third of the budget plus a byte, so the
	// third arrival must evict the first.
	share := int64(inspectSpillBudget/2) + 1
	ins.noteSpill(paths[0], share)
	ins.noteSpill(paths[1], share)

	if _, err := os.Stat(paths[0]); err == nil {
		t.Fatal("evicted too early: two files inside the budget must both survive")
	} else if !os.IsNotExist(err) {
		// The first should be gone: two shares already exceed the budget.
		t.Fatalf("unexpected stat error: %v", err)
	}
	if _, err := os.Stat(paths[1]); err != nil {
		t.Fatal("the newest file must always survive, however large it is")
	}

	ins.mu.RLock()
	total, count := ins.spillBytes, len(ins.spilled)
	ins.mu.RUnlock()
	if count != 1 || total != share {
		t.Fatalf("ledger says %d files / %d bytes, want 1 / %d", count, total, share)
	}
}

// A real capture must charge the budget with the size it actually wrote.
func TestRecordedBodyIsChargedToTheBudget(t *testing.T) {
	payload := bytes.Repeat([]byte("x"), 40*1024)
	origin := newOrigin(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(payload)
	}))
	ins, sink, insPool := newTestInspector(t, trusting(origin))
	client := clientThrough(t, ins, insPool)

	resp, err := client.Get(origin.url + "/charged")
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	_, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	waitFor(t, "the flow to end", func() bool { return len(sink.events("inspect.flow.end")) == 1 })

	ins.mu.RLock()
	total, count := ins.spillBytes, len(ins.spilled)
	ins.mu.RUnlock()
	if count == 0 || total < int64(len(payload)) {
		t.Fatalf("budget ledger has %d files / %d bytes, want at least one file of %d",
			count, total, len(payload))
	}
}

// A CONNECT carrying something that is not TLS — a mail client, an SSH hop —
// must not be reported as a host that pins its certificate. Before the strike
// moved to the TLS path, every one of them was.
func TestNonTLSTunnelIsNotReportedAsPinning(t *testing.T) {
	// An origin that speaks a line protocol, not TLS and not HTTP.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_, _ = c.Write([]byte("220 mail.example.test ESMTP\r\n"))
			_ = c.Close()
		}
	}()

	ins, sink, _ := newTestInspector(t, nil)

	// Several CONNECTs to it, more than the pinning threshold, each speaking a
	// protocol that is not TLS.
	for i := 0; i < inspectPinThreshold+2; i++ {
		c, err := net.Dial("tcp", net.JoinHostPort(ins.bindHost, strconv.Itoa(ins.bindPort)))
		if err != nil {
			t.Fatalf("dial proxy: %v", err)
		}
		target := ln.Addr().String()
		fmt.Fprintf(c, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", target, target)
		// Read the proxy's 200, then send a line that is emphatically not a
		// TLS ClientHello.
		buf := make([]byte, 64)
		_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
		_, _ = c.Read(buf)
		_, _ = c.Write([]byte("EHLO example.test\r\n"))
		time.Sleep(20 * time.Millisecond)
		_ = c.Close()
	}

	// Well past the pin grace: nothing here is a certificate rejection.
	time.Sleep(inspectPinGrace + 300*time.Millisecond)
	if n := len(sink.events("inspect.pinned")); n != 0 {
		t.Fatalf("a non-TLS tunnel was reported as certificate pinning %d time(s)", n)
	}
	ins.mu.RLock()
	strikes := len(ins.attempts)
	ins.mu.RUnlock()
	if strikes != 0 {
		t.Fatalf("a non-TLS tunnel recorded %d pinning strike(s)", strikes)
	}
}

// The other half: it must be REPORTED, because interception breaks it rather
// than merely failing to read it.
func TestOpaqueTunnelIsReportedOnce(t *testing.T) {
	ins, sink, _ := newTestInspector(t, nil)
	// Driven directly rather than over a socket: the grace window is five
	// seconds and the behaviour under test is the decision, not the plumbing.
	m := &connectMark{host: "mail.example.test:993"}
	ins.reportIfOpaque(m)
	ins.reportIfOpaque(m)

	events := sink.events("inspect.opaque")
	if len(events) != 1 {
		t.Fatalf("want exactly one report, got %d", len(events))
	}
	if events[0]["host"] != "mail.example.test:993" {
		t.Fatalf("report named %v; the port is the half that says which protocol it was",
			events[0]["host"])
	}
}

func TestTunnelThatCarriedTLSOrHTTPIsNotReportedOpaque(t *testing.T) {
	ins, sink, _ := newTestInspector(t, nil)

	tlsSeen := &connectMark{host: "site.example:443"}
	tlsSeen.tls.Store(true)
	ins.reportIfOpaque(tlsSeen)

	httpSeen := &connectMark{host: "plain.example:80"}
	httpSeen.used.Store(true)
	ins.reportIfOpaque(httpSeen)

	if n := len(sink.events("inspect.opaque")); n != 0 {
		t.Fatalf("a tunnel that carried TLS or HTTP was reported as opaque %d time(s)", n)
	}
}

// A real HTTPS client must still be counted, or the pinning detection that
// moved here stops working at all.
func TestTLSHandshakeStillCountsAsAnAttempt(t *testing.T) {
	origin := newOrigin(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("never reached"))
	}))
	ins, sink, _ := newTestInspector(t, nil)
	// Trusts only the origin's CA, so it rejects our certificate — genuine
	// pinning behaviour, over genuine TLS.
	client := clientThrough(t, ins, origin.pool)
	for i := 0; i < inspectPinThreshold+1; i++ {
		if resp, err := client.Get(origin.url + "/pinned"); err == nil {
			resp.Body.Close()
			t.Fatal("the client should have refused our certificate")
		}
		client.CloseIdleConnections()
	}
	waitFor(t, "the pinned report", func() bool { return len(sink.events("inspect.pinned")) == 1 })
}

// ------------------------------------------------------------------ h2

// gRPC and other HTTP/2-only services were unreachable while the inspector
// spoke 1.1 only. goproxy's h2 path runs the same request and response
// filters, so flows must be recorded there exactly as on the 1.1 path.
func TestHTTP2IsInterceptedAndRecorded(t *testing.T) {
	origin := newOriginH2(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ProtoMajor != 2 {
			t.Errorf("origin was reached over %s, want HTTP/2", r.Proto)
		}
		w.Header().Set("Content-Type", "application/grpc+proto")
		_, _ = w.Write([]byte("h2 body"))
	}))

	ins, sink, insPool := newTestInspector(t, trusting(origin))
	client := clientThrough(t, ins, insPool)
	// Ask for h2 end to end.
	tr := client.Transport.(*http.Transport)
	tr.ForceAttemptHTTP2 = true
	tr.TLSClientConfig.NextProtos = []string{"h2", "http/1.1"}

	resp, err := client.Get(origin.url + "/h2")
	if err != nil {
		t.Fatalf("h2 request through the inspector: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "h2 body" {
		t.Fatalf("body %q", body)
	}

	waitFor(t, "the h2 flow to end", func() bool { return len(sink.events("inspect.flow.end")) == 1 })
	b := sink.events("inspect.flow.begin")[0]
	if b["path"] != "/h2" {
		t.Fatalf("begin event path %v", b["path"])
	}
	e := sink.events("inspect.flow.end")[0]
	if int(e["status"].(float64)) != 200 {
		t.Fatalf("status %v", e["status"])
	}
	if got := decodePreview(t, e, "resPreviewBase64"); got != "h2 body" {
		t.Fatalf("an h2 response body must be recorded like any other, got %q", got)
	}
}

// ------------------------------------------------------------------ auth

// A listener anywhere but loopback is reachable by the whole network, and it
// decrypts TLS. Refusing to start one without credentials is the only
// defensible default.
func TestNonLoopbackBindRequiresCredentials(t *testing.T) {
	certPem, keyPem, _ := newCA(t)
	_, err := newInspector(context.Background(), NewWriter(&eventSink{}), &InspectStartParams{
		BindHost:  "0.0.0.0",
		CACertPem: certPem,
		CAKeyPem:  keyPem,
		SpillDir:  t.TempDir(),
	}, nil)
	if err == nil {
		t.Fatal("an open proxy on 0.0.0.0 was allowed with no credentials")
	}
	if !strings.Contains(err.Error(), "open proxy") {
		t.Fatalf("the refusal should say why, got %v", err)
	}

	// With credentials it is allowed.
	ins, err := newInspector(context.Background(), NewWriter(&eventSink{}), &InspectStartParams{
		BindHost:  "127.0.0.1", // bound to loopback for the test's own safety
		Username:  "u",
		Password:  "p",
		CACertPem: certPem,
		CAKeyPem:  keyPem,
		SpillDir:  t.TempDir(),
	}, nil)
	if err != nil {
		t.Fatalf("credentials should have been accepted: %v", err)
	}
	ins.close()
}

func TestLoopbackNeedsNoCredentials(t *testing.T) {
	for _, host := range []string{"127.0.0.1", "::1", "localhost", ""} {
		if !isLoopbackHost(host) && host != "" {
			t.Errorf("%q should count as loopback", host)
		}
	}
	for _, host := range []string{"0.0.0.0", "192.168.1.10", "example.com", "::"} {
		if isLoopbackHost(host) {
			t.Errorf("%q must NOT count as loopback", host)
		}
	}
}

func TestCredentialsAreEnforcedOnEveryPath(t *testing.T) {
	origin := newOrigin(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("secret"))
	}))
	ins, sink, insPool := newTestInspector(t, func(p *InspectStartParams) {
		trusting(origin)(p)
		p.Username = "user"
		p.Password = "pass"
	})

	// No credentials: the CONNECT is rejected and nothing is recorded.
	if _, err := clientThrough(t, ins, insPool).Get(origin.url + "/denied"); err == nil {
		t.Fatal("an unauthenticated client reached the origin")
	}
	if n := len(sink.events("inspect.flow.begin")); n != 0 {
		t.Fatalf("an unauthenticated request produced %d flow events", n)
	}

	// With them, it works.
	proxyURL, _ := url.Parse(fmt.Sprintf("http://user:pass@%s:%d", ins.bindHost, ins.bindPort))
	ok := &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			Proxy:           http.ProxyURL(proxyURL),
			TLSClientConfig: &tls.Config{RootCAs: insPool, MinVersion: tls.VersionTLS12},
		},
	}
	resp, err := ok.Get(origin.url + "/allowed")
	if err != nil {
		t.Fatalf("an authenticated request was refused: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "secret" {
		t.Fatalf("body %q", body)
	}
	waitFor(t, "the authenticated flow", func() bool {
		return len(sink.events("inspect.flow.end")) == 1
	})
}

// ------------------------------------------------------------------ cert LRU

// The cache must evict the least recently USED host, not the oldest minted.
// Under the previous insertion-order eviction a host touched on every page
// load was thrown out ahead of one seen once, which is backwards.
func TestCertCacheEvictsLeastRecentlyUsed(t *testing.T) {
	ins, _, _ := newTestInspector(t, nil)

	// Fill the cache exactly.
	for i := 0; i < inspectCertCacheMax; i++ {
		if _, err := ins.leafFor(fmt.Sprintf("h%d.example", i)); err != nil {
			t.Fatalf("leafFor: %v", err)
		}
	}
	// Touch the oldest so it is now the most recently used.
	if _, err := ins.leafFor("h0.example"); err != nil {
		t.Fatalf("leafFor: %v", err)
	}
	// One more host forces exactly one eviction.
	if _, err := ins.leafFor("new.example"); err != nil {
		t.Fatalf("leafFor: %v", err)
	}

	ins.mu.RLock()
	_, keptTouched := ins.certs["h0.example"]
	_, evictedNext := ins.certs["h1.example"]
	size := len(ins.certs)
	ins.mu.RUnlock()

	if !keptTouched {
		t.Fatal("the host used most recently was evicted — that is FIFO, not LRU")
	}
	if evictedNext {
		t.Fatal("the least recently used host survived; something else was evicted")
	}
	if size > inspectCertCacheMax {
		t.Fatalf("cache grew to %d past its %d cap", size, inspectCertCacheMax)
	}
}

// A client that offers h2 must never be able to crash the sidecar.
//
// Advertising "h2" in the client ALPN list without goproxy's AllowHTTP2 drops
// the connection into the HTTP/1 parser, which reads a frame, fails, and
// dereferences a nil request URL — in a goroutine goproxy started, so no
// recover in this process catches it and the whole sidecar dies. This test
// exists because that is exactly what an earlier version of the two settings
// above did to each other.
func TestClientOfferingH2NeverPanicsTheSidecar(t *testing.T) {
	origin := newOriginH2(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("alive"))
	}))
	ins, _, insPool := newTestInspector(t, trusting(origin))

	for _, alpn := range [][]string{
		{"h2"},
		{"h2", "http/1.1"},
		{"http/1.1", "h2"},
		{"http/1.1"},
	} {
		client := clientThrough(t, ins, insPool)
		tr := client.Transport.(*http.Transport)
		tr.ForceAttemptHTTP2 = true
		tr.TLSClientConfig.NextProtos = alpn
		resp, err := client.Get(origin.url + "/alpn")
		if err != nil {
			t.Fatalf("ALPN %v: %v", alpn, err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if string(body) != "alive" {
			t.Fatalf("ALPN %v produced %q", alpn, body)
		}
		client.CloseIdleConnections()
	}
}

// Three unrelated hosts refusing the certificate is not three pinning
// applications, it is one untrusted authority. Reporting it per-host sends
// someone to fix three things that are not broken while the panel shows an
// empty list and claims the certificate is fine — which is exactly what a
// real machine did with the certificate installed but never trusted.
func TestManyRefusalsAreReportedAsAnUntrustedAuthority(t *testing.T) {
	ins, sink, _ := newTestInspector(t, nil)

	for i := 0; i < inspectUntrustedHosts; i++ {
		host := fmt.Sprintf("host%d.example", i)
		for j := 0; j < inspectPinThreshold; j++ {
			ins.noteAttempt(host)
		}
	}
	waitFor(t, "the untrusted-authority report", func() bool {
		return len(sink.events("inspect.untrusted")) == 1
	})

	e := sink.events("inspect.untrusted")[0]
	hosts, _ := e["hosts"].([]any)
	if len(hosts) < inspectUntrustedHosts {
		t.Fatalf("the report must name the hosts so the claim can be checked, got %v", e["hosts"])
	}
	if e["fingerprint"] != ins.caFingerprint {
		t.Fatalf("the report must name the authority it is about, got %v", e["fingerprint"])
	}

	// More refusals must not repeat it.
	for j := 0; j < inspectPinThreshold; j++ {
		ins.noteAttempt("another.example")
	}
	time.Sleep(inspectPinGrace + 200*time.Millisecond)
	if n := len(sink.events("inspect.untrusted")); n != 1 {
		t.Fatalf("said %d times; once per run is the whole point", n)
	}
}

// One host refusing is that host's policy, not a verdict on the authority.
func TestOneRefusalIsNotBlamedOnTheAuthority(t *testing.T) {
	ins, sink, _ := newTestInspector(t, nil)
	for j := 0; j < inspectPinThreshold; j++ {
		ins.noteAttempt("solo.example")
	}
	waitFor(t, "the pinned report", func() bool { return len(sink.events("inspect.pinned")) == 1 })
	if n := len(sink.events("inspect.untrusted")); n != 0 {
		t.Fatalf("a single pinning host must not be reported as an untrusted authority (%d)", n)
	}
}
