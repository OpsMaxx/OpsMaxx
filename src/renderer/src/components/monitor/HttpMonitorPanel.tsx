import { useEffect, useRef, useState } from 'react'
import { Globe, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { EmptyState } from '../common/EmptyState'
import { useApp } from '../../store/app'
import { toast } from '../../store/toast'
import { clsx } from '../../lib/format'
import {
  DEFAULT_CHECK,
  MAX_HISTORY,
  appendResult,
  evaluate,
  isCheckableUrl,
  summarise,
  type CheckResult,
  type CheckState,
  type HttpCheck
} from '../../../../shared/httpMonitor'

/**
 * External service checks: is this URL up, how fast, and how often lately.
 *
 * Deliberately external. Everything else in this view watches machines this app
 * has credentials for; this watches a URL from the outside, which is the thing
 * that tells you whether your users can reach it — a server can be perfectly
 * healthy while the service in front of it returns 502.
 *
 * ── The limitation, stated rather than discovered ──────────────────────────
 *
 * Checks run while this panel is open. They are not a background service and
 * they do not alert: closing the view stops them, and history lives in memory
 * for the session. That is a real limit and the panel says so on screen, because
 * a monitor that quietly stops monitoring is worse than no monitor at all.
 * Making it durable means a main-process scheduler writing into the history
 * store and hooking the alert pipeline, which is its own piece of work.
 */

const STATE_LABEL: Record<CheckState, string> = {
  up: 'Up',
  slow: 'Slow',
  down: 'Down',
  unknown: 'Not checked yet'
}

/** Semantic, and separate from the accent: this is status, not branding. */
const STATE_COLOR: Record<CheckState, string> = {
  up: 'var(--ok)',
  slow: 'var(--warn)',
  down: 'var(--danger)',
  unknown: 'var(--text-faint)'
}

export function HttpMonitorPanel(): React.JSX.Element {
  const checks = useApp((s) => s.httpChecks)
  const activeId = useApp((s) => s.activeId)
  const setChecks = useApp((s) => s.setHttpChecks)

  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [history, setHistory] = useState<Record<string, CheckResult[]>>({})
  const [running, setRunning] = useState<Set<string>>(new Set())

  const mine = checks.filter((c) => c.workspaceId === activeId())

  /**
   * Kept in a ref so the interval below can reach the current checks without
   * being torn down and rebuilt every time one changes — which would restart
   * every timer and skew the schedule each edit.
   */
  const checksRef = useRef(mine)
  checksRef.current = mine

  const runCheck = async (check: HttpCheck): Promise<void> => {
    setRunning((s) => new Set(s).add(check.id))
    try {
      const r = await window.opsmaxx?.http?.check({
        url: check.url,
        method: check.method,
        headers: {},
        via: { kind: 'direct' },
        insecureTls: check.insecureTls,
        timeoutMs: check.timeoutMs
      } as never)
      const outcome = r ?? { ok: false as const, error: 'The bridge did not answer.' }
      const result = evaluate(check, outcome)
      setHistory((h) => ({ ...h, [check.id]: appendResult(h[check.id] ?? [], result) }))
    } finally {
      setRunning((s) => {
        const next = new Set(s)
        next.delete(check.id)
        return next
      })
    }
  }

  /**
   * One timer for every check rather than one per check.
   *
   * A timer each would mean N intervals to reconcile on every edit; this ticks
   * once a second and asks each check whether it is due, which is the same
   * behaviour with one thing to clean up. A check with no history runs
   * immediately, so opening the panel gives an answer rather than a blank row
   * for a minute.
   */
  useEffect(() => {
    const tick = (): void => {
      const now = Date.now()
      for (const check of checksRef.current) {
        if (!check.enabled) continue
        const last = history[check.id]?.[history[check.id].length - 1]
        const due = !last || now - last.at >= check.intervalSec * 1000
        if (due && !running.has(check.id)) void runCheck(check)
      }
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [history, running])

  const add = (): void => {
    if (!isCheckableUrl(url)) return
    const check: HttpCheck = {
      ...DEFAULT_CHECK,
      id: `chk-${crypto.randomUUID()}`,
      workspaceId: activeId(),
      name: name.trim() || new URL(url.trim()).host,
      url: url.trim()
    }
    setChecks([...checks, check])
    setName('')
    setUrl('')
    setAdding(false)
    toast(`Watching ${check.name}`, 'ok')
  }

  const remove = (id: string): void => {
    setChecks(checks.filter((c) => c.id !== id))
    setHistory((h) => {
      const next = { ...h }
      delete next[id]
      return next
    })
  }

  return (
    <div className="content">
      <div className="content-header">
        <div>
          <h1>Service checks</h1>
          <div className="sub">Watch any URL from the outside</div>
        </div>
        <div className="spacer" />
        <button className="btn secondary size-28" onClick={() => setAdding((v) => !v)}>
          <Plus size={14} /> Add a check
        </button>
      </div>

      {adding && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label className="field" style={{ minWidth: 160 }}>
              <span className="field-label">Name (optional)</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field" style={{ flex: 1, minWidth: 240 }}>
              <span className="field-label">URL</span>
              <input
                className="input"
                placeholder="https://example.com/health"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') add()
                }}
              />
            </label>
            <button className="btn primary" disabled={!isCheckableUrl(url)} onClick={add}>
              Add
            </button>
          </div>
          {url.trim() !== '' && !isCheckableUrl(url) && (
            <span className="field-hint">Enter a full http:// or https:// URL.</span>
          )}
        </div>
      )}

      {mine.length === 0 ? (
        <EmptyState
          icon={<Globe size={26} />}
          title="No service checks"
          message="Watch a URL to see whether it answers, how fast, and how often it has been up while this view is open."
          action={
            <button className="btn primary" onClick={() => setAdding(true)}>
              <Plus size={15} /> Add a check
            </button>
          }
        />
      ) : (
        <div className="col" style={{ gap: 8, paddingBottom: 16 }}>
          {mine.map((check) => {
            const s = summarise(history[check.id] ?? [])
            return (
              <div key={check.id} className="card">
                <div className="row" style={{ gap: 10, alignItems: 'baseline' }}>
                  <span
                    className="status-dot"
                    style={{ background: STATE_COLOR[s.state] }}
                    aria-hidden
                  />
                  <span className="sidebar-title">{check.name}</span>
                  <span
                    className="faint"
                    style={{ fontSize: 11, color: STATE_COLOR[s.state] }}
                  >
                    {STATE_LABEL[s.state]}
                    {s.state === 'down' && s.lastError ? ` — ${s.lastError}` : ''}
                  </span>
                  <span className="spacer" style={{ flex: 1 }} />
                  <button
                    className="btn sm"
                    disabled={running.has(check.id)}
                    title="Check now"
                    onClick={() => void runCheck(check)}
                  >
                    <RefreshCw size={12} />
                  </button>
                  <button className="btn sm" title="Stop watching" onClick={() => remove(check.id)}>
                    <Trash2 size={12} />
                  </button>
                </div>

                <div className="row" style={{ gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
                  <span className="mono selectable faint" style={{ fontSize: 11 }}>
                    {check.url}
                  </span>
                  {s.medianMs !== null && (
                    // Median, not mean: one timeout in a hundred fast responses
                    // drags a mean somewhere no request ever was.
                    <span className="faint" style={{ fontSize: 11 }}>
                      median {s.medianMs} ms
                    </span>
                  )}
                  {s.uptimePct !== null && (
                    <span className="faint" style={{ fontSize: 11 }}>
                      {s.uptimePct}% of {s.runs} {s.runs === 1 ? 'check' : 'checks'}
                    </span>
                  )}
                </div>

                {/* One cell per run, oldest left. A shape rather than a chart:
                    what a person reads off this is "has it been flapping", and
                    that is legible at four pixels a run. */}
                {(history[check.id]?.length ?? 0) > 0 && (
                  <div
                    className="row"
                    style={{ gap: 2, marginTop: 8 }}
                    title={`Last ${history[check.id].length} checks, oldest first`}
                  >
                    {history[check.id].slice(-MAX_HISTORY).map((r, i) => (
                      <span
                        key={i}
                        className={clsx('spark-cell')}
                        style={{
                          background: STATE_COLOR[r.state],
                          width: 4,
                          height: 14,
                          borderRadius: 1,
                          opacity: r.state === 'unknown' ? 0.3 : 1
                        }}
                        title={`${new Date(r.at).toLocaleTimeString()} — ${STATE_LABEL[r.state]}${
                          r.status ? ` (${r.status})` : ''
                        }${r.durationMs !== undefined ? ` ${r.durationMs} ms` : ''}`}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })}

          {/* Said plainly and permanently. A monitor that stops when a view
              closes, without saying so, teaches people to trust a number that
              is not being maintained. */}
          <span className="faint" style={{ fontSize: 11, marginTop: 4 }}>
            Checks run while this view is open and their history is kept for this session.
            They do not run in the background and do not raise alerts yet.
          </span>
        </div>
      )}
    </div>
  )
}
