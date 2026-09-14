import { describe, it, expect } from 'vitest'

import {
  BYTES_FLAT_RISE_SHARE,
  BYTES_MAX_STALE_MS,
  BYTES_MIN_POINTS,
  BYTES_MIN_WINDOW_MS,
  BYTES_REFUSAL_WORDS,
  bytesHeadline,
  forecastBytes,
  formatBytes,
  type BytesPoint
} from '../src/shared/bytesForecast'
import { FORECAST_FLAT_RISE_PCT } from '../src/shared/capacity'

// Item 47's database growth series.
//
// `capacity.ts` is percentages only and says so: its whole refusal policy rests
// on one flat-rise number working for cpu, memory and disk because all three
// are 0-100. In bytes that number means nothing, and there is no 90% either --
// so this is a second forecaster with a relative flat rule and an optional
// ceiling, not a tenth metric passed to the first one.

const T0 = Date.UTC(2026, 5, 1)
const DAY = 86_400_000
const GB = 1024 ** 3

/** `n` readings over `days`, starting at `start` bytes and growing `perDay`. */
const series = (
  n: number,
  days: number,
  start: number,
  perDay: number,
  jitter: (i: number) => number = () => 0
): BytesPoint[] =>
  Array.from({ length: n }, (_, i) => {
    const t = T0 - days * DAY + (i * days * DAY) / (n - 1)
    return { ts: t, v: start + perDay * ((t - (T0 - days * DAY)) / DAY) + jitter(i) }
  })

describe('the flat rule is relative, because bytes have no scale', () => {
  it('is a different kind of number from the percentage one', () => {
    // Stated rather than implied: the two files are not interchangeable.
    expect(BYTES_FLAT_RISE_SHARE).toBeLessThan(1)
    expect(FORECAST_FLAT_RISE_PCT).toBeGreaterThan(BYTES_FLAT_RISE_SHARE)
  })

  it('calls a 10 GB database growing 50 MB a week flat', () => {
    const r = forecastBytes(series(40, 7, 10 * GB, (50 * 1024 ** 2) / 7), null, T0)
    expect(r.refusal).toBe('flat')
    expect(r.perDay).toBeNull()
  })

  it('does not call a 10 MB database growing 50 MB a week flat', () => {
    const r = forecastBytes(series(40, 7, 10 * 1024 ** 2, (50 * 1024 ** 2) / 7), null, T0)
    expect(r.refusal).toBe('no-ceiling')
    expect(r.perDay).toBeGreaterThan(0)
  })

  // A database that grew all week and was vacuumed back this morning has still
  // grown all week. The reference is the run's FIRST reading, which does not
  // move -- for a monotonic series the start and the end give the same answer,
  // so this pins the case where they could differ rather than a difference
  // that shows up every day.
  it('still sees a week of growth through a vacuum at the end', () => {
    const grew = series(20, 7, 1 * GB, 0.5 * GB)
    const shrunk = [...grew, { ts: T0 + 1, v: 1 * GB }]
    expect(forecastBytes(shrunk, null, T0 + 2).refusal).not.toBe('flat')
  })

  it('says shrinking rather than flat when it is going down', () => {
    expect(forecastBytes(series(20, 7, 10 * GB, -1 * GB), null, T0).refusal).toBe('shrinking')
  })
})

describe('there is no 90% for bytes', () => {
  // THE design decision. "This database has grown 380 MB a day for six days" is
  // actionable, and refusing to say it because nobody set a limit withholds the
  // useful half.
  it('keeps the rate when no ceiling was given, and refuses only the date', () => {
    const r = forecastBytes(series(40, 7, 1 * GB, 0.2 * GB), null, T0)
    expect(r.refusal).toBe('no-ceiling')
    expect(r.crossesAt).toBeNull()
    expect(r.perDay).toBeGreaterThan(0)
    expect(r.confidence).not.toBeNull()
  })

  it('gives a date once there is one', () => {
    const r = forecastBytes(series(40, 7, 1 * GB, 0.2 * GB), 3 * GB, T0)
    expect(r.refusal).toBeNull()
    expect(r.crossesAt).toBeGreaterThan(T0)
    expect(r.days).toBeGreaterThan(0)
  })

  it('says already-past rather than predicting a crossing behind us', () => {
    const r = forecastBytes(series(40, 7, 1 * GB, 0.2 * GB), 1.5 * GB, T0)
    expect(r.refusal).toBe('already-past')
    // The rate survives: it is still true, and still what somebody acts on.
    expect(r.perDay).toBeGreaterThan(0)
  })

  it('refuses a crossing beyond the horizon and keeps the rate', () => {
    // Real growth -- 51 MiB a day, well past the flat floor -- against a
    // ceiling so far off that "the rate holds" is not a claim worth making.
    const r = forecastBytes(series(40, 7, 1 * GB, 0.05 * GB), 900 * GB, T0)
    expect(r.refusal).toBe('beyond-horizon')
    expect(r.perDay).toBeGreaterThan(0)
  })
})

