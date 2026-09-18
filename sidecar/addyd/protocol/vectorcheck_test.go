// SPDX-License-Identifier: MIT
// Vendored from github.com/opsmaxx/addy internal/protocol/vectorcheck_test.go @ fe66709
//
// Edit it THERE and copy it here. A fix made only in this copy is a
// protocol divergence with no symptom until an AEAD tag fails on somebody
// else's machine. See VENDORED.md in this directory.
package protocol

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"

	bip39 "github.com/blinklabs-io/go-bip39"
)

type vectors struct {
	Root struct {
		AccountIDHex    string `json:"account_id_hex"`
		BIP39EntropyHex string `json:"bip39_entropy_hex"`
		BIP39SeedHex    string `json:"bip39_seed_hex"`
		Mnemonic        string `json:"mnemonic"`
		RKSign          struct {
			SeedHex string `json:"seed_hex"`
			PubHex  string `json:"pub_hex"`
			Info    string `json:"info_ascii"`
		} `json:"rk_sign"`
	} `json:"root"`
	RosterChain struct {
		Entries []struct {
			Note       string `json:"note"`
			Seq        int    `json:"seq"`
			Epoch      int    `json:"epoch"`
			Signer     int    `json:"signer"`
			Op         int    `json:"op"`
			BodyHex    string `json:"body_hex"`
			SigHex     string `json:"sig_hex"`
			PubSignHex string `json:"pub_sign_hex"`
		} `json:"entries"`
	} `json:"roster_chain"`
	EpochKeys []struct {
		Epoch  int `json:"epoch"`
		AKSign struct {
			PubHex string `json:"pub_hex"`
		} `json:"ak_sign"`
	} `json:"epoch_keys"`
}

func load(t *testing.T) vectors {
	t.Helper()
	b, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatalf("reading vectors: %v", err)
	}
	var v vectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("parsing vectors: %v", err)
	}
	return v
}

// Test vectors nobody checks are decoration. This one is checkable against a
// third-party implementation of a published standard, so it is the cheapest
// evidence that the file was computed rather than composed.
func TestTheMnemonicAndEntropyAgreeWithBIP39(t *testing.T) {
	v := load(t)

	entropy, err := bip39.EntropyFromMnemonic(v.Root.Mnemonic)
	if err != nil {
		t.Fatalf("the vector's mnemonic is not a valid BIP39 phrase: %v", err)
	}
	if got, want := hex.EncodeToString(entropy), v.Root.BIP39EntropyHex; got != want {
		t.Errorf("mnemonic decodes to entropy %s, vector says %s", got, want)
	}

	// And back the other way, so the pair is pinned in both directions.
	phrase, err := bip39.NewMnemonic(entropy)
	if err != nil {
		t.Fatalf("NewMnemonic: %v", err)
	}
	if phrase != v.Root.Mnemonic {
		t.Errorf("entropy re-encodes to %q, vector says %q", phrase, v.Root.Mnemonic)
	}

	seed := bip39.NewSeed(v.Root.Mnemonic, "")
	if got, want := hex.EncodeToString(seed), v.Root.BIP39SeedHex; got != want {
		t.Errorf("seed = %s, vector says %s", got, want)
	}
}

// Every roster signature must verify under the key the entry's OWN `signer`
// field names -- not under "whichever key happens to work".
//
// That distinction is the test. The specification makes `signer` explicit
// rather than inferring it from the operation and the context, precisely
// because an implicit rule is the kind two implementations get differently. A
// test that tries every key would pass on an entry whose signer field is wrong,
// which is the bug the explicit field exists to prevent.
//
// signer 1 is the epoch key for the entry's own epoch; signer 2 is the root
// key, which authorises epoch changes and nothing else.
const (
	signerAK = 1
	signerRK = 2
)

