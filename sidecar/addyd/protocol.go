package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
)

// The wire protocol is newline-delimited JSON over stdin/stdout, the same shape
// netd already uses.
//
// Three message shapes travel on it:
//
//	→ request   {"id":"7","method":"pair.begin","params":{…}}
//	← response  {"id":"7","ok":true,"result":{…}}
//	            {"id":"7","ok":false,"error":{"code":"pairing-refused","message":"…"}}
//	← event     {"event":"pair.sas","data":{…}}
//
// An event is distinguished from a response purely by the ABSENCE OF `id`.
//
// STDOUT CARRIES PROTOCOL TRAFFIC AND NOTHING ELSE. A single stray Println
// there desynchronises the parent's parser for the rest of the process
// lifetime, so all diagnostics go out as `log` events.

type Request struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

type Response struct {
	ID     string     `json:"id"`
	OK     bool       `json:"ok"`
	Result any        `json:"result,omitempty"`
	Error  *WireError `json:"error,omitempty"`
}

type WireError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type Event struct {
	Event string `json:"event"`
	Data  any    `json:"data,omitempty"`
}

// Error codes.
//
// ITS OWN UNION, NOT AN ENTRY IN VpnErrorCode. addyd has nothing to do with
// VPNs, and polluting that union with relay codes would mean every VPN error
// handler grows cases it can never see. `src/shared/addy.ts` carries the
// TypeScript half and protocol_test.go asserts every constant here appears
// there.
const (
	ErrConfigInvalid    = "config-invalid"
	ErrNotPaired        = "not-paired"
	ErrPairingRefused   = "pairing-refused"
	ErrPairingExpired   = "pairing-expired"
	ErrSASMismatch      = "sas-mismatch"
	ErrRosterInvalid    = "roster-invalid"
	ErrRosterForked     = "roster-forked"
	ErrRosterRewound    = "roster-rewound"
	ErrSchemaTooNew     = "schema-too-new"
	ErrQuotaExceeded    = "quota-exceeded"
	ErrRelayUnreachable = "relay-unreachable"
	ErrPeerUnreachable  = "peer-unreachable"
	ErrInternal         = "internal"
)

// knownCodes gates what may reach the renderer.
//
// A CODE NOT IN HERE IS DOWNGRADED TO `internal`, so a typo'd constant can
// never reach the parent as an error it has no case for. netd learned this and
// it is worth copying rather than rediscovering.
var knownCodes = map[string]bool{
	ErrConfigInvalid:    true,
	ErrNotPaired:        true,
	ErrPairingRefused:   true,
	ErrPairingExpired:   true,
	ErrSASMismatch:      true,
	ErrRosterInvalid:    true,
	ErrRosterForked:     true,
	ErrRosterRewound:    true,
	ErrSchemaTooNew:     true,
	ErrQuotaExceeded:    true,
	ErrRelayUnreachable: true,
	ErrPeerUnreachable:  true,
	ErrInternal:         true,
}

// codedError carries its own wire code.
type codedError struct {
	code string
	err  error
}

func (c *codedError) Error() string { return c.err.Error() }
func (c *codedError) Unwrap() error { return c.err }

func codedf(code, format string, args ...any) error {
	return &codedError{code: code, err: fmt.Errorf(format, args...)}
}

func wrapCoded(code string, err error, format string, args ...any) error {
	return &codedError{code: code, err: fmt.Errorf(format+": %w", append(args, err)...)}
}

// toWireError classifies an error for the wire.
//
// An unclassified error becomes `internal`, and so does a code this build does
// not own -- both because the parent has no case for something it has never
// heard of, and because a code arriving from nowhere is a bug rather than a
// condition.
func toWireError(err error) *WireError {
	var c *codedError
	if errors.As(err, &c) && knownCodes[c.code] {
		return &WireError{Code: c.code, Message: redact(c.Error())}
	}
	return &WireError{Code: ErrInternal, Message: redact(err.Error())}
}

// Writer is the one thing allowed to write to stdout.
type Writer struct {
	mu  sync.Mutex
	enc *json.Encoder
}

func NewWriter(w io.Writer) *Writer {
	enc := json.NewEncoder(w)
	// Otherwise a hostname with an ampersand in it arrives at the renderer as
	// & and every comparison against it fails.
	enc.SetEscapeHTML(false)
	return &Writer{enc: enc}
}

func (w *Writer) emit(v any) {
	w.mu.Lock()
	defer w.mu.Unlock()
	// The write error is deliberately dropped: if the parent's pipe is gone
	// there is nowhere to report it, and spinning on it would burn a core.
	_ = w.enc.Encode(v)
}

func (w *Writer) Respond(id string, result any) { w.emit(Response{ID: id, OK: true, Result: result}) }

func (w *Writer) Fail(id string, err error) {
	w.emit(Response{ID: id, OK: false, Error: toWireError(err)})
}

func (w *Writer) Emit(event string, data any) { w.emit(Event{Event: event, Data: data}) }

// Log is how diagnostics leave this process. Never fmt.Println: stdout is
// protocol-only, always.
func (w *Writer) Log(level, message string) {
	w.emit(Event{Event: "log", Data: map[string]string{"level": level, "message": redact(message)}})
}
