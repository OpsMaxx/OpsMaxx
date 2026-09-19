import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronRight, RefreshCw, TrendingUp } from 'lucide-react'
import { useApp } from '../../store/app'
import {
  storageHeadline,
  type StorageLayout
} from '../../../../shared/storageLayout'
import { bytes, clsx } from '../../lib/format'
import { Sparkline } from '../common/Sparkline'
import { SweepEmpty } from './SweepEmpty'
import { PanelError } from '../common/PanelError'
import { withVaultUnlock } from '../../lib/withVaultUnlock'
import {
  CAPACITY_METRICS,
  CAPACITY_THRESHOLDS,
  CAPACITY_WINDOWS,
  FORECAST_HORIZON_DAYS,
  FORECAST_MIN_POINTS,
  FORECAST_MIN_R2,
  FORECAST_MIN_WINDOW_MS,
  FORECAST_STEP_SHARE,
  type CapacityBridge,
  type CapacityMetric,
  type CapacityReport,
  type RefusalReason,
  type Trend
} from '../../../../shared/capacity'
import {
  CONFIDENCE_HELP,
  METRIC_LABEL,
  RES_LABEL,
  draw,
  forecastText,
  rateText,
  shortDate,
  span
} from '../../lib/capacity'
import {
  buildFleetForecast,
  type FleetForecastRow,
  type FleetForecast,
  type FleetForecastInput
} from '../../../../shared/fleetForecast'
import { sshTargetFor } from '../../lib/ssh'
import type { Server } from '../../types'
import { PanelShell } from './PanelShell'
import type { OnDemandTarget } from '../../../../shared/ssh'

// "This disk fills in eleven days." — roadmap item 26.
//
// The first thing on screen that reads from item A's store. Everything here is
// derived on demand from samples the fleet sampler already writes; this panel
// stores nothing, schedules nothing and evaluates nothing in the background.
// That is what keeps item 26 the "query and a chart" the roadmap describes
// rather than the metrics warehouse it warns against.
//
// WHAT THIS SCREEN IS FOR, AND WHAT IT USED TO DO INSTEAD.
//
// A capacity trend answers one question: what is going to run out, and when.
// This panel used to answer it fourth. It printed four metrics in a fixed
// order — cpu, memory, disk, inodes — each as a 640px chart with four captions
// under it, and the one sentence anybody came for was the LAST line of each
// block. CPU, which cannot run out at all, got the same real estate as a disk
// eleven days from full. A host at 95% and flat looked exactly like a host at
// 60% climbing five points a day, because nothing on screen ranked anything.
//
// So the order is now the answer, not the metric list:
//
//  1. RANKED BY URGENCY. `rankCapacity` sorts by what the forecast SAYS —
//     already over, then soonest crossing, then a host that stopped reporting,
//     then everything with no date. A number that is not moving is not a
//     problem, and it sorts accordingly however high it is.
//  2. THE CONCLUSION IS THE HEADLINE. "Full in 11 days" is the big text; the
//     current percentage is secondary. The full sentence — with the window it
//     was drawn from, which is never optional — sits directly under it.
//  3. QUIET METRICS COLLAPSE, THEIR COUNT DOES NOT. Same rule the estate strip
//     already followed: hiding "3 of 4 could not be forecast" would be the
//     reassuring fiction this whole feature is written against.
//  4. THE MEASURED LINE IS ONE CLICK AWAY. Everything the charts used to say —
//     the resolution boundary, the silences, the spread inside each hourly
//     bucket — is unchanged and intact inside each card's disclosure. The
//     sparkline beside the headline is the glanceable version, and it is drawn
//     from the most recent unbroken run ONLY, so it can never imply a trend
//     across a silence.
//
// Three things this must never do, all of which a naive version does by
// default:
//
//  1. State a forecast without the window it came from. See forecastText: the
//     window is not an optional suffix.
//  2. Draw one line through two resolutions. The store keeps seven days at
//     full resolution and eighty-three days of hourly means, so a 30-day
//     window is half means of thirty readings and half single readings. Each
//     segment is drawn separately and the boundary is labelled.
//  3. Draw across a gap. A host unreachable for two days has no samples for two
//     days, and a line joined across that shows a trend nothing measured. The
//     silence is a hole in the line, and it is labelled too.

const CHART = { width: 640, height: 96 }
const DAY_MS = 86_400_000

function bridge(): Partial<CapacityBridge> | undefined {
  return (window.opsmaxx as unknown as { capacity?: Partial<CapacityBridge> } | undefined)?.capacity
}

function tone(v: number): string {
  return v > 85 ? 'danger' : v > 65 ? 'warn' : ''
}

// ---------------------------------------------------------------------------
// The ranking. Pure, exported, and tested against known reports.
// ---------------------------------------------------------------------------

/**
 * What kind of answer a metric produced, which is what the screen sorts on.
 *
 * Deliberately four and not three. `fleetForecast.ts` bands an estate as
 * over / crossing / refused, and that is right for a list of hosts; on ONE
 * host a refusal splits in two, because "this stopped reporting" and "this is
 * not moving" are opposite facts. The first is a hole in what we know and
 * belongs beside the crossings; the second is the good news and belongs folded
 * away.
 */
