// SPDX-License-Identifier: MIT
// Vendored from github.com/opsmaxx/addy internal/protocol/version.go @ fe66709
//
// Edit it THERE and copy it here. A fix made only in this copy is a
// protocol divergence with no symptom until an AEAD tag fails on somebody
// else's machine. See VENDORED.md in this directory.
package protocol

// ProtocolVersion identifies the wire contract this implementation speaks.
//
// It is not a build version and does not move with releases. It changes only
// when an encoding, a signature domain, a key-derivation label or a sealed
// object's layout changes -- that is, only when two implementations that were
// interoperable stop being so.
//
// THE CLIENT'S SIDECAR CARRIES A VENDORED COPY of this package, so this
// constant is one half of the gate that keeps the two honest. The other half
// is testdata/vectors.json: `_meta.version` must equal this string, and
// vectorcheck_test.go fails if it does not, in BOTH repositories. Changing the
// protocol without bumping this leaves the vectors claiming a version they no
// longer describe, and the test says so; bumping it without carrying the
// change across leaves a sidecar announcing a version this server refuses, at
// connect time, before anything is sealed.
//
// See docs/decisions/0002-sharing-the-protocol-with-the-client.md.
const ProtocolVersion = "addy-protocol-v1"
