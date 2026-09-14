// Capacity trends and the one sentence they exist to produce — roadmap item 26.
//
//     "This disk fills in eleven days."
//
// ----------------------------------------------------------------------------
// What this is, and what it deliberately is not
// ----------------------------------------------------------------------------
// Item A shipped a durable store. This is its first user-visible consumer, and
// the roadmap is explicit that it is "a query and a chart, not a subsystem".
// The rule that keeps it that way is that NOTHING is stored here. Every number
// below is derived, on demand, from samples the fleet sampler already wrote.
// A capacity feature that starts keeping its own rollups, its own thresholds
// per host and its own evaluation timer has become the metrics warehouse the
// roadmap says not to build, and it will lose to Prometheus.
//
// ----------------------------------------------------------------------------
// Why the refusals are the feature
// ----------------------------------------------------------------------------
// A least-squares fit will cheerfully report that a disk fills in three days
// because somebody untarred a release into /var once. It will report a
// crossing date from ninety minutes of data. It will draw a straight line
// through two days when the host was unreachable and call the slope a trend.
// Each of those is worse than saying nothing, because an operator who acts on
// one and finds nothing wrong stops reading the next one.
//
// So `forecast` returns a REFUSAL with a reason far more often than it returns
// a date, and every refusal names which rule stopped it. The thresholds are
// exported constants rather than literals inside the function so a test can
// state the number it is testing and a reader can see the whole policy in one
// place.
//
// ----------------------------------------------------------------------------
// Percentages only
// ----------------------------------------------------------------------------
// cpu, memPct and diskPct — three of item A's eight series, all of them 0-100.
// diskUsed and memUsed are bytes and would need per-host totals to mean
// anything, and "fills in eleven days" is a question about the percentage
// anyway. Restricting the input domain is what lets FLAT_RISE_PCT below be a
// number rather than a per-metric configuration table.
//
// ----------------------------------------------------------------------------
// No runtime imports
// ----------------------------------------------------------------------------
// This file imports TYPES, from one sibling in shared/, and no runtime value
// from anywhere. `TrendPoint` is structurally the history store's `SeriesPoint`
// and the assignability is asserted in tests/capacity.test.ts, because shared/
// may not reach into src/main. Main passes real SeriesPoints in; the renderer
// receives the report over IPC.
//
// The rule that matters is the runtime half: everything below is arithmetic on
// values the caller supplies, so main can run it, the renderer can run it, and
// a test can run it with no store, no clock and no Electron. The disk's
// byte-domain answer is FITTED BY THE CALLER and arrives here as data for the
// same reason.

// The one import, and it is types only -- see the note above about shared/ not
// reaching into src/main. `BytesReading` is what the disk's byte-domain answer
// travels as, and `BytesPolicy` is how this file states the disk's refusal
// policy without importing the function that applies it.
import type { BytesPolicy, BytesReading } from './bytesForecast'

/** The three series a capacity question is asked about. A subset of item A's
 *  METRICS, by name, checked against it where main wires the two together. */
export const CAPACITY_METRICS = ['cpu', 'memPct', 'diskPct', 'inodePct'] as const

export type CapacityMetric = (typeof CAPACITY_METRICS)[number]

/** One sample as the history store returns it. Structurally `SeriesPoint`. */
export interface TrendPoint {
  ts: number
  v: number
  /** Which tier it came from. 'hourly' is a mean of `n` readings; 'full' is one
   *  instantaneous reading. A consumer that cannot tell them apart is drawing a
   *  mean of thirty samples as if it were a measurement. */
  res: 'full' | 'hourly'
  min?: number
  max?: number
  n?: number
}

/**
 * A contiguous run of points at ONE resolution, ready to draw as one line.
 *
 * The two reasons a series breaks into more than one of these are the two
 * things a chart must not smooth over:
 *
 *  - a GAP. A host that was unreachable for two days has no samples for two
 *    days. Drawing a straight line across that invents a trend that nothing
 *    observed. `gapBefore` is how long the silence was, in ms.
 *  - a RESOLUTION CHANGE. Item A keeps seven days at full resolution and
 *    eighty-three days of hourly means, so any window longer than a week
 *    crosses that boundary. It is routine, not an anomaly, and the two halves
 *    of the line are not the same kind of measurement.
 */
export interface TrendSegment {
  res: 'full' | 'hourly'
  points: TrendPoint[]
  /** Silence before this segment, in ms. 0 when it merely follows a resolution
   *  change with no missing time — the line continues, its meaning changes. */
  gapBefore: number
  /**
   * Set when the silence has a cause we know about: OpsMaxx was not running.
   *
   * "This server went quiet" and "we were not watching" are different facts
   * about the same hole in a line, and only one of them is about the server.
   * Leaving them indistinguishable is what made the panel's advice a standing
   * accusation — it told every operator to leave the app running, because it
   * could not tell which gaps were theirs.
   */
  gapKnown?: 'not-running'
}

/** Why `forecast` declined to give a number. One per host per metric, and the
 *  UI shows it in place of a date; see refusalText in the renderer's lib. */
