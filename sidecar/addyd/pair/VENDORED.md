# Vendored from the addy server

A copy of `internal/pair/` in [OpsMaxx/addy](https://github.com/OpsMaxx/addy),
which is the source of truth, for the same reason as `../protocol/`: Go forbids
importing another module's `internal/` package, and a public MIT repository
whose build needs a second repository to resolve breaks for every contributor
whenever that resolution does. See
`docs/decisions/0002-sharing-the-protocol-with-the-client.md` there.

Only the import path of the SPAKE2 sub-package is rewritten. Nothing else is
edited, and a fix made only here is a pairing that works against this client
and no other.

## What keeps the two honest

Pairing is symmetric: the initiator and the joiner run the same protocol from
opposite ends, and this repository holds one end while the server's reference
client holds the other. So the check is not a vector file -- it is that the two
implementations complete a pairing with each other, which the server's own
tests do against this same code.

What that does NOT catch is the two diverging identically. Nothing does.
