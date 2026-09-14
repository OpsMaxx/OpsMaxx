// Item 47's fleet expansion forecast: one line for the whole estate, soonest
// first.
//
// `capacity.ts` already answers "when does THIS host's disk fill" and, far more
// often, why it will not say. This rolls that up across the fleet, and the
// roadmap row named the design in four words: REFUSAL-FIRST IS THE FEATURE.
//
// WHAT THAT MEANS HERE. A fleet view is a ranking, and a ranking needs a number
// to sort by. Hosts that produced no number are the majority on any real estate
// -- a host sampled for two hours, a host that stopped reporting, a host whose
// disk is flat -- and the obvious shapes for them are both wrong:
//
//   * Dropping them makes "nothing is filling up" and "eleven hosts could not
//     be forecast" render identically. That is the sentence this whole feature
//     exists to prevent.
//   * Sorting them last with a sentinel date puts a host that is ALREADY OVER
//     its threshold below one that fills in eighty days, because `already-past`
//     produces no crossing time at all.
//
// So the ranking has three bands, and the band comes before the date:
// `already-past` first, then real crossings soonest first, then everything that
// was refused with the reason it was refused. The count of each band travels
// with the list, because "3 of 14 hosts could be forecast" is the honest
// headline and "2 hosts fill within a week" on its own is not.

import type { CapacityMetric, CapacityReport, Forecast, RefusalReason, Trend } from './capacity'
import { formatBytes } from './bytesForecast'

export interface FleetForecastInput {
  hostId: string
  hostName: string
  metric: CapacityMetric
  forecast: Forecast
}

export type ForecastBand = 'over' | 'crossing' | 'refused'

export interface FleetForecastRow {
  hostId: string
  hostName: string
  metric: CapacityMetric
  band: ForecastBand
  /** Epoch ms of the predicted crossing. Null in every other band. */
  crossesAt: number | null
  /** Days to it, rounded down. Null in every other band. */
  days: number | null
  /** Set on `refused` AND on `over` -- `already-past` is a refusal in
   *  `capacity.ts` that this promotes, and keeping the reason lets the row say
   *  which one it was. */
  reason: RefusalReason | null
  confidence: 'low' | 'medium' | 'high' | null
  /** The whole sentence, ready to print. */
  because: string
}

/** How long a forecast's own window was, in hours, for the sentence. */
function windowHours(f: Forecast): number {
  return Math.max(0, Math.round((f.to - f.from) / 3_600_000))
}

const METRIC_WORD: Record<CapacityMetric, string> = {
  cpu: 'CPU',
  memPct: 'memory',
  diskPct: 'disk',
  inodePct: 'inodes'
}

/**
 * Why no forecast, in the operator's words rather than the enum's.
 *
 * Every one of these is a different thing to DO about it, which is the reason
 * they are not collapsed into "not enough data": a `stale` host needs somebody
 * to look at why it stopped reporting, a `too-few-points` host needs nothing at
 * all but time, and a `step-change` host needs somebody to find out what was
 * untarred.
 */
export const FORECAST_REFUSAL_WORDS: Record<RefusalReason, string> = {
  'no-data': 'nothing was sampled in this window',
  stale: 'it stopped reporting, so a forecast would be about the past',
  'too-few-points': 'too few samples yet',
  'window-too-short': 'the samples cover too short a stretch to have a rate',
  'already-past': 'it is already at or over the threshold',
  flat: 'it is not moving enough to call a trend',
  falling: 'it is going down',
  noisy: 'the readings scatter too far from any line to extrapolate',
  'step-change': 'the rise is one jump rather than a trend, so something was added at once',
  'beyond-horizon': 'the rate is real but the crossing is beyond the horizon this will predict',
  sparse:
    'the samples sit in too few parts of the window to describe it, so a line through them would be about those hours instead'
}

/**
 * One row.
 *
 * No `now` parameter, deliberately. `ForecastMade.days` is already relative to
 * the `now` the forecast was COMPUTED with, and recomputing it against a
 * different clock here would silently disagree with the per-host panel showing
 * the same number.
 */