export type RefusalReason =
  /** Nothing in the window at all. */
  | 'no-data'
  /** The newest sample is too old to extrapolate from — the host stopped
   *  reporting, and a forecast from a dead series is a forecast about the past. */
  | 'stale'
  | 'too-few-points'
  /** The run is real but too short a slice of time to have a rate. */
  | 'window-too-short'
  /** Already at or over the threshold. There is nothing to predict. */
  | 'already-past'
  /** The line does not move enough over its own window to call it a trend. */
  | 'flat'
  /** It is going down. */
  | 'falling'
  /** The points scatter too far from the fit for the fit to mean anything. */
  | 'noisy'
  /** The rise is one jump, not a trend. Someone untarred something. */
  | 'step-change'
  /** A real rate, but the crossing is past the horizon this feature will
   *  state — beyond which "the rate holds" is not a claim worth making. */
  | 'beyond-horizon'
  /**
   * Samples exist across the window but sit in too few parts of it.
   *
   * The refusal that replaces most of what contiguity used to refuse, and it
   * is a different claim: not "there is a hole in the data" — there always is —
   * but "everything we have is one clump, so a line through it describes those
   * hours and not this window". A host with five hundred samples taken inside
   * ten hours of a month is this, and it used to arrive as 'too-few-points'
   * saying "only 8 samples", which is how the feature came to look broken.
   */
  | 'sparse'

/**
 * How much of the fitted window was actually looked at.
 *
 * Deliberately NOT "what share of the window was observed". Duty cycle is the
 * wrong question for a level: a disk fills whether or not anybody is watching,
 * so a laptop that runs for two hours a day has still seen the disk at sixty
 * moments spread across a month, and a line through them is a true claim about
 * that month. Duty cycle calls that 8% and refuses it, which is the behaviour
 * this whole file was rewritten to stop.
 *
 * What a fit genuinely cannot survive is CLUSTERING. Five hundred samples
 * inside ten hours of a thirty-day window are, for the purpose of fitting a
 * line, one point; two dense clumps at either end are two. Occupancy catches
 * exactly that and nothing else.
 *
 * The window always begins and ends at a sample, so an empty part is always an
 * interior one — which is why there is no separate "longest gap" rule to go
 * with this. At half the parts occupied, the longest silence cannot be more
 * than half the window.
 */
export interface Coverage {
  /** How many parts the window was cut into. FORECAST_COVERAGE_BUCKETS. */
  parts: number
  /** How many of them contain at least one sample. */
  occupied: number
  /** The longest single silence inside the window, in ms, for the sentence. */
  longestGapMs: number
}

export interface ForecastRefused {
  ok: false
  reason: RefusalReason
  /** The run the refusal is about, so the UI can say "two hours of data"
   *  rather than only "too short". Both zero when there was nothing at all. */
  from: number
  to: number
  points: number
  /** How well the window was covered. Optional only so that the many hand-built
   *  `Forecast` literals in tests and in the fleet roll-up keep compiling; it is
   *  always set by `forecast()`, and it is the whole content of a 'sparse'. */
  coverage?: Coverage
}

export interface ForecastMade {
  ok: true
  /** When the fitted line reaches `threshold`. */
  at: number
  /** Days from `now` to `at`. */
  days: number
  threshold: number
  /** Percentage points per day. */
  perDay: number
  /** How well the line fits, 0..1, and the label derived from it. */
  r2: number
  confidence: 'low' | 'medium' | 'high'
  /**
   * The window the forecast was DRAWN FROM, not the window that was queried.
   *
   * "Fills in 11 days" is not an honest sentence. "Fills in 11 days, from 6
   * days of data" is, and the difference is entirely in these three fields,
   * which is why they are not optional.
   */
  from: number
  to: number
  points: number
  /** Whether the fit saw instantaneous readings, hourly means, or both. */
  res: 'full' | 'hourly' | 'mixed'
  /** How well the window was covered. Stated beside the date for the same
   *  reason `from`/`to` are: "fills in 11 days, from 21 days of data, 9 parts
   *  of 10 sampled" is a sentence a reader can judge, and "fills in 11 days"
   *  is not. */
  coverage?: Coverage
}

export type Forecast = ForecastMade | ForecastRefused

/** One metric's answer: a line to draw and, where a threshold was asked for,
 *  a forecast or a refusal. */
export interface Trend {
  metric: CapacityMetric
  /** Ready to draw. Downsampled; see `downsample`. */
  segments: TrendSegment[]
  /** How many points were actually read, before downsampling. The chart is a
   *  summary of this many measurements and says so. */
  read: number
  /** The newest reading in the window, undownsampled. */
  latest: TrendPoint | null
  /** The lowest and highest value seen anywhere in the window, taking the
   *  hourly tier's own min/max into account rather than only its mean. */
  low: number | null
  high: number | null
  /** Where the full-resolution tier begins, when the window contains both
   *  tiers. Null when the whole window is one resolution — there is no
   *  boundary to draw, and drawing one anyway would be a lie. */
  resolutionBoundary: number | null
  /** Null when no threshold was asked for (cpu). */
  forecast: Forecast | null
  /**
   * The same question asked in BYTES, where the stored percentage is too
   * coarse to answer it. Null for every metric except disk.
   *
   * Disk is the metric this whole feature was named for and the one it could
   * never answer: `diskPct` holds df's own Capacity column, which is a rounded
   * integer, so on a 193 GiB filesystem one stored point is about two
   * gigabytes. A disk gaining a gigabyte a week does not move that series for a
   * fortnight and then moves it a whole point, which reads as 'flat' followed
   * by 'step-change' forever. The byte series has been sampled beside it the
   * whole time.
   *
   * Computed by the caller and passed in, because this file holds no runtime
   * import: main reads the series, `forecastBytes` fits it, and the answer
   * travels here.
   */
  bytes: BytesReading | null
}

