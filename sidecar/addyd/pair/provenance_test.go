// NOT VENDORED. This file exists only in the client.
package pair

import (
	"os"
	"strings"
	"testing"
)

// Every vendored file in this package says where it came from.
//
// Same reason as the protocol package's: a copy with no provenance is a copy
// somebody edits in place, and a pairing fixed only here is one that works
// against this client and no other.
func TestEveryVendoredFileSaysWhereItCameFrom(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	checked := 0
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".go") {
			continue
		}
		body, err := os.ReadFile(e.Name())
		if err != nil {
			t.Fatal(err)
		}
		head := string(body)
		if strings.HasPrefix(head, "// NOT VENDORED.") {
			continue
		}
		checked++
		if !strings.HasPrefix(head, "// SPDX-License-Identifier: MIT\n") {
			t.Errorf("%s has no SPDX line", e.Name())
		}
		if !strings.Contains(head, "Vendored from github.com/opsmaxx/addy") {
			t.Errorf("%s does not say where it came from", e.Name())
		}
	}
	if checked == 0 {
		t.Fatal("checked 0 files; the walk is wrong, not the headers")
	}
}
