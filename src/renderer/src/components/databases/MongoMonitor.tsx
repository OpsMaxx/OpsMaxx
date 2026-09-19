import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Lock, Loader2, Pause, Play } from 'lucide-react'
import { Sparkline } from '../common/Sparkline'
import { EmptyState } from '../common/EmptyState'
import {
  MONGO_MONITOR_COMMANDS,
  MONGO_OPCOUNTERS,
  classifyMongoFailure,
  formatBytes,
  formatSeconds,
  isMongoClientOp,
  mongoCurrentOpCommand,
  mongoMonitorRates,
  mongoTopRates,
  parseMongoCurrentOp,
  parseMongoMonitorSample,
  parseMongoTop,
  type MongoMonitorRates,
  type MongoMonitorSample,
  type MongoOpCounter,
  type MongoOperation,
  type MongoTopEntry,
  type MongoTopRate
} from '../../../../shared/dbOps'
import type { DbConnectConfig } from '../../../../shared/db'

/**
 * Live server activity, the way Compass's performance tab reads it.
 *
 * Every number on this page is a RATE and not a total. `serverStatus().opcounters`
 * and every counter under `top` are cumulative since the server started, so on a
 * host that has been up three weeks the raw figures are seven digits long and
 * say nothing whatever about the last two seconds. The differencing is in
 * shared/dbOps.ts — mongoMonitorRates and mongoTopRates — along with the two
 * refusals that matter: a rate with no previous sample is null, and a counter
 * that went BACKWARDS (the server restarted between samples) is null too, never
 * a clamped zero that would draw a quiet minute over a crash.
 *
 * Three commands, three panels, three independent failures. `serverStatus`,
 * `top` and `$currentOp` each need a privilege an application user very often
 * lacks and an Atlas shared tier refuses outright, so a refusal darkens the one
 * panel that asked for it and says so in words. It never blanks a chart and it
 * never takes the page down.
 *
 * Sampling stops when the tab is not the one on screen and when the window is
 * hidden. A background database tab stays mounted in this app — that is how its
 * results and shell history survive a switch — so without the gate every open
 * MongoDB connection would keep issuing three admin commands every two seconds
 * forever.
 */

/** How often to ask. Compass samples at one second; two is chosen here because
 *  every sample is three round trips that may be crossing an SSH tunnel. */
const SAMPLE_MS = 2000

/** How many samples to keep. The buffer is bounded because this panel can be
 *  left open for a working day: 120 samples is four minutes of history and
 *  about the width of the sparklines below. */
const HISTORY = 120

/** How many in-flight operations to ask for. */
const CURRENTOP_LIMIT = 20

type Reply = { ok: true; json: unknown } | { ok: false; error: string }

/**
 * Why a panel is empty, in the panel.
 *
 * Through classifyMongoFailure, which is the classifier the operations tab
 * already uses and is matched against captured refusals in
 * tests/fixtures/dbops/mongodb/unauthorized.json -- rather than a second regex
 * here that would agree with it until the day it did not. It also redacts the
 * command MongoDB echoes back inside its own error text, which for these
 * commands is the whole thirty-four-key serverStatus document.
 *
 * No code reaches this: the generic query bridge carries the driver's sentence
 * and not its `code`, so the message is all there is, and classifyMongoFailure
 * falls through to matching it.
 */
function refusal(error: string, command: string): { note: string; detail: string } {
  const f = classifyMongoFailure(null, null, error)
  if (f.status === 'denied') {
    return {
      note: `This server will not tell us. The account OpsMaxx connected as may not run ${command}, so this panel stays empty — nothing here is a measurement of zero.`,
      detail: f.detail
    }
  }
  if (f.status === 'unsupported') {
    return { note: `This server cannot answer ${command} at all. Treat this panel as unknown, not as zero.`, detail: f.detail }
  }
  return { note: `${command} did not answer.`, detail: f.detail }
}

/** A per-second figure. Never "0.0" for a rate that was not measured — that is
 *  what the em dash is for. */