export interface CapacityReport {
  hostId: string
  /** The window that was asked for. */
  from: number
  to: number
  /** When it was computed. Every "in N days" below is relative to this. */
  now: number
  /** Item A's retention horizons, carried rather than duplicated: the renderer
   *  cannot import a main-process constant, and a panel that hard-coded "7
   *  days" would keep saying it after the policy changed. */
  fullResolutionDays: number
  retainedDays: number
  trends: Trend[]
}

// ---------------------------------------------------------------------------
// The policy. Every number here is a refusal boundary; see the file header for
// why they are the point of the feature rather than an obstacle to it.
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** Below this many points in the run, no forecast. Twelve is two hourly means
 *  short of half a day, or twenty-four minutes of full-resolution samples: few
 *  enough to be reachable, many enough that one bad reading cannot set the
 *  slope. */
export const FORECAST_MIN_POINTS = 12

/** And below this much elapsed time, no forecast however many points there
 *  are. Six hours, because the daily cycle of a working machine — a backup, a
 *  build, a log rotation — is longer than any shorter window, and a rate
 *  measured inside one phase of it is a rate for that phase only. This is what
 *  refuses a fleet that was first connected two hours ago. */
export const FORECAST_MIN_WINDOW_MS = 6 * HOUR_MS

/** Newer than this, or the series is stale and nothing is extrapolated from
 *  it. Six hours of silence from a host that samples every two minutes is not
 *  a quiet patch; it is a host that stopped answering. */
export const FORECAST_MAX_STALE_MS = 6 * HOUR_MS

/** The fitted line must move at least this many percentage points across its
 *  own window, in either direction, to be a trend at all. Below it the answer
 *  is 'flat' — which is the honest answer, and specifically NOT the infinity
 *  that dividing by a slope of zero produces. */
export const FORECAST_FLAT_RISE_PCT = 0.5

/** Coefficient of determination below which the fit is not describing the
 *  data. A memory series that swings twenty points between sweeps has a slope;
 *  it does not have a trend. */
export const FORECAST_MIN_R2 = 0.5

/** If a single jump — measured across at most two consecutive intervals, so
 *  that a step smeared over an hourly bucket boundary still counts as one —
 *  accounts for this share of the whole fitted rise, the rise is that jump and
 *  not a trend. This is the untarred release. */
export const FORECAST_STEP_SHARE = 0.6
const STEP_SPAN_POINTS = 2

/** Crossings further out than this are not stated. At three months the claim
 *  "the current rate holds" is doing all the work and the arithmetic is doing
 *  none, and the store itself only remembers ninety days. */
export const FORECAST_HORIZON_DAYS = 90

/** A gap is this many times the run's own typical spacing. Derived from the
 *  data rather than from a cadence constant: the sampler's interval is a user
 *  setting, and a threshold pinned to two minutes would call every interval a
 *  gap on a fleet sampled every ten. */
export const GAP_FACTOR = 3

/**
 * And no gap shorter than this breaks a run, whatever the spacing says.
 *
 * GAP_FACTOR alone is a ratio, and at full resolution the ratio is brutal: the
 * sampler's default interval is two minutes, so a SIX MINUTE silence started a
 * new run. A laptop asleep for ten minutes, a sweep that skipped a host, a
 * reconfigure — each of them severed a series that had not actually gone
 * anywhere, and the forecast then ran on whatever came after the most recent
 * severance. That is why a host with thirty samples across a day reported
 * "only 8 samples since the last break in the data": the breaks were minutes
 * long and there were several of them.
 *
 * Two hours, because that is the granularity of the coarser tier this same
 * store keeps. Below it a gap is not distinguishable from a sample the store
 * would have averaged away on its own, so treating one as a discontinuity
 * claims a precision the data does not have.
 *
 * It changes nothing at hourly resolution — three times an hour is already
 * more than two — so the case this rule exists for is untouched: a host
 * unreachable for two days still breaks its series, and a forecast still never
 * runs across an outage.
 */
export const GAP_MIN_MS = 2 * HOUR_MS

/**
 * The fitted window, cut into this many parts, to test whether the samples are
 * spread through it or clumped in one corner of it. See `Coverage`.
 *
 * Ten, because a tenth of the SHORTEST window this will ever fit
 * (FORECAST_MIN_WINDOW_MS, six hours) is thirty-six minutes — comfortably
 * longer than the sampler's two-minute default and longer than the coarse
 * tier's own bucket, so a part is never empty merely because no sample was due
 * inside it. Twenty parts of six hours is eighteen minutes, and would start
 * refusing perfectly healthy hosts that are sampled every ten.
 */
