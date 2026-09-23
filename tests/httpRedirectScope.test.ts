import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

// What crosses an origin on a redirect (finalsec M1, L8): cookies are
// attributed to the hop that set them, and a body is never re-sent to
// another origin.
vi.mock('../src/main/services/ssh', () => ({ acquire: vi.fn(), release: vi.fn() }))
const { httpRequest } = await import('../src/main/services/httpClient')

const ctx = { prepare: <T>(t: T): T => t }
let a: http.Server
let b: http.Server
let aUrl = ''
let bUrl = ''
let bodiesAtB: string[] = []

beforeAll(async () => {
  b = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      bodiesAtB.push(Buffer.concat(chunks).toString())
      res.writeHead(200, { 'set-cookie': ['idp=from-b; Path=/'] })
      res.end('b')
    })
  })
  await new Promise<void>((r) => b.listen(0, '127.0.0.1', r))
  bUrl = `http://127.0.0.1:${(b.address() as AddressInfo).port}`
  a = http.createServer((req, res) => {
    req.resume()
    const status = req.url === '/307' ? 307 : req.url === '/308-same' ? 308 : 302
    const to = req.url === '/308-same' ? '/landed' : `${bUrl}/landed`
    if (req.url === '/landed') {
      res.writeHead(200, { 'set-cookie': ['mine=from-a'] })
      return res.end('a')
    }
    res.writeHead(status, { location: to, 'set-cookie': ['sess=from-a-redirect'] })
    res.end()
  })
  await new Promise<void>((r) => a.listen(0, '127.0.0.1', r))
  aUrl = `http://127.0.0.1:${(a.address() as AddressInfo).port}`
})
afterAll(() => {
  a.close()
  b.close()
})

const req = (path: string, over: Record<string, unknown> = {}) =>
  httpRequest({ url: `${aUrl}${path}`, method: 'GET', headers: {}, via: { kind: 'direct' }, maxRedirects: 5, ...over }, ctx)

describe('cookies after a redirect (M1)', () => {
  it('are returned with the URL of the hop that set them, never the one requested', async () => {
    const r = await req('/go')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.finalUrl).toBe(`${bUrl}/landed`)
    expect(r.setCookie).toEqual(['idp=from-b; Path=/'])
    // The redirecting hop's own cookie is not handed back under either name.
    expect(JSON.stringify(r)).not.toContain('from-a-redirect')
  })

  it('says so when a cross-origin hop left the route or the certificate exemption behind', async () => {
    const insecure = await req('/go', { insecureTls: true })
    expect(insecure.ok && insecure.routeDropped).toBe(true)
    const plain = await req('/go')
    expect(plain.ok && 'routeDropped' in plain).toBe(false)
    const sameOrigin = await req('/308-same', { insecureTls: true })
    expect(sameOrigin.ok && 'routeDropped' in sameOrigin).toBe(false)
  })

  it('names the requested URL when nothing redirected', async () => {
    const r = await req('/landed')
    expect(r.ok && r.finalUrl).toBe(`${aUrl}/landed`)
  })

  it('names the requested URL when redirects are not followed', async () => {
    const r = await req('/go', { maxRedirects: 0 })
    expect(r.ok && [r.status, r.finalUrl]).toEqual([302, `${aUrl}/go`])
  })
})

describe('a body on a cross-origin 307/308 (L8)', () => {
  it('is refused with a reason, and never reaches the other origin', async () => {
    bodiesAtB = []
    const body = new TextEncoder().encode('password=hunter2').buffer as ArrayBuffer
    const r = await req('/307', { method: 'POST', body })
    expect(r).toMatchObject({ ok: false, code: 'ECROSSORIGINBODY' })
    expect(r.ok ? '' : r.error).toMatch(/does not send a body across origins/)
    expect(bodiesAtB).toEqual([])
  })

  it('still follows a same-origin 308 with its body, and a cross-origin 307 without one', async () => {
    const body = new TextEncoder().encode('x=1').buffer as ArrayBuffer
    expect(await req('/308-same', { method: 'POST', body })).toMatchObject({ ok: true, status: 200 })
    bodiesAtB = []
    expect(await req('/307')).toMatchObject({ ok: true, status: 200 })
    expect(bodiesAtB).toEqual([''])
  })
})
