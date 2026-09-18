// SPDX-License-Identifier: MIT
// Vendored from github.com/opsmaxx/addy internal/protocol/sign_test.go @ fe66709
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

// THE ASSERTION THE WHOLE SECTION EXISTS FOR: a signature made for one purpose
// must be worthless for another. The design's original draft had one device key
// signing both a server-chosen login challenge and a request authorization,
// which is a chosen-message oracle across two purposes.
func TestASignatureForOnePurposeDoesNotVerifyForAnother(t *testing.T) {
	key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{3}, ed25519.SeedSize))
	pub := key.Public().(ed25519.PublicKey)

	var acct AccountID
	nonce := bytes.Repeat([]byte{1}, NonceLen)

	login := Login{
		AccountID: acct, DeviceNonce: nonce,
		ServerNonce: bytes.Repeat([]byte{2}, NonceLen),
		ServerSPKI:  bytes.Repeat([]byte{4}, 32),
		TS:          1,
	}
	authz := Authz{
		AccountID: acct, DeviceNonce: nonce,
		Method: "GET", Path: "/v1/obj/servers", BodyHash: NoBody, TS: 1,
	}

	loginSig, err := Sign(key, login)
	if err != nil {
		t.Fatal(err)
	}
	if err := Verify(pub, login, loginSig); err != nil {
		t.Fatalf("a login signature did not verify for login: %v", err)
	}
	// The whole point.
	if err := Verify(pub, authz, loginSig); err == nil {
		t.Fatal("a login signature verified as a request authorization")
	}

	authzSig, err := Sign(key, authz)
	if err != nil {
		t.Fatal(err)
	}
	if err := Verify(pub, login, authzSig); err == nil {
		t.Fatal("an authz signature verified as a login")
	}
}

// Binding method, path and body is what stops an authorization for a GET being
// replayed as the DELETE the server would rather have had.
func TestAnAuthorizationIsBoundToItsMethodPathAndBody(t *testing.T) {
	key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{5}, ed25519.SeedSize))
	pub := key.Public().(ed25519.PublicKey)

	base := Authz{
		DeviceNonce: bytes.Repeat([]byte{1}, NonceLen),
		Method:      "GET",
		Path:        "/v1/obj/servers",
		BodyHash:    NoBody,
		TS:          1,
	}
	sig, err := Sign(key, base)
	if err != nil {
		t.Fatal(err)
	}

	altered := []struct {
		name string
		a    Authz
	}{
		{"a different method", func() Authz { c := base; c.Method = "DELETE"; return c }()},
		{"a different path", func() Authz { c := base; c.Path = "/v1/obj/vault"; return c }()},
		{"a body where there was none", func() Authz { c := base; c.BodyHash = HashBody([]byte("x")); return c }()},
		{"a different nonce", func() Authz { c := base; c.DeviceNonce = bytes.Repeat([]byte{9}, NonceLen); return c }()},
		{"a different timestamp", func() Authz { c := base; c.TS = 2; return c }()},
	}
	for _, c := range altered {
		if err := Verify(pub, c.a, sig); err == nil {
			t.Errorf("the signature still verified with %s", c.name)
		}
	}
}

// Without the server's key pinned inside the signature, a login captured from
// one instance replays against another that serves the same account. The
// signature has to say "I am this device talking to YOU".
func TestALoginIsBoundToTheInstanceItWasMadeFor(t *testing.T) {
	key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{6}, ed25519.SeedSize))
	pub := key.Public().(ed25519.PublicKey)

	one := Login{
		DeviceNonce: bytes.Repeat([]byte{1}, NonceLen),
		ServerNonce: bytes.Repeat([]byte{2}, NonceLen),
		ServerSPKI:  bytes.Repeat([]byte{3}, 32),
		TS:          1,
	}
	sig, err := Sign(key, one)
	if err != nil {
		t.Fatal(err)
	}

	other := one
	other.ServerSPKI = bytes.Repeat([]byte{4}, 32)
	if err := Verify(pub, other, sig); err == nil {
		t.Fatal("a login signature replayed against a different instance")
	}
}

