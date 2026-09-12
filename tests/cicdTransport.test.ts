import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import type { AddressInfo } from 'node:net'

/** Captured before anything spies on it, so the spy can still dial for real. */
const realTlsConnect = tls.connect.bind(tls)

// Same seam as httpClientService.test.ts: the SSH pool is stubbed, and the
// transport under test is a real loopback server. Nothing here leaves the
// machine — "cross-origin" is two ports on 127.0.0.1, which is all the origin
// comparison looks at.
vi.mock('../src/main/services/ssh', () => ({
  acquire: vi.fn(),
  release: vi.fn()
}))

const { httpRequest } = await import('../src/main/services/httpClient')
const { isPinnedOrigin, isLinkLocalHost } = await import('../src/shared/httpClient')

const ctx = { prepare: <T>(target: T): T => target }
const json = (body: ArrayBuffer): { headers: Record<string, string> } =>
  JSON.parse(Buffer.from(body).toString('utf8'))

/**
 * `/to/<url>` answers 302 to that url; `/echo` reports the headers it was
 * asked with; `/loop` redirects to itself forever.
 */
const handler =
  (self: () => string): http.RequestListener =>
  (req, res) => {
    const url = new URL(req.url ?? '/', 'http://placeholder')
    if (url.pathname === '/echo') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ headers: req.headers, method: req.method }))
    }
    if (url.pathname === '/loop') {
      res.writeHead(302, { location: `${self()}/loop` })
      return res.end()
    }
    if (url.pathname.startsWith('/to/')) {
      res.writeHead(302, {
        location: decodeURIComponent(url.pathname.slice('/to/'.length))
      })
      return res.end()
    }
    res.writeHead(404)
    res.end()
  }

let a: http.Server
let b: http.Server
let aUrl = ''
let bUrl = ''

const listen = async (server: http.Server): Promise<string> => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

beforeAll(async () => {
  a = http.createServer(handler(() => aUrl))
  b = http.createServer(handler(() => bUrl))
  aUrl = await listen(a)
  bUrl = await listen(b)
})

afterAll(async () => {
  await Promise.all([a, b].map((s) => new Promise<void>((r) => s.close(() => r()))))
})

const get = (url: string, extra: Partial<Parameters<typeof httpRequest>[0]> = {}) =>
  httpRequest(
    {
      url,
      method: 'GET',
      headers: {
        Authorization: 'Bearer ghp_secret',
        'X-Api-Key': 'k',
        Accept: '*/*'
      },
      via: { kind: 'direct' },
      ...extra
    },
    ctx
  )

