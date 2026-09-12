import { describe, it, expect } from 'vitest'

import { pollOnce, reload } from '../src/main/services/cicd/wiring'
import { pollCacheKey, type CicdPollRequest, type CicdPollTarget } from '../src/main/services/cicd/poller'
import type { CicdConnection } from '../src/shared/cicd'
import type { HttpResult } from '../src/shared/httpClient'

/**
 * The probe: the seam between an adapter, which parses, and the poller, which
 * schedules.
 *
 * Everything here is about the things `CicdAdapter` deliberately hides and the
 * poller cannot work without — the status code, `Retry-After` and the rate
 * headers. The adapter throws a plain `Error` on a non-2xx, so if the probe
 * ever went back to sniffing messages instead of recording responses, these
 * are the tests that would notice.
 */

const connection = (over: Partial<CicdConnection> = {}): CicdConnection => ({
  id: 'c1',
  workspaceId: 'ws-1',
  name: 'Platform GitHub',
  provider: 'github',
  baseUrl: 'https://github.com',
  vaultEntryId: 'v1',
  route: { kind: 'direct' },
  enabled: true,
  ...over
})

const target = (over: Partial<CicdPollTarget> = {}): CicdPollTarget => ({
  id: 't1',
  connectionId: 'c1',
  pipelineRef: 'acme/web#.github/workflows/ci.yml',
  kind: 'runs',
  ...over
})

const request = (over: Partial<CicdPollRequest> = {}): CicdPollRequest => {
  const t = over.target ?? target()
  return { target: t, connection: connection(), cacheKey: pollCacheKey(t), ...over }
}

/** An `HttpResult` shaped like what `httpRequest` actually returns. */
const reply = (status: number, body: unknown, headers: Record<string, string> = {}): HttpResult => ({
  ok: true,
  status,
  statusText: '',
  headers,
  body: new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body))
    .buffer as ArrayBuffer,
  durationMs: 1,
  truncated: false
})

const secretFor = (): string => 'token-abc'

describe('the poll probe', () => {
  it('reports the status the server actually sent, not one inferred from an error', async () => {
    const out = await pollOnce(request(), {
      secretFor,
      request: async () => reply(200, { workflow_runs: [] })
    })
    expect(out.status).toBe(200)
    expect(out.error).toBeUndefined()
  })

  it('reports a transport failure as 0, never as something a server said', async () => {
    // The distinction is load-bearing: a 404 on a log is an EXPECTED state that
    // must not back off, so a failed connection must never be able to look
    // like one.
    const out = await pollOnce(request(), {
      secretFor,
      request: async () => ({ ok: false, error: 'ECONNREFUSED', code: 'ECONNREFUSED' }) as HttpResult
    })
    expect(out.status).toBe(0)
    expect(out.error).toBeTruthy()
  })

  it('surfaces a non-2xx status off the recorded response, not the thrown message', async () => {
    const out = await pollOnce(request(), {
      secretFor,
      request: async () => reply(429, { message: 'slow down' }, { 'retry-after': '30' })
    })
    expect(out.status).toBe(429)
    expect(out.retryAfterMs).toBe(30_000)
    expect(out.error).toBeTruthy()
  })

  it('reads Retry-After given as an HTTP date', async () => {
    const when = new Date(Date.now() + 60_000).toUTCString()
    const out = await pollOnce(request(), {
      secretFor,
      request: async () => reply(503, 'nope', { 'retry-after': when })
    })
    // Allow a second of slack for the clock between construction and parse.
    expect(out.retryAfterMs).toBeGreaterThan(55_000)
    expect(out.retryAfterMs).toBeLessThanOrEqual(60_000)
  })

  it('ignores a Retry-After that is neither seconds nor a date', async () => {
    const out = await pollOnce(request(), {
      secretFor,
      request: async () => reply(429, 'nope', { 'retry-after': 'soon' })
    })
    expect(out.retryAfterMs).toBeUndefined()
  })

  it('reads the rate budget when the provider reports one', async () => {
    const out = await pollOnce(request(), {
      secretFor,
      request: async () =>
        reply(
          200,
          { workflow_runs: [] },
          {
            'X-RateLimit-Remaining': '4812',
            'X-RateLimit-Limit': '5000',
            'X-RateLimit-Reset': '1800000000'
          }
        )
    })
    expect(out.rate).toEqual({ remaining: 4812, limit: 5000, resetAt: 1_800_000_000_000 })
  })

  it('reports no budget for a provider that sends none', async () => {
    // Jenkins and GitLab do not report one, and inventing a full budget would
    // make the panel claim headroom nobody measured.
    const out = await pollOnce(request(), {
      secretFor,
      request: async () => reply(200, { workflow_runs: [] })
    })
    expect(out.rate).toBeUndefined()
  })

  it('passes the ETag back so a 304 can be free', async () => {
    const out = await pollOnce(request(), {
      secretFor,
      request: async () => reply(200, { workflow_runs: [] }, { ETag: 'W/"abc"' })
    })
    expect(out.etag).toBe('W/"abc"')
  })

  it('matches headers case-insensitively, because servers disagree about case', async () => {
    const out = await pollOnce(request(), {
      secretFor,
      request: async () => reply(200, { workflow_runs: [] }, { etag: 'lower', 'RETRY-AFTER': '5' })
    })
    expect(out.etag).toBe('lower')
  })

  it('never lets the token reach anything it records', async () => {
    const seen: unknown[] = []
    await pollOnce(request(), {
      secretFor,
      request: async (spec) => {
        seen.push(spec.url)
        return reply(200, { workflow_runs: [] })
      }
    })
    // The token belongs in a header on the wire and nowhere else — not in a
    // URL, which is the one part of a request that ends up in logs and proxies.
    expect(JSON.stringify(seen)).not.toContain('token-abc')
  })
})

describe('where the connection list comes from', () => {
  // The renderer does not get to name a vault entry or a destination. An
  // earlier version took the records straight off `cicd:configure`, which let
  // a compromised renderer point ANY stored credential — an SSH password, a
  // database secret — at a host it chose, with no approval and no audit.
  // `shared/httpClient.ts` states the rule for SSH in the same words: "A
  // renderer that could send a password could also exfiltrate one."
  it('reads connections from the saved file, not from its caller', () => {
    const list = reload({
      cicdConnections: [
        {
          id: 'c1',
          workspaceId: 'ws-1',
          name: 'Platform',
          provider: 'github',
          baseUrl: 'https://github.com',
          vaultEntryId: 'v1',
          route: { kind: 'direct' },
          enabled: true
        }
      ]
    })
    expect(list.map((c) => c.id)).toEqual(['c1'])
  })

  it('drops a record whose provider no adapter can serve', () => {
    const list = reload({
      cicdConnections: [
        { id: 'x', workspaceId: 'ws-1', provider: 'buildkite', baseUrl: 'https://x', vaultEntryId: 'v' }
      ]
    })
    expect(list).toEqual([])
  })

  it('drops a record with no vault reference rather than dialling it anonymously', () => {
    const list = reload({
      cicdConnections: [
        { id: 'x', workspaceId: 'ws-1', provider: 'github', baseUrl: 'https://github.com' }
      ]
    })
    expect(list).toEqual([])
  })

  it('survives a file that predates the module', () => {
    expect(reload({ servers: [] })).toEqual([])
  })
})
