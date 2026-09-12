import { describe, it, expect } from 'vitest'
import { redactOutput, redactKnownSecrets, redactPatterns } from '../src/main/services/secretRedaction'

describe('secret redaction', () => {
  it('redacts a known secret value verbatim', () => {
    const out = redactKnownSecrets('the password is hunter2 today', ['hunter2'])
    expect(out).not.toContain('hunter2')
    expect(out).toContain('[REDACTED]')
  })

  it('redacts KEY=value style env assignments', () => {
    const out = redactPatterns('DB_PASSWORD=abc123\nOTHER=fine')
    expect(out).toContain('DB_PASSWORD=[REDACTED]')
    expect(out).toContain('OTHER=fine')
  })

  it('redacts a full PEM private key block', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nabcdef\n-----END OPENSSH PRIVATE KEY-----'
    const out = redactPatterns(`before\n${pem}\nafter`)
    expect(out).not.toContain('abcdef')
    expect(out).toContain('before')
    expect(out).toContain('after')
  })

  it('redacts a bearer token', () => {
    const out = redactPatterns('Authorization: Bearer abcd1234efgh5678')
    expect(out).not.toContain('abcd1234efgh5678')
  })

  it('redacts a password embedded in a connection URI', () => {
    const out = redactPatterns('postgres://admin:s3cret@db.internal:5432/app')
    expect(out).not.toContain('s3cret')
    expect(out).toContain('admin')
    expect(out).toContain('db.internal')
  })

  it('leaves ordinary output untouched', () => {
    const text = 'total 12\ndrwxr-xr-x 2 root root 4096 Jan 1 00:00 var'
    expect(redactOutput(text)).toBe(text)
  })

  it('never logs the actual secret when both layers are combined', () => {
    const out = redactOutput('DB_PASSWORD=hunter2', ['hunter2'])
    expect(out).not.toContain('hunter2')
  })
})

// VPN engine output (E57). A key printed by wireguard-go, openvpn or frpc goes
// through this before it reaches the ring buffer, the audit log or an AI agent.
describe('VPN engine output', () => {
  it('redacts a WireGuard base64 key', () => {
    const out = redactPatterns('peer: yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=')
    expect(out).not.toContain('yAnz5TF')
    expect(out).toContain('[REDACTED]')
  })

  it('redacts a public key too, because nothing in the text says which it is', () => {
    // The deliberate trade: a redacted public key costs a support ticket, a
    // leaked private key costs the tunnel. The UI shows public keys from the
    // profile model, never scraped back out of a log.
    const out = redactPatterns('public_key xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg= endpoint')
    expect(out).not.toContain('xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=')
    expect(out).toContain('endpoint')
  })

  it('redacts the hex key form wireguard-go speaks on its UAPI socket', () => {
    const hex = 'a'.repeat(64)
    const out = redactPatterns(`private_key=${hex}\npreshared_key=${hex}\nfwmark=0`)
    expect(out).not.toContain(hex)
    expect(out).toContain('preshared_key=[REDACTED]')
    expect(out).toContain('fwmark=0')
  })

  it('redacts an OpenVPN static-challenge response, which carries the password', () => {
    const out = redactPatterns('sending SCRV1:aHVudGVyMg==:MTIzNDU2 to server')
    expect(out).not.toContain('aHVudGVyMg==')
    expect(out).toContain('sending')
    expect(out).toContain('to server')
  })

  it('redacts an frp token assignment whatever the value looks like', () => {
    const out = redactPatterns(
      'serverAddr = "vpn.example.com"\nauth.token = "s3cr3t-token"\n  secretKey = bare-value\n'
    )
    expect(out).not.toContain('s3cr3t-token')
    expect(out).not.toContain('bare-value')
    expect(out).toContain('vpn.example.com')
  })

  it('redacts the OpenVPN management password command it echoes back', () => {
    const out = redactPatterns('MANAGEMENT: CMD \'password "Auth" "hunter2"\'')
    expect(out).not.toContain('hunter2')
    expect(out).toContain('password "Auth" "[REDACTED]"')
  })

  it('does not eat ordinary base64-looking output', () => {
    // The key rules have to be narrow enough that a log full of hashes, digests
    // and encoded blobs stays readable, or people turn the log drawer off.
    const text = [
      'SGVsbG8gd29ybGQsIHRoaXMgaXMgb3JkaW5hcnkgb3V0cHV0IHRoYXQgaGFwcGVucyB0byBiZSBiYXNlNjQgZW5jb2RlZC4=',
      'dGhpcyBpcyBub3QgYSBrZXk=',
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'allowed_ips=10.0.0.0/24 latest_handshake=1735689600'
    ].join('\n')
    expect(redactOutput(text)).toBe(text)
  })

  it('redacts the config line openvpn quotes back when it cannot parse it', () => {
    // The exact shape openvpn uses, and the value is a bare positional secret:
    // no key name, no shape, nothing a pattern can recognise. The config
    // arrives on the elevated process's stdin with its credentials inline, so
    // the echoed line is the credential. Which line it choked on survives.
    const out = redactPatterns(
      'Options error: Unrecognized option or missing or extra parameter(s) in [STDIN]:7: Sup3rS3cretVPNpass (2.5.9)'
    )
    expect(out).not.toContain('Sup3rS3cretVPNpass')
    expect(out).toContain('[STDIN]:7: [REDACTED]')
    expect(out).toContain('Options error')
  })

  it('blanks every resolved literal handed to it, not just the recognisable ones', () => {
    // What ResolvedVpnSecrets.all is for: an frp token has no shape at all, so
    // only knowing the value catches it.
    const out = redactOutput('login to server failed: token=abc-123-not-a-shape', [
      'abc-123-not-a-shape'
    ])
    expect(out).not.toContain('abc-123-not-a-shape')
  })
})

