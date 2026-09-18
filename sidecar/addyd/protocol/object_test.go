// SPDX-License-Identifier: MIT
// Vendored from github.com/opsmaxx/addy internal/protocol/object_test.go @ fe66709
//
// Edit it THERE and copy it here. A fix made only in this copy is a
// protocol divergence with no symptom until an AEAD tag fails on somebody
// else's machine. See VENDORED.md in this directory.
package protocol

import (
	"bytes"
	"errors"
	"testing"
)

func testProfileKey() []byte { return bytes.Repeat([]byte{0x6b}, 32) }

func testCollection() Collection {
	return Collection{
		Name:          "servers",
		Schema:        3,
		WriterVersion: "0.48.0",
		Counter:       11,
		Payload:       []byte(`[{"id":"a","host":"example"}]`),
	}
}

func TestACollectionRoundTrips(t *testing.T) {
	var acct AccountID
	acct[0] = 1
	c := testCollection()

	obj, err := SealCollection(c, acct, 2, testProfileKey())
	if err != nil {
		t.Fatalf("SealCollection: %v", err)
	}
	got, err := OpenCollection(obj, c.Name, acct, 2, testProfileKey(), 3, 0)
	if err != nil {
		t.Fatalf("OpenCollection: %v", err)
	}
	if got.Schema != c.Schema || got.WriterVersion != c.WriterVersion ||
		got.Counter != c.Counter || !bytes.Equal(got.Payload, c.Payload) {
		t.Errorf("round-trip differs: %+v", got)
	}
}

// The collection name is in the AAD, which stops the server answering a request
// for `servers` with the `vault` ciphertext. That is an attack a server can
// mount with no key at all, by handing back a different file.
func TestTheVaultCiphertextCannotBeServedAsServers(t *testing.T) {
	var acct AccountID
	vault := testCollection()
	vault.Name = "vault"

	obj, err := SealCollection(vault, acct, 1, testProfileKey())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := OpenCollection(obj, "servers", acct, 1, testProfileKey(), 9, 0); err == nil {
		t.Fatal("the vault ciphertext opened as servers")
	}
}

// The epoch is in the AAD too, so last epoch's object cannot be served as this
// one's.
func TestAnObjectFromAnotherEpochIsRefused(t *testing.T) {
	var acct AccountID
	c := testCollection()
	obj, err := SealCollection(c, acct, 1, testProfileKey())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := OpenCollection(obj, c.Name, acct, 2, testProfileKey(), 9, 0); err == nil {
		t.Fatal("an object from epoch 1 opened as epoch 2")
	}
}

func TestAnObjectFromAnotherAccountIsRefused(t *testing.T) {
	var a, b AccountID
	a[0], b[0] = 1, 2
	c := testCollection()
	obj, err := SealCollection(c, a, 1, testProfileKey())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := OpenCollection(obj, c.Name, b, 1, testProfileKey(), 9, 0); err == nil {
		t.Fatal("an object from one account opened as another's")
	}
}

// THE ANTI-ROLLBACK CONTROL. A malicious server could otherwise serve last
// month's vault or servers and nothing would notice: it is validly sealed and
// simply old.
func TestAnOlderObjectIsRefused(t *testing.T) {
	var acct AccountID
	c := testCollection()
	c.Counter = 4
	obj, err := SealCollection(c, acct, 1, testProfileKey())
	if err != nil {
		t.Fatal(err)
	}
	_, err = OpenCollection(obj, c.Name, acct, 1, testProfileKey(), 9, 10)
	if !errors.Is(err, ErrObjectRollback) {
		t.Fatalf("err = %v, want ErrObjectRollback", err)
	}
}

