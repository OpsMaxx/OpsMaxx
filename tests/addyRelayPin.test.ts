import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, X509Certificate } from 'node:crypto'
import https from 'node:https'
import type { AddressInfo } from 'node:net'

/**
 * The relay key is enforced on every connection, against a real TLS server.
 *
 * It used to be compared only on a separate probe connection, while every
 * request on a development relay went out with certificate checking off — so
 * something on the path could pass the probe through and answer every real
 * request with a certificate of its own. These run real handshakes: a stub
 * fetch cannot tell which certificate a connection presented.
 */

const dir = mkdtempSync(join(tmpdir(), 'opsmaxx-addy-pin-'))
function makeCert(name: string): { key: Buffer; cert: Buffer; spki: string } {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', join(dir, `${name}.key`), '-out', join(dir, `${name}.pem`),
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'
  ], { stdio: 'ignore' })
  const cert = readFileSync(join(dir, `${name}.pem`))
  const spki = createHash('sha256')
    .update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex')
  return { key: readFileSync(join(dir, `${name}.key`)), cert, spki }
}

const { relayFetch, RelayClient, RelayPinMismatch } = await import('../src/main/services/addy/relay')

let real: ReturnType<typeof makeCert>
let other: ReturnType<typeof makeCert>
let server: https.Server
let base = ''
const seen: string[] = []

beforeAll(async () => {
  real = makeCert('real')
  other = makeCert('other')
  server = https.createServer({ key: real.key, cert: real.cert }, (req, res) => {
    seen.push(`${req.method} ${req.url}`)
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/v1/auth/challenge') return res.end(JSON.stringify({ nonce: '11'.repeat(32) }))
      if (req.url === '/v1/auth/login') {
        // The relay's channel binding: the signed SPKI must be its own key.
        const ok = JSON.parse(body).server_spki === real.spki
        res.statusCode = ok ? 200 : 401
        return res.end(JSON.stringify(ok ? { token: 'tok' } : { error: 'wrong server key' }))
      }
      res.end(JSON.stringify({ chain: '' }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise((r) => server.close(r))
  rmSync(dir, { recursive: true, force: true })
})

const signer = {
  alive: () => true,
  close: async () => undefined,
  send: async (m: string) =>
    m === 'whoami'
      ? { accountId: 'ab'.repeat(16), devicePub: 'aa'.repeat(32) }
      : m === 'signLogin'
        ? { account: 'ab'.repeat(16), device: 'aa'.repeat(32), deviceNonce: '22'.repeat(32), ts: 1, signature: '33'.repeat(64) }
        : { nonce: '00'.repeat(32), signature: '00'.repeat(64) }
} as never

describe('a pinned connection (development relay, no certificate checking)', () => {
  it('goes through when the relay presents the pinned key', async () => {
    const resp = await relayFetch(`${base}/v1/roster`, {}, true, real.spki)
    expect(resp.status).toBe(200)
  })

  it('is refused in the handshake, before the request is written, on any other key', async () => {
    const before = seen.length
    const err = await relayFetch(`${base}/v1/roster`, { method: 'POST', body: 'secret' }, true, other.spki).catch(
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(RelayPinMismatch)
    expect(seen.length, 'the request reached a server presenting the wrong key').toBe(before)
  })
})

describe('login signs the key of the connections it is sent over', () => {
  it('signs in when the probe and the requests see the same key', async () => {
    const relay = new RelayClient({ baseURL: base, token: '', insecureTLS: true }, signer)
    const r = await relay.login()
    expect(r.spki).toBe(real.spki)
    expect(r.token).toBe('tok')
  })

  it('sends nothing when the requests would reach a different key than the probe saw', async () => {
    // The attack: the probe is passed through to a key the attacker does not
    // control, the real calls are answered by one it does. Modelled by making
    // the probe report another key than the server's.
    const relay = new RelayClient({ baseURL: base, token: '', insecureTLS: true }, signer)
    vi.spyOn(relay, 'serverPin').mockResolvedValue({ spki: other.spki, webpki: false })
    const before = seen.length
    const err = await relay.login().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RelayPinMismatch)
    expect(seen.length).toBe(before)
  })
})

describe('a request connection that shows a different key', () => {
  it('signs in again (where comparePin decides) and never re-pins on its own', async () => {
    const relay = new RelayClient({ baseURL: base, token: '', insecureTLS: true }, signer, async () => {
      // What a re-login does: probe, compare, and — if accepted — pin the key
      // the new session was signed over.
      await relay.login()
    })
    await relay.login()
    ;(relay as unknown as { pin: string }).pin = other.spki // the key the session was signed over
    const resp = await relay.request('GET', '/v1/roster')
    expect(resp.status).toBe(200)
    expect((relay as unknown as { pin: string }).pin).toBe(real.spki)
  })

  it('without a way to sign in again, fails closed', async () => {
    const relay = new RelayClient({ baseURL: base, token: '', insecureTLS: true }, signer)
    await relay.login()
    ;(relay as unknown as { pin: string }).pin = other.spki
    const err = await relay.request('GET', '/v1/roster').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RelayPinMismatch)
  })
})