export const FORECAST_COVERAGE_BUCKETS = 10

/**
 * And at least this share of those parts must contain a sample.
 *
 * A fit is a claim about the WHOLE window, and half of it having been looked at
 * is the least that supports one. At exactly one half the largest unobserved
 * stretch is necessarily under half the window, so the line is never mostly
 * bridging. A share rather than a count, so that changing the number of parts
 * above does not silently change the policy.
 */
export const FORECAST_MIN_OCCUPANCY = 0.5

/**
 * Which gap rule each metric gets, and why, one line per metric.
 *
 * LEVEL — the quantity persists while nobody is looking. An observation after a
 * silence is still an observation of the same accumulating thing, so the
 * silence is missing evidence rather than a different machine:
 *
 *   diskPct   the file written while the app was shut is still on the disk
 *   inodePct  likewise — inodes are consumed, not borrowed
 *   memPct    allocation outlives the sampler being away
 *
 * RATE — the quantity is instantaneous and has no memory. What the CPU did
 * yesterday says nothing about what it is doing now, so a line drawn across a
 * silence is drawn through nothing that was ever true:
 *
 *   cpu
 *
 * THIS IS THE DISTINCTION THE FILE USED TO LACK. Everything was treated as a
 * rate, so every metric was fitted on the last unbroken run only — and on a
 * desktop app, where the laptop shuts and the machine sleeps, that meant a
 * thirty-day question was answered from the last ten hours. For a CPU that is
 * correct. For a disk it throws away the evidence and then blames the operator
 * for not leaving the app running.
 */
export const CAPACITY_METRIC_DOMAIN: Record<CapacityMetric, 'level' | 'rate'> = {
  cpu: 'rate',
  memPct: 'level',
  diskPct: 'level',
  inodePct: 'level'
}

/** Fallbacks for the typical spacing when there are too few intervals to take
 *  a median of. */
const NOMINAL_SPACING: Record<'full' | 'hourly', number> = {
  full: 2 * MINUTE_MS,
  hourly: HOUR_MS
}

/** Chart points per trend, across all its segments. A 90-day window holds
 *  about seven thousand samples per metric; a line drawn at eight hundred
 *  pixels cannot show them and sending them to the renderer to be averaged
 *  into invisibility is the warehouse habit in miniature. */
export const CHART_MAX_POINTS = 400

// ---------------------------------------------------------------------------

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * The typical spacing between consecutive points, per resolution.
 *
 * Taken from the points themselves so that a fleet sampled every ten minutes
 * is not read as a fleet with a gap between every pair of samples.
 */
function spacing(points: TrendPoint[]): Record<'full' | 'hourly', number> {
  const gaps: Record<'full' | 'hourly', number[]> = { full: [], hourly: [] }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (a.res !== b.res) continue
    const d = b.ts - a.ts
    if (d > 0) gaps[a.res].push(d)
  }
  return {
    full: gaps.full.length >= 3 ? median(gaps.full) : NOMINAL_SPACING.full,
    hourly: gaps.hourly.length >= 3 ? median(gaps.hourly) : NOMINAL_SPACING.hourly
  }
}

/**
 * Split into runs of points with no missing time between them.
 *
 * This is the whole of "a gap is not a flat line". Everything downstream —
 * the fit, the chart, the window a forecast states — operates on a run, so
 * there is no path by which two days of silence can become a slope.
 *
 * A run may change resolution partway through: the boundary between item A's
 * two tiers is a change of measurement, not a break in time, and a run that
 * split there would report a shorter window than the store actually holds.
 */
export function runs(points: TrendPoint[]): TrendPoint[][] {
  if (points.length === 0) return []
  const typical = spacing(points)
  const out: TrendPoint[][] = [[points[0]]]
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    // The coarser of the two ends decides. Crossing from an hourly mean into
    // full resolution, an hour of daylight between them is normal.
    const expected = Math.max(typical[a.res], typical[b.res])
    // The ratio, floored. See GAP_MIN_MS: at a two-minute cadence the ratio
    // alone made six minutes of silence a discontinuity.
    const breaks = Math.max(GAP_FACTOR * expected, GAP_MIN_MS)
    if (b.ts - a.ts > breaks) out.push([b])
    else out[out.length - 1].push(b)
  }
  return out
}

/** Runs, split further wherever the resolution changes, each carrying how much
 *  silence preceded it. This is what a chart draws. */
