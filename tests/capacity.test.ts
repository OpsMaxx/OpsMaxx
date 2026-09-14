import { describe, it, expect } from 'vitest'
import { forecastBytes } from '../src/shared/bytesForecast'
import {
  CAPACITY_METRICS,
  CAPACITY_THRESHOLDS,
  FORECAST_FLAT_RISE_PCT,
  FORECAST_MIN_POINTS,
  diskBytesPolicy,
  diskCeilingBytes,
  buildCapacityReport,
  downsample,
  forecast,
  resolutionBoundary,
  runs,
  segments,
  type CapacityMetric,
  type TrendPoint
} from '../src/shared/capacity'
import { METRICS, type Metric, type SeriesPoint } from '../src/main/services/history'

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

// A fixed instant, so every expected number below is a literal a reader can
// check by hand rather than something recomputed from Date.now().
const T0 = 1_700_000_000_000

/** `count` points ending at `end`, spaced `step` apart, value from the index. */
function points(
  end: number,
  count: number,
  step: number,
  res: 'full' | 'hourly',
  value: (i: number) => number
): TrendPoint[] {
  const start = end - (count - 1) * step
  return Array.from({ length: count }, (_, i) => ({ ts: start + i * step, v: value(i), res }))
}

describe('the metrics a capacity question is asked about', () => {
  it('names the item A metrics and nothing invented', () => {
    // `inodePct` joined them in item 47: it was measured every sweep and never
    // stored, so a host running out of inodes had a number on screen, no series
    // behind it and no forecast in front of it.
    expect(CAPACITY_METRICS).toEqual(['cpu', 'memPct', 'diskPct', 'inodePct'])
    // Every one of them is a real series the sampler writes. A name that
    // drifted from METRICS would read as an empty chart forever, with nothing
    // on screen to say the metric does not exist.
    for (const m of CAPACITY_METRICS) expect(METRICS).toContain(m)
    // And the compile-time half of the same statement, in both directions:
    // main hands the store real SeriesPoints to this module's TrendPoint, and
    // asks the store for these names as Metrics.
    const asMetrics: readonly Metric[] = CAPACITY_METRICS
    expect(asMetrics.length).toBe(4)
    const fromStore: SeriesPoint = { ts: 1, v: 2, res: 'hourly', min: 1, max: 3, n: 4 }
    const asTrendPoint: TrendPoint = fromStore
    expect(asTrendPoint.n).toBe(4)
  })

  it('forecasts a disk and a memory, and refuses to forecast a cpu', () => {
    // A CPU at 100% is busy, not full. Offering "your cpu fills in 4 days"
    // would be the feature saying something it cannot mean.
    expect(CAPACITY_THRESHOLDS.diskPct).toBe(90)
    expect(CAPACITY_THRESHOLDS.memPct).toBe(90)
    expect(CAPACITY_THRESHOLDS.cpu).toBeUndefined()
  })
})

describe('a step change is not a trend', () => {
  it('refuses a disk that jumped once and has been flat since', () => {
    // Three days at 50%, somebody untars a release, three days at 70%. A least
    // squares fit through that has a slope of about 3 points a day and will
    // happily say the disk fills next week. Nothing is filling: it is a step.
    const flatThenStep = points(T0, 145, HOUR, 'hourly', (i) => (i < 72 ? 50 : 70))
    const f = forecast(flatThenStep, 90, T0)
    expect(f.ok).toBe(false)
    expect(f.ok === false && f.reason).toBe('step-change')
    // And it says which window it looked at, so the refusal is checkable.
    expect(f.from).toBe(T0 - 144 * HOUR)
    expect(f.to).toBe(T0)
    expect(f.points).toBe(145)
  })

  it('still catches a step that lands mid-hour and is smeared over two buckets', () => {
    // The hourly tier averages within the hour, so an instantaneous jump at
    // 03:30 arrives as two half-steps rather than one. A rule that only looked
    // at single consecutive differences would let this through.
    const smeared = points(T0, 145, HOUR, 'hourly', (i) => (i < 72 ? 50 : i === 72 ? 60 : 70))
    const f = forecast(smeared, 90, T0)
    expect(f.ok === false && f.reason).toBe('step-change')
  })
})

