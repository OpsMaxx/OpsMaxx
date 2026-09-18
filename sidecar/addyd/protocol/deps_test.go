package protocol

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// The vendored package's dependencies are pinned to the same versions the
// server pins.
//
// Not because a different minor version would obviously break -- it usually
// would not -- but because this package's whole job is to produce bytes
// identical to another implementation's, and a dependency is part of that
// implementation. `go-bip39` decides what a mnemonic derives to and
// `golang.org/x/text` normalises it beforehand; an unnoticed change in either
// is a recovery phrase that restores a different account on one machine than
// on the other, which is the worst failure in this file's reach.
//
// A test rather than a comment because `go get -u` updates one repo at a time
// and says nothing about the other.
func TestTheVendoredDependenciesArePinned(t *testing.T) {
	raw, err := os.ReadFile("../go.mod")
	if err != nil {
		t.Fatalf("reading go.mod: %v", err)
	}
	text := string(raw)

	// Kept as literals rather than read from the server's go.mod: that file is
	// in another repository which is not present here, and a test that skipped
	// when it could not find it would be a test that never ran in CI. Bumping
	// a version means editing this list, which is the point -- it is the
	// moment somebody has to confirm the other side moved too.
	want := map[string]string{
		"filippo.io/edwards25519":          "v1.2.0",
		"github.com/blinklabs-io/go-bip39": "v0.2.0",
		"golang.org/x/crypto":              "v0.57.0",
		"golang.org/x/text":                "v0.42.0",
	}
	for module, version := range want {
		re := regexp.MustCompile(`(?m)^\s*` + regexp.QuoteMeta(module) + `\s+(v\S+)`)
		m := re.FindStringSubmatch(text)
		if m == nil {
			t.Errorf("%s is not required by sidecar/addyd/go.mod at all", module)
			continue
		}
		// `// indirect` markers and build metadata do not matter; the version
		// does.
		got := strings.TrimSuffix(m[1], "+incompatible")
		if got != version {
			t.Errorf("%s is pinned to %s here and %s in the addy server.\n"+
				"Bump both, or the two implementations can derive different keys from one mnemonic.",
				module, got, version)
		}
	}
}