export function segments(points: TrendPoint[], resumedAt: number[] = []): TrendSegment[] {
  const out: TrendSegment[] = []
  let previousEnd: number | null = null
  for (const run of runs(points)) {
    let gapBefore = previousEnd === null ? 0 : run[0].ts - previousEnd
    // A gap that CONTAINS a moment the sampler started again is a gap OpsMaxx
    // was absent for. The end is inclusive and the start is not: a resume at
    // the instant the previous run ended did not interrupt anything.
    const known =
      previousEnd !== null && resumedAt.some((t) => t > previousEnd! && t <= run[0].ts)
        ? ('not-running' as const)
        : undefined
    for (const p of run) {
      const last = out[out.length - 1]
      if (last && last.res === p.res && last.points[last.points.length - 1].ts <= p.ts && gapBefore === 0) {
        last.points.push(p)
        continue
      }
      out.push({ res: p.res, points: [p], gapBefore, ...(gapBefore > 0 && known ? { gapKnown: known } : {}) })
      // Only the first segment of a run inherits the run's gap; a resolution
      // change inside a run is continuous in time.
      gapBefore = 0
    }
    previousEnd = run[run.length - 1].ts
  }
  return out
}

/**
 * Fewer points, same shape.
 *
 * Buckets are taken inside a segment, never across one, so a bucket can never
 * straddle a gap or mix a mean of thirty readings with an instantaneous one.
 * The bucket keeps the extremes as well as the mean: on a disk it is the peak
 * that matters, and a chart that averages a spike away has removed the only
 * interesting thing in the window.
 */
export function downsample(segment: TrendSegment, bucketMs: number): TrendSegment {
  if (bucketMs <= 0 || segment.points.length === 0) return segment
  const out: TrendPoint[] = []
  let bucket = -1
  let acc: TrendPoint[] = []
  const flush = (): void => {
    if (acc.length === 0) return
    let sum = 0
    let weight = 0
    let lo = Infinity
    let hi = -Infinity
    for (const p of acc) {
      const n = p.n && p.n > 0 ? p.n : 1
      sum += p.v * n
      weight += n
      lo = Math.min(lo, p.min ?? p.v)
      hi = Math.max(hi, p.max ?? p.v)
    }
    const point: TrendPoint = { ts: acc[0].ts, v: sum / weight, res: acc[0].res }
    // Only where it says something the mean does not. A single full-resolution
    // reading that survived a bucket alone has no spread and must not pretend
    // to one.
    if (hi > lo) {
      point.min = lo
      point.max = hi
    }
    if (weight > acc.length || acc[0].n !== undefined) point.n = weight
    out.push(point)
    acc = []
  }
  for (const p of segment.points) {
    const b = Math.floor(p.ts / bucketMs)
    if (b !== bucket) {
      flush()
      bucket = b
    }
    acc.push(p)
  }
  flush()
  return {
    res: segment.res,
    points: out,
    gapBefore: segment.gapBefore,
    ...(segment.gapKnown ? { gapKnown: segment.gapKnown } : {})
  }
}

/** Least squares, with x measured from the first point so that millisecond
 *  timestamps near 1.7e12 do not eat the precision of the sums. */
function fit(points: TrendPoint[]): { slope: number; intercept: number; r2: number; x0: number } {
  const x0 = points[0].ts
  const n = points.length
  let sx = 0
  let sy = 0
  for (const p of points) {
    sx += p.ts - x0
    sy += p.v
  }
  const mx = sx / n
  const my = sy / n
  let sxy = 0
  let sxx = 0
  for (const p of points) {
    const dx = p.ts - x0 - mx
    sxy += dx * (p.v - my)
    sxx += dx * dx
  }
  const slope = sxx === 0 ? 0 : sxy / sxx
  const intercept = my - slope * mx
  let ssRes = 0
  let ssTot = 0
  for (const p of points) {
    const predicted = intercept + slope * (p.ts - x0)
    ssRes += (p.v - predicted) ** 2
    ssTot += (p.v - my) ** 2
  }
  // A series with no variance at all is fitted perfectly by a flat line. It is
  // caught by the flat rule below long before r2 is consulted; NaN here would
  // make every comparison false and let it through.
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot
  return { slope, intercept, r2, x0 }
}

/**
 * The largest rise across one or two consecutive intervals — never across a
 * silence.
 *
 * Two intervals, because a step that lands mid-hour is split across two hourly
 * means and would otherwise read as two ordinary changes.
 *
 * THE TIME BOUND IS WHAT MAKES CROSS-GAP FITTING POSSIBLE AT ALL, and without
 * it this rule silently defeats the entire change. Once a level metric is
 * fitted across gaps, the growth that accumulated while nobody was looking
 * arrives as ONE interval: a disk that gained four gigabytes over a weekend the
 * laptop was shut shows up as a single pair of samples carrying most of the
 * fitted rise, trips FORECAST_STEP_SHARE, and is refused as "something was
 * untarred". Every ordinary host would refuse that way, and the only visible
 * effect of fitting across gaps would have been to change the word in the
 * refusal from 'flat' to 'step-change'.
 *
 * A pair further apart than `maxSpanMs` is therefore not a jump at all — it is
 * two measurements of a quantity that was accumulating in between, which is
 * what a level metric does. GAP_MIN_MS is the bound, the same threshold that
 * decides what counts as a break anywhere else in this file, so "not a jump"
 * and "a break in the series" mean the same span of time.
 *
 * What the rule still catches is what it was written for: a step BETWEEN
 * CONSECUTIVE SAMPLES, minutes apart, which is an event and not a trend.
 */