// The counter is inside the ciphertext, so an attacker who wanted to defeat the
// rollback check would have to break the AEAD rather than edit a field.
func TestTheCounterIsNotVisibleOrEditableInTheObject(t *testing.T) {
	var acct AccountID
	c := testCollection()
	c.Counter = 0x4142434445464748
	obj, err := SealCollection(c, acct, 1, testProfileKey())
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(obj, []byte{0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48}) {
		t.Error("the counter appears in the sealed object in the clear")
	}
	if bytes.Contains(obj, []byte("0.48.0")) {
		t.Error("the writer version appears in the sealed object in the clear")
	}
	if bytes.Contains(obj, c.Payload) {
		t.Error("the payload appears in the sealed object in the clear")
	}
}

// READ-ONLY RATHER THAN DEGRADED, which is the whole reason the schema is in
// there. Without it: a newer client writes a field an older one does not know,
// the older one reads the document, drops the field on its typed round-trip,
// edits one unrelated record and writes the whole thing back -- and the field is
// gone on both machines, with no error and no symptom.
func TestAnOlderClientGetsTheDocumentAndAnInstructionNotToWriteIt(t *testing.T) {
	var acct AccountID
	c := testCollection()
	c.Schema = 7

	obj, err := SealCollection(c, acct, 1, testProfileKey())
	if err != nil {
		t.Fatal(err)
	}

	got, err := OpenCollection(obj, c.Name, acct, 1, testProfileKey(), 5, 0)
	if !errors.Is(err, ErrSchemaTooNew) {
		t.Fatalf("err = %v, want ErrSchemaTooNew", err)
	}
	// It must still hand back the document. A client that cannot WRITE a
	// collection can still show it, and refusing to decode it would turn a
	// version skew into a blank panel.
	if got == nil {
		t.Fatal("a too-new schema returned no document at all")
	}
	if !bytes.Equal(got.Payload, c.Payload) {
		t.Error("the payload was not returned alongside the read-only signal")
	}
}

func TestAWrongProfileKeyIsRefused(t *testing.T) {
	var acct AccountID
	c := testCollection()
	obj, err := SealCollection(c, acct, 1, testProfileKey())
	if err != nil {
		t.Fatal(err)
	}
	other := bytes.Repeat([]byte{0x11}, 32)
	if _, err := OpenCollection(obj, c.Name, acct, 1, other, 9, 0); err == nil {
		t.Fatal("an object opened under the wrong profile key")
	}
}

func TestATamperedObjectIsRefusedToo(t *testing.T) {
	var acct AccountID
	c := testCollection()
	obj, err := SealCollection(c, acct, 1, testProfileKey())
	if err != nil {
		t.Fatal(err)
	}
	for _, at := range []int{len(obj) - 1, len(obj) / 2, len(domainObject) + 2} {
		tampered := bytes.Clone(obj)
		tampered[at] ^= 0x01
		if _, err := OpenCollection(tampered, c.Name, acct, 1, testProfileKey(), 9, 0); err == nil {
			t.Errorf("a one-bit change at %d was accepted", at)
		}
	}
}

// Two writes of the same document must not produce the same bytes: a repeated
// nonce under one key is a catastrophic failure for any AEAD, and a random
// 24-byte nonce is what makes coordination unnecessary between two devices
// writing the same collection.
func TestEveryWriteDrawsAFreshNonce(t *testing.T) {
	var acct AccountID
	c := testCollection()
	seen := make(map[string]bool)
	for i := 0; i < 200; i++ {
		obj, err := SealCollection(c, acct, 1, testProfileKey())
		if err != nil {
			t.Fatal(err)
		}
		nonce := string(obj[len(domainObject)+2 : len(domainObject)+2+nonceLen])
		if seen[nonce] {
			t.Fatal("a nonce repeated")
		}
		seen[nonce] = true
	}
}

func TestACollectionWithoutItsEssentialsIsRefused(t *testing.T) {
	var acct AccountID
	base := testCollection()

	noName := base
	noName.Name = ""
	if _, err := SealCollection(noName, acct, 1, testProfileKey()); err == nil {
		t.Error("SealCollection accepted a collection with no name")
	}
	zeroCounter := base
	zeroCounter.Counter = 0
	if _, err := SealCollection(zeroCounter, acct, 1, testProfileKey()); err == nil {
		t.Error("SealCollection accepted a zero counter")
	}
}