// Without the DTLS fingerprint inside the signature, a malicious relay
// substitutes its own certificate and reads everything on the data channel. It
// does not need to break any crypto; it needs the fingerprint to be unsigned.
func TestSignallingIsBoundToTheDTLSFingerprint(t *testing.T) {
	key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, ed25519.SeedSize))
	pub := key.Public().(ed25519.PublicKey)

	offer := Signal{
		Epoch:           1,
		DeviceNonce:     bytes.Repeat([]byte{1}, 32),
		PeerNonce:       make([]byte, 32),
		PeerPubSign:     bytes.Repeat([]byte{2}, 32),
		DTLSFingerprint: bytes.Repeat([]byte{3}, 32),
		RosterHead:      bytes.Repeat([]byte{4}, 32),
		TS:              1,
	}
	sig, err := Sign(key, offer)
	if err != nil {
		t.Fatal(err)
	}

	relayed := offer
	relayed.DTLSFingerprint = bytes.Repeat([]byte{0xaa}, 32)
	if err := Verify(pub, relayed, sig); err == nil {
		t.Fatal("a relay substituted its own DTLS fingerprint and the signature still verified")
	}

	// And a peer on a different roster view must be detectable.
	forked := offer
	forked.RosterHead = bytes.Repeat([]byte{0xbb}, 32)
	if err := Verify(pub, forked, sig); err == nil {
		t.Fatal("the roster head is not covered by the signature")
	}
}

// Fixed-width fields are checked rather than silently padded or truncated,
// because a short nonce is a weak nonce and nothing downstream would notice.
func TestFixedWidthFieldsAreChecked(t *testing.T) {
	short := bytes.Repeat([]byte{1}, 8)
	if _, err := (Login{DeviceNonce: short, ServerNonce: make([]byte, 32), ServerSPKI: make([]byte, 32)}).Encode(); err == nil {
		t.Error("Login accepted a short device nonce")
	}
	if _, err := (Authz{DeviceNonce: make([]byte, 32), BodyHash: short}).Encode(); err == nil {
		t.Error("Authz accepted a short body hash")
	}
	if _, err := (Signal{DeviceNonce: short, PeerNonce: make([]byte, 32), PeerPubSign: make([]byte, 32),
		DTLSFingerprint: make([]byte, 32), RosterHead: make([]byte, 32)}).Encode(); err == nil {
		t.Error("Signal accepted a short device nonce")
	}
}

func TestNoncesAreFreshAndFullWidth(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 200; i++ {
		n, err := Nonce()
		if err != nil {
			t.Fatal(err)
		}
		if len(n) != NonceLen {
			t.Fatalf("nonce is %d bytes, want %d", len(n), NonceLen)
		}
		k := hex.EncodeToString(n)
		if seen[k] {
			t.Fatal("Nonce returned a repeat")
		}
		seen[k] = true
	}
}

// Every purpose's encoding must carry its own domain prefix, which is what the
// cross-purpose refusal above actually rests on.
func TestEachPurposeCarriesItsOwnDomainPrefix(t *testing.T) {
	n := make([]byte, 32)
	cases := []struct {
		domain string
		s      Signable
	}{
		{DomainLogin, Login{DeviceNonce: n, ServerNonce: n, ServerSPKI: n}},
		{DomainAuthz, Authz{DeviceNonce: n, BodyHash: NoBody}},
		{DomainSignal, Signal{DeviceNonce: n, PeerNonce: n, PeerPubSign: n, DTLSFingerprint: n, RosterHead: n}},
	}
	seen := make(map[string]bool)
	for _, c := range cases {
		b, err := c.s.Encode()
		if err != nil {
			t.Fatalf("%s: %v", c.domain, err)
		}
		want := append([]byte(c.domain), 0x00)
		if !bytes.HasPrefix(b, want) {
			t.Errorf("%s encoding does not start with its prefix", c.domain)
		}
		if seen[c.domain] {
			t.Errorf("two structures share the prefix %s", c.domain)
		}
		seen[c.domain] = true
	}
}