function largestJump(points: TrendPoint[], maxSpanMs: number): number {
  let max = 0
  for (let i = 0; i < points.length; i++) {
    for (let k = 1; k <= STEP_SPAN_POINTS && i + k < points.length; k++) {
      if (points[i + k].ts - points[i].ts > maxSpanMs) break
      const d = points[i + k].v - points[i].v
      if (d > max) max = d
    }
  }
  return max
}

/**
 * How many parts of [first..last] contain a sample, and the longest silence.
 *
 * Exported because main applies the window chosen from one series to another —
 * the disk's percentage series and its byte series must be described as being
 * about the same stretch of time by construction, not by two rules that happen
 * to agree today.
 */
export function coverageOf(points: TrendPoint[]): Coverage {
  const parts = FORECAST_COVERAGE_BUCKETS
  if (points.length === 0) return { parts, occupied: 0, longestGapMs: 0 }
  const from = points[0].ts
  const to = points[points.length - 1].ts
  const span = to - from
  let longestGapMs = 0
  for (let i = 1; i < points.length; i++) {
    const d = points[i].ts - points[i - 1].ts
    if (d > longestGapMs) longestGapMs = d
  }
  // A window with no width at all is one instant, however many samples landed
  // in it. One part, occupied.
  if (span <= 0) return { parts, occupied: 1, longestGapMs }
  const seen = new Set<number>()
  for (const p of points) {
    // The last point lands exactly on the upper edge and would index one past
    // the end.
    seen.add(Math.min(parts - 1, Math.floor(((p.ts - from) / span) * parts)))
  }
  return { parts, occupied: seen.size, longestGapMs }
}

/**
 * The stretch of series a level metric is fitted over, and how well it covers
 * it.
 *
 * Walks the runs oldest-first and takes the LONGEST window that clears the
 * occupancy gate, so that one stale reading from three weeks ago cannot drag a
 * host below the gate: that run is dropped and everything after it stands. When
 * nothing clears the gate, the newest run is returned marked `sparse` — which
 * is never worse than the behaviour this replaces, because the newest run is
 * exactly what that behaviour always used.
 */
export function fitWindow(points: TrendPoint[]): {
  window: TrendPoint[]
  coverage: Coverage
  sparse: boolean
} {
  const rs = runs(points)
  if (rs.length === 0) return { window: [], coverage: coverageOf([]), sparse: false }
  const need = FORECAST_MIN_OCCUPANCY * FORECAST_COVERAGE_BUCKETS
  for (let i = 0; i < rs.length; i++) {
    const w = rs.slice(i).flat()
    const span = w[w.length - 1].ts - w[0].ts
    // Anything shorter than the minimum window cannot be accepted here anyway,
    // and letting it through would hand back a narrower window than the caller
    // would have had. Stop and fall through to the newest run.
    if (span < FORECAST_MIN_WINDOW_MS) break
    const coverage = coverageOf(w)
    if (coverage.occupied >= need) return { window: w, coverage, sparse: false }
  }
  const last = rs[rs.length - 1]
  const whole = points[points.length - 1].ts - points[0].ts
  return {
    window: last,
    coverage: coverageOf(points),
    // A host that is simply young is not sparse — it gets the 'too-few-points'
    // or 'window-too-short' refusal it has always had, which tells the operator
    // to wait rather than to change anything.
    sparse: whole >= FORECAST_MIN_WINDOW_MS
  }
}

function resolutionOf(points: TrendPoint[]): 'full' | 'hourly' | 'mixed' {
  let full = false
  let hourly = false
  for (const p of points) {
    if (p.res === 'full') full = true
    else hourly = true
    if (full && hourly) return 'mixed'
  }
  return full ? 'full' : 'hourly'
}

/**
 * When this series crosses `threshold`, or why that question has no answer.
 *
 * WHICH STRETCH IT IS FITTED ON depends on what kind of quantity it is, and
 * that is the whole of the redesign — see CAPACITY_METRIC_DOMAIN.
 *
 * A 'rate' is fitted on the MOST RECENT contiguous run only. A CPU has no
 * memory of the hours nobody watched, so a line across a silence is drawn
 * through nothing that was ever true.
 *
 * A 'level' is fitted across the silences, over the longest window whose
 * samples are actually SPREAD through it. A disk keeps filling while the app
 * is shut, so the reading after a gap is a real measurement of the same
 * accumulating quantity, and refusing to use it does not make the answer safer
 * — it makes there be no answer. Measured on a real host, the old rule read
 * five hundred samples over thirty days and fitted two hundred and ninety-one
 * of them spanning ten hours, because a laptop sleeps.
 *
 * What replaces contiguity as the guard is three things together, and none of
 * them is sufficient alone: occupancy (`Coverage`), which refuses a clump
 * dressed up as a window; r2, which refuses a line the points do not sit on;
 * and the step rule, now bounded in time so that accumulated growth across a
 * gap is not mistaken for an event.
 */
