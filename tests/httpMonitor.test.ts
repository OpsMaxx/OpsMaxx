import { describe, it, expect } from 'vitest'
import {
  DEFAULT_CHECK,
  MAX_HISTORY,
  appendResult,
  evaluate,
  isCheckableUrl,
  summarise,
  type CheckResult,
  type HttpCheck
} from '../src/shared/httpMonitor'

/**
 * What "up" means for an external service check.
 *
 * The judgements here are the whole feature — the transport is the app's
 * existing HTTP client — so they are what is worth testing: which statuses
 * count, what separates slow from down, and how a run of results summarises.
 */

const CHECK: HttpCheck = {
  ...DEFAULT_CHECK,
  id: 'c1',
  workspaceId: 'w1',
  name: 'api',
  url: 'https://example.com/health'
}

describe('isCheckableUrl', () => {
  it('accepts http and https', () => {
    expect(isCheckableUrl('https://example.com')).toBe(true)
    expect(isCheckableUrl('http://10.0.0.1:8080/health')).toBe(true)
  })

  /**
   * `file:` would read the local disk through a control labelled "watch a
   * service", and the rest are not things this transport speaks. Refusing is
   * better than a check that silently never succeeds.
   */
  it('refuses anything else', () => {
    for (const u of ['file:///etc/passwd', 'ftp://example.com', 'javascript:alert(1)', 'example.com', '']) {
      expect(isCheckableUrl(u), u).toBe(false)
    }
  })
})

describe('evaluate', () => {
  it('calls an expected status up', () => {
    expect(evaluate(CHECK, { ok: true, status: 200, durationMs: 120 }, 1).state).toBe('up')
  })

  /**
   * A status the check did not expect is DOWN with the status shown, not
   * "unknown". A 502 is a precise fact about the service and the most useful
   * thing on the row.
   */
  it('calls an unexpected status down, and says which', () => {
    const r = evaluate(CHECK, { ok: true, status: 502, durationMs: 90 }, 1)
    expect(r.state).toBe('down')
    expect(r.status).toBe(502)
    expect(r.error).toContain('502')
  })

  /**
   * An empty expectation list is a pure reachability test — a legitimate thing
   * to want for an endpoint whose status varies.
   */
  it('treats an empty expectation list as "any answer is up"', () => {
    const any = { ...CHECK, expectStatus: [] }
    expect(evaluate(any, { ok: true, status: 503, durationMs: 10 }, 1).state).toBe('up')
  })

  // Latency warning, not an outage: the service answered correctly.
  it('calls a correct but slow answer slow', () => {
    const r = evaluate({ ...CHECK, slowMs: 100 }, { ok: true, status: 200, durationMs: 350 }, 1)
    expect(r.state).toBe('slow')
    expect(r.status).toBe(200)
  })

  /**
   * Nothing answered at all. The transport's own words are kept, because
   * "status unknown" throws away the only useful part of a refused connection.
   */
  it('quotes the transport when nothing answered', () => {
    const r = evaluate(CHECK, { ok: false, error: 'connect ECONNREFUSED 10.0.0.1:443' }, 1)
    expect(r.state).toBe('down')
    expect(r.status).toBeUndefined()
    expect(r.error).toContain('ECONNREFUSED')
  })

  // 401 is not in the default expectations: an endpoint that should be public
  // answering 401 is a real failure, and someone who wants it to count as up
  // can say so per check.
  it('does not treat auth-required as up by default', () => {
    expect(evaluate(CHECK, { ok: true, status: 401, durationMs: 20 }, 1).state).toBe('down')
    const authed = { ...CHECK, expectStatus: [401] }
    expect(evaluate(authed, { ok: true, status: 401, durationMs: 20 }, 1).state).toBe('up')
  })
})

describe('summarise', () => {
  const at = (n: number): number => 1000 + n
  const run = (state: CheckResult['state'], ms?: number, i = 0): CheckResult => ({
    at: at(i),
    state,
    durationMs: ms
  })

  it('says nothing at all rather than 0% with no history', () => {
    expect(summarise([])).toMatchObject({ state: 'unknown', uptimePct: null, runs: 0 })
  })

  /**
   * `slow` counts toward uptime. It is a warning about latency, not an outage —
   * folding it into downtime would make a slow service indistinguishable from
   * an unreachable one, which is the distinction the state exists to draw.
   */
  it('counts slow as up for the uptime figure', () => {
    const s = summarise([run('up', 10, 0), run('slow', 900, 1), run('down', undefined, 2)])
    expect(s.uptimePct).toBe(67)
  })

  /**
   * Median, not mean. One ten-second timeout among a hundred fast responses
   * drags a mean somewhere no request ever was, and the number a person reads
   * as "how fast is it" should be a number it actually was.
   */
  it('reports the median rather than the mean', () => {
    const s = summarise([run('up', 10, 0), run('up', 12, 1), run('up', 10_000, 2)])
    expect(s.medianMs).toBe(12)
  })

  it('reports the latest state and its reason', () => {
    const s = summarise([
      run('up', 10, 0),
      { at: at(1), state: 'down', error: 'no route to host' }
    ])
    expect(s.state).toBe('down')
    expect(s.lastError).toBe('no route to host')
  })
})

describe('appendResult', () => {
  /**
   * Bounded because this lives in memory: a check on a ten-second interval
   * would otherwise grow for as long as the app is open.
   */
  it('keeps the history bounded and drops the oldest', () => {
    let h: CheckResult[] = []
    for (let i = 0; i < MAX_HISTORY + 25; i++) {
      h = appendResult(h, { at: i, state: 'up', durationMs: 1 })
    }
    expect(h).toHaveLength(MAX_HISTORY)
    // The newest survived and the oldest went.
    expect(h[h.length - 1].at).toBe(MAX_HISTORY + 24)
    expect(h[0].at).toBe(25)
  })
})