describe('a gap is not a flat line', () => {
  it('splits the series where the server stopped answering', () => {
    const before = points(T0 - 2 * DAY - 12 * HOUR, 73, HOUR, 'hourly', (i) => 40 + i * 0.4)
    const after = points(T0, 13, HOUR, 'hourly', () => 80)
    const both = [...before, ...after]
    expect(runs(both).map((r) => r.length)).toEqual([73, 13])
  })

  it('fits a LEVEL across the silence, because a disk fills while nobody watches', () => {
    // Three days climbing 40 -> 68.8, then two days unreachable, then half a
    // day at 80.
    //
    // THIS TEST USED TO ASSERT THE OPPOSITE, and the comment explaining why was
    // the clearest statement of the bug: it called the rise across the outage
    // "an artefact of the host being absent, not a measurement". Read the
    // numbers. The disk was at 68.8 when the samples stopped and at 80 when
    // they resumed; it really did gain eleven points, at 5.6 a day, which is
    // the same climb as the three days before it. Nothing was invented by the
    // absence. What the absence costs is knowledge of the RATE inside it, not
    // of the change across it -- and that is what the coverage gate and the
    // bounded step rule are for.
    //
    // The old behaviour fitted the twelve hours after the outage, found them
    // flat, and reported 'flat' about a disk that had climbed forty points in
    // five days. That is the failure this whole file was rewritten for.
    const before = points(T0 - 2 * DAY - 12 * HOUR, 73, HOUR, 'hourly', (i) => 40 + i * 0.4)
    const after = points(T0, 13, HOUR, 'hourly', () => 80)
    const f = forecast([...before, ...after], 90, T0)
    expect(f.ok).toBe(true)
    // The whole series, not the last run: 86 points over five and a half days.
    expect(f.from).toBe(T0 - 5 * DAY - 12 * HOUR)
    expect(f.to).toBe(T0)
    expect(f.points).toBe(86)
    // And the sentence carries how much of that window was actually looked at,
    // because "from 5.5 days of data" would otherwise read as 5.5 days of
    // watching, which it is not.
    expect(f.ok === true && f.coverage).toEqual({
      parts: 10,
      occupied: 7,
      longestGapMs: 2 * DAY
    })
  })

  it('does not call ordinary growth across a gap a step change', () => {
    // THE TRAP THAT WOULD HAVE MADE THE WHOLE CHANGE POINTLESS. Once a level is
    // fitted across gaps, everything that accumulated while the laptop was shut
    // arrives as one interval. Unbounded, the step rule sees that single pair
    // carrying most of the fitted rise and refuses -- so every host would have
    // gone on refusing, with 'step-change' printed where 'flat' used to be.
    //
    // A steady half a point an hour, sampled for six hours a day for six days.
    // Every overnight gap carries nine points of perfectly ordinary growth.
    const days: TrendPoint[] = []
    for (let d = 5; d >= 0; d--) {
      const end = T0 - d * DAY
      for (const p of points(end, 7, HOUR, 'hourly', (i) => 40 + (5 - d) * 6 + i * 0.5)) {
        days.push(p)
      }
    }
    const f = forecast(days, 90, T0)
    expect(f.ok === false && f.reason).not.toBe('step-change')
    expect(f.ok).toBe(true)
  })

  it('still refuses a step BETWEEN CONSECUTIVE SAMPLES, which is an event', () => {
    // The bound is on time, not on gaps as such: minutes apart, a jump is still
    // somebody untarring a release, and that is what the rule was written for.
    const flat = points(T0 - 12 * HOUR, 73, 10 * MIN, 'full', () => 50)
    const jumped = points(T0, 73, 10 * MIN, 'full', () => 68)
    const f = forecast([...flat, ...jumped], 90, T0)
    expect(f.ok === false && f.reason).toBe('step-change')
  })

  it('refuses a clump that cannot stand on its own, and says so as sparse', () => {
    // A month of history, all of it in one short burst an hour ago plus a
    // handful of readings thirty days back.
    //
    // NOTE WHAT DOES **NOT** HAPPEN HERE, because it is the more common case
    // and it is deliberately not a refusal: when the recent burst is itself
    // long enough to fit -- six hours or more -- it is fitted, and the answer
    // states that six-hour window. That is honest and it is what the old code
    // did. 'sparse' is the narrower case where neither view works: the long one
    // is two clumps with nothing in between, and the recent one is too short to
    // stand alone. Refusing then is right, and saying "only 8 samples" about a
    // host with three hundred -- which is what this used to say -- was not.
    const clump = points(T0, 300, MIN, 'full', (i) => 50 + i * 0.001)
    const ancient = points(T0 - 30 * DAY, 20, 2 * MIN, 'full', () => 49)
    const f = forecast([...ancient, ...clump], 90, T0)
    expect(f.ok).toBe(false)
    expect(f.ok === false && f.reason).toBe('sparse')
    // The refusal is about the WHOLE window, not about the clump -- reporting
    // five hours here would hide the very thing being refused.
    expect(f.from).toBe(T0 - 30 * DAY - 38 * MIN)
    expect(f.points).toBe(320)
    expect(f.ok === false && f.coverage?.occupied).toBeLessThan(5)
  })

  it('keeps last-run-only for a RATE, where the silence really is unknowable', () => {
    // A CPU has no memory of the hours nobody watched. Same data as the level
    // case above; opposite answer, and both are right.
    const before = points(T0 - 2 * DAY - 12 * HOUR, 73, HOUR, 'hourly', (i) => 40 + i * 0.4)
    const after = points(T0, 13, HOUR, 'hourly', () => 80)
    const f = forecast([...before, ...after], 90, T0, 'rate')
    expect(f.ok).toBe(false)
    expect(f.ok === false && f.reason).toBe('flat')
    expect(f.points).toBe(13)
  })

  it('leaves the silence in the drawn line as a hole, not a segment boundary to bridge', () => {
    const before = points(T0 - 2 * DAY - 12 * HOUR, 73, HOUR, 'hourly', (i) => 40 + i * 0.4)
    const after = points(T0, 13, HOUR, 'hourly', () => 80)
    const drawn = segments([...before, ...after])
    expect(drawn.length).toBe(2)
    expect(drawn[0].gapBefore).toBe(0)
    expect(drawn[1].gapBefore).toBe(2 * DAY)
    // Nothing was manufactured inside the silence.
    const inGap = drawn
      .flatMap((s) => s.points)
      .filter((p) => p.ts > T0 - 2 * DAY - 12 * HOUR && p.ts < T0 - 12 * HOUR)
    expect(inGap).toEqual([])
  })

  it('does not call every interval a gap on a fleet sampled every ten minutes', () => {
    // The gap rule is derived from the series own spacing. Pinned to a
    // two-minute cadence constant it would shatter a ten-minute fleet into one
    // run per sample and refuse every forecast on the estate.
    const slow = points(T0, 60, 10 * MIN, 'full', (i) => 50 + i * 0.01)
    expect(runs(slow).length).toBe(1)
  })
})

