package protocol

import (
	"encoding/json"
	"os"
	"testing"
)

// The vectors describe THIS version of the protocol, and say so.
//
// Without this, a change to an encoding plus a regenerated vector file is a
// silent protocol break: both halves agree with each other, and every existing
// client stops interoperating with no test going red anywhere. The version is
// what makes the break loud, and this is what makes the version true.
func TestTheVectorsClaimThisProtocolVersion(t *testing.T) {
	raw, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatalf("reading the vectors: %v", err)
	}
	var file struct {
		Meta struct {
			Version string `json:"version"`
		} `json:"_meta"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatalf("parsing the vectors: %v", err)
	}
	if file.Meta.Version == "" {
		t.Fatal("the vectors carry no _meta.version; the parser is wrong, or the file is")
	}
	if file.Meta.Version != ProtocolVersion {
		t.Fatalf("the vectors describe %q but this implementation is %q.\n"+
			"Either the protocol changed and ProtocolVersion was not bumped, or it was "+
			"bumped and the vectors were not regenerated. Both are protocol breaks.",
			file.Meta.Version, ProtocolVersion)
	}
}
