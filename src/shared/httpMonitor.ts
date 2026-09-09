// External service checks: what a check is, and what its result means.
//
// Pure. The transport is `httpRequest`, which already knows about proxies, SSH
// tunnels, VPN transports and TLS — this file only decides what "up" means and
// summarises a run of results, which is the part worth testing and the part
// that would otherwise be scattered through a component.

export interface HttpCheck {
  id: string
  workspaceId: string
  name: string
  url: string
  /** HEAD by default: a monitor should not download a page to learn it is up. */
  method: 'GET' | 'HEAD'
  /** Seconds between runs while the monitor is watching. */
  intervalSec: number
  timeoutMs: number
  /**
   * Statuses that count as up.
   *
   * A list rather than "2xx", because plenty of healthy endpoints answer 401
   * (an API behind auth), 403, or a 3xx that the checker is told not to follow.
   * Empty means "any status at all is up" — the check is then purely a
   * reachability test, which is a legitimate thing to want.
   */
  expectStatus: number[]
  /** Warn above this many ms while still counting as up. */
  slowMs?: number
  /** Skip TLS verification. Off unless explicitly set; the UI has to show it. */
  insecureTls?: boolean
  enabled: boolean
}

export type CheckState = 'up' | 'slow' | 'down' | 'unknown'

export interface CheckResult {
  at: number
  state: CheckState
  status?: number
  durationMs?: number
  /** Why it is down, in the words the transport used. */
  error?: string
}

export const DEFAULT_CHECK: Omit<HttpCheck, 'id' | 'workspaceId' | 'name' | 'url'> = {
  method: 'HEAD',
  intervalSec: 60,
  timeoutMs: 10_000,
  // 2xx and 3xx. Deliberately not "anything under 400": a 401 on an endpoint
  // that should be public is a real failure, and someone who wants it to count
  // as up can say so.
  expectStatus: [200, 201, 202, 204, 301, 302, 304, 307, 308],
  slowMs: 2_000,
  enabled: true
}

/** A URL this is willing to check. */
export function isCheckableUrl(url: string): boolean {
  try {
    const u = new URL(url.trim())
    // http and https only. `file:` would read the local disk, and the rest are
    // not things this transport speaks.
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Turn one transport result into a state.
 *
 * The distinction that matters is between "the service answered something we
 * did not expect" and "nothing answered at all": the first is a status to show,
 * the second is an error to quote. Reporting a refused connection as "status
 * unknown" loses the only useful part of it.
 */
export function evaluate(
  check: HttpCheck,
  outcome: { ok: true; status: number; durationMs: number } | { ok: false; error: string },
  at: number = Date.now()
): CheckResult {
  if (!outcome.ok) return { at, state: 'down', error: outcome.error }

  const { status, durationMs } = outcome
  const expected = check.expectStatus.length === 0 || check.expectStatus.includes(status)
  if (!expected) {
    return {
      at,
      state: 'down',
      status,
      durationMs,
      error: `Answered ${status}, which is not one of the statuses this check expects.`
    }
  }
  if (check.slowMs !== undefined && durationMs > check.slowMs) {
    return { at, state: 'slow', status, durationMs }
  }
  return { at, state: 'up', status, durationMs }
}

export interface CheckSummary {
  state: CheckState
  /** Percent of runs that were up or slow, 0-100. `null` with no history. */
  uptimePct: number | null
  /** Median, which is the honest middle when one timeout skews a mean. */
  medianMs: number | null
  lastAt: number | null
  lastError?: string
  runs: number
}

/**
 * Summarise a check's history.
 *
 * Median rather than mean, deliberately: a single 10-second timeout in a
 * hundred fast responses drags a mean somewhere no request ever was, and the
 * number people read as "how fast is it" should be a number it actually was.
 *
 * `slow` counts toward uptime. It is a warning about latency, not an outage,
 * and folding it into downtime would make a slow service indistinguishable
 * from an unreachable one.
 */
export function summarise(results: readonly CheckResult[]): CheckSummary {
  if (results.length === 0) {
    return { state: 'unknown', uptimePct: null, medianMs: null, lastAt: null, runs: 0 }
  }
  const last = results[results.length - 1]
  const good = results.filter((r) => r.state === 'up' || r.state === 'slow').length
  const times = results
    .map((r) => r.durationMs)
    .filter((n): n is number => typeof n === 'number')
    .sort((a, b) => a - b)

  return {
    state: last.state,
    uptimePct: Math.round((good / results.length) * 100),
    medianMs: times.length ? times[Math.floor(times.length / 2)] : null,
    lastAt: last.at,
    lastError: last.error,
    runs: results.length
  }
}

/**
 * How many results to keep per check.
 *
 * Bounded because this lives in memory and a check on a 10-second interval
 * would otherwise grow without limit for as long as the app is open. 200 runs
 * is a few hours at a minute apiece, which is the window someone actually looks
 * at; anything longer belongs in a store this feature does not have yet.
 */
export const MAX_HISTORY = 200

export function appendResult(
  history: readonly CheckResult[],
  next: CheckResult
): CheckResult[] {
  const out = [...history, next]
  return out.length > MAX_HISTORY ? out.slice(out.length - MAX_HISTORY) : out
}
