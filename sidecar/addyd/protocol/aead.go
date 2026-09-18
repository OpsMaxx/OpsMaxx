// SPDX-License-Identifier: MIT
// Vendored from github.com/opsmaxx/addy internal/protocol/aead.go @ fe66709
//
// Edit it THERE and copy it here. A fix made only in this copy is a
// protocol divergence with no symptom until an AEAD tag fails on somebody
// else's machine. See VENDORED.md in this directory.
package protocol

import (
	"crypto/rand"
	"fmt"
	"time"

	"golang.org/x/crypto/chacha20poly1305"
)

// sealXChaCha prefixes the 24-byte nonce to the ciphertext, so callers never
// carry the two separately and can never pair the wrong ones.
func sealXChaCha(key, plaintext, aad []byte) ([]byte, error) {
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, fmt.Errorf("protocol: key: %w", err)
	}
	nonce := make([]byte, nonceLen)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("protocol: drawing a nonce: %w", err)
	}
	return aead.Seal(nonce, nonce, plaintext, aad), nil
}

func openXChaCha(key, sealed, aad []byte) ([]byte, error) {
	if len(sealed) < nonceLen {
		return nil, fmt.Errorf("protocol: sealed value is shorter than its nonce")
	}
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, fmt.Errorf("protocol: key: %w", err)
	}
	return aead.Open(nil, sealed[:nonceLen], sealed[nonceLen:], aad)
}

// timeNow is a variable so a test can pin a timestamp. Nothing load-bearing
// depends on it -- ts is display only everywhere in this protocol, because a
// clock is a thing an attacker controls on a machine they own.
var timeNow = time.Now