// THE STRONGEST CHECK IN THIS FILE: rebuild each purpose's structure with our
// encoder and compare against the bytes the specification says get signed. Field
// ORDER is not visible in a signature that verifies against itself -- two
// implementations can each be self-consistent and disagree -- so this is what
// makes the code and the spec one thing rather than two descriptions of an
// intention.
func TestEachPurposeEncodesToTheSpecificationsSignedBytes(t *testing.T) {
	raw, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatalf("reading vectors: %v", err)
	}
	var v struct {
		Root struct {
			AccountIDHex string `json:"account_id_hex"`
		} `json:"root"`
		Devices map[string]struct {
			Label     string `json:"label"`
			DKSignPub string `json:"dk_sign_pub_hex"`
		} `json:"devices"`
		SignaturePurposes struct {
			Login struct {
				DeviceNonceHex string `json:"device_nonce_hex"`
				ServerNonceHex string `json:"server_nonce_hex"`
				ServerSPKIHex  string `json:"server_spki_sha256_hex"`
				TSMillis       uint64 `json:"ts_ms"`
				SignedHex      string `json:"signed_bytes_hex"`
				SigHex         string `json:"sig_hex"`
			} `json:"login"`
			Authz struct {
				DeviceNonceHex string `json:"device_nonce_hex"`
				Method         string `json:"method"`
				Path           string `json:"path"`
				BodySHA256Hex  string `json:"body_sha256_hex"`
				TSMillis       uint64 `json:"ts_ms"`
				SignedHex      string `json:"signed_bytes_hex"`
				SigHex         string `json:"sig_hex"`
			} `json:"request_authorization"`
			Signal struct {
				Epoch           uint64 `json:"epoch"`
				DeviceNonceHex  string `json:"device_nonce_hex"`
				PeerNonceHex    string `json:"peer_nonce_hex"`
				PeerPubSignHex  string `json:"peer_pub_sign_hex"`
				DTLSFingerprint string `json:"dtls_fingerprint_sha256_hex"`
				RosterHeadHex   string `json:"roster_head_hex"`
				TSMillis        uint64 `json:"ts_ms"`
				SignedHex       string `json:"signed_bytes_hex"`
				SigHex          string `json:"sig_hex"`
			} `json:"signalling"`
		} `json:"signature_purposes"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parsing vectors: %v", err)
	}

	var acct AccountID
	copy(acct[:], mustHex(t, v.Root.AccountIDHex))

	sp := v.SignaturePurposes

	t.Run("login", func(t *testing.T) {
		got, err := Login{
			AccountID:   acct,
			DeviceNonce: mustHex(t, sp.Login.DeviceNonceHex),
			ServerNonce: mustHex(t, sp.Login.ServerNonceHex),
			ServerSPKI:  mustHex(t, sp.Login.ServerSPKIHex),
			TS:          sp.Login.TSMillis,
		}.Encode()
		if err != nil {
			t.Fatal(err)
		}
		compare(t, got, sp.Login.SignedHex)
	})

	t.Run("request authorization", func(t *testing.T) {
		got, err := Authz{
			AccountID:   acct,
			DeviceNonce: mustHex(t, sp.Authz.DeviceNonceHex),
			Method:      sp.Authz.Method,
			Path:        sp.Authz.Path,
			BodyHash:    mustHex(t, sp.Authz.BodySHA256Hex),
			TS:          sp.Authz.TSMillis,
		}.Encode()
		if err != nil {
			t.Fatal(err)
		}
		compare(t, got, sp.Authz.SignedHex)
	})

	t.Run("signalling", func(t *testing.T) {
		got, err := Signal{
			AccountID:       acct,
			Epoch:           sp.Signal.Epoch,
			DeviceNonce:     mustHex(t, sp.Signal.DeviceNonceHex),
			PeerNonce:       mustHex(t, sp.Signal.PeerNonceHex),
			PeerPubSign:     mustHex(t, sp.Signal.PeerPubSignHex),
			DTLSFingerprint: mustHex(t, sp.Signal.DTLSFingerprint),
			RosterHead:      mustHex(t, sp.Signal.RosterHeadHex),
			TS:              sp.Signal.TSMillis,
		}.Encode()
		if err != nil {
			t.Fatal(err)
		}
		compare(t, got, sp.Signal.SignedHex)
	})

	// The vectors name device A as the signer of all three, so verify against
	// THAT key rather than "whichever one works" -- the named signer is the
	// assertion; a search would pass even if the file named the wrong device.
	deviceA, ok := v.Devices["A"]
	if !ok {
		t.Fatal("the vectors carry no device A")
	}
	pubRaw := mustHex(t, deviceA.DKSignPub)
	if len(pubRaw) != ed25519.PublicKeySize {
		t.Fatalf("device A's public key is %d bytes", len(pubRaw))
	}
	signer := ed25519.PublicKey(pubRaw)

	for _, c := range []struct {
		name      string
		signedHex string
		sigHex    string
	}{
		{"login", sp.Login.SignedHex, sp.Login.SigHex},
		{"request authorization", sp.Authz.SignedHex, sp.Authz.SigHex},
		{"signalling", sp.Signal.SignedHex, sp.Signal.SigHex},
	} {
		if !ed25519.Verify(signer, mustHex(t, c.signedHex), mustHex(t, c.sigHex)) {
			t.Errorf("the %s signature does not verify under device A, which the file names as its signer", c.name)
		}
	}

	// The specification's own negative: a login signature must not verify over
	// the authorization bytes. This is the chosen-message oracle the domain
	// prefixes exist to close.
	if ed25519.Verify(signer, mustHex(t, sp.Authz.SignedHex), mustHex(t, sp.Login.SigHex)) {
		t.Fatal("a login signature verified over the authorization bytes")
	}
}

func compare(t *testing.T, got []byte, wantHex string) {
	t.Helper()
	want := mustHex(t, wantHex)
	if !bytes.Equal(got, want) {
		t.Fatalf("encoding does not match the specification\n got %x\nwant %x", got, want)
	}
}
