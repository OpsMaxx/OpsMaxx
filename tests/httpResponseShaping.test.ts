import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import zlib from 'node:zlib'
import type { AddressInfo } from 'node:net'

/**
 * What the client hands back after a response arrives.
 *
 * Three things that were wrong, each of which is invisible to a test that only
 * checks status and body text:
 *
 *   - Repeated `Set-Cookie` lines were joined with `', '`, and an `Expires`
 *     date contains a comma — so the joined string cannot be split back apart.
 *     A cookie jar built on it gets the common case wrong.
 *   - `Content-Encoding` was never undone. `http.request` does not decompress,
 *     so a gzip response rendered as binary noise.
 *   - `text/event-stream` was buffered like any other body, and a stream has no
 *     end — so the request sat until the timeout and reported ETIMEDOUT for an
 *     endpoint that answered instantly.
 *
 * The SSH pool is stubbed for the same reason the sibling suite stubs it:
 * these are about response shaping, not about reaching a server.
 */
vi.mock('../src/main/services/ssh', () => ({
  acquire: vi.fn(),
  release: vi.fn()
}))

const { httpRequest } = await import('../src/main/services/httpClient')
const { MAX_RESPONSE_BYTES } = await import('../src/shared/httpClient')

const ctx = { prepare: <T>(target: T): T => target }
const text = (body: ArrayBuffer): string => Buffer.from(body).toString('utf8')
const direct = { kind: 'direct' as const }

const PAYLOAD = JSON.stringify({ hello: 'world', note: 'compressed on the wire' })

let server: http.Server
let base: string

const handler: http.RequestListener = (req, res) => {
  const path = new URL(req.url ?? '/', 'http://placeholder').pathname

  if (path === '/cookies') {
    // Two cookies, and the first carries a comma inside its Expires date —
    // which is the whole reason joining them is lossy.
    res.writeHead(200, {
      'content-type': 'text/plain',
      'set-cookie': [
        'session=abc123; Path=/; Expires=Wed, 21 Oct 2099 07:28:00 GMT; HttpOnly',
        'theme=dark; Path=/'
      ]
    })
    return res.end('ok')
  }

  if (path === '/gzip') {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
    return res.end(zlib.gzipSync(Buffer.from(PAYLOAD)))
  }

  if (path === '/br') {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'br' })
    return res.end(zlib.brotliCompressSync(Buffer.from(PAYLOAD)))
  }

  if (path === '/deflate') {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'deflate' })
    return res.end(zlib.deflateSync(Buffer.from(PAYLOAD)))
  }

  // The spelling some servers actually send: raw deflate under the wrapped
  // name. Node's inflate rejects it, and the retry is what saves it.
  if (path === '/deflate-raw') {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'deflate' })
    return res.end(zlib.deflateRawSync(Buffer.from(PAYLOAD)))
  }

  if (path === '/double') {
    // Applied gzip first, then brotli — so the header reads `gzip, br` and
    // undoing it left to right produces garbage.
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip, br' })
    return res.end(zlib.brotliCompressSync(zlib.gzipSync(Buffer.from(PAYLOAD))))
  }

  if (path === '/unknown-encoding') {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'exotic-v9' })
    return res.end('untouched')
  }

  if (path === '/identity') {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'identity' })
    return res.end('plain')
  }

  if (path === '/bomb') {
    // A few hundred KB of gzip that expands to far past the cap. The point is
    // that it is refused mid-decompression rather than allocated in full.
    res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' })
    return res.end(zlib.gzipSync(Buffer.alloc(MAX_RESPONSE_BYTES + 8 * 1024 * 1024, 0x61)))
  }

  if (path === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    res.write('data: one\n\n')
    // Deliberately never ends.
    return
  }

  res.writeHead(404)
  res.end()
}

beforeAll(async () => {
  server = http.createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server?.close()
})

const get = (path: string) =>
  httpRequest({ url: `${base}${path}`, method: 'GET', headers: {}, via: direct }, ctx)

describe('repeated Set-Cookie headers', () => {
  it('arrive unjoined, one entry per line the server sent', async () => {
    const res = await get('/cookies')
    expect(res.ok).toBe(true)
    if (!res.ok) return

    expect(res.setCookie).toHaveLength(2)
    expect(res.setCookie?.[0]).toContain('session=abc123')
    // The comma that makes joining unrecoverable is still inside ONE entry.
    expect(res.setCookie?.[0]).toContain('Expires=Wed, 21 Oct 2099')
    expect(res.setCookie?.[1]).toContain('theme=dark')
  })

  it('is absent when the response set none', async () => {
    const res = await get('/identity')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.setCookie).toBeUndefined()
  })
})

describe('Content-Encoding', () => {
  it.each([
    ['gzip', '/gzip'],
    ['br', '/br'],
    ['deflate', '/deflate'],
    ['raw deflate sent as deflate', '/deflate-raw']
  ])('decodes %s', async (_label, path) => {
    const res = await get(path)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(text(res.body)).toBe(PAYLOAD)
    expect(res.decodedFrom).toBeDefined()
  })

  it('undoes stacked codings in reverse, not header order', async () => {
    const res = await get('/double')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(text(res.body)).toBe(PAYLOAD)
    expect(res.decodedFrom).toBe('gzip, br')
  })

  it('leaves a coding it cannot undo completely alone', async () => {
    const res = await get('/unknown-encoding')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // Untouched bytes and no claim to have decoded them. Half-decoded output
    // that says it is decoded would be worse than this.
    expect(text(res.body)).toBe('untouched')
    expect(res.decodedFrom).toBeUndefined()
  })

  it('treats identity as nothing to undo', async () => {
    const res = await get('/identity')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(text(res.body)).toBe('plain')
    expect(res.decodedFrom).toBeUndefined()
  })

  it('keeps the header as the server sent it, so the wire is still readable', async () => {
    const res = await get('/gzip')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // The body is decoded; the header still describes what arrived. A viewer
    // says "gzip, decoded" from `decodedFrom` rather than being told the
    // response was never compressed.
    expect(res.headers['content-encoding']).toBe('gzip')
  })

  it('caps what a decompression bomb expands to', async () => {
    const res = await get('/bomb')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // The cap held, and it is reported rather than silently short.
    expect(res.body.byteLength).toBeLessThanOrEqual(MAX_RESPONSE_BYTES)
    expect(res.truncated).toBe(true)
  })
})

describe('server-sent events', () => {
  it('are refused immediately instead of hanging until the timeout', async () => {
    const started = Date.now()
    const res = await httpRequest(
      {
        url: `${base}/events`,
        method: 'GET',
        headers: {},
        via: direct,
        // Long enough that a hang would be obvious: if this ever waits for the
        // timeout, the elapsed assertion below fails rather than the suite
        // simply running slowly.
        timeoutMs: 30_000
      },
      ctx
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('ESTREAMUNSUPPORTED')
    expect(res.error).toMatch(/event stream/i)
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})