describe('a series too young to have a rate', () => {
  it('refuses two hours of samples and says the window was too short', () => {
    // Sixty-one points is plenty of points. It is still two hours, and a disk
    // that gained a percent during one backup has not told you anything about
    // next week.
    const young = points(T0, 61, 2 * MIN, 'full', (i) => 50 + i * 0.1)
    expect(young.length).toBeGreaterThan(FORECAST_MIN_POINTS)
    const f = forecast(young, 90, T0)
    expect(f.ok).toBe(false)
    expect(f.ok === false && f.reason).toBe('window-too-short')
    expect(f.to - f.from).toBe(2 * HOUR)
    expect(f.points).toBe(61)
  })

  it('refuses a handful of points even when they span days', () => {
    const sparse = points(T0, 6, 12 * HOUR, 'hourly', (i) => 50 + i * 2)
    const f = forecast(sparse, 90, T0)
    expect(f.ok === false && f.reason).toBe('too-few-points')
    expect(f.points).toBe(6)
  })

  it('refuses a series that stopped reporting, rather than extrapolating a dead server', () => {
    const stopped = points(T0 - 2 * DAY, 145, HOUR, 'hourly', (i) => 60 + i * 0.1)
    const f = forecast(stopped, 90, T0)
    expect(f.ok === false && f.reason).toBe('stale')
    expect(f.to).toBe(T0 - 2 * DAY)
  })
})

