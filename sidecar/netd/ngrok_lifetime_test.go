package main

import (
	"context"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"
)

// The context a tunnel's session is built on has to outlive the call that
// starts it.
//
// ngrok-go ties the SESSION LIFETIME to the context passed to Connect and
// Listen: internal/legacy/session.go closes the session on `<-ctx.Done()`, and
// closing the session takes every endpoint on it offline at the edge. ngrokUp
// used to pass a `context.WithTimeout(ctx, timeout)` with `defer startCancel()`,
// so the cancel fired the instant ngrokUp returned. The tunnel published, the
// URL came back, this process reported "connected", and the public address
// answered ERR_NGROK_3200 -- offline since a microsecond after it opened.
//
// Reproducing that against the real ngrok service would need an account and a
// network, so these read the source instead. They are narrow on purpose: the
// bug was one argument, and it is the argument they check.

func ngrokSource(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("ngrok.go")
	if err != nil {
		t.Fatalf("could not read ngrok.go: %v", err)
	}
	return string(b)
}

// ngrokUp's body with comments stripped.
//
// Stripped because the comments explain the bug and quote the offending line,
// so a check that reads them finds the thing it is looking for in the very
// prose saying it is gone. Found immediately, by this test failing against the
// fixed code.
func ngrokUpBody(t *testing.T) string {
	t.Helper()
	s := ngrokSource(t)
	i := strings.Index(s, "func (s *Server) ngrokUp(")
	if i < 0 {
		t.Fatal("ngrokUp is gone")
	}
	rest := s[i:]
	if j := strings.Index(rest, "\nfunc "); j > 0 {
		rest = rest[:j]
	}
	var code []string
	for _, line := range strings.Split(rest, "\n") {
		if t := strings.TrimSpace(line); strings.HasPrefix(t, "//") {
			continue
		}
		code = append(code, line)
	}
	return strings.Join(code, "\n")
}

func TestSessionOutlivesTheStartCall(t *testing.T) {
	body := ngrokUpBody(t)

	// A context that a deferred cancel will kill is the exact bug.
	if regexp.MustCompile(`defer\s+startCancel\(\)`).MatchString(body) {
		t.Error("the start context is cancelled on return, which closes the session and takes every endpoint offline")
	}

	for _, call := range []string{"agent.Connect(", "agent.Listen("} {
		i := strings.Index(body, call)
		if i < 0 {
			t.Fatalf("%s is gone from ngrokUp", call)
		}
		arg := body[i+len(call):]
		arg = arg[:strings.IndexAny(arg, ",)")]
		if strings.TrimSpace(arg) != "ctx" {
			t.Errorf("%s takes %q; it must take the long-lived ctx, because that argument IS the session's lifetime", call, strings.TrimSpace(arg))
		}
	}
}

func TestStartStillHasADeadline(t *testing.T) {
	// Removing the timeout would be its own bug: a Connect that hangs would
	// block the sidecar's request loop forever. The deadline moved from the
	// context to a watchdog over it, and it has to still be there.
	body := ngrokUpBody(t)
	if !strings.Contains(body, "case <-time.After(timeout):") {
		t.Error("no start deadline; a hung Connect would never return")
	}
	if !strings.Contains(body, "case <-started:") {
		t.Error("the watchdog has nothing telling it the start finished, so it will cancel a healthy session")
	}
}

// The watchdog itself, exercised rather than read: a start that finishes must
// leave the context alive, and one that hangs must cancel it.
func TestWatchdogCancelsOnlyAHungStart(t *testing.T) {
	run := func(finish bool, timeout time.Duration) error {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		started := make(chan struct{})
		go func() {
			select {
			case <-started:
			case <-time.After(timeout):
				cancel()
			}
		}()
		if finish {
			close(started)
		}
		// Long enough for the watchdog to fire in the hung case.
		time.Sleep(timeout + 40*time.Millisecond)
		return ctx.Err()
	}

	if err := run(true, 30*time.Millisecond); err != nil {
		t.Errorf("a start that finished had its session cancelled anyway: %v", err)
	}
	if err := run(false, 30*time.Millisecond); err == nil {
		t.Error("a start that hung past its deadline was left running")
	}
}
