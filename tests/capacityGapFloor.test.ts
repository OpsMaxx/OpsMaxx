import { describe, it, expect } from 'vitest'
import { runs, forecast, GAP_MIN_MS, FORECAST_MIN_POINTS } from '../src/shared/capacity'
import type { TrendPoint } from '../src/shared/capacity'

/**
 * What counts as a break in the data.
 *
 * Reported as capacity trends never producing a forecast: a host with thirty
 * samples across a day sat at "Only 8 samples since the last break in the
 * data; 12 are needed", with breaks of eleven hours, forty-eight minutes and
 * EIGHT MINUTES listed above it.
 *
 * The eight-minute one is the bug. A run was severed whenever the silence
 * exceeded three times the typical spacing, and the sampler's default spacing
 * is two minutes — so six minutes of silence started a new series. A laptop
 * asleep, a skipped sweep, a reconfigure: each severed a series that had not
 * gone anywhere, and the fit then ran on whatever followed the most recent
 * severance.
 *
 * What must NOT change is the case the rule exists for: a host that was
 * genuinely away, whose before and after describe different machines.
 */

const MIN = 60_000
const HOUR = 60 * MIN
const T0 = new Date('2026-03-01T00:00:00Z').getTime()

const at = (ts: number, v: number, res: 'full' | 'hourly' = 'full'): TrendPoint => ({ ts, v, res })

/** `n` samples two minutes apart, climbing steadily, starting at `from`. */
const burst = (from: number, n: number, v0: number, step = 0.05): TrendPoint[] =>
  Array.from({ length: n }, (_, i) => at(from + i * 2 * MIN, v0 + i * step))

describe('short silences no longer sever a series', () => {
  it('keeps a run across the eight-minute gap from the report', () => {
    const a = burst(T0, 10, 40)
    const b = burst(T0 + 10 * 2 * MIN + 8 * MIN, 10, 41)
    expect(runs([...a, ...b])).toHaveLength(1)
  })

  it('keeps a run across a forty-eight minute gap', () => {
    const a = burst(T0, 10, 40)
    const b = burst(T0 + 10 * 2 * MIN + 48 * MIN, 10, 41)
    expect(runs([...a, ...b])).toHaveLength(1)
  })

  it('still severs one across a silence longer than the floor', () => {
    const a = burst(T0, 10, 40)
    const b = burst(T0 + 10 * 2 * MIN + GAP_MIN_MS + MIN, 10, 41)
    expect(runs([...a, ...b])).toHaveLength(2)
  })

  it('leaves hourly points exactly as they were', () => {
    // Three times an hour already exceeds the floor, so the coarser tier — and
    // every outage case expressed in it — is untouched.
    const a = Array.from({ length: 5 }, (_, i) => at(T0 + i * HOUR, 40 + i, 'hourly'))
    const b = Array.from({ length: 5 }, (_, i) => at(T0 + 8 * HOUR + i * HOUR, 60 + i, 'hourly'))
    expect(runs([...a, ...b])).toHaveLength(2)
  })
})

describe('the reported host, reconstructed', () => {
  it('forecasts from samples a few short silences used to sever', () => {
    // Thirty samples over eleven hours in three bursts, split by an
    // eight-minute and a forty-eight-minute silence — the shape the panel
    // reported as "only 8 samples". One run now, and enough of one to fit.
    const one = burst(T0, 10, 40, 0.4)
    const twoFrom = one[9].ts + 8 * MIN
    const two = burst(twoFrom, 10, 45, 0.4)
    const threeFrom = two[9].ts + 48 * MIN
    const three = burst(threeFrom, 10, 52, 0.4)
    const points = [...one, ...two, ...three]

    expect(runs(points)).toHaveLength(1)
    expect(points.length).toBeGreaterThanOrEqual(FORECAST_MIN_POINTS)

    // Long enough a window to have a rate, so it produces one rather than
    // refusing for want of contiguity.
    const spread = points.map((p, i) => at(T0 + i * 40 * MIN, 40 + i * 0.8))
    const f = forecast(spread, 90, spread[spread.length - 1].ts)
    expect(f.ok).toBe(true)
  })
})

describe('what the floor must not do', () => {
  it('never lets a fit run across a real outage', () => {
    // Two days unreachable. The floor is two hours; this is twenty-four times
    // it, and the series is still two runs.
    const before = Array.from({ length: 20 }, (_, i) => at(T0 + i * HOUR, 40 + i * 0.4, 'hourly'))
    const after = Array.from({ length: 13 }, (_, i) =>
      at(T0 + 20 * HOUR + 48 * HOUR + i * HOUR, 80, 'hourly')
    )
    expect(runs([...before, ...after])).toHaveLength(2)
  })
})
