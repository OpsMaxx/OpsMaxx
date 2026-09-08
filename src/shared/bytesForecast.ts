// Item 47's database growth series, and the reason it needed a second
// forecaster rather than a third metric in `capacity.ts`.
//
// THAT FILE IS PERCENTAGES ONLY, AND SAYS SO. Its whole refusal policy rests on
// it: `FORECAST_FLAT_RISE_PCT = 0.5` can be one number for cpu, memory and disk
// because all three are 0-100. In bytes it means nothing. Half a byte over a
// week is noise on any database; half a gigabyte is noise on a 400 GB one and a
// crisis on a 2 GB one. A flat rule for bytes has to be RELATIVE to how big the
// thing already is.
//
// AND THERE IS NO 90%. A percentage series carries its own ceiling. Bytes do
// not: a database is "too big" relative to a disk, a quota or somebody's
// judgement, and this build knows none of those unless it is told. So a ceiling
// is optional, and its absence is a refusal of its own rather than being folded
// into "not enough data".
//
// WHICH LEADS TO THE ONE REAL DESIGN DECISION HERE. When there is no ceiling,
// the RATE is still the answer: "this database has grown 380 MB a day for six
// days" is actionable, and refusing to say it because nobody set a limit would
// be withholding the useful half. So a reading can carry a rate with no
// crossing, and the two are separate fields rather than one nullable date.

export interface BytesPoint {
  ts: number
  /** Bytes. Structurally the history store's `SeriesPoint.v`. */
  v: number
}

export type BytesRefusal =
  | 'no-data'
  | 'stale'
  | 'too-few-points'
  | 'window-too-short'
  | 'flat'
  | 'shrinking'
  | 'noisy'
  | 'step-change'
  /** A rate was found, and nothing said how big is too big. */
  | 'no-ceiling'
  /** Already at or over the ceiling. */
  | 'already-past'
  | 'beyond-horizon'

export const BYTES_REFUSAL_WORDS: Record<BytesRefusal, string> = {
  'no-data': 'nothing has been recorded for it',
  stale: 'the last reading is too old to extrapolate from',
  'too-few-points': 'too few readings yet',
  'window-too-short': 'the readings cover too short a stretch to have a rate',
  flat: 'it is not growing enough to call it growth',
  shrinking: 'it is getting smaller',
  noisy: 'the readings scatter too far from any line',
  'step-change': 'the growth is one jump rather than a trend, so something was loaded at once',
  'no-ceiling': 'nothing has said how big is too big for it',
  'already-past': 'it is already at or over the size it was given',
  'beyond-horizon': 'the rate is real but the crossing is beyond the horizon this will predict'
}

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** Below this many readings, no rate. The same twelve `capacity.ts` uses, and
 *  for the same reason: few enough to be reachable, many enough that one bad
 *  reading cannot set the slope. */
export const BYTES_MIN_POINTS = 12

/** A database read is on demand, not on a two-minute sweep, so the window has
 *  to be longer than the metric sampler's before a slope means anything. */
export const BYTES_MIN_WINDOW_MS = 24 * HOUR_MS

/** Older than this and the series is about a database nobody has opened since. */
export const BYTES_MAX_STALE_MS = 14 * DAY_MS

/**
 * The flat rule, RELATIVE.
 *
 * The run must grow by at least this share of its own starting size over its
 * own window. Two percent of a 10 GB database is 200 MB, which is far more than
 * a checkpoint, a vacuum or a rounding difference moves it; two percent of a
 * 10 MB one is 200 KB, which is a real change at that scale.
 *
 * A POLICY NUMBER, chosen rather than measured, and exported so a test states
 * it and a reader sees the whole policy in one place -- the same standing as
 * `FORECAST_FLAT_RISE_PCT` next door.
 */
export const BYTES_FLAT_RISE_SHARE = 0.02

export const BYTES_MIN_R2 = 0.5
export const BYTES_STEP_SHARE = 0.6
export const BYTES_HORIZON_DAYS = 365

export interface BytesReading {
  /** Bytes per day, positive, when a rate was found. Null when it was refused
   *  before one could be. */
  perDay: number | null
  /** When the line reaches the ceiling. Null when there is no ceiling, or when
   *  the crossing was refused. */
  crossesAt: number | null
  days: number | null
  /** Why there is no crossing. Null only when there IS one. */
  refusal: BytesRefusal | null
  r2: number | null
  confidence: 'low' | 'medium' | 'high' | null
  from: number
  to: number
  points: number
  /** The newest size read, for the sentence. Null when nothing was read. */
  latest: number | null
}

function fit(run: BytesPoint[]): { slope: number; intercept: number; r2: number; x0: number } {
  const x0 = run[0].ts
  const n = run.length
  let sx = 0
  let sy = 0
  for (const p of run) {
    sx += p.ts - x0
    sy += p.v
  }
  const mx = sx / n
  const my = sy / n
  let num = 0
  let den = 0
  for (const p of run) {
    const dx = p.ts - x0 - mx
    num += dx * (p.v - my)
    den += dx * dx
  }
  const slope = den === 0 ? 0 : num / den
  const intercept = my - slope * mx
  let ssTot = 0
  let ssRes = 0
  for (const p of run) {
    const pred = intercept + slope * (p.ts - x0)
    ssTot += (p.v - my) ** 2
    ssRes += (p.v - pred) ** 2
  }
  const r2 = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot)
  return { slope, intercept, r2, x0 }
}