func TestEveryRosterSignatureVerifiesUnderTheKeyItsSignerFieldNames(t *testing.T) {
	v := load(t)
	if len(v.RosterChain.Entries) == 0 {
		t.Fatal("the vectors carry no roster entries")
	}

	rk := mustKey(t, v.Root.RKSign.PubHex)
	epochPub := map[int]ed25519.PublicKey{}
	for _, e := range v.EpochKeys {
		epochPub[e.Epoch] = mustKey(t, e.AKSign.PubHex)
	}

	sawRK := false
	for _, e := range v.RosterChain.Entries {
		body, err := hex.DecodeString(e.BodyHex)
		if err != nil {
			t.Fatalf("seq %d body is not hex: %v", e.Seq, err)
		}
		sig, err := hex.DecodeString(e.SigHex)
		if err != nil {
			t.Fatalf("seq %d signature is not hex: %v", e.Seq, err)
		}

		// The domain prefix is what stops a signature over one structure
		// verifying over another, so its presence is asserted rather than
		// assumed.
		if !strings.HasPrefix(string(body), "addy-roster-v1\x00") {
			t.Errorf("seq %d body does not begin with the roster domain prefix", e.Seq)
		}

		var pub ed25519.PublicKey
		switch e.Signer {
		case signerAK:
			var ok bool
			if pub, ok = epochPub[e.Epoch]; !ok {
				t.Errorf("seq %d names epoch %d, which the file has no key for", e.Seq, e.Epoch)
				continue
			}
		case signerRK:
			pub = rk
			sawRK = true
		default:
			t.Errorf("seq %d has unknown signer %d", e.Seq, e.Signer)
			continue
		}

		if !ed25519.Verify(pub, body, sig) {
			t.Errorf("seq %d: the signature does not verify under the key its signer field names", e.Seq)
		}
	}

	// A chain with no root-signed entry would not exercise the split at all,
	// and the split is the point: a compromised epoch key must not be able to
	// authorise its own successor.
	if !sawRK {
		t.Error("no entry is signed by the root key; the vectors do not cover an epoch transition")
	}
}

// The other half of the same rule: an epoch key must NOT be able to sign an
// epoch transition. If it could, a stolen laptop could re-key the account it
// was revoked from.
func TestAnEpochKeyCannotStandInForTheRootKey(t *testing.T) {
	v := load(t)
	rk := mustKey(t, v.Root.RKSign.PubHex)

	for _, e := range v.RosterChain.Entries {
		if e.Signer != signerRK {
			continue
		}
		body, _ := hex.DecodeString(e.BodyHex)
		sig, _ := hex.DecodeString(e.SigHex)

		for _, k := range v.EpochKeys {
			if ed25519.Verify(mustKey(t, k.AKSign.PubHex), body, sig) {
				t.Errorf("seq %d is root-signed but also verifies under epoch %d's key", e.Seq, k.Epoch)
			}
		}
		if !ed25519.Verify(rk, body, sig) {
			t.Errorf("seq %d does not verify under the root key", e.Seq)
		}
	}
}

func mustKey(t *testing.T, h string) ed25519.PublicKey {
	t.Helper()
	raw, err := hex.DecodeString(h)
	if err != nil {
		t.Fatalf("public key %q is not hex: %v", h, err)
	}
	if len(raw) != ed25519.PublicKeySize {
		t.Fatalf("public key is %d bytes, want %d", len(raw), ed25519.PublicKeySize)
	}
	return ed25519.PublicKey(raw)
}

// A signature that verifies over altered bytes is not a signature.
func TestATamperedBodyFailsVerification(t *testing.T) {
	v := load(t)
	e := v.RosterChain.Entries[0]

	body, _ := hex.DecodeString(e.BodyHex)
	sig, _ := hex.DecodeString(e.SigHex)

	pub := mustKey(t, v.EpochKeys[0].AKSign.PubHex)
	if !ed25519.Verify(pub, body, sig) {
		t.Fatal("the first entry does not verify; the positive test covers why")
	}

	tampered := append([]byte(nil), body...)
	tampered[len(tampered)-1] ^= 0x01
	if ed25519.Verify(pub, tampered, sig) {
		t.Fatal("a one-bit change to the body still verified")
	}
}
