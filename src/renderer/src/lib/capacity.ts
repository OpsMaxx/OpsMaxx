import {
  FORECAST_HORIZON_DAYS,
  FORECAST_MIN_POINTS,
  FORECAST_MIN_WINDOW_MS,
  type CapacityMetric,
  type Forecast,
  type Trend,
  type TrendSegment
} from '../../../shared/capacity'
import type { MessageKey } from '../../../shared/i18n'
import { t } from './i18n'

// Turning a capacity report into words and a shape — roadmap item 26.
//
// The arithmetic is all in src/shared/capacity.ts, where main can run it too.
// What is here is presentation, and it has one job beyond looking right: it
// must not be able to say more than the report does.
//
// That is a real risk and not a stylistic one. Every sentence below either
// carries the window the number came from or is a refusal that names its
// reason. "Fills in 11 days" rendered on its own is the failure the whole item
// is written against — an operator reads it, plans around it, finds the disk at
// the same 74% a fortnight later and never trusts the panel again. The window
// is what lets them judge it: eleven days from six days of data is worth acting
// on, eleven days from seven hours is not.

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

// Getters, so each read is in the current language.
export const METRIC_LABEL: Record<CapacityMetric, string> = {
  get cpu() {
    return t('lib.capacity.metric.cpu')
  },
  get memPct() {
    return t('lib.capacity.metric.memPct')
  },
  get diskPct() {
    return t('lib.capacity.metric.diskPct')
  },
  // Not "Inodes": the word means nothing to most people and the panel is read
  // in a hurry. What runs out is the ability to create files.
  get inodePct() {
    return t('lib.capacity.metric.inodePct')
  }
}

/** The same names mid-sentence, where a language may want them in another case. */
const METRIC_INLINE = {
  cpu: 'lib.capacity.metricInline.cpu',
  memPct: 'lib.capacity.metricInline.memPct',
  diskPct: 'lib.capacity.metricInline.diskPct',
  inodePct: 'lib.capacity.metricInline.inodePct'
} as const satisfies Record<CapacityMetric, MessageKey>

/**
 * A span of time in the coarsest unit that does not lie about it.
 *
 * Rounded, and deliberately never to more than one decimal: "5.7 days of data"
 * suggests a precision the sampler does not have, and "137 hours" makes a
 * reader do arithmetic to find out it is under a week.
 */
export function span(ms: number): string {
  const abs = Math.abs(ms)
  if (abs < 90 * MINUTE_MS) {
    const m = Math.max(1, Math.round(abs / MINUTE_MS))
    return t('lib.capacity.span.minutes', { count: m })
  }
  if (abs < 2 * DAY_MS) {
    const h = Math.round(abs / HOUR_MS)
    return t('lib.capacity.span.hours', { count: h })
  }
  const rounded = dayCount(abs / DAY_MS)
  return t('lib.capacity.span.days', { count: rounded })
}

/**
 * The number of days `span` would print, for the places too narrow for words.
 *
 * `span` rounds — 12.7 days reads as "13 days". Two other places on the same
 * card floored it instead, so the headline said "Fills in 13 days" while the
 * line under it said "90% in 12 day(s)" and the estate column said "12d". Same
 * forecast, three renderings, two answers.
 *
 * The rule lives here once and both forms read it, rather than each site
 * picking its own. Below two days `span` switches to hours and this does not,
 * which is not a disagreement: "36 hours" and "1.5d" are the same duration,
 * unlike 12 and 13.
 */
export function dayCount(days: number): number {
  return days < 10 ? Math.round(days * 10) / 10 : Math.round(days)
}

/** A date a person can read, in their own locale. Day and month only: the year
 *  is never in doubt at a ninety-day horizon and it crowds the line. */
export function shortDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/**
 * Why there is no number, in words, including how much data the refusal is
 * about.
 *
 * A bare "not enough data" is the same dead end as no message at all: the
 * operator cannot tell whether to come back in an hour or whether this host
 * will never produce a forecast. Every branch here says what would change it.
 */
