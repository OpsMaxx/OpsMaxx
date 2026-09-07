import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

// The service reaches a server through the SSH pool. These tests are about the
// HTTP half — the transport, the response shaping and the limits — so the pool
// is stubbed and the `via: server` path is asserted on the call it makes.
const acquire = vi.fn()
const release = vi.fn()
vi.mock('../src/main/services/ssh', () => ({
  acquire: (...args: unknown[]) => acquire(...args),
  release: (...args: unknown[]) => release(...args)
}))

const { httpRequest } = await import('../src/main/services/httpClient')
const { MAX_RESPONSE_BYTES } = await import('../src/shared/httpClient')

const ctx = { prepare: <T>(target: T): T => target }
const text = (body: ArrayBuffer): string => Buffer.from(body).toString('utf8')

let plain: http.Server
let plainUrl: string
let tls: https.Server
let tlsUrl: string
const servers: http.Server[] = []
let certDir: string
let decoy: http.Server
let decoyUrl: string
let realPort: number

/** Requests that echo what they were sent, plus a few shapes worth testing. */
const handler: http.RequestListener = (req, res) => {
  const url = new URL(req.url ?? '/', 'http://placeholder')
  if (url.pathname === '/slow') return // never answers: the timeout is the test
  if (url.pathname === '/big') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    // Comfortably past the cap, written in chunks so the cap is hit mid-stream.
    for (let i = 0; i < 40; i++) res.write(Buffer.alloc(1024 * 1024, 0x61))
    return res.end()
  }
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    res.writeHead(url.pathname === '/teapot' ? 418 : 200, {
      'content-type': 'application/json',
      'x-echo-method': req.method ?? ''
    })
    res.end(
      JSON.stringify({
        method: req.method,
        path: url.pathname,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8')
      })
    )
  })
}

beforeAll(async () => {
  plain = http.createServer(handler)
  await new Promise<void>((r) => plain.listen(0, '127.0.0.1', r))
  plainUrl = `http://127.0.0.1:${(plain.address() as AddressInfo).port}`

  // A self-signed certificate, which is what an internal service presents and
  // the whole reason the certificate toggle exists.
  certDir = mkdtempSync(join(tmpdir(), 'sp-http-tls-'))
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(certDir, 'key.pem'),
    '-out', join(certDir, 'cert.pem'),
    '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'
  ], { stdio: 'ignore' })

  // Answers every request saying which server it is, so a test can prove which
  // one was actually reached.
  const named = (who: string): http.RequestListener => (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ servedBy: who }))
  }
  decoy = http.createServer(named('decoy'))
  await new Promise<void>((r) => decoy.listen(0, '127.0.0.1', r))
  decoyUrl = `http://127.0.0.1:${(decoy.address() as AddressInfo).port}`

  const real = http.createServer(named('real'))
  await new Promise<void>((r) => real.listen(0, '127.0.0.1', r))
  realPort = (real.address() as AddressInfo).port
  servers.push(real)

  tls = https.createServer(
    { key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) },
    handler
  )
  await new Promise<void>((r) => tls.listen(0, '127.0.0.1', r))
  tlsUrl = `https://127.0.0.1:${(tls.address() as AddressInfo).port}`
})

afterAll(() => {
  plain?.close()
  tls?.close()
  decoy?.close()
  for (const s of servers) s.close()
  if (certDir) rmSync(certDir, { recursive: true, force: true })
})

