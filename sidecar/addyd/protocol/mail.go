// SPDX-License-Identifier: MIT
// Vendored from github.com/opsmaxx/addy internal/protocol/mail.go
//
// Edit it THERE and copy it here. A fix made only in this copy is a
// protocol divergence with no symptom until an AEAD tag fails on somebody
// else's machine. See VENDORED.md in this directory.
package protocol

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hpke"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
)

// Device-to-device mail: sealed to ONE device, signed by ONE device.
//
// The relay's mailbox carries clipboards and file notices between a user's
// devices. It used to carry them sealed under the epoch key, which every
// device on the account holds -- and so does a removed one until the next
// re-key. A recipient could not tell its own desktop from any other key
// holder, and the only sender identity it had was the relay's `fromDevice`.
//
// Now each mail is HPKE-sealed to the recipient's DK_enc, the same suite as
// the escrow and the pairing handoff, and carries the sender's signature over
// `Mail` (sign.go). Opening proves it was for this device; the signature
// proves which device wrote it; the CALLER proves that device is a member, by
// checking `From` against the roster it verified. This file cannot do the last
// step because it has no roster, and that is why OpenMail returns the signer
// rather than a verdict.
//
// The HPKE info binds the account, the recipient and the kind, so a mail
// sealed for another account, another device or another purpose does not
// open at all rather than opening and being checked afterwards.

const (
	domainMailObject    = "addy-mail-obj-v1"
	domainMailPlaintext = "addy-mail-pt-v1"
	domainMailBlob      = "addy-mail-blob-v1"
	infoMailHPKE        = "addy-mail-hpke-v1"

	// MailBlobKeyLen is the size of a blob's one-time key.
	MailBlobKeyLen = 32
)

// ErrMailForged is a mail whose signature does not verify against the key it
// names as its sender.
var ErrMailForged = errors.New("mail: the signature does not verify against the sender it names")

func mailInfo(acct AccountID, to []byte, kind string) []byte {
	return NewEncoder(infoMailHPKE).Fixed(acct[:]).Fixed(to).Str(kind).Out()
}

// SealMail signs m with the sender's device key and seals it, with the
// payload, to the recipient's DK_enc. m.From must be that key's public half
// and m.PayloadHash is filled in here, from the payload actually sealed.
func SealMail(m Mail, payload []byte, from ed25519.PrivateKey, recipient *ecdh.PublicKey) ([]byte, error) {
	if !from.Public().(ed25519.PublicKey).Equal(ed25519.PublicKey(m.From)) {
		return nil, errors.New("protocol: mail.From is not the signing key's public half")
	}
	sum := sha256.Sum256(payload)
	m.PayloadHash = sum[:]
	sig, err := Sign(from, m)
	if err != nil {
		return nil, err
	}
	// Account, recipient and kind are in the HPKE info and in what the
	// recipient already knows, so the plaintext carries only what it does not.
	plaintext := NewEncoder(domainMailPlaintext).
		Fixed(m.From).
		Fixed(m.Nonce).
		U64(m.TS).
		Fixed(sig).
		Bytes(payload).
		Out()

	pk, err := hpke.NewDHKEMPublicKey(recipient)
	if err != nil {
		return nil, fmt.Errorf("protocol: mail recipient key: %w", err)
	}
	kdf, aead := suite()
	enc, sender, err := hpke.NewSender(pk, kdf, aead, mailInfo(m.AccountID, m.To, m.Kind))
	if err != nil {
		return nil, fmt.Errorf("protocol: mail sender: %w", err)
	}
	ct, err := sender.Seal(nil, plaintext)
	if err != nil {
		return nil, fmt.Errorf("protocol: sealing mail: %w", err)
	}
	return NewEncoder(domainMailObject).U8(SuitePinned).Bytes(enc).Bytes(ct).Out(), nil
}

// OpenMail opens a mail addressed to `self` (this device's DK_sign public
// half) and checks its signature against the sender it names. It does NOT
// decide whether that sender may write to this device: the caller compares the
// returned Mail.From against its own verified roster.
func OpenMail(object []byte, acct AccountID, kind string, self ed25519.PublicKey, recipient *ecdh.PrivateKey) (*Mail, []byte, error) {
	d := NewDecoder(domainMailObject, object)
	gotSuite := d.U8()
	enc := d.Bytes()
	ct := d.Bytes()
	if err := d.End(); err != nil {
		return nil, nil, fmt.Errorf("mail: %w", err)
	}
	if gotSuite != SuitePinned {
		return nil, nil, fmt.Errorf("mail: unknown cipher suite %#02x", gotSuite)
	}

	sk, err := hpke.NewDHKEMPrivateKey(recipient)
	if err != nil {
		return nil, nil, fmt.Errorf("mail: recipient key: %w", err)
	}
	kdf, aead := suite()
	r, err := hpke.NewRecipient(enc, sk, kdf, aead, mailInfo(acct, self, kind))
	if err != nil {
		return nil, nil, fmt.Errorf("mail: recipient context: %w", err)
	}
	plaintext, err := r.Open(nil, ct)
	if err != nil {
		return nil, nil, fmt.Errorf("mail: opening: %w", err)
	}

	pd := NewDecoder(domainMailPlaintext, plaintext)
	m := Mail{AccountID: acct, Kind: kind, To: self}
	m.From = pd.Fixed(ed25519.PublicKeySize)
	m.Nonce = pd.Fixed(NonceLen)
	m.TS = pd.U64()
	sig := pd.Fixed(ed25519.SignatureSize)
	payload := pd.Bytes()
	if err := pd.End(); err != nil {
		return nil, nil, fmt.Errorf("mail: plaintext: %w", err)
	}
	sum := sha256.Sum256(payload)
	m.PayloadHash = sum[:]
	// Re-encoded with To = self: a mail signed for another device verifies
	// only against that device's key, so one forwarded here fails.
	if err := Verify(ed25519.PublicKey(m.From), m, sig); err != nil {
		return nil, nil, ErrMailForged
	}
	return &m, payload, nil
}

// SealMailBlob seals bytes too large for a mail under a fresh one-time key.
// The key travels inside a mail, so the blob is exactly as readable as the
// mail is -- by its one recipient -- and is not bound to any epoch.
func SealMailBlob(plaintext []byte) (key, sealed []byte, err error) {
	key = make([]byte, MailBlobKeyLen)
	if _, err := rand.Read(key); err != nil {
		return nil, nil, fmt.Errorf("protocol: drawing a blob key: %w", err)
	}
	ct, err := sealXChaCha(key, plaintext, NewEncoder(domainMailBlob).Out())
	if err != nil {
		return nil, nil, err
	}
	return key, NewEncoder(domainMailBlob).Fixed(ct).Out(), nil
}

// OpenMailBlob opens what SealMailBlob produced.
func OpenMailBlob(key, sealed []byte) ([]byte, error) {
	if err := fixed("blob_key", key, MailBlobKeyLen); err != nil {
		return nil, err
	}
	prefix := NewEncoder(domainMailBlob).Out()
	if len(sealed) < len(prefix) || string(sealed[:len(prefix)]) != string(prefix) {
		return nil, errors.New("mail: not a mail blob")
	}
	return openXChaCha(key, sealed[len(prefix):], prefix)
}