describe('the refusals a gappy series produces', () => {
  // A database read is on demand, not on a sweep. The roadmap row said the
  // series would be gappy and that the refusals should handle it honestly.
  it('refuses a series nobody has added to in a fortnight', () => {
    const old = series(40, 7, 1 * GB, 0.2 * GB)
    expect(forecastBytes(old, null, T0 + BYTES_MAX_STALE_MS + DAY).refusal).toBe('stale')
  })

  it('refuses too few readings', () => {
    expect(forecastBytes(series(BYTES_MIN_POINTS - 1, 7, 1 * GB, 0.2 * GB), null, T0).refusal).toBe(
      'too-few-points'
    )
  })

  it('refuses readings that cover too short a stretch', () => {
    const hours = BYTES_MIN_WINDOW_MS / 3_600_000 / 2
    const tight = series(20, hours / 24, 1 * GB, 0.2 * GB)
    expect(forecastBytes(tight, null, T0).refusal).toBe('window-too-short')
  })

  it('refuses nothing at all with its own word', () => {
    const r = forecastBytes([], null, T0)
    expect(r.refusal).toBe('no-data')
    expect(r.latest).toBeNull()
  })

  it('refuses a scatter no line describes', () => {
    const noisy = series(40, 7, 1 * GB, 0.2 * GB, (i) => (i % 2 === 0 ? 4 * GB : -4 * GB))
    expect(forecastBytes(noisy, null, T0).refusal).toBe('noisy')
  })

  // Somebody loaded a dump. That is not a growth rate.
  it('refuses one jump wearing a trend’s clothes', () => {
    const jump = series(40, 7, 1 * GB, 0).map((p, i) => (i > 30 ? { ...p, v: p.v + 5 * GB } : p))
    expect(forecastBytes(jump, null, T0).refusal).toBe('step-change')
  })

  it('sorts readings that arrive out of order', () => {
    const shuffled = [...series(40, 7, 1 * GB, 0.2 * GB)].reverse()
    expect(forecastBytes(shuffled, null, T0).refusal).toBe('no-ceiling')
  })

  it('has a sentence for every refusal it can produce', () => {
    for (const w of Object.values(BYTES_REFUSAL_WORDS)) expect(w.length).toBeGreaterThan(10)
  })
})

describe('the sentence', () => {
  it('leads with the rate, which is true whether or not there is a ceiling', () => {
    const r = forecastBytes(series(40, 7, 1 * GB, 0.2 * GB), null, T0)
    const s = bytesHeadline('orders', r)
    expect(s).toMatch(/^orders is growing/)
    expect(s).toContain('No crossing date: nothing has said how big is too big')
  })

  it('states the window the rate came from', () => {
    const s = bytesHeadline('orders', forecastBytes(series(40, 7, 1 * GB, 0.2 * GB), null, T0))
    expect(s).toContain('from 7 days of readings')
  })

  it('adds the crossing when there is one', () => {
    const s = bytesHeadline('orders', forecastBytes(series(40, 7, 1 * GB, 0.2 * GB), 3 * GB, T0))
    expect(s).toContain('reaches its ceiling in')
  })

  it('names the refusal when there is no rate at all', () => {
    const s = bytesHeadline('orders', forecastBytes([], null, T0))
    expect(s).toContain('nothing has been recorded for it')
  })

  it('says the current size, which is the one fact always available', () => {
    const s = bytesHeadline('orders', forecastBytes(series(40, 7, 1 * GB, 0.2 * GB), null, T0))
    expect(s).toContain('It is')
    expect(s).toContain('GiB now')
  })
})

