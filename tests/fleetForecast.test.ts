import { describe, it, expect } from 'vitest'

import {
  buildFleetForecast,
  fleetForecastRow,
  FORECAST_REFUSAL_WORDS,
  forecastHeadline,
  type FleetForecastInput
} from '../src/shared/fleetForecast'
import { CAPACITY_METRICS, type Forecast, type RefusalReason } from '../src/shared/capacity'

// Item 47's fleet expansion forecast. The roadmap row named the design in four
// words -- refusal-first is the feature -- and every test here is about that:
// on a real estate most hosts produce no forecast, and a ranking that drops
// them makes "nothing is filling up" and "eleven hosts could not be forecast"
// render identically.

const T0 = Date.UTC(2026, 5, 1)
const DAY = 86_400_000

const made = (over: Partial<Extract<Forecast, { ok: true }>> = {}): Forecast => ({
  ok: true,
  at: T0 + 11 * DAY,
  days: 11,
  threshold: 90,
  perDay: 1.2,
  r2: 0.95,
  confidence: 'high',
  from: T0 - 6 * 3_600_000,
  to: T0,
  points: 40,
  res: 'full',
  ...over
})

const refused = (reason: RefusalReason): Forecast => ({
  ok: false,
  reason,
  from: T0 - 3_600_000,
  to: T0,
  points: 4
})

const input = (over: Partial<FleetForecastInput> = {}): FleetForecastInput => ({
  hostId: 'a',
  hostName: 'web-1',
  metric: 'diskPct',
  forecast: made(),
  ...over
})

describe('a refusal is a row, not a gap', () => {
  it('keeps a host that could not be forecast in the list', () => {
    const f = buildFleetForecast([input({ forecast: refused('too-few-points') })])
    expect(f.rows).toHaveLength(1)
    expect(f.rows[0].band).toBe('refused')
  })

  it('says which refusal it was, in words rather than the enum', () => {
    // Each one is a different thing to DO about it, which is why they are not
    // collapsed into "not enough data".
    const r = fleetForecastRow(input({ forecast: refused('stale') }))
    expect(r.because).toContain('stopped reporting')
    expect(r.because).not.toContain('stale')
  })

  it('has a sentence for every refusal the forecaster can produce', () => {
    // A reason added to `capacity.ts` without a sentence here would render as
    // `undefined` in a status bar.
    for (const reason of Object.keys(FORECAST_REFUSAL_WORDS) as RefusalReason[]) {
      expect(FORECAST_REFUSAL_WORDS[reason].length).toBeGreaterThan(0)
    }
    const r = fleetForecastRow(input({ forecast: refused('noisy') }))
    expect(r.because).not.toContain('undefined')
  })

  it('names every metric it can rank', () => {
    for (const metric of CAPACITY_METRICS) {
      expect(fleetForecastRow(input({ metric })).because).not.toContain('undefined')
    }
  })
})

