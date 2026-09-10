import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import type { StoredAlertEvent, StoredAlertRow } from '../src/shared/webhook'

/**
 * The pending period: a gauge has to STAY over the line before anything is
 * said about it.
 *
 * Reported as CPU alerts raising and clearing at 83–97% on a host that another
 * monitor had not seen above 7% in a day. The measurement behind those numbers
 * was separately broken and is fixed, but the alert path would have announced a
 * real two-second spike in exactly the same way — one sample over the line was
 * an incident, and a compile or a log rotation is not.
 *
 * Two properties are on trial here, and they are opposites, so both are needed
 * or a change that breaks one passes by breaking the other:
 *
 *   A transient says nothing.   A sustained breach still gets through.
 *
 * The third is the mirror: an all-clear also has to be earned, or one continuous
 * incident is written down as a column of Raised/Cleared pairs — which is what
 * the reported screen actually showed.
 */

const shown: { title: string; body: string }[] = []
const posted: Record<string, unknown>[] = []

type Alerts = typeof import('../src/renderer/src/store/alerts')
type AppStore = typeof import('../src/renderer/src/store/app')

let alerts: Alerts
let app: AppStore

beforeAll(async () => {
  ;(globalThis as { window?: unknown }).window = {
    opsmaxx: {
      getVersion: () => Promise.resolve('9.9.9'),
      notify: {
        show: (title: string, body: string) => {
          shown.push({ title, body })
        }
      },
      webhook: {
        notify: (p: Record<string, unknown>) => {
          posted.push(p)
        }
      },
      alerts: {
        record: (_e: StoredAlertEvent, _at?: number) => Promise.resolve(true),
        history: () => Promise.resolve([] as StoredAlertRow[])
      }
    }
  }
  alerts = await import('../src/renderer/src/store/alerts')
  app = await import('../src/renderer/src/store/app')
})

const raises = (): Record<string, unknown>[] => posted.filter((p) => p.event === 'raised')
const resolves = (): Record<string, unknown>[] => posted.filter((p) => p.event === 'resolved')
const chips = (): string[] =>
  alerts.useAlerts
    .getState()
    .list()
    .map((a) => a.kind)
    .sort()

const T0 = new Date('2026-01-01T00:00:00Z').getTime()
const SECOND = 1000

const cpu = (v: number | null): void =>
  alerts.checkResourceAlerts('s1', 'web-1', { cpu: v, ram: null, disk: null, inode: null, load: null })
const disk = (v: number): void =>
  alerts.checkResourceAlerts('s1', 'web-1', { cpu: null, ram: null, disk: v, inode: null, load: null })

beforeEach(() => {
  shown.length = 0
  posted.length = 0
  alerts.resetAlertsForTests()
  app.useApp.getState().setSettings({
    resourceAlertsEnabled: true,
    resourceAlertThreshold: 80,
    resourceAlertThresholds: {}
  })
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a transient spike', () => {
  it('says nothing, however many samples it spans', () => {
    // Thirty samples at the foreground two-second cadence: a minute of 99%,
    // which is a build, not an incident.
    for (let i = 0; i < 30; i++) {
      vi.setSystemTime(T0 + i * 2 * SECOND)
      cpu(99)
    }
    expect(raises()).toHaveLength(0)
    expect(shown).toHaveLength(0)
  })

  it('still shows the chip the whole time', () => {
    // Nothing is hidden. The chip states what is true NOW, and one reading
    // over the line is true now — the split between showing and announcing is
    // the same one hysteresis already makes in this file.
    cpu(99)
    expect(chips()).toEqual(['cpu'])
  })

  it('leaves nothing behind once it passes', () => {
    cpu(99)
    vi.setSystemTime(T0 + 4 * SECOND)
    cpu(10)
    expect(chips()).toEqual([])
    // No raise, so no all-clear either: a "resolved" for something nobody was
    // told about is a message about nothing.
    expect(resolves()).toHaveLength(0)
  })

  it('starts the clock again after dropping below the line', () => {
    // A saw-tooth that is over the line more often than not must not
    // accumulate its way to an alert: the run has to be UNBROKEN.
    for (let i = 0; i < 40; i++) {
      vi.setSystemTime(T0 + i * 30 * SECOND)
      cpu(i % 2 === 0 ? 99 : 10)
    }
    expect(raises()).toHaveLength(0)
  })
})

describe('a breach that holds', () => {
  it('is announced once the period has passed', () => {
    cpu(95)
    vi.setSystemTime(T0 + 2 * 60 * SECOND + SECOND)
    cpu(95)
    expect(raises()).toHaveLength(1)
    expect(raises()[0].kind).toBe('cpu')
  })

  it('says how long it held, rather than implying one reading', () => {
    cpu(95)
    vi.setSystemTime(T0 + 2 * 60 * SECOND + SECOND)
    cpu(95)
    expect(shown[0].body).toContain('for 2 min')
  })

  it('needs more than one reading, however long the gap', () => {
    // Time alone is not evidence. One reading, then the host goes away for an
    // hour, then one more, asserts an hour of sustained load nobody watched.
    cpu(95)
    vi.setSystemTime(T0 + 60 * 60 * SECOND)
    expect(raises()).toHaveLength(0)
  })

  it('does not count an unmeasurable reading as either', () => {
    // Null is "not measured". It must not break the run — that would be
    // reading a failed probe as a recovery — nor extend it.
    cpu(95)
    vi.setSystemTime(T0 + 60 * SECOND)
    cpu(null)
    vi.setSystemTime(T0 + 2 * 60 * SECOND + SECOND)
    cpu(95)
    expect(raises()).toHaveLength(1)
  })
})

describe('the all-clear', () => {
  const pegged = (): number => {
    cpu(95)
    const t = T0 + 2 * 60 * SECOND + SECOND
    vi.setSystemTime(t)
    cpu(95)
    return t
  }

  it('is not posted for a single quiet sample on a host still pegged', () => {
    const t = pegged()
    expect(raises()).toHaveLength(1)
    vi.setSystemTime(t + 2 * SECOND)
    cpu(10)
    expect(resolves()).toHaveLength(0)
  })

  it('does not let a dip earn a second raise either', () => {
    // The other half of the Raised/Cleared column: if the dip resolved, the
    // next reading would be a fresh crossing and announce immediately.
    const t = pegged()
    vi.setSystemTime(t + 2 * SECOND)
    cpu(10)
    vi.setSystemTime(t + 4 * SECOND)
    cpu(95)
    expect(raises()).toHaveLength(1)
    expect(resolves()).toHaveLength(0)
  })

  it('is posted once the recovery has held as long as the breach did', () => {
    const t = pegged()
    vi.setSystemTime(t + 2 * SECOND)
    cpu(10)
    vi.setSystemTime(t + 2 * 60 * SECOND + 3 * SECOND)
    cpu(10)
    expect(resolves()).toHaveLength(1)
    expect(chips()).toEqual([])
  })
})

describe('kinds with no pending period', () => {
  it('announces a full disk on the first reading', () => {
    // A filesystem does not empty itself between two samples, so there is no
    // transient to filter — and delaying a full-disk warning to prove it is
    // still full is a delay that buys nothing and costs the thing it warns
    // about.
    disk(95)
    expect(raises()).toHaveLength(1)
    expect(raises()[0].kind).toBe('disk')
  })

  it('resolves a disk on the first reading below the line', () => {
    disk(95)
    vi.setSystemTime(T0 + 2 * SECOND)
    disk(10)
    expect(resolves()).toHaveLength(1)
  })
})