describe('a flat disk', () => {
  it('forecasts nothing rather than a date thirty thousand years out', () => {
    // The failure this exists to prevent is arithmetic, not judgement: a slope
    // of zero divides into infinity and renders as "fills in Infinity days" or
    // as a date in the year 33000, both of which look like a working feature.
    const flat = points(T0, 73, HOUR, 'hourly', () => 50)
    const f = forecast(flat, 90, T0)
    expect(f.ok).toBe(false)
    expect(f.ok === false && f.reason).toBe('flat')
    expect('days' in f).toBe(false)
    expect('at' in f).toBe(false)
  })

  it('calls a disk that is emptying falling, not filling', () => {
    const shrinking = points(T0, 73, HOUR, 'hourly', (i) => 70 - i * 0.1)
    const f = forecast(shrinking, 90, T0)
    expect(f.ok === false && f.reason).toBe('falling')
  })

  it('says nothing about a disk that is already over the threshold', () => {
    const over = points(T0, 73, HOUR, 'hourly', (i) => 88 + i * 0.05)
    const f = forecast(over, 90, T0)
    expect(f.ok === false && f.reason).toBe('already-past')
  })

  it('refuses a memory series that swings between sweeps', () => {
    // Real memory bounces twenty points in four minutes. There is a slope
    // through it and it means nothing.
    const bouncing = points(T0, 200, 2 * MIN, 'full', (i) => 50 + (i % 7) * 6 + i * 0.02)
    const f = forecast(bouncing, 90, T0)
    expect(f.ok === false && f.reason).toBe('noisy')
  })
})

describe('a disk that is genuinely filling', () => {
  // Six days of hourly means, 64.5% rising a point and a half a day, with a
  // small repeating wobble so the fit is not artificially perfect. 64.5 + 17 *
  // 1.5 = 90, so the crossing is seventeen days after the run started and the
  // run ended today: eleven days from now.
  const filling = points(T0, 145, HOUR, 'hourly', (i) => 64.5 + (i / 24) * 1.5 + ((i % 5) - 2) * 0.05)

  it('says eleven days', () => {
    const f = forecast(filling, 90, T0)
    expect(f.ok).toBe(true)
    if (!f.ok) throw new Error('expected a forecast')
    expect(f.days).toBeCloseTo(11, 0)
    expect(f.at).toBeCloseTo(T0 + 11 * DAY, -7)
    expect(f.perDay).toBeCloseTo(1.5, 2)
    expect(f.threshold).toBe(90)
  })

  it('states the window it was drawn from, not only the conclusion', () => {
    // "Fills in 11 days" is not an honest sentence on its own. "Fills in 11
    // days, from 6 days of data" is, and the difference is these three fields.
    const f = forecast(filling, 90, T0)
    if (!f.ok) throw new Error('expected a forecast')
    expect(f.from).toBe(T0 - 144 * HOUR)
    expect(f.to).toBe(T0)
    expect(f.points).toBe(145)
    expect(f.to - f.from).toBe(6 * DAY)
    expect(f.res).toBe('hourly')
    expect(f.confidence).toBe('high')
  })

  it('drops to a lower confidence on a shorter run of the same slope', () => {
    // Same rate, eight hours of it. The date is the same arithmetic; the claim
    // behind it is much weaker, and the label has to say so.
    const short = points(T0, 9, HOUR, 'hourly', (i) => 64.5 + (i / 24) * 1.5)
    const f = forecast([...points(T0 - 9 * HOUR, 4, HOUR, 'hourly', () => 64.4), ...short], 90, T0)
    if (!f.ok) throw new Error('expected a forecast')
    expect(f.confidence).toBe('low')
  })
})