export function fleetForecastRow(input: FleetForecastInput): FleetForecastRow {
  const { hostId, hostName, metric, forecast: f } = input
  const what = METRIC_WORD[metric]
  if (f.ok) {
    return {
      hostId,
      hostName,
      metric,
      band: 'crossing',
      crossesAt: f.at,
      days: f.days,
      reason: null,
      confidence: f.confidence,
      because:
        `${hostName}: ${what} reaches ${f.threshold}% in ${f.days} day(s), ` +
        // The window is not a footnote. "Fills in 11 days" is not an honest
        // sentence; "from 6 hours of data" is what makes it one.
        `from ${windowHours(f)}h of data (${f.confidence} confidence).`
    }
  }
  // `already-past` is promoted out of the refusals. It is the only one that
  // describes a host in trouble RIGHT NOW, and leaving it at the bottom of a
  // list sorted by urgency would bury the single most urgent row.
  if (f.reason === 'already-past') {
    return {
      hostId,
      hostName,
      metric,
      band: 'over',
      crossesAt: null,
      days: null,
      reason: 'already-past',
      confidence: null,
      because: `${hostName}: ${what} is already at or over its threshold.`
    }
  }
  return {
    hostId,
    hostName,
    metric,
    band: 'refused',
    crossesAt: null,
    days: null,
    reason: f.reason,
    confidence: null,
    because: `${hostName}: no ${what} forecast — ${FORECAST_REFUSAL_WORDS[f.reason]}.`
  }
}

const BAND_ORDER: Record<ForecastBand, number> = { over: 0, crossing: 1, refused: 2 }

export interface FleetForecast {
  rows: FleetForecastRow[]
  /** How many hosts-and-metrics landed in each band. */
  counts: Record<ForecastBand, number>
  /** The status-bar line. Never only the crossings. */
  headline: string
  /** The soonest real crossing, or null. */
  soonest: FleetForecastRow | null
}

/**
 * The estate, ranked.
 *
 * Band first and date second. Within `refused`, rows keep a stable order by
 * reason then host so the list does not reshuffle between refreshes for a
 * reason nobody can see.
 */
export function buildFleetForecast(inputs: FleetForecastInput[]): FleetForecast {
  const rows = inputs
    .map((i) => fleetForecastRow(i))
    .sort(
      (a, b) =>
        BAND_ORDER[a.band] - BAND_ORDER[b.band] ||
        (a.crossesAt ?? 0) - (b.crossesAt ?? 0) ||
        (a.reason ?? '').localeCompare(b.reason ?? '') ||
        a.hostName.localeCompare(b.hostName) ||
        a.metric.localeCompare(b.metric)
    )
  const counts: Record<ForecastBand, number> = { over: 0, crossing: 0, refused: 0 }
  for (const r of rows) counts[r.band] += 1
  const soonest = rows.find((r) => r.band === 'crossing') ?? null

  return { rows, counts, headline: forecastHeadline(counts, soonest), soonest }
}

/**
 * The one line.
 *
 * IT ALWAYS CARRIES THE REFUSAL COUNT. A status bar reading "nothing fills
 * within 90 days" on an estate where eleven of fourteen hosts could not be
 * forecast is the most reassuring thing this app could print and one of the
 * least true, so the denominator is in the sentence rather than behind a
 * hover.
 */
export function forecastHeadline(
  counts: Record<ForecastBand, number>,
  soonest: FleetForecastRow | null
): string {
  const total = counts.over + counts.crossing + counts.refused
  if (total === 0) return 'No host has been sampled for long enough to say anything about capacity.'
  const forecastable = counts.over + counts.crossing
  const of = `${forecastable} of ${total} could be forecast`
  if (counts.over > 0) {
    return `${counts.over} already over threshold; ${of}.`
  }
  if (soonest !== null && soonest.days !== null) {
    return `Soonest: ${soonest.hostName} in ${soonest.days} day(s); ${of}.`
  }
  return `Nothing is forecast to cross a threshold; ${of}.`
}


// ---------------------------------------------------------------------------
// The digest -- one host's report as sentences, for an agent.
// ---------------------------------------------------------------------------
//
// It lives in this file rather than a new one because this file is already
// "the forecast in the operator's words": FORECAST_REFUSAL_WORDS and
// METRIC_WORD are here, and a second home for those sentences would be a
// second place for them to drift from what the panel says.
//
// WHAT IT REPLACES. `get_capacity_trends` used to return the whole
// CapacityReport as pretty-printed JSON. Measured against a real host over a
// thirty-day window that was about ten kilobytes: five hundred chart points
// across four metrics, and every conclusion in it the single word "flat". An
// agent then has to reduce that to a sentence -- doing, differently and worse,
// arithmetic this code has already done -- and the chart points it paid for
// exist to be drawn, which an agent cannot do. The renderer keeps the full
// report on its own channel, where the points are the point.

