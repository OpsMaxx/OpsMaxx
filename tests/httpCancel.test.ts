import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

// The pool is not under test; netTransport imports it.
vi.mock('../src/main/services/ssh', () => ({ acquire: vi.fn(), release: vi.fn() }))

const { trackedHttpRequest, cancelHttpRequest, inFlightCount } = await import(
  '../src/main/services/httpClient'
)

const ctx = { prepare: <T>(t: T): T => t }
let server: http.Server
let base: string
/** Resolves when the server's side of the connection for `path` closes. */
const closed = new Map<string, Promise<void>>()
const arrived = new Map<string, () => void>()

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = req.url ?? '/'
    const socket: Socket = req.socket
    closed.set(path, new Promise((r) => socket.once('close', () => r())))
    if (path.startsWith('/stall')) {
      // Headers and half a body, then nothing: the cancel lands mid-body.
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' })
      res.write('half')
      arrived.get(path)?.()
      return
    }
    setTimeout(() => res.end('late'), 150)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => {
  server.closeAllConnections()
  server.close()
})

const spec = (path: string, requestId?: string) => ({
  url: `${base}${path}`,
  method: 'GET',
  headers: {},
  via: { kind: 'direct' as const },
  ...(requestId !== undefined ? { requestId } : {})
})

describe('http:cancel', () => {
  it('aborts mid-body with ABORTED, destroys the socket, and forgets the entry', async () => {
    const reached = new Promise<void>((r) => arrived.set('/stall1', r))
    const pending = trackedHttpRequest(1, spec('/stall1', 'r1'), ctx)
    await reached
    expect(inFlightCount()).toBe(1)
    cancelHttpRequest(1, 'r1')
    const result = await pending
    expect(result).toMatchObject({ ok: false, code: 'ABORTED' })
    await closed.get('/stall1')
    expect(inFlightCount()).toBe(0)
  })

  it('refuses a duplicate in-flight id rather than overwriting it', async () => {
    const reached = new Promise<void>((r) => arrived.set('/stall2', r))
    const first = trackedHttpRequest(1, spec('/stall2', 'dup'), ctx)
    await reached
    const second = await trackedHttpRequest(1, spec('/late', 'dup'), ctx)
    expect(second.ok).toBe(false)
    expect(second.ok ? '' : second.error).toMatch(/already in flight/)
    // The first is still cancellable: its controller was not orphaned.
    cancelHttpRequest(1, 'dup')
    expect(await first).toMatchObject({ code: 'ABORTED' })
  })

  it('scopes ids to the sender: another window cannot cancel, and may reuse the id', async () => {
    const mine = trackedHttpRequest(1, spec('/late', 'shared'), ctx)
    const theirs = trackedHttpRequest(2, spec('/late', 'shared'), ctx)
    cancelHttpRequest(3, 'shared')
    const [a, b] = await Promise.all([mine, theirs])
    expect(a.ok && Buffer.from(a.body).toString()).toBe('late')
    expect(b.ok).toBe(true)
  })

  it('validates the id and ignores a malformed cancel', async () => {
    expect(await trackedHttpRequest(1, spec('/late', 'x'.repeat(65)), ctx)).toMatchObject({ ok: false })
    expect(await trackedHttpRequest(1, spec('/late', ''), ctx)).toMatchObject({ ok: false })
    expect(() => cancelHttpRequest(1, { not: 'a string' })).not.toThrow()
  })

  it('removes the entry in finally when the request fails', async () => {
    const r = await trackedHttpRequest(1, { ...spec('/x', 'gone'), url: 'http://127.0.0.1:1/' }, ctx)
    expect(r.ok).toBe(false)
    expect(inFlightCount()).toBe(0)
  })
})