describe('the boundary between item A two tiers', () => {
  // Item A keeps seven days at full resolution and eighty-three days of hourly
  // means, so any window longer than a week crosses the boundary. It is
  // routine. The line either says which half is which or it is presenting a
  // mean of thirty readings as a measurement.
  const older = points(T0 - 120 * MIN, 48, HOUR, 'hourly', (i) => 60 + i * 0.02)
  const recent = points(T0, 60, 2 * MIN, 'full', (i) => 61 + i * 0.001)
  const mixed = [...older, ...recent]

  it('reports where full resolution begins', () => {
    expect(resolutionBoundary(mixed)).toBe(recent[0].ts)
  })

  it('reports no boundary when the window holds only one tier', () => {
    expect(resolutionBoundary(older)).toBeNull()
    expect(resolutionBoundary(recent)).toBeNull()
    expect(resolutionBoundary([])).toBeNull()
  })

  it('draws the two tiers as separate segments with no silence between them', () => {
    const drawn = segments(mixed)
    expect(drawn.map((s) => s.res)).toEqual(['hourly', 'full'])
    // Zero, and that is the point: the measurement changed, the clock did not
    // skip. A chart that broke the line here would report an outage that never
    // happened, every time a window longer than a week is opened.
    expect(drawn[1].gapBefore).toBe(0)
  })

  it('tells a forecast which kind of data it used', () => {
    // The run spans the boundary, so the fit saw both an average of thirty
    // readings and single readings. Reporting that as 'full' would present the
    // whole line as measurements.
    const f = forecast(mixed, 90, T0)
    if (!f.ok) throw new Error(`expected a forecast, got ${f.reason}`)
    expect(f.res).toBe('mixed')
    expect(f.from).toBe(mixed[0].ts)
    expect(f.points).toBe(108)
  })
})

describe('downsampling', () => {
  it('keeps the extremes rather than averaging a spike away', () => {
    // On a disk it is the peak that matters. A bucket that reported only its
    // mean would have removed the only interesting thing in the window.
    const segment = {
      res: 'hourly' as const,
      gapBefore: 0,
      points: [
        { ts: T0, v: 10, res: 'hourly' as const, min: 5, max: 40, n: 30 },
        { ts: T0 + HOUR, v: 12, res: 'hourly' as const, min: 8, max: 90, n: 30 }
      ]
    }
    const out = downsample(segment, 6 * HOUR)
    expect(out.points).toEqual([{ ts: T0, v: 11, res: 'hourly', min: 5, max: 90, n: 60 }])
  })

  it('weights the mean by the readings behind each bucket', () => {
    const segment = {
      res: 'hourly' as const,
      gapBefore: 0,
      points: [
        { ts: T0, v: 0, res: 'hourly' as const, min: 0, max: 0, n: 30 },
        { ts: T0 + HOUR, v: 60, res: 'hourly' as const, min: 60, max: 60, n: 10 }
      ]
    }
    // The straight mean is 30. Forty readings averaging (30*0 + 10*60)/40 is
    // 15, which is what those forty machines actually reported.
    expect(downsample(segment, 6 * HOUR).points[0].v).toBe(15)
  })

  it('does not invent a spread for a single instantaneous reading', () => {
    const segment = {
      res: 'full' as const,
      gapBefore: 0,
      points: [{ ts: T0, v: 42, res: 'full' as const }]
    }
    expect(downsample(segment, HOUR).points).toEqual([{ ts: T0, v: 42, res: 'full' }])
  })

  it('never merges across a gap, because buckets are taken inside a segment', () => {
    const before = points(T0 - 2 * DAY - 12 * HOUR, 73, HOUR, 'hourly', () => 40)
    const after = points(T0, 13, HOUR, 'hourly', () => 80)
    const drawn = segments([...before, ...after]).map((s) => downsample(s, 7 * DAY))
    // One bucket each, and emphatically not one bucket of 60 spanning both
    // sides of the outage.
    expect(drawn.length).toBe(2)
    expect(drawn[0].points.map((p) => p.v)).toEqual([40])
    expect(drawn[1].points.map((p) => p.v)).toEqual([80])
  })
})