// Secrets that used to walk straight through, each measured against the real
// table before the rule that catches it was written.
//
// Every case here is paired with the same two fixtures, because a rule that
// over-matches is worse than the gap it closes: it destroys diagnostics
// silently, and then people turn the log drawer off. `ORDINARY` and `BASE64`
// are the fixtures the two assertions above this block guard, repeated per rule
// rather than once, so a widened rule cannot pass by being tested in isolation.
describe('secrets with no key name in front of them', () => {
  const ORDINARY = 'total 12\ndrwxr-xr-x 2 root root 4096 Jan 1 00:00 var'
  const BASE64 = [
    'SGVsbG8gd29ybGQsIHRoaXMgaXMgb3JkaW5hcnkgb3V0cHV0IHRoYXQgaGFwcGVucyB0byBiZSBiYXNlNjQgZW5jb2RlZC4=',
    'dGhpcyBpcyBub3QgYSBrZXk=',
    'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'allowed_ips=10.0.0.0/24 latest_handshake=1735689600'
  ].join('\n')

  /** Run after every new rule, not once: this is the assertion that makes a
   *  widened pattern safe to ship. */
  const expectDiagnosticsIntact = (): void => {
    expect(redactOutput(ORDINARY)).toBe(ORDINARY)
    expect(redactOutput(BASE64)).toBe(BASE64)
  }

  it('redacts a glued mysql -p password, and leaves other -p flags alone', () => {
    const out = redactPatterns('mysql -h db -u root -pPr0dDbPass1')
    expect(out).not.toContain('Pr0dDbPass1')
    expect(out).toContain('-p[REDACTED]')
    // Anchored on the client name, because `\s-p\S+` on its own eats these.
    expect(redactOutput('find . -name "*.log" -print')).toBe('find . -name "*.log" -print')
    expect(redactOutput('tar -pxf backup.tar')).toBe('tar -pxf backup.tar')
    expect(redactOutput('docker run -p8080:80 nginx')).toBe('docker run -p8080:80 nginx')
    expectDiagnosticsIntact()
  })

  it('redacts the hyphenated HTTP header spelling of an API key', () => {
    // `X-Auth-Token:` always matched, via the bare TOKEN alternative. The gap
    // was the API_KEY family, whose every alternative spelled the separator _.
    const out = redactPatterns('header X-Api-Key: 9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c')
    expect(out).not.toContain('9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c')
    expect(redactPatterns('X-Api-Secret: s3cr3t-value')).not.toContain('s3cr3t-value')
    expectDiagnosticsIntact()
  })

  it('redacts PGP armour, which ends PRIVATE KEY BLOCK-----', () => {
    const out = redactPatterns(
      '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBGPGPbody1234\n-----END PGP PRIVATE KEY BLOCK-----'
    )
    expect(out).not.toContain('lQOYBGPGPbody1234')
    expectDiagnosticsIntact()
  })

  it('redacts a key whose label contains a hyphen', () => {
    const out = redactPatterns(
      '-----BEGIN RSA-PSS PRIVATE KEY-----\nMIIEpssBODY9999\n-----END RSA-PSS PRIVATE KEY-----'
    )
    expect(out).not.toContain('MIIEpssBODY9999')
    expectDiagnosticsIntact()
  })

  it('leaves a certificate block, and everything after it, alone', () => {
    // The label class must not be able to swallow an intervening `-----`, or one
    // BEGIN CERTIFICATE plus one later private key would redact the log between
    // them.
    const text =
      '-----BEGIN CERTIFICATE-----\nMIIDdTCCAl2gAwIBAgILBAAAAAABFUtaw5Q\n-----END CERTIFICATE-----\nSubject: CN=vpn'
    expect(redactOutput(text)).toBe(text)
  })

  it('redacts an AWS secret access key, which has no prefix to anchor on', () => {
    const out = redactPatterns('aws creds: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')
    expect(out).not.toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')
    expect(out).toContain('aws creds:')
    expectDiagnosticsIntact()
  })

  it('does not take a 40-character digest or object id for one', () => {
    // What the mixed-case requirement buys: a git object id and a sha1 are
    // single-case hex, and a log is full of both.
    const sha1 = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3'
    expect(redactOutput(`commit ${sha1} tagged`)).toContain(sha1)
    const upper = sha1.toUpperCase()
    expect(redactOutput(`sha1 ${upper}`)).toContain(upper)
    expectDiagnosticsIntact()
  })

  it('redacts vendor-prefixed tokens, where the prefix is the whole tell', () => {
    // Each token is joined here rather than written out whole. A complete
    // vendor token as a source literal trips GitHub's push protection, and
    // this repo is public — so the file whose job is to prove such strings get
    // removed would be the one file that could not be pushed. The rule sees
    // the assembled string either way, which is the only thing under test.
    const join = (prefix: string, body: string): string => `${prefix}${body}`
    for (const token of [
      join('xoxb-', '1234567890-ABCDEFGHIJKLMNOP'),
      join('xoxp-', '1234567890-ABCDEFGHIJKLMNOP'),
      join('glpat-', 'AbCdEfGhIjKlMnOpQrSt'),
      join('ghp_', 'AbCdEfGhIjKlMnOpQrStUvWxYz012345'),
      join('sk-', 'AbCdEfGhIjKlMnOpQrStUv')
    ]) {
      expect(redactPatterns(`token ${token} in use`)).not.toContain(token)
    }
    expectDiagnosticsIntact()
  })

  it('redacts a private key that was cut off before its END marker', () => {
    // The case the elevator's stderr cap used to create: with no END marker the
    // block rule matches nothing, and the body is stored as prose. Fail closed
    // — everything after the marker goes, because there is no way to know where
    // the key stopped.
    const body = 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAt'
    const out = redactPatterns(`starting tunnel\n-----BEGIN OPENSSH PRIVATE KEY-----\n${body}`)
    expect(out).not.toContain(body)
    expect(out).toContain('starting tunnel')
    expectDiagnosticsIntact()
  })
})