export function forecast(
  points: TrendPoint[],
  threshold: number,
  now: number,
  mode: 'level' | 'rate' = 'level'
): Forecast {
  if (points.length === 0) return { ok: false, reason: 'no-data', from: 0, to: 0, points: 0 }

  const all = runs(points)
  const chosen =
    mode === 'rate'
      ? { window: all[all.length - 1], coverage: coverageOf(all[all.length - 1]), sparse: false }
      : fitWindow(points)
  const window = chosen.window
  const from = window[0].ts
  const to = window[window.length - 1].ts
  const refuse = (reason: RefusalReason): ForecastRefused => ({
    ok: false,
    reason,
    from,
    to,
    points: window.length,
    coverage: chosen.coverage
  })

  // Staleness is asked of the SERIES, not of the chosen window: a host that
  // stopped reporting yesterday is stale whichever stretch of its past the
  // window rule settled on.
  const newest = points[points.length - 1].ts
  if (now - newest > FORECAST_MAX_STALE_MS) return refuse('stale')
  if (chosen.sparse) {
    // The span reported is the WHOLE series, because the sentence is "over
    // thirty days we looked in two parts of ten" — describing only the clump
    // would hide the very thing being refused.
    return {
      ok: false,
      reason: 'sparse',
      from: points[0].ts,
      to: newest,
      points: points.length,
      coverage: chosen.coverage
    }
  }
  if (window.length < FORECAST_MIN_POINTS) return refuse('too-few-points')
  const span = to - from
  if (span < FORECAST_MIN_WINDOW_MS) return refuse('window-too-short')
  if (window[window.length - 1].v >= threshold) return refuse('already-past')

  const { slope, intercept, r2, x0 } = fit(window)
  const rise = slope * span
  if (rise <= -FORECAST_FLAT_RISE_PCT) return refuse('falling')
  if (rise < FORECAST_FLAT_RISE_PCT) return refuse('flat')
  if (r2 < FORECAST_MIN_R2) return refuse('noisy')
  if (largestJump(window, GAP_MIN_MS) >= FORECAST_STEP_SHARE * rise) return refuse('step-change')

  // slope > 0 here: `rise` is slope * span with both positive.
  const at = x0 + (threshold - intercept) / slope
  const days = Math.max(0, (at - now) / DAY_MS)
  if (days > FORECAST_HORIZON_DAYS) return refuse('beyond-horizon')

  const spanDays = span / DAY_MS
  const confidence =
    r2 >= 0.9 && spanDays >= 3 ? 'high' : r2 >= 0.7 && spanDays >= 1 ? 'medium' : 'low'
  return {
    ok: true,
    at,
    days,
    threshold,
    perDay: slope * DAY_MS,
    r2,
    confidence,
    from,
    to,
    points: window.length,
    res: resolutionOf(window),
    coverage: chosen.coverage
  }
}

/** Where the full-resolution tier starts, when the window holds both tiers.
 *  Null when it holds only one: there is no boundary to draw. */
export function resolutionBoundary(points: TrendPoint[]): number | null {
  let sawHourly = false
  for (const p of points) {
    if (p.res === 'hourly') sawHourly = true
    else if (sawHourly) return p.ts
  }
  return null
}

export interface ReportOptions {
  now: number
  from: number
  to: number
  /** Per metric. A metric with no threshold gets a line and no forecast, which
   *  is the right answer for cpu: a CPU does not fill up. */
  thresholds: Partial<Record<CapacityMetric, number>>
  fullResolutionDays: number
  retainedDays: number
  maxPoints?: number
  /** Per metric, fitted by the caller. Only diskPct ever carries one — see
   *  `Trend.bytes`. */
  bytes?: Partial<Record<CapacityMetric, BytesReading>>
  /** Moments the sampler started again after being stopped: app launch, and
   *  the machine waking. A gap spanning one of these is a gap OpsMaxx caused,
   *  and `segments` marks it so the panel can say which kind of silence it is
   *  looking at. */
  resumedAt?: number[]
}

/**
 * The whole answer for one host, from series the caller has already read.
 *
 * Takes points rather than a store handle so that it is pure: main reads,
 * this decides, and the report crosses IPC as an answer rather than as a
 * table of samples.
 */
export function buildCapacityReport(
  hostId: string,
  series: Partial<Record<CapacityMetric, TrendPoint[]>>,
  opts: ReportOptions
): CapacityReport {
  const maxPoints = Math.max(2, opts.maxPoints ?? CHART_MAX_POINTS)
  const trends: Trend[] = CAPACITY_METRICS.map((metric) => {
    const points = series[metric] ?? []
    const threshold = opts.thresholds[metric]
    const segs = segments(points, opts.resumedAt ?? [])
    // One bucket size for the whole trend, so the two sides of a resolution
    // boundary stay comparable to the eye.
    const bucketMs = Math.max(1, Math.ceil((opts.to - opts.from) / maxPoints))
    let low: number | null = null
    let high: number | null = null
    for (const p of points) {
      const lo = p.min ?? p.v
      const hi = p.max ?? p.v
      low = low === null ? lo : Math.min(low, lo)
      high = high === null ? hi : Math.max(high, hi)
    }
    return {
      metric,
      segments: segs.map((s) => downsample(s, bucketMs)),
      read: points.length,
      latest: points.length === 0 ? null : points[points.length - 1],
      low,
      high,
      resolutionBoundary: resolutionBoundary(points),
      forecast:
        threshold === undefined
          ? null
          : forecast(points, threshold, opts.now, CAPACITY_METRIC_DOMAIN[metric]),
      bytes: opts.bytes?.[metric] ?? null
    }
  })
  return {
    hostId,
    from: opts.from,
    to: opts.to,
    now: opts.now,
    fullResolutionDays: opts.fullResolutionDays,
    retainedDays: opts.retainedDays,
    trends
  }
}