describe('the report main hands the panel', () => {
  const series: Partial<Record<CapacityMetric, TrendPoint[]>> = {
    cpu: points(T0, 145, HOUR, 'hourly', (i) => 20 + (i % 9)),
    memPct: points(T0, 145, HOUR, 'hourly', () => 44),
    diskPct: points(T0, 145, HOUR, 'hourly', (i) => 64.5 + (i / 24) * 1.5)
  }
  const report = buildCapacityReport('srv-alpha', series, {
    now: T0,
    from: T0 - 7 * DAY,
    to: T0,
    thresholds: CAPACITY_THRESHOLDS,
    fullResolutionDays: 7,
    retainedDays: 90
  })

  it('answers with a conclusion per metric, not with the samples', () => {
    expect(report.hostId).toBe('srv-alpha')
    expect(report.trends.map((t) => t.metric)).toEqual(['cpu', 'memPct', 'diskPct', 'inodePct'])
    const disk = report.trends[2]
    expect(disk.read).toBe(145)
    if (!disk.forecast?.ok) throw new Error('expected a disk forecast')
    expect(disk.forecast.days).toBeCloseTo(11, 0)
  })

  it('carries the store retention horizons rather than making the panel guess', () => {
    // The renderer cannot import a main-process constant, and a panel with "7
    // days" typed into it goes on saying that after the policy changes.
    expect(report.fullResolutionDays).toBe(7)
    expect(report.retainedDays).toBe(90)
  })

  it('gives cpu a line and no forecast', () => {
    expect(report.trends[0].forecast).toBeNull()
    expect(report.trends[0].segments.length).toBe(1)
  })

  it('sends a drawable number of points, not seven thousand samples', () => {
    const drawn = report.trends[2].segments.reduce((n, s) => n + s.points.length, 0)
    expect(report.trends[2].read).toBe(145)
    expect(drawn).toBeLessThanOrEqual(145)
    expect(drawn).toBeGreaterThan(0)
  })

  it('reports the range seen including the hourly tier own extremes', () => {
    const spiky: Partial<Record<CapacityMetric, TrendPoint[]>> = {
      diskPct: [
        { ts: T0 - HOUR, v: 50, res: 'hourly', min: 20, max: 99, n: 30 },
        { ts: T0, v: 51, res: 'full' }
      ]
    }
    const r = buildCapacityReport('srv-alpha', spiky, {
      now: T0,
      from: T0 - DAY,
      to: T0,
      thresholds: CAPACITY_THRESHOLDS,
      fullResolutionDays: 7,
      retainedDays: 90
    })
    // 99 was reached inside that hour. A panel that only read the mean would
    // report a quiet 51% for a disk that touched 99.
    expect(r.trends[2].high).toBe(99)
    expect(r.trends[2].low).toBe(20)
  })

  it('reports nothing at all for a server with no history, without throwing', () => {
    const r = buildCapacityReport('srv-new', {}, {
      now: T0,
      from: T0 - DAY,
      to: T0,
      thresholds: CAPACITY_THRESHOLDS,
      fullResolutionDays: 7,
      retainedDays: 90
    })
    expect(r.trends.map((t) => t.read)).toEqual([0, 0, 0, 0])
    expect(r.trends[2].latest).toBeNull()
    expect(r.trends[2].forecast).toEqual({ ok: false, reason: 'no-data', from: 0, to: 0, points: 0 })
  })
})

// ---------------------------------------------------------------------------
// The disk, in bytes -- the question this feature is named for and could not
// answer.
// ---------------------------------------------------------------------------

