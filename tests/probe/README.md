# The live device-sync flow probe

Not part of the suite. These files are `*.probe.ts` so the root config's
`tests/**/*.test.ts` glob cannot pick them up; `vitest.probe.config.ts` is the
only thing that runs them.

They drive `AddySession` for real — real `addyd`, real crypto, real keychain
file, real relay over strict TLS — because every existing addy test replaces
`openAddyd` with a stub, and a stub cannot refuse a payload it was never told
about. That is how `attach()` came to omit `rootSignPub` with 230 tests green.

## Setting it up

1. Build the sidecar for this machine into a scratch dir and write it a
   manifest, then point `OPSMAXX_VPN_BIN_DIR` at that dir. (Building into
   `resources/bin` would change the checked-in `manifest.json`.)

2. Build and run the relay from the addy repo, with a fake OIDC provider:

       go build -o /tmp/addy-flows ./cmd/addy
       ADDY_OIDC_ISSUER=http://127.0.0.1:9110 ADDY_OIDC_CLIENT_ID=cid \
       ADDY_OIDC_CLIENT_SECRET=s ADDY_DATA_DIR=<scratch>/data \
       /tmp/addy-flows serve -dev -ui -addr 127.0.0.1:8480 -http-addr 127.0.0.1:8099

3. Put a TLS front door in front of it on 8490 with a certificate Node will
   accept, and trust its CA with `NODE_EXTRA_CA_CERTS`. This is not optional:
   `-dev` presents a self-signed certificate with no SAN, and `insecureTLS`
   is reachable from `recoverFromPhrase` and from nothing else — so neither
   `createAccount` nor pairing can be driven against the dev certificate.
   A second certificate from the SAME CA is what PATH 13 swaps in; one from a
   different CA tests Node, not the pin.

4. Sign in to the operator console once and keep the cookie jar:

       curl -sk --resolve localhost:8480:127.0.0.1 -c jar.txt -b jar.txt -L \
         https://localhost:8480/admin/login -o /dev/null

## Running it

    OPSMAXX_VPN_BIN_DIR=<scratch>/bin \
    NODE_EXTRA_CA_CERTS=<scratch>/certs1/ca.pem \
    ADDY_JAR=<scratch>/jar.txt ADDY_OUT=<scratch>/probe.txt \
    ADDY_SCRATCH=<scratch> \
    npx vitest run --config tests/probe/vitest.probe.config.ts

The matrix is written to `$ADDY_OUT`, one line per step, recording what each
call returned OR what it threw — nothing stops the run, because the point is
the whole matrix rather than the first failure.

`ADDY_SHIM_ROOTPUB=1` supplies the missing `rootSignPub` at the sidecar
boundary, without touching `src/`. Leave it off to see the unshimmed truth;
turn it on to see what lies behind the blocker. Every row past PATH 2 needs it
until `attach()` is fixed.

**One relay per run.** The relay enforces one sync group per signed-in person,
so a second `createAccount` is refused; reset the relay's data directory
between runs.
