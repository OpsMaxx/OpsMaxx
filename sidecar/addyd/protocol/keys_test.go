// SPDX-License-Identifier: MIT
// Vendored from github.com/opsmaxx/addy internal/protocol/keys_test.go @ fe66709
//
// Edit it THERE and copy it here. A fix made only in this copy is a
// protocol divergence with no symptom until an AEAD tag fails on somebody
// else's machine. See VENDORED.md in this directory.
package protocol

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

type keyVectors struct {
	Root struct {
		AccountIDHex string `json:"account_id_hex"`
		BIP39SeedHex string `json:"bip39_seed_hex"`
		HKDFSaltHex  string `json:"hkdf_salt_hex"`
		RKSign       struct {
			InfoASCII string `json:"info_ascii"`
			SeedHex   string `json:"seed_hex"`
			PubHex    string `json:"pub_hex"`
		} `json:"rk_sign"`
		RKEnc struct {
			InfoASCII string `json:"info_ascii"`
			ScalarHex string `json:"scalar_hex"`
			PubHex    string `json:"pub_hex"`
		} `json:"rk_enc"`
	} `json:"root"`
	EpochKeys []struct {
		Epoch  uint64 `json:"epoch"`
		AKHex  string `json:"ak_seed_hex"`
		AKSign struct {
			SeedHex string `json:"seed_hex"`
			PubHex  string `json:"pub_hex"`
		} `json:"ak_sign"`
		AKEnc struct {
			ScalarHex string `json:"scalar_hex"`
			PubHex    string `json:"pub_hex"`
		} `json:"ak_enc"`
		KProfile struct {
			KeyHex string `json:"key_hex"`
		} `json:"k_profile"`
	} `json:"epoch_keys"`
}

func loadKeyVectors(t *testing.T) keyVectors {
	t.Helper()
	b, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatalf("reading vectors: %v", err)
	}
	var v keyVectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("parsing vectors: %v", err)
	}
	return v
}

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("%q is not hex: %v", s, err)
	}
	return b
}

// The derivation must reproduce the specification's vectors exactly. This is
// what makes the spec and the code one thing rather than two descriptions of
// the same intention.
func TestRootDerivationMatchesTheVectors(t *testing.T) {
	v := loadKeyVectors(t)

	if got, want := hex.EncodeToString(SaltGenesis), v.Root.HKDFSaltHex; got != want {
		t.Errorf("SALT_GENESIS = %s, vector says %s", got, want)
	}

	root, err := DeriveRoot(mustHex(t, v.Root.BIP39SeedHex))
	if err != nil {
		t.Fatalf("DeriveRoot: %v", err)
	}

	if got, want := hex.EncodeToString(root.SignSeed), v.Root.RKSign.SeedHex; got != want {
		t.Errorf("RK_sign seed = %s, vector says %s", got, want)
	}
	if got, want := hex.EncodeToString(root.Sign.Public().(ed25519.PublicKey)), v.Root.RKSign.PubHex; got != want {
		t.Errorf("RK_sign pub = %s, vector says %s", got, want)
	}
	if got, want := hex.EncodeToString(root.Enc.Bytes()), v.Root.RKEnc.ScalarHex; got != want {
		t.Errorf("RK_enc scalar = %s, vector says %s", got, want)
	}
	if got, want := hex.EncodeToString(root.Enc.PublicKey().Bytes()), v.Root.RKEnc.PubHex; got != want {
		t.Errorf("RK_enc pub = %s, vector says %s", got, want)
	}
	if got, want := root.AccountID.String(), v.Root.AccountIDHex; got != want {
		t.Errorf("account id = %s, vector says %s", got, want)
	}
}

func TestEpochDerivationMatchesTheVectors(t *testing.T) {
	v := loadKeyVectors(t)
	root, err := DeriveRoot(mustHex(t, v.Root.BIP39SeedHex))
	if err != nil {
		t.Fatal(err)
	}
	if len(v.EpochKeys) < 2 {
		t.Fatalf("the vectors carry %d epochs; two are needed to show they differ", len(v.EpochKeys))
	}

	for _, e := range v.EpochKeys {
		keys, err := DeriveEpoch(mustHex(t, e.AKHex), root.AccountID, e.Epoch)
		if err != nil {
			t.Fatalf("DeriveEpoch(%d): %v", e.Epoch, err)
		}
		if got, want := hex.EncodeToString(keys.SignSeed), e.AKSign.SeedHex; got != want {
			t.Errorf("epoch %d sign seed = %s, vector says %s", e.Epoch, got, want)
		}
		if got, want := hex.EncodeToString(keys.Sign.Public().(ed25519.PublicKey)), e.AKSign.PubHex; got != want {
			t.Errorf("epoch %d sign pub = %s, vector says %s", e.Epoch, got, want)
		}
		if got, want := hex.EncodeToString(keys.Enc.Bytes()), e.AKEnc.ScalarHex; got != want {
			t.Errorf("epoch %d enc scalar = %s, vector says %s", e.Epoch, got, want)
		}
		if got, want := hex.EncodeToString(keys.Profile), e.KProfile.KeyHex; got != want {
			t.Errorf("epoch %d K_profile = %s, vector says %s", e.Epoch, got, want)
		}
	}
}