function perSec(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1)
}

function gauge(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : Math.round(v).toLocaleString('en-US')
}

function bytesPerSec(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `${formatBytes(v)}/s`
}

/** One labelled panel. `note` replaces the body when the server refused. */
function Panel({
  title,
  note,
  detail,
  children
}: {
  title: string
  note?: string | null
  detail?: string | null
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="db-mon-panel">
      <div className="db-mon-panel-head">
        <span className="sidebar-title">{title}</span>
        {note && <Lock size={11} className="faint" />}
      </div>
      {note ? (
        <div className="db-mon-refused">
          <div>{note}</div>
          {detail && (
            <div className="mono faint selectable db-mon-detail">
              {detail}
            </div>
          )}
        </div>
      ) : (
        children
      )}
    </section>
  )
}

/** One number with its own sparkline. */
function Stat({
  label,
  value,
  history,
  color
}: {
  label: string
  value: string
  history: number[]
  color?: string
}): React.JSX.Element {
  return (
    <div className="db-mon-stat">
      <div className="db-mon-stat-head">
        <span className="db-mon-stat-label">{label}</span>
        <span className="db-mon-stat-value mono">{value}</span>
      </div>
      {/* One point cannot be a line. Until there are two the slot is held open
          rather than drawn as a flat baseline at zero. */}
      {history.length > 1 ? (
        <Sparkline data={history} color={color} height={26} />
      ) : (
        <div className="db-mon-spark-placeholder" />
      )}
    </div>
  )
}

