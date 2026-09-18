# Vendored from the addy server

Everything in this directory except this file is a copy of
`internal/protocol/` in [OpsMaxx/addy](https://github.com/OpsMaxx/addy), which
is the source of truth. Edit it there and copy it here; a fix made only here
is a protocol divergence with no symptom until an AEAD tag fails on a user's
machine.

It is a copy rather than an import because Go forbids importing another
module's `internal/` package, and because a public MIT repository whose build
needs a second repository to resolve is one that breaks for every contributor
whenever that resolution does. The full reasoning, including the two options
this rejects and why a `replace` directive is not one of them, is in
`docs/decisions/0002-sharing-the-protocol-with-the-client.md` in that repo.

## What keeps the two copies honest

Not this file, and not source comparison — identical source was never the
requirement. Identical **output** is: two implementations may differ freely in
structure and still interoperate, and cannot differ by one byte of output and
be anything at all.

So the shared contract is `testdata/vectors.json`. `vectorcheck_test.go` in
both repositories asserts its implementation reproduces the same encodings,
signatures and chain hashes from the same fixed inputs, and
`version_test.go` asserts the file's `_meta.version` matches the
`ProtocolVersion` constant. A protocol change that is not carried across
therefore forces a version bump, and a sidecar still announcing the old
version is refused by the server at connect time — before anything is sealed,
rather than after.

The one failure this cannot catch is a change made identically in both copies
and wrong in both. Nothing catches that.

## Provenance

Every file here carries `SPDX-License-Identifier: MIT` and the upstream path
and commit it was copied from. `deps_test.go` asserts that, and it is the
cheapest thing that puts the upstream path in front of whoever opens the file
-- a copy with no provenance is a copy somebody edits in place.

Files written only on this side say `// NOT VENDORED.` on their first line and
name themselves rather than being listed somewhere a reader has to go and find.

## Why this is the WHOLE package rather than the subset addyd calls

A trimmed copy was considered and measured. It saves no dependencies:

| dependency | needed by | droppable? |
|---|---|---|
| `golang.org/x/text` | `ace.go`, the canonical encoder | no |
| `go-bip39` | the vector replay test | no |
| `filippo.io/edwards25519` | `pair/spake2` | no |

What trimming would remove is source that mirrors upstream exactly, and
replace it with a curated subset somebody has to re-derive on every upstream
change -- which is the opposite of what makes a copy easy to keep in step. The
design says this is a copy; a copy is what it is.

## Licence

Ours, MIT, same copyright holder as the rest of this repository. It adds no
third-party obligation and nothing to `THIRD-PARTY-NOTICES.md`.
