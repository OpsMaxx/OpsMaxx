import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ServiceCheckRunner, type ServiceCheckAlert } from '../src/main/services/serviceChecks'
import { DEFAULT_CHECK, type HttpCheck } from '../src/shared/httpMonitor'

/**
 * Checks that run whether or not anybody is looking at them.
 *
 * The scheduler used to live in the panel: a `setInterval` in a React
 * component with the history in `useState`. Navigating away unmounted it,
 * which stopped every check and discarded every result — so the feature
 * answered "is this up while I watch" rather than "has this been up", which is
 * the only question a monitor exists to answer.
 *
 * These tests are written against the runner in the main process, because that
 * is the thing that now has to be true when no window is showing.
 */

const check = (over: Partial<HttpCheck> = {}): HttpCheck => ({
  ...DEFAULT_CHECK,
  id: 'c1',
  workspaceId: 'w1',
  name: 'api',
  url: 'https://example.com/health',
  ...over
})

const up = { ok: true as const, status: 200, durationMs: 5 }
const down = { ok: false as const, error: 'connection refused' }

let runner: ServiceCheckRunner | null = null

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  runner?.dispose()
  runner = null
  vi.useRealTimers()
})

/** Let the probe promise settle as well as the timer fire. */
const settle = async (ms = 0): Promise<void> => {
  if (ms) await vi.advanceTimersByTimeAsync(ms)
  else await vi.advanceTimersByTimeAsync(1)
}

describe('running without a window', () => {
  it('checks as soon as it is configured, rather than after one interval', async () => {
    const emit = vi.fn()
    runner = new ServiceCheckRunner({ probe: async () => up, emit })
    runner.configure([check()])
    await settle()
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0][0].result.state).toBe('up')
  })

  it('keeps checking on the interval, with nothing subscribed', async () => {
    const emit = vi.fn()
    runner = new ServiceCheckRunner({ probe: async () => up, emit })
    runner.configure([check({ intervalSec: 10 })])
    await settle()
    await settle(30_000)
    // First run, then one per 10s. Exact count matters less than "it kept
    // going": the bug was that it stopped entirely.
    expect(emit.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  // The history is the thing the panel lost on every unmount.
  it('accumulates history the panel can ask for later', async () => {
    runner = new ServiceCheckRunner({ probe: async () => up, emit: vi.fn() })
    runner.configure([check({ intervalSec: 1 })])
    await settle()
    await settle(3_000)
    expect(runner.snapshot()['c1'].length).toBeGreaterThan(1)
  })

  it('does not run a disabled check', async () => {
    const emit = vi.fn()
    runner = new ServiceCheckRunner({ probe: async () => up, emit })
    runner.configure([check({ enabled: false })])
    await settle(5_000)
    expect(emit).not.toHaveBeenCalled()
  })

  /**
   * A slow endpoint must not be asked again while the first request is still
   * out, or a service that takes 30s to time out gets a new connection every
   * second until it has one per second forever.
   */
  it('never has two requests out for the same check', async () => {
    let open = 0
    let maxOpen = 0
    runner = new ServiceCheckRunner({
      probe: async () => {
        open += 1
        maxOpen = Math.max(maxOpen, open)
        await new Promise((r) => setTimeout(r, 5_000))
        open -= 1
        return up
      },
      emit: vi.fn()
    })
    runner.configure([check({ intervalSec: 1 })])
    await settle(4_000)
    expect(maxOpen).toBe(1)
  })
})

describe('what it refuses to check', () => {
  /**
   * Enforced here and not only in the renderer that sends the list. The
   * renderer's copy explains a refusal while somebody types; this one decides
   * what the main process opens a connection to, and a rule enforced only on
   * the side that is easiest to bypass is not a rule.
   */
  it('drops a URL the shared gate refuses', async () => {
    const emit = vi.fn()
    runner = new ServiceCheckRunner({ probe: async () => up, emit })
    runner.configure([
      check({ url: 'file:///etc/passwd' }),
      check({ id: 'c2', url: 'not a url' }),
      // The control. Without it this test would also pass if configure() had
      // simply stopped running anything at all.
      check({ id: 'ok', url: 'https://example.com/health' })
    ])
    await settle(3_000)
    const checked = emit.mock.calls.map((c) => c[0].checkId)
    expect(new Set(checked)).toEqual(new Set(['ok']))
  })
})

describe('alerting on transitions', () => {
  const collect = (): { alerts: ServiceCheckAlert[]; alert: (a: ServiceCheckAlert) => void } => {
    const alerts: ServiceCheckAlert[] = []
    return { alerts, alert: (a) => alerts.push(a) }
  }

  it('says nothing when a check is simply up', async () => {
    const { alerts, alert } = collect()
    runner = new ServiceCheckRunner({ probe: async () => up, emit: vi.fn(), alert })
    runner.configure([check({ intervalSec: 1 })])
    await settle(5_000)
    expect(alerts).toEqual([])
  })

  /**
   * The property that decides whether an alert channel is one people read or
   * one people mute: a service that is down stays down, and must not produce
   * an alert every interval for as long as it is broken.
   */
  it('raises once when it goes down, not once per failing run', async () => {
    const { alerts, alert } = collect()
    runner = new ServiceCheckRunner({ probe: async () => down, emit: vi.fn(), alert })
    runner.configure([check({ intervalSec: 1 })])
    await settle(10_000)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].state).toBe('down')
  })

  it('raises again when it recovers', async () => {
    const { alerts, alert } = collect()
    let healthy = false
    runner = new ServiceCheckRunner({
      probe: async () => (healthy ? up : down),
      emit: vi.fn(),
      alert
    })
    runner.configure([check({ intervalSec: 1 })])
    await settle(3_000)
    healthy = true
    await settle(3_000)
    expect(alerts.map((a) => a.state)).toEqual(['down', 'up'])
  })

  // A webhook is the easiest way to leak an estate's addressing out of this
  // app, and the check's name is a string the user chose.
  it('carries the name and never the URL', async () => {
    const { alerts, alert } = collect()
    runner = new ServiceCheckRunner({ probe: async () => down, emit: vi.fn(), alert })
    runner.configure([check({ name: 'billing api', url: 'https://secret.internal/health' })])
    await settle()
    expect(alerts[0].name).toBe('billing api')
    expect(JSON.stringify(alerts[0])).not.toContain('secret.internal')
  })
})

describe('reconfiguring', () => {
  it('forgets a check that was removed, so the maps stay bounded', async () => {
    runner = new ServiceCheckRunner({ probe: async () => up, emit: vi.fn() })
    runner.configure([check()])
    await settle()
    expect(Object.keys(runner.snapshot())).toEqual(['c1'])
    runner.configure([])
    expect(runner.snapshot()).toEqual({})
  })

  // dispose() has to actually stop the loop, or quitting leaves a timer
  // firing against a history store that is closing.
  it('stops checking once disposed', async () => {
    const emit = vi.fn()
    runner = new ServiceCheckRunner({ probe: async () => up, emit })
    runner.configure([check({ intervalSec: 1 })])
    await settle()
    const seen = emit.mock.calls.length
    runner.dispose()
    await settle(5_000)
    expect(emit.mock.calls.length).toBe(seen)
  })
})
