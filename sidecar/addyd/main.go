// Command addyd is OpsMaxx's addy sidecar.
//
// TWO SUBCOMMANDS, ONE BINARY, AND NO SHARED MEMORY BETWEEN THEM.
//
//	addyd --crypto   holds keys; never links a WebRTC stack
//	addyd --rtc      speaks WebRTC; never sees a key beyond a session key
//
// The split exists because the two obvious alternatives are both wrong. Putting
// the account key in the same address space as a DTLS and SDP parser reproduces
// exactly the objection that justified splitting addyd from netd in the first
// place -- netd can run --privileged, as root with a real TUN device, and a
// stack that parses untrusted SDP, STUN, DTLS and SRTP straight off the open
// internet should not be LOADED in a process that is sometimes root, whether or
// not it is reached. And putting the keys in Node means implementing HPKE and
// SPAKE2 in TypeScript with no existing dependencies, plus a second roster
// verifier, which is a second thing to get wrong.
//
// The parent spawns both.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

// Stamped by the build script. Deliberately obvious rather than plausible: a
// version string that looks real but was never stamped is worse in a bug report
// than one that says so.
var (
	Version  = "0.0.0-dev"
	BuildSha = "unknown"
)

const maxRequestBytes = 8 << 20

func main() {
	var (
		crypto  = flag.Bool("crypto", false, "Hold keys and perform the crypto. Never links a WebRTC stack")
		rtc     = flag.Bool("rtc", false, "Speak WebRTC. Never sees a key beyond the session keys handed to it")
		version = flag.Bool("version", false, "Print version information as JSON and exit")
	)
	flag.Parse()

	if *version {
		// JSON, because the parent parses it -- the same shape netd's probe
		// expects.
		enc := json.NewEncoder(os.Stdout)
		enc.SetEscapeHTML(false)
		_ = enc.Encode(map[string]string{
			"version":   Version,
			"buildSha":  BuildSha,
			"goVersion": goVersion(),
		})
		return
	}

	if *crypto == *rtc {
		// Usage goes to STDERR. stdout is protocol-only, always.
		fmt.Fprintln(os.Stderr, "addyd: exactly one of --crypto or --rtc is required")
		os.Exit(2)
	}

	role := "crypto"
	if *rtc {
		role = "rtc"
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	w := NewWriter(os.Stdout)
	w.Log("info", fmt.Sprintf("addyd %s (%s) started as %s", Version, BuildSha, role))

	serve(ctx, w, role, os.Stdin)
}

func serve(ctx context.Context, w *Writer, role string, in *os.File) {
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 0, 64<<10), maxRequestBytes)

	for scanner.Scan() {
		// The scanner reuses its buffer, so the bytes are copied before they
		// are handed to anything that might outlive this iteration.
		line := append([]byte(nil), scanner.Bytes()...)
		if len(line) == 0 {
			continue
		}
		var req Request
		if err := json.Unmarshal(line, &req); err != nil {
			// Deliberately NOT passing json's own error through: it quotes the
			// offending value, and for a mistyped recovery phrase that is the
			// phrase.
			w.Fail("", codedf(ErrConfigInvalid, "malformed request"))
			continue
		}
		dispatch(ctx, w, role, req)
	}

	// stdin EOF means the parent is gone. Exiting is the orphan safety net: a
	// sidecar that outlives its parent is a process holding keys with nobody
	// watching it.
	w.Log("info", "parent closed the connection; stopping")
}

func dispatch(ctx context.Context, w *Writer, role string, req Request) {
	// One handler's panic fails that request rather than stranding every other
	// one. A sidecar that dies on a malformed frame takes the pairing with it.
	defer func() {
		if p := recover(); p != nil {
			w.Fail(req.ID, codedf(ErrInternal, "handler panicked: %v", p))
		}
	}()

	// ROLE-GATED, and the gate is the point of the split rather than a
	// formality. `--rtc` links a WebRTC stack and must never be able to reach
	// a key; `--crypto` holds the keys and must never be asked to parse SDP.
	// A method reachable from both roles would collapse the distinction the
	// two processes exist to maintain.
	if role == "crypto" {
		if handler, ok := cryptoMethods[req.Method]; ok {
			result, err := handler(req)
			if err != nil {
				w.Fail(req.ID, err)
				return
			}
			w.Respond(req.ID, result)
			return
		}
	}

	switch req.Method {
	case "ping":
		w.Respond(req.ID, map[string]string{"role": role, "version": Version})
	case "reset":
		// Forgets every key this process holds. The parent calls it when the
		// vault locks, and it is why killing or resetting the sidecar is a
		// real remediation: nothing here is on disk, so forgetting is all
		// there is to do.
		keys.reset()
		w.Respond(req.ID, map[string]any{"ok": true})
	default:
		w.Fail(req.ID, codedf(ErrConfigInvalid, "unknown method %q for role %s", req.Method, role))
	}
	_ = ctx
}

// cryptoMethods is the --crypto role's surface, as a map rather than a switch
// so that `ping` and `reset` above cannot be shadowed by one of them and so
// that a test can enumerate it.
var cryptoMethods = map[string]func(Request) (any, error){
	"load":         handleLoad,
	"seal":         handleSeal,
	"open":         handleOpen,
	"verifyRoster": handleVerifyRoster,
	"fingerprint":  handleFingerprint,
}