export type CapacityRank = 'over' | 'crossing' | 'stalled' | 'quiet'

const RANK_ORDER: Record<CapacityRank, number> = { over: 0, crossing: 1, stalled: 2, quiet: 3 }

export interface CapacityRow {
  trend: Trend
  rank: CapacityRank
  /** The threshold this metric is forecast against, or null where it has none
   *  (cpu). Carried so the card never has to guess one. */
  threshold: number | null
  /** Days to the crossing. Null in every rank but `crossing`. */
  days: number | null
  /** The conclusion, short enough to be the headline. The full sentence — with
   *  the window behind it — is rendered under it from forecastText, never
   *  replaced by this. */
  headline: string
  /**
   * WHICH SERIES the date came from.
   *
   * 'bytes' only ever happens on disk, and it is not a refinement — it is the
   * difference between an answer and none. `diskPct` is df's Capacity column,
   * a rounded integer, so on a 193 GiB filesystem one stored point is about
   * two gigabytes: a disk gaining a gigabyte a week does not move that series
   * for a fortnight and then moves it a whole point, which the percentage fit
   * reads as 'flat' and then 'step-change', forever. Ranking on the percentage
   * alone would file the panel's headline metric under "not moving" on exactly
   * the hosts it was built for. The card says which series it used.
   */
  basis: 'percent' | 'bytes'
  /** Ascending, WITHIN a rank only. The units differ per rank on purpose:
   *  days for a crossing, a negated percentage for a level, a timestamp for a
   *  host that went quiet. Comparing across ranks is what RANK_ORDER is for. */
  sortKey: number
}

/**
 * The word for reaching the threshold, per metric.
 *
 * "Full" is not "100%", and the card says which percentage it means on the
 * line underneath. What it must not do is make an operator read a sentence to
 * find out whether this is the urgent one.
 */
const FILL_WORD: Record<CapacityMetric, string> = {
  // Unreachable: cpu has no threshold, so it never produces a crossing. Total
  // rather than optional so that adding a metric is a compile error here.
  cpu: 'Busy',
  memPct: 'Full',
  diskPct: 'Full',
  inodePct: 'Out of inodes'
}

/**
 * The refusal, in four words instead of forty.
 *
 * It never REPLACES `refusalText` — that sentence, with its numbers and what
 * would change it, is rendered directly underneath. This is the part a reader
 * is allowed to skim.
 */
const QUIET_HEADLINE: Record<RefusalReason, string> = {
  'no-data': 'Nothing sampled in this window',
  // Both of these are reached only through their own rank; kept so the record
  // is total and a new reason cannot be added without a phrase for it.
  stale: 'Not reporting any more',
  'already-past': 'At or over the threshold',
  'too-few-points': 'Not enough history yet',
  'window-too-short': 'Not enough history yet',
  flat: 'Not moving',
  falling: 'Going down, not up',
  noisy: 'Too erratic to project',
  'step-change': 'One jump, not a trend',
  'beyond-horizon': `Further out than ${FORECAST_HORIZON_DAYS} days`,
  sparse: 'Samples too clustered to project'
}

/** One metric's place in the ranking. */
export function capacityRow(trend: Trend): CapacityRow {
  const threshold = CAPACITY_THRESHOLDS[trend.metric] ?? null
  const level = trend.latest?.v ?? null
  const f = trend.forecast

  // No threshold was asked for. A CPU at 100% is busy, not full, and saying
  // nothing at all left a reader to decide for themselves whether the blank
  // was an error.
  if (f === null) {
    return {
      trend,
      rank: 'quiet',
      threshold,
      days: null,
      basis: 'percent',
      headline: 'No ceiling — a CPU does not fill up',
      sortKey: -(level ?? -1)
    }
  }

  if (f.ok) {
    return {
      trend,
      rank: 'crossing',
      threshold,
      days: f.days,
      basis: 'percent',
      headline: fillsIn(trend.metric, f.days),
      sortKey: f.days
    }
  }

  if (f.reason === 'already-past') {
    return {
      trend,
      rank: 'over',
      threshold,
      days: null,
      basis: 'percent',
      headline:
        threshold === null ? 'At or over its threshold now' : `At or over ${threshold}% now`,
      // Worst first among several that are already over.
      sortKey: -(level ?? 0)
    }
  }

  // A host that stopped reporting is NOT good news folded away with the flat
  // ones. It is the one refusal that says the screen has stopped knowing, and
  // the oldest silence is the one to look at first.
  if (f.reason === 'stale') {
    return {
      trend,
      rank: 'stalled',
      threshold,
      days: null,
      basis: 'percent',
      headline: QUIET_HEADLINE.stale,
      sortKey: trend.latest?.ts ?? 0
    }
  }

  // The disk's real answer, where the stored percentage is too coarse to hold
  // one. See CapacityRow.basis: this is not a tie-break between two opinions,
  // it is the only series that can see a filesystem filling slowly.
  const b = trend.bytes
  if (b !== null && b.days !== null && b.crossesAt !== null) {
    return {
      trend,
      rank: 'crossing',
      threshold,
      days: b.days,
      basis: 'bytes',
      headline: fillsIn(trend.metric, b.days),
      sortKey: b.days
    }
  }

  return {
    trend,
    rank: 'quiet',
    threshold,
    days: null,
    basis: 'percent',
    headline: QUIET_HEADLINE[f.reason],
    sortKey: -(level ?? -1)
  }
}