/**
 * The default thresholds a capacity question is asked against.
 *
 * 90% for both, and deliberately NOT the 85% `hostHealth.DISK_DANGER` uses.
 * That number answers "is this host in trouble now" and turns a bar red; this
 * one answers "when will it be", and forecasting the moment a warning appears
 * would make the panel say "fills in 3 days" about a host that has three days
 * until it goes amber, not until it goes wrong. cpu has none: a CPU at 100%
 * is busy, not full.
 */
export const CAPACITY_THRESHOLDS: Partial<Record<CapacityMetric, number>> = {
  diskPct: 90,
  memPct: 90,
  // The same 90 as disk, and for the same reason -- but the failure it
  // forecasts is nastier. A filesystem out of inodes cannot create a file while
  // `df -h` still reports free space, so the error every program gives is "No
  // space left on device" on a disk that visibly has some.
  inodePct: 90
}

/**
 * What the preload must expose for the panel to work.
 *
 * Declared here, and the preload annotated with it, so the two halves can land
 * in separate diffs and type-check against one contract — the same arrangement
 * as DockerBridge. The renderer treats it as Partial: a build where the
 * preload half has not landed must show a panel that says so rather than throw
 * `undefined is not a function`.
 */

export interface CapacityBridge {
  trends(hostId: string, windowDays: number): Promise<CapacityReport | null>
  /**
   * A database's size series, forecast in BYTES.
   *
   * A separate channel and a separate return type, not a tenth metric on
   * `trends`: this file is percentages only and says so at the top, and its
   * thresholds and flat rule mean nothing against a byte count. `ceilingBytes`
   * comes from the caller because nothing in this app knows one.
   */
  dbGrowth?(
    connectionId: string,
    windowDays: number,
    ceilingBytes?: number
  ): Promise<BytesReading | null>
}

/**
 * The byte ceiling a disk is forecast against.
 *
 * The same percentage the percent-domain row uses, applied to the filesystem's
 * usable size -- derived from CAPACITY_THRESHOLDS rather than written out
 * again, so that the two sentences about one disk cannot drift apart in a later
 * edit.
 *
 * `usableBytes` is HostMetrics.diskCapacity, not diskTotal, and the difference
 * is not pedantry: df's Capacity column excludes the blocks ext4 reserves for
 * root, so on a default filesystem 90% of the raw total is about four and a
 * half points of disk LATER than the 90% the row above reports. On a 193 GiB
 * disk that is roughly nine gigabytes, or weeks, of disagreement between two
 * lines of the same panel.
 */
export function diskCeilingBytes(usableBytes: number): number | null {
  const pct = CAPACITY_THRESHOLDS.diskPct
  return pct === undefined || usableBytes <= 0 ? null : (pct / 100) * usableBytes
}

/**
 * `bytesForecast`'s policy, for a disk rather than for a database.
 *
 * That file's own constants were tuned for a series written when somebody opens
 * a database panel: its minimum window is 24 hours against this file's 6, and
 * it tolerates 14 DAYS of staleness against this file's 6 hours. Left alone,
 * the byte line would cheerfully forecast a disk that had been silent for a
 * week while the percentage line directly above it said `stale` -- two
 * sentences about one disk, disagreeing, which is the failure this whole panel
 * is written against.
 *
 * The flat rule is replaced outright rather than scaled. `BYTES_FLAT_RISE_SHARE`
 * is two percent of how big the thing already is, which is the right rule for a
 * database, where "big" is relative and nobody set a ceiling. A disk HAS a
 * ceiling and the row above already defines what flat means on it: half a
 * percentage point of the filesystem. So that is what it means here, in bytes.
 */
export function diskBytesPolicy(usableBytes: number): BytesPolicy {
  return {
    minWindowMs: FORECAST_MIN_WINDOW_MS,
    maxStaleMs: FORECAST_MAX_STALE_MS,
    horizonDays: FORECAST_HORIZON_DAYS,
    flatRiseBytes: (FORECAST_FLAT_RISE_PCT / 100) * usableBytes,
    // The same bound, for the same reason, as the percent-domain rule next
    // door: growth accumulated across a silence is not a step. See largestJump.
    maxJumpSpanMs: GAP_MIN_MS
  }
}

/** The windows the panel offers. A day, a week (exactly the full-resolution
 *  horizon), a month and the whole of what item A retains. */
export const CAPACITY_WINDOWS = [1, 7, 30, 90] as const