function largestJump(run: BytesPoint[]): number {
  let worst = 0
  for (let i = 1; i < run.length; i++) worst = Math.max(worst, run[i].v - run[i - 1].v)
  return worst
}

/**
 * Growth, and where it ends up.
 *
 * `ceiling` is bytes, or null when nobody has said. A null ceiling refuses the
 * CROSSING and keeps the RATE, which is the whole point of this shape.
 */
export function forecastBytes(
  points: BytesPoint[],
  ceiling: number | null,
  now: number
): BytesReading {
  const empty = (refusal: BytesRefusal, from = 0, to = 0, n = 0): BytesReading => ({
    perDay: null,
    crossesAt: null,
    days: null,
    refusal,
    r2: null,
    confidence: null,
    from,
    to,
    points: n,
    latest: points.length === 0 ? null : points[points.length - 1].v
  })

  if (points.length === 0) return empty('no-data')
  const run = [...points].sort((a, b) => a.ts - b.ts)
  const from = run[0].ts
  const to = run[run.length - 1].ts
  const latest = run[run.length - 1].v

  if (now - to > BYTES_MAX_STALE_MS) return empty('stale', from, to, run.length)
  if (run.length < BYTES_MIN_POINTS) return empty('too-few-points', from, to, run.length)
  const span = to - from
  if (span < BYTES_MIN_WINDOW_MS) return empty('window-too-short', from, to, run.length)

  const { slope, intercept, r2, x0 } = fit(run)
  const rise = slope * span
  // Relative to where the run STARTED. For a series that only grows the two
  // choices agree -- the arithmetic makes them agree, since a rise big enough
  // to clear 2% of the start is big enough to clear 2% of the end and vice
  // versa -- so this is a choice about which number is STABLE rather than a
  // behaviour difference. The latest reading moves with every vacuum and
  // checkpoint; the run's first reading does not move at all.
  const floor = Math.max(1, Math.abs(run[0].v)) * BYTES_FLAT_RISE_SHARE
  if (rise <= -floor) return empty('shrinking', from, to, run.length)
  if (rise < floor) return empty('flat', from, to, run.length)
  if (r2 < BYTES_MIN_R2) return empty('noisy', from, to, run.length)
  if (largestJump(run) >= BYTES_STEP_SHARE * rise) return empty('step-change', from, to, run.length)

  const spanDays = span / DAY_MS
  const perDay = slope * DAY_MS
  const confidence: 'low' | 'medium' | 'high' =
    r2 >= 0.9 && spanDays >= 7 ? 'high' : r2 >= 0.7 && spanDays >= 3 ? 'medium' : 'low'
  const base = {
    perDay,
    r2,
    confidence,
    from,
    to,
    points: run.length,
    latest
  }

  // A rate WITH a refusal: the useful half is kept.
  if (ceiling === null) {
    return { ...base, crossesAt: null, days: null, refusal: 'no-ceiling' }
  }
  if (latest >= ceiling) {
    return { ...base, crossesAt: null, days: null, refusal: 'already-past' }
  }
  const at = x0 + (ceiling - intercept) / slope
  const days = Math.max(0, (at - now) / DAY_MS)
  if (days > BYTES_HORIZON_DAYS) {
    return { ...base, crossesAt: null, days: null, refusal: 'beyond-horizon' }
  }
  return { ...base, crossesAt: at, days, refusal: null }
}

/** Bytes, as an operator reads them. Binary units, because a database reports
 *  its size in bytes and every tool that shows it uses GiB. */
export function formatBytes(n: number): string {
  const abs = Math.abs(n)
  if (abs < 1024) return `${Math.round(n)} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let v = n / 1024
  let i = 0
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v >= 100 || v <= -100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/**
 * The sentence.
 *
 * The RATE leads whenever there is one, because it is true regardless of
 * whether anybody set a ceiling, and it is the number somebody acts on.
 */
export function bytesHeadline(name: string, r: BytesReading): string {
  const size = r.latest === null ? '' : ` It is ${formatBytes(r.latest)} now.`
  if (r.perDay === null) {
    return `No growth reading for ${name}: ${BYTES_REFUSAL_WORDS[r.refusal ?? 'no-data']}.${size}`
  }
  const rate = `${name} is growing ${formatBytes(r.perDay)} a day (${r.confidence} confidence, from ${Math.round((r.to - r.from) / DAY_MS)} days of readings).`
  if (r.refusal === null && r.days !== null) {
    return `${rate} At that rate it reaches its ceiling in ${Math.floor(r.days)} day(s).${size}`
  }
  return `${rate} No crossing date: ${BYTES_REFUSAL_WORDS[r.refusal ?? 'no-ceiling']}.${size}`
}