/** The headline, from either series — so the two can never word it
 *  differently for the same disk. */
function fillsIn(metric: CapacityMetric, days: number): string {
  return `${FILL_WORD[metric]} ${days < 1 ? 'within a day' : `in ${span(days * DAY_MS)}`}`
}

/**
 * The metrics of one host, most urgent first.
 *
 * The comparator is rank, then the rank's own key, then the declared metric
 * order — so two flat metrics do not swap places between refreshes for a
 * reason nobody can see.
 */
export function rankCapacity(trends: Trend[]): CapacityRow[] {
  const declared = new Map<CapacityMetric, number>(CAPACITY_METRICS.map((m, i) => [m, i]))
  return trends
    .map(capacityRow)
    .sort(
      (a, b) =>
        RANK_ORDER[a.rank] - RANK_ORDER[b.rank] ||
        a.sortKey - b.sortKey ||
        (declared.get(a.trend.metric) ?? 0) - (declared.get(b.trend.metric) ?? 0)
    )
}

/**
 * What the percentage is a percentage OF.
 *
 * "72%" is not a measurement until it says of what, measured when and sampled
 * how often; the card carries the other two and this carries the first. Each
 * of these is what the sampler actually stores, not a guess about it — disk
 * and inodes are df's own columns for the root filesystem, which is also why
 * the panel offers to read the other filesystems separately.
 */
const METRIC_BASIS: Record<CapacityMetric, string> = {
  cpu: 'CPU in use',
  memPct: 'of total RAM',
  diskPct: 'of the root filesystem, as df reports it',
  inodePct: 'of the root filesystem’s inodes'
}

/** The most recent unbroken run, for the sparkline. NOT the whole series: a
 *  sparkline has no room to show a hole, so it is drawn over a stretch that
 *  has none rather than over one it would silently bridge. */
function latestRun(trend: Trend): number[] {
  const last = trend.segments[trend.segments.length - 1]
  return last === undefined ? [] : last.points.map((p) => p.v)
}

// ---------------------------------------------------------------------------
// One metric.
// ---------------------------------------------------------------------------

/**
 * The card: conclusion, then evidence, then the measured line behind a chevron.
 *
 * Nothing that used to be on this screen has been removed — the chart, the
 * resolution caption, the silences and the sample count are all in the
 * disclosure, unchanged. What moved is the ORDER: the sentence an operator
 * came for is now the first thing in the card rather than the last.
 */