describe('redirects', () => {
  it('drops credential headers when the origin changes', async () => {
    const res = await get(`${aUrl}/to/${encodeURIComponent(`${bUrl}/echo`)}`, {
      maxRedirects: 3
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.status).toBe(200)
    const { headers } = json(res.body)
    expect(headers.authorization).toBeUndefined()
    // Not an Authorization special case: anything that could carry a
    // credential goes, and only the safe set survives.
    expect(headers['x-api-key']).toBeUndefined()
    expect(headers.accept).toBe('*/*')
  })

  it('keeps them on a same-origin redirect', async () => {
    const res = await get(`${aUrl}/to/${encodeURIComponent(`${aUrl}/echo`)}`, {
      maxRedirects: 3
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(json(res.body).headers.authorization).toBe('Bearer ghp_secret')
  })

  it('does not follow anything unless asked', async () => {
    const res = await get(`${aUrl}/to/${encodeURIComponent(`${bUrl}/echo`)}`)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.status).toBe(302)
  })

  it('terminates at the hop cap', async () => {
    const res = await get(`${aUrl}/loop`, { maxRedirects: 2 })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('ETOOMANYREDIRECTS')
    expect(res.error).toContain('2 redirects')
  })
})

describe('addresses', () => {
  it('refuses link-local, where the metadata endpoints live', async () => {
    const res = await get('http://169.254.169.254/latest/meta-data/')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toContain('link-local')

    expect(isLinkLocalHost('169.254.169.254')).toBe(true)
    expect(isLinkLocalHost('[fe80::1]')).toBe(true)
    expect(isLinkLocalHost('[FEBF::1]')).toBe(true)
  })

  it('does not refuse a private address — that is the normal CI install', async () => {
    // 127.0.0.1 is how a Jenkins behind a local tunnel is reached, and this
    // server is on it.
    const res = await get(`${aUrl}/echo`)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.status).toBe(200)

    for (const host of ['127.0.0.1', '10.1.2.3', '192.168.1.10', '172.16.0.9']) {
      expect(isLinkLocalHost(host)).toBe(false)
    }
  })
})

describe('origin pinning', () => {
  it('is exact, so a suffix is not a match', () => {
    expect(isPinnedOrigin('https://ci.example.com/job/1', 'https://ci.example.com')).toBe(true)
    // The bug the exactness exists to make unwriteable.
    expect(isPinnedOrigin('https://ci.example.com.evil.tld/job/1', 'https://ci.example.com')).toBe(
      false
    )
    expect(isPinnedOrigin('https://evil.ci.example.com/', 'https://ci.example.com')).toBe(false)
    // Different port and different scheme are different origins.
    expect(isPinnedOrigin('https://ci.example.com:8443/', 'https://ci.example.com')).toBe(false)
    expect(isPinnedOrigin('http://ci.example.com/', 'https://ci.example.com')).toBe(false)
    // The default port and the trailing dot are the same origin.
    expect(isPinnedOrigin('https://ci.example.com.:443/x', 'https://ci.example.com')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// What a redirect may NOT inherit
// ---------------------------------------------------------------------------

describe('a redirect cannot borrow the trust granted to the first host', () => {
  // `via`, `insecureTls` and `caPem` are all answers to "what do I grant THIS
  // host", decided once about the URL the user typed. The far end writes the
  // Location, so on an origin change it would otherwise be choosing which of
  // the user's grants to spend.
  const forwarded: string[] = []

  beforeEach(async () => {
    forwarded.length = 0
    const { acquire, release } = await import('../src/main/services/ssh')
    vi.mocked(release).mockImplementation(() => {})
    vi.mocked(acquire).mockImplementation(
      async () =>
        ({
          // A stand-in for a direct-tcpip channel: it reaches the target the
          // same way the real one does, and records that it was used at all.
          client: {
            forwardOut: (
              _h: string,
              _p: number,
              host: string,
              port: number,
              cb: (err: Error | undefined, stream?: unknown) => void
            ) => {
              forwarded.push(`${host}:${port}`)
              const socket = net.connect({ host, port })
              socket.once('connect', () => cb(undefined, socket))
              socket.once('error', (err) => cb(err))
            }
          }
        }) as never
    )
  })

  const viaServer = {
    via: {
      kind: 'server' as const,
      server: { host: 'bastion', port: 22, username: 'ops', auth: 'agent' as const }
    },
    maxRedirects: 3
  }

  it('sends a cross-origin hop direct, not through the SSH channel', async () => {
    // The attack: a self-hosted GitLab answers a log request with
    // `302 Location: http://10.0.0.5:8080/admin`, and that URL gets fetched
    // through the user's own SSH connection — a read primitive into a private
    // network, aimed by the remote side. Stripping credentials does not touch
    // it, because the transport is the thing being borrowed.
    const res = await get(`${aUrl}/to/${encodeURIComponent(`${bUrl}/echo`)}`, viaServer)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.status).toBe(200)
    // Exactly one channel: the first hop, to the host the user named.
    expect(forwarded).toEqual([aUrl.replace('http://', '')])
  })

  it('keeps the channel for a same-origin hop', async () => {
    // Same host the user pointed at, so the grant still applies — a GitLab
    // behind a bastion redirecting within itself must still work.
    const res = await get(`${aUrl}/to/${encodeURIComponent(`${aUrl}/echo`)}`, viaServer)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(forwarded).toHaveLength(2)
    expect(new Set(forwarded)).toEqual(new Set([aUrl.replace('http://', '')]))
  })

  it('stays direct for the rest of the chain, even coming back to the first origin', async () => {
    // A -> B -> A must not walk back into the tunnel on the third hop: the
    // decision was taken about a chain the far end is now steering.
    const back = `${bUrl}/to/${encodeURIComponent(`${aUrl}/echo`)}`
    const res = await get(`${aUrl}/to/${encodeURIComponent(back)}`, viaServer)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(forwarded).toEqual([aUrl.replace('http://', '')])
  })
})

describe('TLS trust is per host, not per redirect chain', () => {
  // The spec's own words: "Skip TLS certificate verification for THIS request"
  // and "A PEM bundle to trust for THIS request". A hop to another origin is a
  // different request to a different host.
  //
  // Asserted on the options tls.connect was called with rather than on a
  // handshake, so no test certificate has to exist: the targets below are the
  // plain HTTP servers above, which fail the handshake after the options are
  // already in hand.
  let opts: Record<string, unknown>[] = []
  let spy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    opts = []
    spy = vi.spyOn(tls, 'connect').mockImplementation(((o: Record<string, unknown>) => {
      opts.push(o)
      return realTlsConnect(o as never)
    }) as never)
  })
  afterEach(() => spy.mockRestore())

  it('drops insecureTls and caPem when the origin changes', async () => {
    const httpsB = `https://127.0.0.1:${(b.address() as AddressInfo).port}/echo`
    await get(`${aUrl}/to/${encodeURIComponent(httpsB)}`, {
      maxRedirects: 3,
      insecureTls: true,
      caPem: '-----BEGIN CERTIFICATE-----\nnot-a-real-ca\n-----END CERTIFICATE-----'
    })
    expect(opts).toHaveLength(1)
    expect(opts[0].rejectUnauthorized).toBe(true)
    expect(opts[0].ca).toBeUndefined()
  })

  it('keeps both for the host the user actually named', async () => {
    await get(`https://127.0.0.1:${(b.address() as AddressInfo).port}/echo`, {
      insecureTls: true,
      caPem: '-----BEGIN CERTIFICATE-----\nnot-a-real-ca\n-----END CERTIFICATE-----'
    })
    expect(opts).toHaveLength(1)
    expect(opts[0].rejectUnauthorized).toBe(false)
    expect(Array.isArray(opts[0].ca)).toBe(true)
  })
})

describe('a failure after a dropped route explains itself', () => {
  // Agent 1 of the review called this the actual defect: the policy is right,
  // the error it produces is undiagnosable. The request fails at a hostname the
  // user never typed, and the ECONNREFUSED branch of `messageOf` even advises
  // routing through a server — which is exactly what they already configured.
  it('names both hosts and says the route did not carry over', async () => {
    const res = await get(`${aUrl}/to/${encodeURIComponent('http://127.0.0.1:9/dead')}`, {
      via: {
        kind: 'server' as const,
        server: { host: 'bastion', port: 22, username: 'ops', auth: 'agent' as const }
      },
      maxRedirects: 3
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toContain('127.0.0.1:9')
    expect(res.error).toContain('redirected there')
    expect(res.error).toMatch(/does not inherit the route/)
    // The misleading advice is cut, not appended to.
    expect(res.error).not.toContain('send the request through that server')
  })

  it('says nothing extra when no route was dropped', async () => {
    const res = await get(`${aUrl}/to/${encodeURIComponent('http://127.0.0.1:9/dead')}`, {
      maxRedirects: 3
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).not.toMatch(/does not inherit the route/)
  })
})