/**
 * What to do about a window that is mostly one clump, said once.
 *
 * THIS REPLACES A SENTENCE THAT WAS AN ACCUSATION. The old one was attached to
 * every "not enough data" refusal and told the operator that quitting OpsMaxx
 * broke the run, because the forecaster fitted one unbroken run and a laptop
 * shut overnight severed it. That was true of the code and it was the code that
 * was wrong: a disk keeps filling while the app is shut, so the reading after
 * the gap is a real measurement and the gap is missing evidence, not a
 * different machine. The forecaster now spans those gaps, so on
 * 'too-few-points' and 'window-too-short' the advice is simply false — those
 * hosts need time, not a settings change.
 *
 * It survives here, on 'sparse' alone, because there it is still the only thing
 * to do: a host sampled inside a single ten-hour stretch of a month has nothing
 * spread through the month to fit, and running for longer is what fixes it.
 */
const whySparse = (): string => t('lib.capacity.refusal.whySparse')

export function refusalText(
  f: Forecast & { ok: false },
  metric: CapacityMetric,
  threshold: number
): string {
  const held = f.points === 0 ? '' : span(f.to - f.from)
  const label = t(METRIC_INLINE[metric])
  switch (f.reason) {
    case 'no-data':
      return t('lib.capacity.refusal.noData')
    case 'stale':
      return t('lib.capacity.refusal.stale', { span: span(Date.now() - f.to) })
    case 'too-few-points':
      // No longer "since the last break in the data": there is no last break
      // any more, the fit spans them. This host simply needs time.
      return t('lib.capacity.refusal.tooFewPoints', {
        count: f.points,
        needed: FORECAST_MIN_POINTS,
        window: span(FORECAST_MIN_WINDOW_MS)
      })
    case 'window-too-short':
      return t('lib.capacity.refusal.windowTooShort', { held, window: span(FORECAST_MIN_WINDOW_MS) })
    case 'sparse': {
      const c = f.coverage
      return c === undefined
        ? t('lib.capacity.refusal.sparseUnknown', { advice: whySparse() })
        : t('lib.capacity.refusal.sparse', {
            occupied: c.occupied,
            parts: c.parts,
            gap: span(c.longestGapMs),
            advice: whySparse()
          })
    }
    case 'already-past':
      return t('lib.capacity.refusal.alreadyPast', { threshold })
    case 'flat':
      return t('lib.capacity.refusal.flat', { held })
    case 'falling':
      return t('lib.capacity.refusal.falling', { held })
    case 'noisy':
      return t('lib.capacity.refusal.noisy', { label })
    case 'step-change':
      return t('lib.capacity.refusal.stepChange', { held, label })
    case 'beyond-horizon':
      return t('lib.capacity.refusal.beyondHorizon', { days: FORECAST_HORIZON_DAYS })
  }
}

/**
 * The sentence. The whole item is this sentence being true.
 *
 * Both halves are mandatory: what it concludes, and the window it concluded it
 * from. There is no formatting option that drops the second half.
 */
export function forecastText(f: Forecast, metric: CapacityMetric, threshold: number): string {
  if (!f.ok) return refusalText(f, metric, threshold)
  const vars = {
    threshold: f.threshold,
    span: span(f.days * DAY_MS),
    date: shortDate(f.at),
    held: span(f.to - f.from)
  }
  // The coverage clause joins the window clause as the second half that cannot
  // be dropped: "from 21 days of data" reads as 21 days of watching, and on a
  // desktop app it never is.
  if (f.coverage === undefined) {
    return f.days < 1 ? t('lib.capacity.forecast.withinDay', vars) : t('lib.capacity.forecast.inSpan', vars)
  }
  const covered = { ...vars, occupied: f.coverage.occupied, parts: f.coverage.parts }
  return f.days < 1
    ? t('lib.capacity.forecast.withinDayCovered', covered)
    : t('lib.capacity.forecast.inSpanCovered', covered)
}

/** The rate, spelled out, so the reader can sanity-check the projection
 *  against what they know about the host. */