function CapacityCard({ row, report }: { row: CapacityRow; report: CapacityReport }): React.JSX.Element {
  const { trend, threshold } = row
  const latest = trend.latest
  const label = METRIC_LABEL[trend.metric]
  const f = trend.forecast
  const run = latestRun(trend)

  return (
    <li
      className={clsx('cap-card', `is-${row.rank}`)}
      data-testid={`cap-card-${trend.metric}`}
      data-rank={row.rank}
    >
      <div className="cap-head">
        <div className="cap-said">
          <span className="cap-metric">{label}</span>
          <span className="cap-headline">{row.headline}</span>
        </div>

        {run.length > 0 && (
          <span
            className="cap-spark"
            role="img"
            aria-label={`${label}: the last ${run.length} readings, without the gaps`}
          >
            {/* Fixed at 0–100 for the same reason the chart below is: a
                percentage auto-scaled to its own range turns ten points of
                movement into a cliff. */}
            <Sparkline data={run} max={100} height={28} color="currentColor" />
          </span>
        )}

        <div className="cap-now">
          {latest === null ? (
            <span className="faint">no samples</span>
          ) : (
            <span className={clsx('mono', 'cap-value', tone(latest.v))}>
              {latest.v.toFixed(1)}%
            </span>
          )}
        </div>
      </div>

      {/* Unit, and basis. Every number above is a percentage of something,
          measured at some moment, out of some number of readings — and none of
          that was on screen before. */}
      <div className="cap-basis">
        {METRIC_BASIS[trend.metric]}
        {latest !== null && <> · last read {span(report.now - latest.ts)} ago</>}
        {trend.read > 0 && (
          <>
            {' '}
            · {trend.read} reading{trend.read === 1 ? '' : 's'} over {span(report.to - report.from)}
          </>
        )}
        {trend.high !== null && trend.low !== null && (
          <>
            {' '}
            · {trend.low.toFixed(0)}–{trend.high.toFixed(0)}% across the window
          </>
        )}
      </div>

      {/* THE SENTENCE, whole. The headline above is a shorthand for it and is
          never a substitute: "Full in 11 days" without the window it was drawn
          from is the exact failure this feature was written against. */}
      {f !== null && threshold !== null && row.basis === 'percent' && (
        <div className={clsx('cap-why', f.ok ? '' : 'faint')}>
          {forecastText(f, trend.metric, threshold)}
          {f.ok && (
            <>
              {' '}
              <span className="cap-rate">{rateText(f)}</span>{' '}
              <span className="chip" title={CONFIDENCE_HELP[f.confidence]}>
                {f.confidence} confidence
              </span>
            </>
          )}
        </div>
      )}

      {/* The date came from the OTHER series, and the card says so rather than
          leaving a headline that the sentence under it appears to contradict.
          The percentage's own verdict is quoted in full, because "this reads as
          flat as a percentage" is the reason the byte series exists. */}
      {f !== null && threshold !== null && row.basis === 'bytes' && trend.bytes !== null && (
        <div className="cap-why" data-testid={`cap-basis-bytes-${trend.metric}`}>
          Measured in bytes, not in percent: df reports capacity as a rounded whole number, so a
          large filesystem sits still for weeks and then moves a whole point at once. As a
          percentage the same disk reads: {forecastText(f, trend.metric, threshold)}
          {trend.bytes.confidence !== null && (
            <>
              {' '}
              <span className="chip" title={CONFIDENCE_HELP[trend.bytes.confidence]}>
                {trend.bytes.confidence} confidence
              </span>
            </>
          )}
        </div>
      )}

      {/* The disk, in bytes.
          The figure the percentage above is rounded from, the rate at full
          precision, and what is left before the threshold. This is the row the
          whole panel is named for and the one the stored integer percentage
          could never answer, so it is on the card rather than inside the fold. */}
      {trend.bytes !== null && trend.bytes.latest !== null && (
        <div className="cap-basis" data-testid={`cap-bytes-${trend.metric}`}>
          {bytes(trend.bytes.latest)} used
          {trend.bytes.perDay !== null && <> · growing {bytes(trend.bytes.perDay)} a day</>}
          {trend.bytes.crossesAt !== null && trend.bytes.days !== null && (
            <> · {threshold ?? 90}% in {Math.floor(trend.bytes.days)} day(s)</>
          )}
        </div>
      )}

      {trend.read > 0 && (
        <details className="disclosure cap-fold">
          <summary className="disclosure-head">
            <ChevronRight size={14} className="chev" />
            Show the measured line
          </summary>
          <div className="disclosure-body">
            <TrendChart trend={trend} report={report} />
          </div>
        </details>
      )}
    </li>
  )
}

/**
 * The line, the boundary, the silences.
 *
 * Unchanged from the version that used to be the whole row, minus the three
 * things the card above now states once: the metric name, the current value
 * and the forecast sentence. A number printed twice on one screen is a number
 * two people can disagree about.
 *
 * The chart is deliberately plain. A capacity panel earns its place by being
 * believed, and every extra flourish is another thing that can imply a
 * measurement that was not taken.
 */
