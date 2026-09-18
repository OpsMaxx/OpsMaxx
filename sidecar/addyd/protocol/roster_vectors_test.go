package protocol

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

// The specification's own chain, verified by this implementation.
//
// The vectors were produced by a different program from a different reading of
// the same prose. A chain that one wrote and the other accepts is the strongest
// evidence available that the two agree about what the protocol is.
func TestTheSpecificationsChainVerifiesHere(t *testing.T) {
	raw, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatalf("reading vectors: %v", err)
	}
	var v struct {
		Root struct {
			AccountIDHex string `json:"account_id_hex"`
			BIP39SeedHex string `json:"bip39_seed_hex"`
		} `json:"root"`
		EpochKeys []struct {
			Epoch  uint64 `json:"epoch"`
			AKSign struct {
				PubHex string `json:"pub_hex"`
			} `json:"ak_sign"`
		} `json:"epoch_keys"`
		RosterChain struct {
			HeadHashHex string `json:"head_hash_hex"`
			Entries     []struct {
				Note    string `json:"note"`
				Seq     uint64 `json:"seq"`
				WireHex string `json:"wire_hex"`
			} `json:"entries"`
		} `json:"roster_chain"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parsing vectors: %v", err)
	}
	if len(v.RosterChain.Entries) == 0 {
		t.Skip("the vector file carries no roster chain in this shape")
	}

	root, err := DeriveRoot(mustHex(t, v.Root.BIP39SeedHex))
	if err != nil {
		t.Fatal(err)
	}

	var epoch1 ed25519.PublicKey
	for _, e := range v.EpochKeys {
		if e.Epoch == 1 {
			epoch1 = ed25519.PublicKey(mustHex(t, e.AKSign.PubHex))
		}
	}
	if epoch1 == nil {
		t.Fatal("the vectors carry no epoch 1 signing key")
	}

	var chain []byte
	for _, e := range v.RosterChain.Entries {
		chain = append(chain, mustHex(t, e.WireHex)...)
	}

	got, err := VerifyChain(chain, root.AccountID, root.Sign.Public().(ed25519.PublicKey), epoch1, nil)
	if err != nil {
		t.Fatalf("the specification's own chain was refused by this implementation: %v", err)
	}

	if got.Entries != len(v.RosterChain.Entries) {
		t.Errorf("verified %d entries, the file has %d", got.Entries, len(v.RosterChain.Entries))
	}
	if want := v.RosterChain.HeadHashHex; want != "" {
		if h := hex.EncodeToString(got.Head); h != want {
			t.Errorf("head hash = %s, the file says %s", h, want)
		}
	}
	t.Logf("verified %d entries, ending in epoch %d with %d devices",
		got.Entries, got.Epoch, len(got.Devices))

	// And a one-byte change anywhere in the chain must break it.
	tampered := bytes.Clone(chain)
	tampered[len(tampered)/2] ^= 0x01
	if _, err := VerifyChain(tampered, root.AccountID, root.Sign.Public().(ed25519.PublicKey), epoch1, nil); err == nil {
		t.Error("a one-byte change to the chain was accepted")
	}
}