export function rateText(f: Forecast): string {
  if (!f.ok) return ''
  const perDay = Math.round(f.perDay * 100) / 100
  return t('lib.capacity.rate', { rate: `${perDay > 0 ? '+' : ''}${perDay}` })
}

/** What the confidence label is FOR. Shown as a title, so the word is never on
 *  screen without the thing it is a judgement about. */
export const CONFIDENCE_HELP: Record<'low' | 'medium' | 'high', string> = {
  get high() {
    return t('lib.capacity.confidence.high')
  },
  get medium() {
    return t('lib.capacity.confidence.medium')
  },
  get low() {
    return t('lib.capacity.confidence.low')
  }
}

/** How the two tiers of item A's store are described on screen. The store's
 *  own words for them are 'full' and 'hourly', which mean nothing to a reader
 *  looking at a line. */
export const RES_LABEL: Record<'full' | 'hourly', string> = {
  get full() {
    return t('lib.capacity.res.full')
  },
  get hourly() {
    return t('lib.capacity.res.hourly')
  }
}

export interface Box {
  width: number
  height: number
}

export interface DrawnSegment {
  res: 'full' | 'hourly'
  /** The mean line. */
  line: string
  /** min..max as a closed area, where the tier has extremes to show. Empty for
   *  a run of single readings, which have no spread. */
  band: string
  gapBefore: number
  /** Carried through from the report: the silence before this segment has a
   *  known cause, and the label says which rather than implying the host went
   *  quiet. See TrendSegment.gapKnown. */
  gapKnown?: 'not-running'
  /** x of this segment's first point, for labelling the silence before it. */
  x0: number
}

export interface Drawing {
  segments: DrawnSegment[]
  /** x of the moment full resolution begins, or null when the window holds
   *  only one tier. */
  boundaryX: number | null
  /** y of the forecast threshold, or null when this metric has none. */
  thresholdY: number | null
}

/**
 * Geometry for one trend.
 *
 * The y axis is fixed at 0-100 rather than fitted to the data, and that is a
 * decision rather than laziness. A disk moving 64% to 74% on an axis zoomed to
 * 64-74 is a dramatic climb; the same line against 0-100 is what it actually
 * is, and the 90% threshold stays on screen where the forecast can be read
 * against it. Auto-scaling a percentage is how a chart lies without a single
 * wrong number in it.
 *
 * Each segment becomes its OWN path. Two segments are never joined, so a gap
 * in the data is a gap in the line and a change of resolution is a change of
 * line, both without any drawing code deciding to bridge them.
 */
export function draw(trend: Trend, from: number, to: number, box: Box, threshold: number | null): Drawing {
  const width = Math.max(1, box.width)
  const height = Math.max(1, box.height)
  const range = Math.max(1, to - from)
  const x = (ts: number): number => ((ts - from) / range) * width
  const y = (v: number): number => height - (Math.max(0, Math.min(100, v)) / 100) * height
  const round = (n: number): number => Math.round(n * 100) / 100

  const segments = trend.segments
    .filter((s: TrendSegment) => s.points.length > 0)
    .map((s) => {
      const line = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${round(x(p.ts))} ${round(y(p.v))}`).join(' ')
      const hasSpread = s.points.some((p) => p.min !== undefined && p.max !== undefined && p.max > p.min)
      const band = hasSpread
        ? [
            ...s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${round(x(p.ts))} ${round(y(p.max ?? p.v))}`),
            ...[...s.points].reverse().map((p) => `L${round(x(p.ts))} ${round(y(p.min ?? p.v))}`),
            'Z'
          ].join(' ')
        : ''
      return {
        res: s.res,
        line,
        band,
        gapBefore: s.gapBefore,
        ...(s.gapKnown ? { gapKnown: s.gapKnown } : {}),
        x0: round(x(s.points[0].ts))
      }
    })

  return {
    segments,
    boundaryX: trend.resolutionBoundary === null ? null : round(x(trend.resolutionBoundary)),
    thresholdY: threshold === null ? null : round(y(threshold))
  }
}
