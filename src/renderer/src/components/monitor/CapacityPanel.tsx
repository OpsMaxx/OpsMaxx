import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, RefreshCw, TrendingUp } from 'lucide-react'
import { openSettings } from '../../store/nav'
import { useApp } from '../../store/app'
import {
  storageHeadline,
  type StorageLayout
} from '../../../../shared/storageLayout'
import { bytes, clsx } from '../../lib/format'
import {
  CAPACITY_THRESHOLDS,
  CAPACITY_WINDOWS,
  type CapacityBridge,
  type CapacityReport,
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
import type { Server } from '../../types'
import { PanelShell } from './PanelShell'

// "This disk fills in eleven days." — roadmap item 26.
//
// The first thing on screen that reads from item A's store. Everything here is
// derived on demand from samples the fleet sampler already writes; this panel
// stores nothing, schedules nothing and evaluates nothing in the background.
// That is what keeps item 26 the "query and a chart" the roadmap describes
// rather than the metrics warehouse it warns against.
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

function bridge(): Partial<CapacityBridge> | undefined {
  return (window.shellpilot as unknown as { capacity?: Partial<CapacityBridge> } | undefined)?.capacity
}

function tone(v: number): string {
  return v > 85 ? 'danger' : v > 65 ? 'warn' : ''
}

/**
 * One metric: the line, the boundary, the silences, and the sentence.
 *
 * The chart is deliberately plain. A capacity panel earns its place by being
 * believed, and every extra flourish is another thing that can imply a
 * measurement that was not taken.
 */
function TrendRow({
  trend,
  report
}: {
  trend: Trend
  report: CapacityReport
}): React.JSX.Element {
  const threshold = CAPACITY_THRESHOLDS[trend.metric] ?? null
  const drawing = draw(trend, report.from, report.to, CHART, threshold)
  const latest = trend.latest
  const label = METRIC_LABEL[trend.metric]
  const gaps = drawing.segments.filter((s) => s.gapBefore > 0)

  return (
    <div className="col" style={{ gap: 6, marginTop: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <b>{label}</b>
        {latest === null ? (
          <span className="faint">
            no samples
          </span>
        ) : (
          <span className={clsx('mono', tone(latest.v))}>
            {latest.v.toFixed(1)}%
            {trend.high !== null && trend.low !== null && (
              <span className="faint">
                {' '}
                · {trend.low.toFixed(0)}–{trend.high.toFixed(0)}% over the window
              </span>
            )}
          </span>
        )}
      </div>

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
        <div key={i} className="state-unknown">
          <AlertTriangle size={11} /> No samples for {span(s.gapBefore)}. The line is broken there
          rather than joined — nothing was measured across it.
        </div>
      ))}

      {trend.forecast !== null && threshold !== null && (
        <div
          className={clsx('panel-note', trend.forecast.ok ? '' : 'faint')}
          style={{ marginTop: 2 }}
        >
          {forecastText(trend.forecast, trend.metric, threshold)}
          {trend.forecast.ok && (
            <>
              {' '}
              <span className="faint">{rateText(trend.forecast)}.</span>{' '}
              <span className="mono" title={CONFIDENCE_HELP[trend.forecast.confidence]}>
                {trend.forecast.confidence} confidence
              </span>
            </>
          )}
        </div>
      )}
    </div>
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
 */
function ForecastRows({ rows }: { rows: FleetForecastRow[] }): React.JSX.Element {
  const [showQuiet, setShowQuiet] = useState(false)
  const said = rows.filter((r) => r.band !== 'refused')
  const quiet = rows.filter((r) => r.band === 'refused')
  const shown = showQuiet ? [...said, ...quiet] : said

  return (
    <>
      {shown.length > 0 && (
        <table className="mini-table">
          <tbody>
            {shown.map((r) => (
              <tr key={`${r.hostId} ${r.metric}`} data-band={r.band}>
                <td>
                  <span
                    className={clsx(
                      'chip',
                      r.band === 'over' ? 'danger' : r.band === 'crossing' ? 'warn' : 'state-unknown'
                    )}
                  >
                    {r.band === 'refused' ? 'no forecast' : r.band}
                  </span>
                </td>
                <td className="mono">{r.hostName}</td>
                <td>{withoutHostPrefix(r.because, r.hostName)}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
        window.shellpilot as
          | { fleet?: { storage?: (cfg: unknown) => Promise<StorageLayout | { error: string }> } }
          | undefined
      )?.fleet?.storage
      setStorage(
        typeof call === 'function'
          ? await call(server)
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
          How one server&rsquo;s CPU, memory and disk have moved over time, drawn from samples the
          fleet sampler already writes. Nothing extra is measured for this panel.
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
        <button
          className="btn ghost sm"
          disabled={loading || typeof trends !== 'function' || serverId === ''}
          onClick={refresh}
        >
          <RefreshCw size={13} className={clsx(loading && 'spin')} /> Refresh
        </button>
        </>
      }
    >

      {/* Item 47's estate strip. Asked for, because it queries the store once
          per server and the answer only matters when somebody is asking the
          estate question rather than the one-host one. */}
      {typeof trends === 'function' && servers.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <button className="btn ghost sm" disabled={fleetLoading} onClick={() => void loadFleet()}>
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
              <div className="s-note">{fleet.headline}</div>
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
          <div className="panel-empty">
            <p className="panel-empty-title">No stored history.</p>
            <p className="panel-empty-body">
              Trends come from the fleet sampler’s own samples, so this fills in once sampling has
              been running. Turn background checking on and leave it for an hour.
            </p>
            <div className="panel-empty-actions">
              <button className="btn ghost sm" onClick={() => openSettings('monitoring')}>
                Open Monitoring settings
              </button>
            </div>
          </div>
        )
      ) : (
        <>
          <div className="panel-note">
            {selected?.name ?? serverId} over the last {span(report.to - report.from)}, from the
            samples the fleet sampler already writes. Nothing is measured for this panel.
          </div>
          {report.trends.map((t) => (
            <TrendRow key={t.metric} trend={t} report={report} />
          ))}
          <div className="faint" style={{ marginTop: 12 }}>
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
              The trend above is the root filesystem. This host may have others.
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
            <div className="panel-note is-alarm">The filesystems could not be read: {storage.error}</div>
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