// THE ONE-CHARACTER MISTAKE. An Ed25519 seed and an X25519 scalar that are the
// same bytes make every cross-protocol attack on the pair live in a system that
// otherwise has none -- and it is invisible to spot by reading.
func TestSigningAndEncryptionKeysNeverShareBytes(t *testing.T) {
	v := loadKeyVectors(t)
	root, err := DeriveRoot(mustHex(t, v.Root.BIP39SeedHex))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(root.SignSeed, root.Enc.Bytes()) {
		t.Error("RK_sign's seed and RK_enc's scalar are the same bytes")
	}

	for _, e := range v.EpochKeys {
		keys, err := DeriveEpoch(mustHex(t, e.AKHex), root.AccountID, e.Epoch)
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Equal(keys.SignSeed, keys.Enc.Bytes()) {
			t.Errorf("epoch %d: the signing seed and the encryption scalar are the same bytes", e.Epoch)
		}
		if bytes.Equal(keys.SignSeed, keys.Profile) {
			t.Errorf("epoch %d: the signing seed and K_profile are the same bytes", e.Epoch)
		}
		if bytes.Equal(keys.Enc.Bytes(), keys.Profile) {
			t.Errorf("epoch %d: the encryption scalar and K_profile are the same bytes", e.Epoch)
		}
		// And none of them may be the epoch key itself.
		if bytes.Equal(keys.AK, keys.SignSeed) || bytes.Equal(keys.AK, keys.Profile) {
			t.Errorf("epoch %d: a derived key is the raw AK", e.Epoch)
		}
	}
}

// The epoch is mixed into every label below the root, so a key from one epoch
// cannot be replayed as a key from another. If it were not, rotation would
// change the number and nothing else.
func TestTheSameEpochKeyUnderTwoEpochsDerivesDifferently(t *testing.T) {
	v := loadKeyVectors(t)
	root, err := DeriveRoot(mustHex(t, v.Root.BIP39SeedHex))
	if err != nil {
		t.Fatal(err)
	}
	ak := mustHex(t, v.EpochKeys[0].AKHex)

	one, err := DeriveEpoch(ak, root.AccountID, 1)
	if err != nil {
		t.Fatal(err)
	}
	two, err := DeriveEpoch(ak, root.AccountID, 2)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(one.SignSeed, two.SignSeed) {
		t.Error("the same AK under two epochs produced the same signing key")
	}
	if bytes.Equal(one.Profile, two.Profile) {
		t.Error("the same AK under two epochs produced the same profile key")
	}
}

// Likewise the account id, so one account's keys are not another's.
func TestTheSameEpochKeyUnderTwoAccountsDerivesDifferently(t *testing.T) {
	ak := bytes.Repeat([]byte{7}, 32)
	var a, b AccountID
	a[0], b[0] = 1, 2

	ka, err := DeriveEpoch(ak, a, 1)
	if err != nil {
		t.Fatal(err)
	}
	kb, err := DeriveEpoch(ak, b, 1)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(ka.SignSeed, kb.SignSeed) {
		t.Error("two accounts derived the same signing key from the same AK")
	}
}

// Epoch 0 is never valid, so a zeroed or absent field cannot be mistaken for a
// legitimate epoch.
func TestEpochZeroIsRefused(t *testing.T) {
	var acct AccountID
	if _, err := DeriveEpoch(bytes.Repeat([]byte{1}, 32), acct, 0); err == nil {
		t.Error("DeriveEpoch accepted epoch 0")
	}
	if _, err := NewEpochKey(acct, 0); err == nil {
		t.Error("NewEpochKey accepted epoch 0")
	}
}

// The account id is a function of the root key alone, so it survives every
// epoch. A changing account id would invalidate every object name.
func TestTheAccountIDIsStableAcrossEpochs(t *testing.T) {
	v := loadKeyVectors(t)
	root, err := DeriveRoot(mustHex(t, v.Root.BIP39SeedHex))
	if err != nil {
		t.Fatal(err)
	}
	again, err := DeriveRoot(mustHex(t, v.Root.BIP39SeedHex))
	if err != nil {
		t.Fatal(err)
	}
	if root.AccountID != again.AccountID {
		t.Error("the same seed produced two account ids")
	}
	if root.AccountID == (AccountID{}) {
		t.Error("the account id is all zeroes")
	}
}

// Device keys are two independent draws and are not derived from anything.
func TestDeviceKeysAreIndependentAndUnique(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 50; i++ {
		d, err := NewDeviceKeys()
		if err != nil {
			t.Fatalf("NewDeviceKeys: %v", err)
		}
		if bytes.Equal(d.SignSeed, d.Enc.Bytes()) {
			t.Fatal("a device's signing seed and encryption scalar are the same bytes")
		}
		key := hex.EncodeToString(d.SignSeed)
		if seen[key] {
			t.Fatal("NewDeviceKeys returned a repeat")
		}
		seen[key] = true
	}
}