describe('the ranking puts trouble now above trouble later', () => {
  // `already-past` produces no crossing time at all, so a list sorted purely by
  // date puts the host that is ALREADY OVER below one that fills in eighty
  // days.
  it('puts an over-threshold host first, ahead of every crossing', () => {
    const f = buildFleetForecast([
      input({ hostId: 'a', hostName: 'soon', forecast: made({ at: T0 + DAY, days: 1 }) }),
      input({ hostId: 'b', hostName: 'over', forecast: refused('already-past') })
    ])
    expect(f.rows.map((r) => r.hostName)).toEqual(['over', 'soon'])
    expect(f.rows[0].band).toBe('over')
  })

  it('keeps the reason on the promoted row', () => {
    const r = fleetForecastRow(input({ forecast: refused('already-past') }))
    expect(r.reason).toBe('already-past')
    expect(r.because).toContain('already at or over')
  })

  it('sorts real crossings soonest first', () => {
    const f = buildFleetForecast([
      input({ hostId: 'a', hostName: 'later', forecast: made({ at: T0 + 40 * DAY, days: 40 }) }),
      input({ hostId: 'b', hostName: 'sooner', forecast: made({ at: T0 + 3 * DAY, days: 3 }) })
    ])
    expect(f.rows.map((r) => r.hostName)).toEqual(['sooner', 'later'])
    expect(f.soonest?.hostName).toBe('sooner')
  })

  it('puts every refusal below every crossing', () => {
    const f = buildFleetForecast([
      input({ hostId: 'a', hostName: 'refused-1', forecast: refused('flat') }),
      input({ hostId: 'b', hostName: 'crossing-1', forecast: made({ days: 80 }) })
    ])
    expect(f.rows.map((r) => r.band)).toEqual(['crossing', 'refused'])
  })

  it('does not call a refusal the soonest crossing', () => {
    const f = buildFleetForecast([input({ forecast: refused('flat') })])
    expect(f.soonest).toBeNull()
  })

  // A list that reshuffles between refreshes for a reason nobody can see is a
  // list people stop trusting.
  it('orders the refusals stably', () => {
    const rows = [
      input({ hostId: 'a', hostName: 'zeta', forecast: refused('flat') }),
      input({ hostId: 'b', hostName: 'alpha', forecast: refused('flat') }),
      input({ hostId: 'c', hostName: 'mid', forecast: refused('falling') })
    ]
    const once = buildFleetForecast(rows).rows.map((r) => r.hostName)
    const again = buildFleetForecast([...rows].reverse()).rows.map((r) => r.hostName)
    expect(once).toEqual(again)
  })
})

describe('the one line always carries the denominator', () => {
  // A status bar reading "nothing fills within 90 days" on an estate where
  // eleven of fourteen could not be forecast is the most reassuring thing this
  // app could print and one of the least true.
  it('says how many of how many could be forecast', () => {
    const f = buildFleetForecast([
      input({ hostId: 'a', hostName: 'a-1', forecast: made({ days: 5 }) }),
      input({ hostId: 'b', hostName: 'b-1', forecast: refused('too-few-points') }),
      input({ hostId: 'c', hostName: 'c-1', forecast: refused('stale') })
    ])
    expect(f.headline).toContain('1 of 3 could be forecast')
    expect(f.headline).toContain('a-1 in 5 day(s)')
  })

  it('leads with the over-threshold count when there is one', () => {
    const f = buildFleetForecast([
      input({ hostId: 'a', hostName: 'a-1', forecast: refused('already-past') }),
      input({ hostId: 'b', hostName: 'b-1', forecast: made({ days: 5 }) })
    ])
    expect(f.headline).toMatch(/^1 already over threshold/)
    expect(f.headline).toContain('2 of 2 could be forecast')
  })

  it('still names the denominator when nothing crosses', () => {
    const f = buildFleetForecast([input({ forecast: refused('flat') })])
    expect(f.headline).toContain('Nothing is forecast to cross')
    expect(f.headline).toContain('0 of 1 could be forecast')
  })

  it('says nothing has been sampled rather than that nothing is wrong', () => {
    // An empty estate and a healthy one must not read the same.
    const f = buildFleetForecast([])
    expect(f.headline).toContain('has been sampled for long enough')
    expect(f.headline).not.toContain('Nothing is forecast to cross')
  })

  it('is derivable without the rows, for a status bar that has only counts', () => {
    expect(forecastHeadline({ over: 0, crossing: 0, refused: 4 }, null)).toContain('0 of 4')
  })
})

describe('a crossing states the window it was drawn from', () => {
  // "Fills in 11 days" is not an honest sentence. "Fills in 11 days, from 6
  // hours of data" is, and the difference is entirely in the window.
  it('names the hours behind the number', () => {
    const r = fleetForecastRow(input({ forecast: made() }))
    expect(r.because).toContain('from 6h of data')
    expect(r.because).toContain('high confidence')
  })

  it('carries the confidence out for the caller to colour by', () => {
    expect(fleetForecastRow(input({ forecast: made({ confidence: 'low' }) })).confidence).toBe('low')
  })

  it('does not recompute the days against a clock of its own', () => {
    // `days` is relative to the `now` the forecast was computed with. A second
    // clock here would silently disagree with the per-host panel showing the
    // same number.
    const r = fleetForecastRow(input({ forecast: made({ days: 11, at: T0 + 99 * DAY }) }))
    expect(r.days).toBe(11)
  })
})