export function MongoMonitor({
  cfg,
  visible
}: {
  cfg: DbConnectConfig
  visible: boolean
}): React.JSX.Element {
  /**
   * Every command here is an admin one — `top` and `$currentOp` are refused
   * anywhere else, and `serverStatus` is conventionally read there. The
   * operator's own database selection is left alone.
   *
   * Through a ref, and the sampling effect below is keyed on `cfg.id` rather
   * than on `cfg`. DatabaseView builds this object fresh on every render, so an
   * effect that depended on the object itself would be torn down and restarted
   * by its own setState — a sampling loop with no interval in it at all, three
   * admin commands per render against somebody's primary.
   */
  const cfgRef = useRef(cfg)
  cfgRef.current = cfg
  const adminCfg = useCallback((): DbConnectConfig => ({ ...cfgRef.current, database: 'admin' }), [])

  const [samples, setSamples] = useState<MongoMonitorSample[]>([])
  const [statusError, setStatusError] = useState<string | null>(null)
  /** The previous sweep's `top` totals, which the next one is differenced
   *  against. A ref rather than state: nothing renders it. */
  const topRef = useRef<MongoTopEntry[]>([])
  // Null until `top` has answered once. An empty array after that is a real
  // answer — a window in which no collection was touched.
  const [top, setTop] = useState<MongoTopRate[] | null>(null)
  const [topError, setTopError] = useState<string | null>(null)
  const [ops, setOps] = useState<{ operations: MongoOperation[]; ownOpsOnly: boolean } | null>(null)
  const [opsError, setOpsError] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)

  // The window being hidden is the other half of `visible`: a minimised app is
  // nobody looking, and three admin commands every two seconds against a
  // production primary is not a thing to leave running behind a hidden window.
  const [awake, setAwake] = useState(() => !document.hidden)
  useEffect(() => {
    const on = (): void => setAwake(!document.hidden)
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])

  // A connection change throws every reading away. Rates are differences
  // between two samples, and a difference across two different servers is not a
  // rate of anything.
  useEffect(() => {
    setSamples([])
    topRef.current = []
    setTop(null)
    setOps(null)
    setStatusError(null)
    setTopError(null)
    setOpsError(null)
  }, [cfg.id])

  const command = useCallback(
    async (db: DbConnectConfig, cmd: Record<string, unknown>): Promise<Reply> => {
      try {
        const r = await window.opsmaxx?.db.query(db, JSON.stringify(cmd))
        if (!r) return { ok: false, error: 'The preload bridge does not expose database queries. Restart the app.' }
        if (!r.ok) return { ok: false, error: r.error ?? 'The command failed.' }
        return { ok: true, json: r.json }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    []
  )

  const running = visible && awake && !paused

  // Chained rather than on an interval, for the reason useServerMetrics gives:
  // over a slow link an interval queues samples faster than they land, and each
  // queued sample is another round trip on the connection the operator is also
  // querying over. At most one is ever outstanding.
  useEffect(() => {
    if (!running) return
    const admin = adminCfg()
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null

    const sample = async (): Promise<void> => {
      const [status, activity] = await Promise.all([
        command(admin, MONGO_MONITOR_COMMANDS.serverStatus.command),
        command(admin, MONGO_MONITOR_COMMANDS.top.command)
      ])
      if (!alive) return
      const at = Date.now()

      if (status.ok) {
        setStatusError(null)
        const next = parseMongoMonitorSample(status.json as Record<string, unknown>, at)
        setSamples((s) => [...s, next].slice(-HISTORY))
      } else {
        setStatusError(status.error)
      }

      if (activity.ok) {
        setTopError(null)
        const entries = parseMongoTop(activity.json as Record<string, unknown>, at)
        const before = topRef.current
        const seconds = before.length ? (at - before[0].atMs) / 1000 : 0
        topRef.current = entries
        setTop(mongoTopRates(before, entries, seconds))
      } else {
        setTopError(activity.error)
      }

      // $currentOp over every user needs a privilege of its own. When it is
      // refused the fallback returns ONLY this connection's own operations,
      // which is a different question with the same shape — so the answer is
      // labelled rather than quietly narrowed. Same trap parseMongoCurrentOp
      // documents for the operations tab.
      let all = await command(admin, mongoCurrentOpCommand(CURRENTOP_LIMIT, true))
      let ownOnly = false
      if (!all.ok) {
        const mine = await command(admin, mongoCurrentOpCommand(CURRENTOP_LIMIT, false))
        if (mine.ok) {
          all = mine
          ownOnly = true
        }
      }
      if (!alive) return
      if (all.ok) {
        setOpsError(null)
        const rows = Array.isArray(all.json) ? (all.json as Record<string, unknown>[]) : []
        setOps(parseMongoCurrentOp(rows, ownOnly))
      } else {
        setOpsError(all.error)
      }
    }

    const loop = async (): Promise<void> => {
      await sample()
      if (!alive) return
      timer = setTimeout(() => void loop(), SAMPLE_MS)
    }
    void loop()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [running, cfg.id, adminCfg, command])

  // Every window in the buffer, so the sparklines plot rates rather than the
  // seven-digit totals the server actually sent. A window spanning a restart
  // comes back null and is dropped: a gap in the line, not a dive to zero.
  const history = useMemo((): MongoMonitorRates[] => {
    const out: MongoMonitorRates[] = []
    for (let i = 1; i < samples.length; i++) {
      const r = mongoMonitorRates(samples[i - 1], samples[i])
      if (r) out.push(r)
    }
    return out
  }, [samples])

  const latest = history.length ? history[history.length - 1] : null
  const now = samples.length ? samples[samples.length - 1] : null

  const opSeries = (k: MongoOpCounter): number[] =>
    history.map((r) => r.opsPerSec[k]).filter((v): v is number => v !== null)
  const series = (pick: (r: MongoMonitorRates) => number | null): number[] =>
    history.map(pick).filter((v): v is number => v !== null)
  const gaugeSeries = (pick: (s: MongoMonitorSample) => number | null): number[] =>
    samples.map(pick).filter((v): v is number => v !== null)

  const clientOps = (ops?.operations ?? []).filter(isMongoClientOp)

  return (
    <div className="db-mon">
      <div className="db-mon-bar">
        <button className="btn sm" onClick={() => setPaused((p) => !p)}>
          {paused ? <Play size={13} /> : <Pause size={13} />} {paused ? 'Resume' : 'Pause'}
        </button>
        <span className="faint">
          {!visible || !awake
            ? 'Sampling is stopped while this tab is not on screen.'
            : paused
              ? 'Sampling is paused.'
              : latest
                ? `Rates over the last ${latest.windowSeconds.toFixed(1)}s. Every figure is a difference between samples, not a total since the server started.`
                : 'Taking the first sample. A rate needs two, so the first one shows nothing.'}
        </span>
        <span className="spacer" />
        {running && !latest && !statusError && <Loader2 size={13} className="spin" />}
        {now?.uptimeSeconds !== null && now?.uptimeSeconds !== undefined && (
          <span className="faint">
            up {formatSeconds(now.uptimeSeconds)}
          </span>
        )}
      </div>

      <div className="db-mon-grid">
        <Panel
          title="Operations"
          note={statusError ? refusal(statusError, 'serverStatus').note : null}
          detail={statusError ? refusal(statusError, 'serverStatus').detail : null}
        >
          <div className="db-mon-stats">
            {MONGO_OPCOUNTERS.map((k) => (
              <Stat
                key={k}
                label={k}
                value={`${perSec(latest?.opsPerSec[k])}/s`}
                history={opSeries(k)}
              />
            ))}
          </div>
          {/* Replicated writes are the other half of a primary's load and are
              not in opcounters at all. Shown only when the set reports them. */}
          {latest && MONGO_OPCOUNTERS.some((k) => (latest.replOpsPerSec[k] ?? 0) > 0) && (
            <div className="faint db-mon-foot">
              Replicated:{' '}
              {MONGO_OPCOUNTERS.filter((k) => (latest.replOpsPerSec[k] ?? 0) > 0)
                .map((k) => `${k} ${perSec(latest.replOpsPerSec[k])}/s`)
                .join(' · ')}
            </div>
          )}
        </Panel>

        <Panel
          title="Read & write"
          note={statusError ? refusal(statusError, 'serverStatus').note : null}
          detail={statusError ? refusal(statusError, 'serverStatus').detail : null}
        >
          {/* Gauges, not counters: these are how many clients are in the server
              right now, so they are shown as they were read and never
              differenced. */}
          <div className="db-mon-stats">
            <Stat label="active reads" value={gauge(now?.activeReads)} history={gaugeSeries((s) => s.activeReads)} color="var(--ok)" />
            <Stat label="active writes" value={gauge(now?.activeWrites)} history={gaugeSeries((s) => s.activeWrites)} color="var(--ok)" />
            <Stat label="queued reads" value={gauge(now?.queuedReads)} history={gaugeSeries((s) => s.queuedReads)} color="var(--warn)" />
            <Stat label="queued writes" value={gauge(now?.queuedWrites)} history={gaugeSeries((s) => s.queuedWrites)} color="var(--warn)" />
          </div>
          <div className="faint db-mon-foot">
            Queued is the one to watch: a client in the queue is waiting for the lock rather than
            working.
          </div>
        </Panel>

        <Panel
          title="Network"
          note={statusError ? refusal(statusError, 'serverStatus').note : null}
          detail={statusError ? refusal(statusError, 'serverStatus').detail : null}
        >
          <div className="db-mon-stats">
            <Stat label="bytes in" value={bytesPerSec(latest?.bytesInPerSec)} history={series((r) => r.bytesInPerSec)} />
            <Stat label="bytes out" value={bytesPerSec(latest?.bytesOutPerSec)} history={series((r) => r.bytesOutPerSec)} />
            <Stat label="requests" value={`${perSec(latest?.requestsPerSec)}/s`} history={series((r) => r.requestsPerSec)} />
            <Stat
              label="connections"
              value={
                now?.connectionsCurrent === null || now?.connectionsCurrent === undefined
                  ? '—'
                  : `${gauge(now.connectionsCurrent)}${now.connectionsAvailable !== null ? ` / ${gauge(now.connectionsCurrent + now.connectionsAvailable)}` : ''}`
              }
              history={gaugeSeries((s) => s.connectionsCurrent)}
            />
          </div>
        </Panel>

        <Panel
          title="Memory"
          note={statusError ? refusal(statusError, 'serverStatus').note : null}
          detail={statusError ? refusal(statusError, 'serverStatus').detail : null}
        >
          <div className="db-mon-stats">
            <Stat label="resident" value={now?.memResidentBytes === null || now?.memResidentBytes === undefined ? '—' : formatBytes(now.memResidentBytes)} history={gaugeSeries((s) => s.memResidentBytes)} />
            <Stat label="virtual" value={now?.memVirtualBytes === null || now?.memVirtualBytes === undefined ? '—' : formatBytes(now.memVirtualBytes)} history={gaugeSeries((s) => s.memVirtualBytes)} />
          </div>
        </Panel>

        <Panel
          title="Hottest collections"
          note={topError ? refusal(topError, 'top').note : null}
          detail={topError ? refusal(topError, 'top').detail : null}
        >
          {top && top.length > 0 ? (
            <table className="table db-mon-table">
              <thead>
                <tr>
                  <th>namespace</th>
                  <th>ops/s</th>
                  <th>reads/s</th>
                  <th>writes/s</th>
                  <th>mean</th>
                </tr>
              </thead>
              <tbody>
                {top.slice(0, 8).map((r) => (
                  <tr key={r.ns}>
                    <td className="mono">{r.ns}</td>
                    <td className="mono">{perSec(r.opsPerSec)}</td>
                    <td className="mono">{perSec(r.readsPerSec)}</td>
                    <td className="mono">{perSec(r.writesPerSec)}</td>
                    <td className="mono">{r.meanMs === null ? '—' : `${r.meanMs.toFixed(2)} ms`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState
              compact
              title={top ? 'Nothing has run' : 'Waiting for a second sample'}
              message={
                top
                  ? 'No collection was touched in the last window. These are rates, so a quiet server has an empty list rather than a list of zeroes.'
                  : 'top reports totals since the server started, so the first sample cannot be a rate.'
              }
            />
          )}
        </Panel>

        <Panel
          title="Slowest operations"
          note={opsError ? refusal(opsError, '$currentOp').note : null}
          detail={opsError ? refusal(opsError, '$currentOp').detail : null}
        >
          {clientOps.length > 0 ? (
            <>
              <table className="table db-mon-table">
                <thead>
                  <tr>
                    <th>op</th>
                    <th>namespace</th>
                    <th>running</th>
                    <th>plan</th>
                    <th>lock</th>
                  </tr>
                </thead>
                <tbody>
                  {clientOps.slice(0, 8).map((o, i) => (
                    <tr key={`${String(o.opid)}-${i}`}>
                      <td className="mono">{o.op ?? '—'}</td>
                      <td className="mono">{o.ns ?? '—'}</td>
                      <td className="mono">{formatSeconds(o.secondsRunning)}</td>
                      <td className="mono">{o.planSummary ?? '—'}</td>
                      <td className="mono">{o.waitingForLock === null ? '—' : o.waitingForLock ? 'waiting' : 'no'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {ops?.ownOpsOnly && (
                <div className="db-mon-foot warn">
                  <AlertTriangle size={11} /> Only this connection&rsquo;s own operations. $currentOp
                  was refused for all users, so this list is not the server&rsquo;s.
                </div>
              )}
            </>
          ) : (
            <EmptyState
              compact
              title={ops ? 'Nothing is running' : 'Not read yet'}
              message={
                ops
                  ? `No client operation was in flight when the server was last asked.${ops.ownOpsOnly ? ' $currentOp was refused for all users, so only this connection was visible.' : ''}`
                  : 'In-flight operations are read with every sample.'
              }
            />
          )}
        </Panel>
      </div>
    </div>
  )
}