describe('a disk whose stored percentage is too coarse to forecast', () => {
  // The live host that prompted the change: 193 GiB root, 30.3 GiB used, df
  // reporting a flat `16`. One percentage point is about two gigabytes there,
  // so a disk gaining a gigabyte a week does not move the stored series for a
  // fortnight and then moves it a whole point.
  const GIB = 1024 ** 3
  const TOTAL = 193 * GIB
  // What df's Capacity column is a percentage OF: total less the blocks ext4
  // reserves for root.
  const USABLE = Math.round(TOTAL * 0.95)
  // Nearly full and creeping up: 88% of usable, gaining a tenth of a point a
  // day. This is the case the feature exists for and the one quantisation
  // destroys most completely -- see the two tests below.
  const START = 0.88 * USABLE
  const PER_DAY = 0.001 * USABLE

  /** Fourteen days of hourly readings, growing steadily. */
  const used = Array.from({ length: 14 * 24 }, (_, i) => ({
    ts: T0 - (14 * 24 - 1 - i) * HOUR,
    v: START + (PER_DAY * i) / 24
  }))

  it('is refused outright when asked in whole percentage points', () => {
    // THE BUG, STATED AS A TEST. The same disk, through the stored integer
    // series: a fortnight of real, steady growth becomes a staircase of one-
    // point steps, and a staircase is refused whichever way it falls. Slowly
    // enough and the rise never clears the flat rule; fast enough and each
    // single step is most of the whole rise, which is the definition of the
    // step rule. A disk creeping towards full sits exactly where both apply,
    // and it is the disk anybody actually wants forecast.
    //
    // Here it is 'step-change': one stored point is roughly two gigabytes, and
    // against a total rise of 1.4 points a single step of 1 is well over the
    // 0.6 share. Nothing about the disk is a step -- it gained a steady tenth
    // of a point a day for fourteen days.
    const asPct = used.map((p) => ({
      ts: p.ts,
      v: Math.round((p.v / USABLE) * 100),
      res: 'full' as const
    }))
    const f = forecast(asPct, 90, T0)
    expect(f.ok).toBe(false)
    expect(f.ok === false && f.reason).toBe('step-change')
  })

  it('answers in bytes, from the series that was being sampled all along', () => {
    const r = forecastBytes(used, diskCeilingBytes(USABLE), T0, diskBytesPolicy(USABLE))
    expect(r.refusal).toBeNull()
    expect(r.perDay).not.toBeNull()
    // The real rate, recovered to within a percent of itself.
    expect(Math.abs((r.perDay ?? 0) - PER_DAY) / PER_DAY).toBeLessThan(0.01)
    // And a date. The series has already run fourteen of the twenty days from
    // 88%, so what is left is six.
    expect(r.days).not.toBeNull()
    expect(Math.round(r.days ?? 0)).toBe(6)
  })

  it('measures against what df calls capacity, not the raw size', () => {
    // Four and a half points of disk between the two denominators -- about nine
    // gigabytes here, which is weeks at this rate. Forecasting against the raw
    // total would put the crossing later than the percentage row beside it says,
    // and two lines of one panel would disagree about one disk.
    const onUsable = diskCeilingBytes(USABLE) ?? 0
    const onTotal = diskCeilingBytes(TOTAL) ?? 0
    expect(onTotal - onUsable).toBeGreaterThan(8 * GIB)
    expect(onUsable).toBe(0.9 * USABLE)
  })

  it('takes its flat rule from the percentage row, not from the database one', () => {
    // bytesForecast's own flat rule is 2% of how big the thing already is,
    // which is right for a database and meaningless for a disk with a real
    // ceiling. Half a percentage point of the filesystem is what "flat" means
    // on the row above, so it is what it means here.
    expect(diskBytesPolicy(USABLE).flatRiseBytes).toBe((FORECAST_FLAT_RISE_PCT / 100) * USABLE)
  })

  it('refuses a disk that has been silent for two days, as the percentage row does', () => {
    // Left on bytesForecast's own 14-day staleness, the byte line would forecast
    // a disk that had been quiet for a week while the line directly above it
    // said `stale`.
    const old = used.map((p) => ({ ...p, ts: p.ts - 2 * DAY }))
    const r = forecastBytes(old, diskCeilingBytes(USABLE), T0, diskBytesPolicy(USABLE))
    expect(r.refusal).toBe('stale')
  })

  it('keeps the rate when nothing said how big is too big', () => {
    // A host whose diskCapacity fact has not been collected yet. The date is
    // refused and "+1.4 GiB a day" survives, because that is the half somebody
    // acts on.
    const r = forecastBytes(used, null, T0, diskBytesPolicy(0))
    expect(r.refusal).toBe('no-ceiling')
    expect(r.perDay).not.toBeNull()
  })
})
