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

import type { CapacityMetric, Forecast, RefusalReason } from './capacity'

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
  'beyond-horizon': 'the rate is real but the crossing is beyond the horizon this will predict'
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