function TrendChart({ trend, report }: { trend: Trend; report: CapacityReport }): React.JSX.Element {
  const threshold = CAPACITY_THRESHOLDS[trend.metric] ?? null
  const drawing = draw(trend, report.from, report.to, CHART, threshold)
  const label = METRIC_LABEL[trend.metric]
  const gaps = drawing.segments.filter((s) => s.gapBefore > 0)

  return (
    <div className="col" style={{ gap: 6 }}>
      <svg
        role="img"
        aria-label={`${label} over the last ${span(report.to - report.from)}`}
        viewBox={`0 0 ${CHART.width} ${CHART.height}`}
        preserveAspectRatio="none"
        style={{ width: '100%', height: CHART.height, display: 'block' }}
      >
        {/* The threshold the forecast is about, drawn where the line has to
            reach rather than described only in the sentence. */}
        {drawing.thresholdY !== null && (
          <line
            x1={0}
            x2={CHART.width}
            y1={drawing.thresholdY}
            y2={drawing.thresholdY}
            stroke="currentColor"
            strokeWidth={1}
            strokeDasharray="2 4"
            opacity={0.35}
          />
        )}
        {/* Where the store's two tiers meet. Routine — any window longer than
            a week crosses it — so it is a quiet rule, not an alarm. */}
        {drawing.boundaryX !== null && (
          <line
            data-testid="resolution-boundary"
            x1={drawing.boundaryX}
            x2={drawing.boundaryX}
            y1={0}
            y2={CHART.height}
            stroke="currentColor"
            strokeWidth={1}
            strokeDasharray="1 3"
            opacity={0.5}
          />
        )}
        {drawing.segments.map((s, i) => (
          <g key={i} data-testid={`segment-${s.res}`}>
            {/* The spread inside each hourly bucket. On a disk it is the peak
                that matters and a mean can hide one entirely. */}
            {s.band !== '' && <path d={s.band} fill="currentColor" opacity={0.15} stroke="none" />}
            <path
              d={s.line}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              // Means are drawn dashed and readings solid, so the two halves of
              // a long window are distinguishable at a glance and not only in
              // the legend below.
              strokeDasharray={s.res === 'hourly' ? '3 2' : undefined}
              opacity={0.9}
            />
          </g>
        ))}
      </svg>

      <div className="row faint" style={{ gap: 10, flexWrap: 'wrap' }}>
        {drawing.boundaryX !== null && (
          <span>
            Before {shortDate(trend.resolutionBoundary ?? report.from)}: {RES_LABEL.hourly}. After:{' '}
            {RES_LABEL.full}.
          </span>
        )}
        {drawing.boundaryX === null && trend.segments.length > 0 && (
          <span>{RES_LABEL[trend.segments[0].res]}.</span>
        )}
        <span>{trend.read} samples.</span>
      </div>

      {gaps.map((s, i) => (
        <div key={i} className={s.gapKnown === 'not-running' ? 'faint' : 'state-unknown'}>
          {/* Two different facts, and only one of them is about the server.
              A gap OpsMaxx caused by not running is not a warning about the
              host, so it does not get the warning colour or the triangle. */}
          {s.gapKnown === 'not-running' ? (
            <>
              OpsMaxx was not running for {span(s.gapBefore)} — nothing was measured across it, so
              the line is broken there rather than joined.
            </>
          ) : (
            <>
              <AlertTriangle size={11} /> No samples for {span(s.gapBefore)}. The line is broken
              there rather than joined — nothing was measured across it.
            </>
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * The method, once, where a reader who distrusts a number can check it.
 *
 * Every figure is imported from the module that enforces it, so the paragraph
 * cannot drift from the behaviour it describes. A straight line through noisy
 * data is a weak instrument and the screen says so in its own words rather
 * than implying a precision the sampler does not have.
 */
function MethodNote(): React.JSX.Element {
  return (
    <details className="disclosure cap-fold" data-testid="capacity-method">
      <summary className="disclosure-head">
        <ChevronRight size={14} className="chev" />
        How a date is worked out, and when one is refused
      </summary>
      <div className="disclosure-body">
        <div className="cap-note">
          Every projection is <b>a straight line</b> — an ordinary least-squares fit through the
          samples in the window, extended until it meets the threshold. It assumes the current rate
          holds, and that assumption is doing most of the work: treat a date as a description of
          today’s rate, not as a schedule.
        </div>
        <div className="cap-note">
          Nothing is projected from fewer than {FORECAST_MIN_POINTS} samples, from a run shorter
          than {span(FORECAST_MIN_WINDOW_MS)}, or from points that sit further from the line than
          an r² of {FORECAST_MIN_R2} allows. If one jump accounts for{' '}
          {Math.round(FORECAST_STEP_SHARE * 100)}% or more of the whole rise, that is something
          written once and not a trend, and no date is given. Crossings further out than{' '}
          {FORECAST_HORIZON_DAYS} days are not stated at all.
        </div>
        <div className="cap-note">
          Nothing is measured for this screen. Every number is derived on demand from samples the
          fleet sampler already wrote, which is also why a host that has just been added has no
          history to draw on.
        </div>
      </div>
    </details>
  )
}

/**
 * The estate forecast list, summary first and detail only where there is any.
 *
 * TWO THINGS ARE WRONG WITH PRINTING EVERY ROW, and they are different problems
 * with the same symptom.
 *
 * The first is that a "no forecast" row carries no information the headline has
 * not already given. `forecastHeadline` says "0 of 18 could be forecast", and
 * then eighteen rows said "no forecast" one after another. That is not detail
 * behind a summary, it is the summary retyped eighteen times, and it pushed the
 * rows that DO say something — the crossings — off the bottom of the panel on
 * the estates where there were any.
 *
 * The second is that each row printed the hostname twice: once in its own
 * column and once at the head of `because`, which `fleetForecastRow` builds as
 * `${hostName}: …` so the sentence stands alone wherever it is quoted. The
 * column is the scannable copy and stays; the prefix is stripped HERE rather
 * than removed there, because the sentence is also used in contexts with no
 * column beside it.
 *
 * What does NOT collapse: a host that could not be forecast is still listed,
 * with its reason, one click away and with the count on the button. "18 servers
 * with no forecast" hidden entirely would be the reassuring fiction this whole
 * feature is built against — the headline carries the denominator for exactly
 * that reason and the disclosure carries it too.
 *
 * The rows themselves are no longer a table of sentences. `buildFleetForecast`
 * already ranks them; what was missing was any way to SEE the ranking, so the
 * time to the crossing is now a column of its own, left of the name, in the
 * one place the eye goes first.
 */
function ForecastRows({ rows }: { rows: FleetForecastRow[] }): React.JSX.Element {
  const [showQuiet, setShowQuiet] = useState(false)
  const said = rows.filter((r) => r.band !== 'refused')
  const quiet = rows.filter((r) => r.band === 'refused')
  const shown = showQuiet ? [...said, ...quiet] : said

  return (
    <>
      {shown.length > 0 && (
        <ol className="cap-fleet" data-testid="capacity-fleet-rows">
          {shown.map((r) => (
            <li key={`${r.hostId} ${r.metric}`} data-band={r.band} className={`is-${r.band}`}>
              <span className="cap-fleet-when mono">
                {r.band === 'over' ? 'now' : r.days === null ? '—' : `${Math.floor(r.days)}d`}
              </span>
              <span className="cap-fleet-host mono">{r.hostName}</span>
              <span className="cap-fleet-why">{withoutHostPrefix(r.because, r.hostName)}</span>
            </li>
          ))}
        </ol>
      )}
      {quiet.length > 0 && (
        <button
          className="btn ghost sm"
          data-testid="forecast-show-quiet"
          aria-expanded={showQuiet}
          onClick={() => setShowQuiet((v) => !v)}
          style={{ marginTop: 6 }}
        >
          {showQuiet
            ? `Hide ${quiet.length} server${quiet.length === 1 ? '' : 's'} with no forecast`
            : `Show ${quiet.length} server${quiet.length === 1 ? '' : 's'} with no forecast`}
        </button>
      )}
    </>
  )
}

/** Drops the `hostname: ` the sentence carries for standalone use. Exact match
 *  only — a sentence that does not start with the host is left alone rather
 *  than sliced at a guessed offset. */
function withoutHostPrefix(sentence: string, hostName: string): string {
  const prefix = `${hostName}: `
  return sentence.startsWith(prefix) ? sentence.slice(prefix.length) : sentence
}

export function CapacityPanel({ servers }: { servers: Server[] }): React.JSX.Element {
  const [serverId, setServerId] = useState<string>(servers[0]?.id ?? '')
  const [days, setDays] = useState<number>(7)
  const [report, setReport] = useState<CapacityReport | null>(null)
  const hydrated = useApp((st) => st.hydrated)
  const [loading, setLoading] = useState(false)
  // When the user last re-read, so the button can say it happened.
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)
  /** Bumped by Refresh. A re-read of the SAME server and window has to be a
   *  new dependency or the effect does not run, and the button would spin
   *  once and then quietly do nothing forever. */
  const [nonce, setNonce] = useState(0)
  /** Which read the UI is showing. A read still in flight when the operator
   *  changes server or window must not land under the new heading — that is
   *  one host's disk presented as another's, and there is nothing on screen
   *  that would give it away. */
  const generation = useRef(0)
  /**
   * The filesystems this host actually has.
   *
   * READ ON DEMAND, not with the trends. The trends come from stored samples
   * and touch no host; this opens an SSH channel, and a panel that did it on
   * every server change would probe a machine because somebody used a
   * dropdown.
   */
  const [storage, setStorage] = useState<StorageLayout | { error: string } | null>(null)
  const [storageLoading, setStorageLoading] = useState(false)

  const loadStorage = async (): Promise<void> => {
    const server = servers.find((sv) => sv.id === serverId)
    if (!server) return
    setStorageLoading(true)
    setStorage(null)
    try {
      const call = (
        window.opsmaxx as
          | { fleet?: { storage?: (cfg: OnDemandTarget) => Promise<StorageLayout | { error: string }> } }
          | undefined
      )?.fleet?.storage
      setStorage(
        typeof call === 'function'
          ? // sshTargetFor, NOT `server`. A Server holds its jump chain in
            // `route`; main reads `hops`, so a raw Server crosses the bridge
            // intact, resolves its credentials, and then dials the private
            // address direct — "connect ETIMEDOUT 192.168.19.7:1051" on a host
            // the sampler one panel over reads perfectly. The v0.27.0 fix
            // wrapped the handler in resolveChainSecrets/withVpnTransport,
            // which repaired credentials and VPN but not the chain, because
            // the SHAPE was still wrong here.
            await withVaultUnlock('Reading this host’s filesystems needs its stored credential.', () =>
              call(sshTargetFor(server))
            )
          : { error: 'This build cannot read filesystems. Restart the app to rebuild it.' }
      )
    } catch (e) {
      setStorage({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      setStorageLoading(false)
    }
  }

  const selected = servers.find((s) => s.id === serverId) ?? null
  const trends = bridge()?.trends

  useEffect(() => {
    if (typeof trends !== 'function' || serverId === '') return
    const mine = ++generation.current
    setLoading(true)
    setFailed(false)
    void trends(serverId, days)
      .then((r) => {
        if (generation.current !== mine) return
        setReport(r)
        setFailed(false)
      })
      .catch(() => {
        if (generation.current !== mine) return
        setReport(null)
        setFailed(true)
      })
      .finally(() => {
        if (generation.current === mine) setLoading(false)
      })
  }, [trends, serverId, days, nonce])

  const refresh = (): void => setNonce((n) => n + 1)

  /** The selected host's metrics, most urgent first. */
  const ranked = useMemo(() => (report === null ? [] : rankCapacity(report.trends)), [report])
  const loud = ranked.filter((r) => r.rank !== 'quiet')
  const quiet = ranked.filter((r) => r.rank === 'quiet')

  /**
   * The estate strip -- item 47's fleet expansion forecast.
   *
   * Reuses the per-host `trends` channel across every server rather than adding
   * an IPC of its own: that channel reads the LOCAL history store, not a host,
   * so N calls are N queries against a database this process already has open.
   * A second channel would be a second place for the forecast policy to drift.
   *
   * `over` and `refused` rows are the point. On a real estate most hosts
   * produce no forecast, and a strip that showed only crossings would read as
   * an all-clear on an estate nobody has measured.
   */
  const [fleet, setFleet] = useState<FleetForecast | null>(null)
  const [fleetLoading, setFleetLoading] = useState(false)
  const fleetGen = useRef(0)

  const loadFleet = async (): Promise<void> => {
    if (typeof trends !== 'function') return
    const mine = ++fleetGen.current
    setFleetLoading(true)
    try {
      const inputs: FleetForecastInput[] = []
      for (const s of servers) {
        const r = await trends(s.id, days).catch(() => null)
        if (fleetGen.current !== mine) return
        // A server whose read FAILED is not silently absent: it goes in as a
        // refusal with no data, which is exactly what it is.
        if (r === null) {
          inputs.push({
            hostId: s.id,
            hostName: s.name,
            metric: 'diskPct',
            forecast: { ok: false, reason: 'no-data', from: 0, to: 0, points: 0 }
          })
          continue
        }
        for (const t of r.trends) {
          if (t.forecast === null) continue
          inputs.push({ hostId: s.id, hostName: s.name, metric: t.metric, forecast: t.forecast })
        }
      }
      if (fleetGen.current !== mine) return
      setFleet(buildFleetForecast(inputs))
    } finally {
      if (fleetGen.current === mine) setFleetLoading(false)
    }
  }

  return (
    <PanelShell
      icon={<TrendingUp size={14} />}
      title="Capacity trends"
      about={
        <p>
          What is going to run out on this server, and when — projected from samples the fleet
          sampler already writes. Nothing extra is measured for this panel.
        </p>
      }
      actions={
        <>
        <select
          className="input"
          style={{ maxWidth: 200 }}
          aria-label="Server"
          value={serverId}
          onChange={(e) => {
              setServerId(e.target.value)
              // Cleared with the server, for the reason `generation` exists
              // above: one host's filesystems left on screen under another
              // host's name is a wrong answer nothing on screen gives away.
              setStorage(null)
            }}
        >
          {servers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          className="input"
          style={{ maxWidth: 130 }}
          aria-label="Window"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          {CAPACITY_WINDOWS.map((d) => (
            <option key={d} value={d}>
              {d === 1 ? 'Last 24 hours' : `Last ${d} days`}
            </option>
          ))}
        </select>
        {/**
         * Refresh, and a word about what it did.
         *
         * Deliberately NOT a "Check now": trends are computed from samples
         * already in the store, so re-querying is the honest description of
         * what this button does. What was missing is any acknowledgement — on
         * an estate whose numbers have not moved, a silent re-query is
         * indistinguishable from a dead control, which is what it was
         * reported as.
         */}
        <div className="check-now">
          <button
            className="btn ghost sm"
            disabled={loading || typeof trends !== 'function' || serverId === ''}
            onClick={() => {
              void Promise.resolve(refresh()).then(() => setRefreshedAt(Date.now()))
            }}
            title="Re-reads the samples already collected for this window. New samples arrive with the hourly sweep."
          >
            <RefreshCw size={13} className={clsx(loading && 'spin')} />
            {loading ? 'Reading…' : 'Refresh'}
          </button>
          {refreshedAt !== null && !loading && (
            <span className="check-now-said" aria-live="polite">
              <Check size={12} />
              Re-read at{' '}
              {new Date(refreshedAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit'
              })}
            </span>
          )}
        </div>
        </>
      }
    >

      {/* Item 47's estate strip. Asked for, because it queries the store once
          per server and the answer only matters when somebody is asking the
          estate question rather than the one-host one. */}
      {typeof trends === 'function' && servers.length > 0 && (
        <div className="cap-estate">
          <button
            className={clsx('btn sm', fleet === null ? 'primary' : 'ghost')}
            disabled={fleetLoading}
            onClick={() => void loadFleet()}
          >
            {fleet === null ? 'Forecast the whole estate' : 'Forecast again'}
            {fleetLoading && <span className="faint"> reading…</span>}
          </button>
          {fleet !== null && (
            <>
              {/* The denominator is in the headline, not behind a hover: a
                  status line reading "nothing fills within 90 days" on an
                  estate where most hosts could not be forecast is the most
                  reassuring thing this app could print and one of the least
                  true. */}
              <div className="cap-estate-head">{fleet.headline}</div>
              <ForecastRows rows={fleet.rows} />
            </>
          )}
        </div>
      )}

      {typeof trends !== 'function' ? (
        <div className="panel-note is-alarm">
          This build’s preload does not expose capacity trends yet. Restart the app to rebuild it.
        </div>
      ) : servers.length === 0 && !hydrated ? (
        // Saved servers arrive from an await, so the list is empty for the
        // first moments of every launch -- and this panel used that emptiness
        // to tell people they had no servers. It is not a claim worth making
        // before the answer is in.
        //
        // Only the EMPTY branch waits. A list with something in it is its own
        // proof that servers exist, whatever the flag says, and holding a chart
        // back for a signal that would only confirm what is already on screen
        // would be a spinner in front of an answer.
        <div className="panel-empty">
          <p className="panel-empty-title">Reading your servers…</p>
        </div>
      ) : servers.length === 0 ? (
        <div className="panel-empty">
          <p className="panel-empty-title">No servers to chart.</p>
          <p className="panel-empty-body">
            Add a server to this workspace and its samples start accumulating here.
          </p>
        </div>
      ) : failed ? (
        <div className="panel-note is-alarm">Could not read the history store.</div>
      ) : report === null ? (
        loading ? (
          <div className="panel-note">Reading…</div>
        ) : (
          <SweepEmpty
            subject="No stored history."
            busy={loading}
            onCheckNow={refresh}
            note="Trends are drawn from the sampler’s own samples. Nothing is measured for this panel, so it fills only while background checking is running."
          />
        )
      ) : report.trends.every((t) => t.read === 0) ? (
        <SweepEmpty
          subject={`Nothing has been sampled for ${selected?.name ?? serverId} in this window.`}
          busy={loading}
          onCheckNow={refresh}
          note="A longer window will not help until sampling resumes — the store has no readings for this host at any resolution."
        />
      ) : (
        <>
          <div className="cap-lede">
            <b>{selected?.name ?? serverId}</b>
            <span className="faint"> · last {span(report.to - report.from)}</span>
          </div>

          {/* The answer, ranked. What is going to run out, soonest first. */}
          {loud.length === 0 ? (
            // NOT "all clear". Most of the four metrics produced no date on any
            // real host, and saying nothing about that is how a screen comes to
            // read as an all-clear for an estate nobody has measured.
            <div className="panel-note" data-testid="capacity-none-urgent">
              Nothing here is heading for a limit within {FORECAST_HORIZON_DAYS} days. None of the{' '}
              {ranked.length} metrics produced a date — the reason for each is below.
            </div>
          ) : (
            <ol className="cap-cards" data-testid="capacity-ranked">
              {loud.map((row) => (
                <CapacityCard key={row.trend.metric} row={row} report={report} />
              ))}
            </ol>
          )}

          {/* The quiet ones fold; the COUNT does not. A metric that is not
              moving is not a problem however high it is, and it is exactly what
              a reader should not have to scroll past to reach the one that is. */}
          {quiet.length > 0 && (
            <details className="disclosure cap-fold" data-testid="capacity-quiet">
              <summary className="disclosure-head">
                <ChevronRight size={14} className="chev" />
                No date for {quiet.length} of {ranked.length} — open for the reason each was refused
              </summary>
              <div className="disclosure-body">
                <ol className="cap-cards">
                  {quiet.map((row) => (
                    <CapacityCard key={row.trend.metric} row={row} report={report} />
                  ))}
                </ol>
              </div>
            </details>
          )}

          <MethodNote />

          <div className="cap-note faint">
            The store keeps {report.fullResolutionDays} days of {RES_LABEL.full} and{' '}
            {report.retainedDays} days of {RES_LABEL.hourly}. Older than that is gone, which is why
            a longer window is not always more line.
          </div>

          {/* THE TREND ABOVE IS `/` ONLY. This says which other filesystems
              exist, because a full /var or /data is invisible to a single disk
              percentage — and on a host running containers most of what `df`
              lists is not a filesystem at all. */}
          <div className="row" style={{ gap: 8, marginTop: 14, alignItems: 'center' }}>
            <span className="grow faint">
              The disk row above is the root filesystem. This host may have others.
            </span>
            <button
              className="btn ghost sm"
              disabled={storageLoading}
              onClick={() => void loadStorage()}
            >
              {storageLoading ? 'Reading…' : 'Read filesystems'}
            </button>
          </div>
          {storage !== null && 'error' in storage && (
            // NOT an empty list: a read that could not happen and a host with
            // one filesystem are different answers.
            <PanelError
              error={`The filesystems could not be read: ${storage.error}`}
              reason="Reading this host’s filesystems needs its stored credential."
              onRetry={() => void loadStorage()}
            />
          )}
          {storage !== null && !('error' in storage) && (
            <>
              <div className="faint">
                {storageHeadline(storage)}
              </div>
              <table className="mini-table">
                <thead>
                  <tr>
                    <th>Mounted on</th>
                    <th>Type</th>
                    <th className="num">Size</th>
                    <th className="num">Used</th>
                    <th className="num">Inodes</th>
                  </tr>
                </thead>
                <tbody>
                  {storage.df.mounts.map((m) => (
                    <tr key={m.target}>
                      <td className="mono">{m.target}</td>
                      <td>{m.fstype}</td>
                      <td className="num">{m.sizeKb === null ? '?' : bytes(m.sizeKb * 1024)}</td>
                      <td className="num">{m.usePct === null ? '?' : `${m.usePct}%`}</td>
                      {/* `-` from vfat is unknown, not zero. */}
                      <td className="num">{m.inodePct === null ? '—' : `${m.inodePct}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </PanelShell>
  )
}
