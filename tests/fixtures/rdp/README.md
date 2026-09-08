Self-signed key and certificate for the RDP relay tests.

Generated once, valid for 100 years, and deliberately committed: the relay's
job in `performHandshake` is to complete a TLS handshake against a server whose
certificate nobody trusts — which is the normal case for RDP — and hand the
chain back to the client. Testing that needs a real certificate, and generating
one per run would need `openssl` on every machine that runs the suite.

It secures nothing. It is only ever presented by a stub server bound to
127.0.0.1 inside a test, and the private key is public by construction.

    openssl req -x509 -newkey rsa:2048 -keyout test-key.pem -out test-cert.pem \
      -days 36500 -nodes -subj "/CN=rdp-test"