const DAY = 86_400_000
const HOUR = 3_600_000

/** A span in the coarsest unit that does not overstate it. The renderer has its
 *  own richer version; this one exists so the digest needs no renderer code. */
function plainSpan(ms: number): string {
  const abs = Math.abs(ms)
  if (abs < 2 * DAY) {
    const h = Math.max(1, Math.round(abs / HOUR))
    return `${h} hour${h === 1 ? '' : 's'}`
  }
  const d = Math.round(abs / DAY)
  return `${d} day${d === 1 ? '' : 's'}`
}

function pct(n: number): string {
  return `${Math.round(n * 10) / 10}%`
}

/** The coverage clause, which never appears without a number it qualifies. */
function coverageClause(f: Forecast): string {
  const c = f.coverage
  if (c === undefined) return ''
  return `, ${c.occupied} of ${c.parts} parts of it sampled`
}

/**
 * One metric's line.
 *
 * Every branch either states a rate or names a refusal, and a stated rate never
 * appears without the window it was drawn from -- the same rule the panel is
 * held to, for the same reason: "fills in 11 days" is not an honest sentence
 * and "fills in 11 days, from 21 days of data" is.
 */
function trendLine(t: Trend): string {
  // METRIC_WORD is written for mid-sentence use in the fleet rows next door
  // ("web-01: disk reaches 90%..."). Here each metric starts its own line, so
  // it starts with a capital -- the words themselves stay in one place.
  const word = METRIC_WORD[t.metric]
  const what = word.charAt(0).toUpperCase() + word.slice(1)
  const now = t.latest === null ? null : pct(t.latest.v)
  const head = now === null ? `${what}: no samples in this window.` : `${what}: ${now} now`

  if (t.latest === null) return head

  // cpu. It has no threshold and never will: a CPU at 100% is busy, not full.
  // Saying nothing at all -- which is what `forecast: null` rendered as -- left
  // an agent to decide for itself whether that was an error.
  if (t.forecast === null) {
    const range =
      t.low === null || t.high === null ? '' : `, ${pct(t.low)}-${pct(t.high)} across the window`
    return `${head}${range}. No forecast: a CPU does not fill up.`
  }

  const f = t.forecast
  // `?? null` rather than a bare read: this is the MCP path, and a Trend that
  // reached it without the field -- an older report shape, a caller that built
  // one by hand -- must produce a sentence without the byte half, not a
  // TypeError where the agent expected an answer.
  const bytes = t.bytes ?? null
  // The byte answer leads for disk when there is one, because it is the precise
  // one -- the percentage it sits beside is df's rounded integer.
  const size =
    bytes !== null && bytes.latest !== null ? ` (${formatBytes(bytes.latest)} used)` : ''

  if (f.ok) {
    const rate = `${f.perDay > 0 ? '+' : ''}${Math.round(f.perDay * 100) / 100} points a day`
    return (
      `${head}${size}, ${rate}. Reaches ${f.threshold}% in ${Math.floor(f.days)} day(s), ` +
      `${f.confidence} confidence, from ${plainSpan(f.to - f.from)} of data${coverageClause(f)}.`
    )
  }

  // A refusal that still has a rate is the useful half kept: "no crossing date,
  // but it is growing 180 MiB a day" is something to act on, and withholding it
  // because the percentage row could not name a date would be withholding it
  // for the wrong reason.
  const kept =
    bytes !== null && bytes.perDay !== null
      ? ` It is still growing ${formatBytes(bytes.perDay)} a day over ${plainSpan(bytes.to - bytes.from)}.`
      : ''
  return `${head}${size}. No forecast: ${FORECAST_REFUSAL_WORDS[f.reason]}.${kept}`
}

/**
 * The whole answer for one host, in sentences.
 *
 * `hostName` is the friendly name the caller already resolved; this file never
 * sees a hostname or an address.
 */
export function capacityDigest(report: CapacityReport, hostName: string): string {
  const window = plainSpan(report.to - report.from)
  const read = report.trends.reduce((n, t) => Math.max(n, t.read), 0)
  if (read === 0) {
    return (
      `${hostName}: nothing has been recorded in the last ${window}, so there is nothing to ` +
      `forecast. This does not mean the server has spare capacity. Samples are collected while ` +
      `OpsMaxx is running with background checking on, and kept for ${report.retainedDays} days.`
    )
  }
  return [`${hostName} - capacity over the last ${window}.`, ...report.trends.map(trendLine)].join(
    '\n'
  )
}