describe('bytes as an operator reads them', () => {
  it('uses binary units, which is what every database tool shows', () => {
    expect(formatBytes(1024)).toBe('1.0 KiB')
    expect(formatBytes(1024 ** 3)).toBe('1.0 GiB')
    expect(formatBytes(512)).toBe('512 B')
  })

  it('drops the decimal once the number is big enough not to need it', () => {
    expect(formatBytes(200 * 1024 ** 2)).toBe('200 MiB')
  })

  it('handles a negative rate without printing nonsense', () => {
    expect(formatBytes(-2 * 1024 ** 2)).toBe('-2.0 MiB')
  })
})

// ---------------------------------------------------------------------------
// The policy parameter.
// ---------------------------------------------------------------------------
//
// Added so a disk could use this arithmetic under a different regime. The thing
// worth pinning hardest is the half that did NOT change: a caller that passes
// no policy must behave exactly as it did, because the database growth series
// still depends on it and nobody asked for that to be re-tuned.

describe('a caller whose series is not a database', () => {
  const HOUR = 3_600_000
  const DAY = 86_400_000
  const T0 = 1_700_000_000_000
  const MB = 1024 * 1024

  /** Steady growth, hourly, for `days` days, ending at T0. */
  const growing = (days: number, perDay: number, start = 1000 * MB): BytesPoint[] =>
    Array.from({ length: days * 24 }, (_, i) => ({
      ts: T0 - (days * 24 - 1 - i) * HOUR,
      v: start + (perDay * i) / 24
    }))

  it('behaves identically when given no policy at all', () => {
    const pts = growing(6, 200 * MB)
    expect(forecastBytes(pts, null, T0)).toEqual(forecastBytes(pts, null, T0, {}))
  })

  it('keeps the database staleness horizon unless told otherwise', () => {
    // Two days old is nothing for a series written when somebody opens a panel.
    const stale = growing(6, 200 * MB).map((p) => ({ ...p, ts: p.ts - 2 * DAY }))
    expect(forecastBytes(stale, null, T0).refusal).not.toBe('stale')
    // The disk regime is six hours, and says so.
    expect(forecastBytes(stale, null, T0, { maxStaleMs: 6 * HOUR }).refusal).toBe('stale')
  })

  it('takes an absolute flat floor in place of the relative one', () => {
    // 2% of a 1000 MB start is 20 MB, so 60 MB of total growth is a trend by
    // the database rule. An absolute floor of 100 MB calls the same series flat.
    const slow = growing(6, 10 * MB)
    expect(forecastBytes(slow, null, T0).refusal).toBe('no-ceiling')
    expect(forecastBytes(slow, null, T0, { flatRiseBytes: 100 * MB }).refusal).toBe('flat')
  })

  it('does not count growth across a silence as a step, once bounded', () => {
    // THE TRAP, AND THE REASON THE BOUND EXISTS. Two days of readings, ten days
    // during which the laptop was shut, then two more days. Nothing unusual
    // happened: the thing grew at exactly 200 MB a day throughout.
    //
    // Unbounded, the single pair of readings spanning those ten days carries
    // ten days of perfectly ordinary growth -- most of the whole rise -- and is
    // refused as "something was added at once". Every gappy series refuses that
    // way, which is why fitting across gaps without this bound would have
    // changed nothing but the wording of the refusal.
    const perDay = 200 * MB
    const before = growing(2, perDay).map((p) => ({ ...p, ts: p.ts - 12 * DAY }))
    const after = growing(2, perDay, 1000 * MB + perDay * 12)
    const series = [...before, ...after]
    expect(forecastBytes(series, null, T0).refusal).toBe('step-change')
    // Bounded, it is what it is: a rate.
    const bounded = forecastBytes(series, null, T0, { maxJumpSpanMs: 2 * HOUR })
    expect(bounded.refusal).toBe('no-ceiling')
    expect(Math.abs((bounded.perDay ?? 0) - perDay) / perDay).toBeLessThan(0.05)
  })
})