describe('httpRequest, direct', () => {
  it('returns the status, headers and body of a plain request', async () => {
    const result = await httpRequest(
      { url: `${plainUrl}/teapot`, method: 'GET', headers: {}, via: { kind: 'direct' } },
      ctx
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.status).toBe(418)
    expect(result.headers['content-type']).toBe('application/json')
    expect(result.headers['x-echo-method']).toBe('GET')
    expect(JSON.parse(text(result.body)).path).toBe('/teapot')
    expect(result.truncated).toBe(false)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('sends a body on the methods that carry one, and the query string', async () => {
    const body = new TextEncoder().encode(JSON.stringify({ hello: 'world' }))
    const result = await httpRequest(
      {
        url: `${plainUrl}/echo?limit=2`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body.buffer as ArrayBuffer,
        via: { kind: 'direct' }
      },
      ctx
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const echoed = JSON.parse(text(result.body))
    expect(echoed.method).toBe('POST')
    expect(echoed.body).toBe('{"hello":"world"}')
    expect(echoed.headers['content-type']).toBe('application/json')
  })

  it('never sends a body on GET, matching fetch', async () => {
    const result = await httpRequest(
      {
        url: `${plainUrl}/echo`,
        method: 'GET',
        headers: {},
        body: new TextEncoder().encode('ignored').buffer as ArrayBuffer,
        via: { kind: 'direct' }
      },
      ctx
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(JSON.parse(text(result.body)).body).toBe('')
  })

  it('drops a header that would inject another one', async () => {
    const result = await httpRequest(
      {
        url: `${plainUrl}/echo`,
        method: 'GET',
        headers: { 'X-Good': 'kept', 'X-Bad': 'a\r\nX-Injected: yes' },
        via: { kind: 'direct' }
      },
      ctx
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const headers = JSON.parse(text(result.body)).headers
    expect(headers['x-good']).toBe('kept')
    expect(headers['x-injected']).toBeUndefined()
    expect(headers['x-bad']).toBeUndefined()
  })

  it('reports an unreachable port rather than throwing', async () => {
    // Port 1 on loopback: nothing listens there, and it fails immediately.
    const result = await httpRequest(
      { url: 'http://127.0.0.1:1/', method: 'GET', headers: {}, via: { kind: 'direct' } },
      ctx
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('ECONNREFUSED')
    // The message names the fix a ShellPilot user most often needs.
    expect(result.error).toMatch(/through that server/)
  })

  it('gives up on a server that never answers', async () => {
    const result = await httpRequest(
      { url: `${plainUrl}/slow`, method: 'GET', headers: {}, via: { kind: 'direct' }, timeoutMs: 300 },
      ctx
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('ETIMEDOUT')
  })

  // The buffer lives in main, so an unbounded response takes the whole app
  // down rather than one view.
  it('caps a huge response and says that it did', async () => {
    const result = await httpRequest(
      { url: `${plainUrl}/big`, method: 'GET', headers: {}, via: { kind: 'direct' }, timeoutMs: 30000 },
      ctx
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.truncated).toBe(true)
    expect(result.body.byteLength).toBe(MAX_RESPONSE_BYTES)
  })

  it('refuses a scheme that is not http or https', async () => {
    const result = await httpRequest(
      { url: 'file:///etc/passwd', method: 'GET', headers: {}, via: { kind: 'direct' } },
      ctx
    )
    expect(result.ok).toBe(false)
  })
})

describe('httpRequest, TLS', () => {
  it('refuses a self-signed certificate by default, and says how to proceed', async () => {
    const result = await httpRequest(
      { url: `${tlsUrl}/echo`, method: 'GET', headers: {}, via: { kind: 'direct' } },
      ctx
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toMatch(/SELF_SIGNED|DEPTH_ZERO/)
    expect(result.error).toMatch(/Skip certificate check/)
  })

  it('accepts it only when the request explicitly opts out', async () => {
    const result = await httpRequest(
      {
        url: `${tlsUrl}/teapot`,
        method: 'GET',
        headers: {},
        via: { kind: 'direct' },
        insecureTls: true
      },
      ctx
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.status).toBe(418)
  })

  // The flag is per request. A previous insecure request must not leave
  // verification off for the next one.
  it('does not leak the opt-out to the request after it', async () => {
    await httpRequest(
      { url: `${tlsUrl}/echo`, method: 'GET', headers: {}, via: { kind: 'direct' }, insecureTls: true },
      ctx
    )
    const strict = await httpRequest(
      { url: `${tlsUrl}/echo`, method: 'GET', headers: {}, via: { kind: 'direct' } },
      ctx
    )
    expect(strict.ok).toBe(false)
  })
})

describe('httpRequest, through a server', () => {
  it('sends the request down the channel, not from this machine', async () => {
    // The URL names the decoy. The channel goes to the real server. If the
    // request is sent over anything other than the channel it will reach the
    // decoy, and the body will say so.
    //
    // This is not a hypothetical: `createConnection` is an agent option, and
    // passing it alongside `agent: false` makes Node build its own agent and
    // dial the URL directly — which looks like success while quietly bypassing
    // the server the user chose.
    const forwardOut = vi.fn(
      (_h: string, _p: number, _host: string, _port: number, cb: (e: Error | null, s: unknown) => void) => {
        const socket = net.connect({ host: '127.0.0.1', port: realPort }, () => cb(null, socket))
      }
    )
    const conn = { client: { forwardOut } }
    acquire.mockResolvedValueOnce(conn)

    const server = { host: 'bastion.example', port: 22, username: 'ops', auth: 'agent' as const }
    const prepare = vi.fn((t: unknown) => ({ ...(t as object), password: 'merged-in-main' }))

    const result = await httpRequest(
      { url: `${decoyUrl}/echo`, method: 'GET', headers: {}, via: { kind: 'server', server } },
      { prepare: prepare as never }
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The answer came from the far end of the channel, not from the URL's host.
    expect(JSON.parse(text(result.body)).servedBy).toBe('real')
    // Credentials are merged in main, never sent by the renderer.
    expect(prepare).toHaveBeenCalledWith(server)
    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ password: 'merged-in-main' }))
    // The hostname is resolved on the server, so the channel is opened to the
    // request's host — not to the SSH host.
    expect(forwardOut).toHaveBeenCalledWith(
      '127.0.0.1',
      0,
      '127.0.0.1',
      Number(new URL(decoyUrl).port),
      expect.any(Function)
    )
    // The channel is this request's; the pooled connection is not.
    expect(release).toHaveBeenCalledWith(conn)
  })

  it('releases the connection even when the request fails', async () => {
    release.mockClear()
    const conn = {
      client: {
        forwardOut: (_h: string, _p: number, _dh: string, _dp: number, cb: (e: Error) => void) =>
          cb(new Error('channel refused'))
      }
    }
    acquire.mockResolvedValueOnce(conn)

    const result = await httpRequest(
      {
        url: `${plainUrl}/echo`,
        method: 'GET',
        headers: {},
        via: { kind: 'server', server: { host: 'h', port: 22, username: 'u', auth: 'agent' } }
      },
      ctx
    )
    expect(result.ok).toBe(false)
    expect(release).toHaveBeenCalledWith(conn)
  })
})
