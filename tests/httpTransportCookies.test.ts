// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHttpTransport } from '../src/renderer/src/lib/httpTransport'

/**
 * The cookie a browser will not let you send, and an API client cannot work
 * without.
 *
 * `Cookie` is a forbidden request-header name. A `Request`'s headers carry the
 * request guard, which drops forbidden names SILENTLY — no throw, no warning.
 * Scalar builds that Request before this transport is ever called, so by the
 * time the transport reads the headers the cookie is already gone.
 *
 * What the user saw: log in, watch the session cookie appear in the cookie
 * panel — Scalar's persist-response-cookies does store it — and then get a 401
 * on the very next request, for ever, with nothing anywhere to explain it.
 *
 * The cookie therefore has to be sourced from the document and attached after
 * the guard, on the plain object that crosses IPC. This test exists because the
 * failure is invisible: everything about it looks like it works.
 */
describe('cookies on an outgoing request', () => {
  const requests: { headers: Record<string, string> }[] = []

  beforeEach(() => {
    requests.length = 0
    ;(globalThis as unknown as { window: unknown }).window = globalThis
    ;(globalThis as unknown as { opsmaxx: unknown }).opsmaxx = {
      http: {
        request: vi.fn(async (spec: { headers: Record<string, string> }) => {
          requests.push({ headers: spec.headers })
          return { ok: true, status: 200, statusText: 'OK', headers: {}, body: new ArrayBuffer(0), durationMs: 1, truncated: false }
        })
      }
    }
  })

  const options = () => ({ via: { kind: 'direct' as const }, insecureTls: false })

  it('attaches a cookie the request never carried', async () => {
    // The request arrives WITHOUT a cookie, which is the real shape: in a
    // browser or in Electron the guard has already dropped it by now.
    //
    // Not asserted here, deliberately — jsdom does not implement the forbidden
    // header guard, so a test that checked for the drop would be measuring
    // jsdom rather than this transport, and would pass for the wrong reason on
    // the day the guard stopped applying. That the guard is real in Electron 43
    // was verified in a live renderer: of accept-encoding, cookie, host,
    // origin, referer, user-agent and the rest, only authorization,
    // x-scalar-cookie and content-type survived constructing a Request.
    //
    // What this asserts is the part that is ours: whatever the cookie source
    // returns reaches the spec that crosses IPC.
    const fetchLike = createHttpTransport(options, undefined, () => 'session=abc123')
    await fetchLike(
      new Request('https://api.example.com/me', { headers: { 'content-type': 'application/json' } })
    )
    expect(requests[0]?.headers['Cookie']).toBe('session=abc123')
  })

  it('sends no cookie header when nothing matches the url', async () => {
    // An empty string is not a cookie. Sending `Cookie: ` is a malformed
    // header that some servers reject outright.
    const fetchLike = createHttpTransport(options, undefined, () => '')
    await fetchLike(new Request('https://api.example.com/me'))
    expect(requests[0]?.headers['Cookie']).toBeUndefined()
  })

  it('works with no cookie source at all, which is every other caller', async () => {
    const fetchLike = createHttpTransport(options)
    await fetchLike(new Request('https://api.example.com/me'))
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers['Cookie']).toBeUndefined()
  })
})
