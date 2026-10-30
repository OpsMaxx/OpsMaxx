import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Play, Plus, RotateCw, Square, Trash2 } from 'lucide-react'
import { EmptyState } from '../common/EmptyState'
import { clsx } from '../../lib/format'
import { useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'
import type { MessageKey } from '../../../../shared/i18n'
import {
  PROCESS_LOG_PAGE,
  processDraftProblem
} from '../../../../shared/processes'
import type {
  ManagedProcessView,
  ProcessEnvVar,
  ProcessDraft,
  ProcessLogLine,
  ProcessState,
  ProcessStatus,
  ProcessesBridge
} from '../../../../shared/processes'

// Roadmap item 1 — the local half. See src/shared/processes.ts for why there
// is no remote half, no auto-start, and no environment VALUE anywhere in this
// file.
//
// ---------------------------------------------------------------------------
// IT POLLS. THERE IS NO LOG STREAM AND NO STATUS EVENT.
// ---------------------------------------------------------------------------
//
// A crash-looping process writes as fast as the OS will let it, and a push
// channel repaints this at exactly that rate. The ring in main is bounded, but
// a stream out of a bounded ring is not — the bound is on what is HELD, not on
// what is SENT. Polling makes the cost of a process that has lost its mind one
// capped page per interval, whatever it is doing, and it makes that cost
// visible in one constant rather than emergent from how fast a child writes.
//
// The interval only runs while this tab is the one on screen, and only while
// the window has focus: FleetMonitor keeps every panel mounted and hidden, so
// an unconditional interval here would be a poll per second for a tab nobody
// is looking at.

/** How often the visible tab asks. Fast enough that Start feels immediate,
 *  slow enough that it is not a busy loop. */
const POLL_MS = 1_500

/**
 * The bridge, or null when this build's main process has none.
 *
 * Checked at runtime rather than assumed, the same way `CronPanel.editBridge`
 * is: a main process that has not been taught these channels answers nothing,
 * and a button that silently does nothing is worse than an absent one.
 */
function processBridge(): ProcessesBridge | null {
  const p = (window.opsmaxx as { processes?: Partial<ProcessesBridge> } | undefined)?.processes
  return p && typeof p.list === 'function' && typeof p.start === 'function'
    ? (p as ProcessesBridge)
    : null
}

const STATE_LABEL: Record<ProcessState, MessageKey> = {
  stopped: 'processes.state.stopped',
  starting: 'processes.state.starting',
  running: 'processes.state.running',
  'crash-looped': 'processes.state.crashLooped',
  failed: 'processes.state.failed'
}

const STATE_CLASS: Record<ProcessState, string> = {
  stopped: '',
  starting: 'warn',
  running: 'ok',
  'crash-looped': 'danger',
  failed: 'danger'
}

const emptyDraft = (): ProcessDraft => ({
  name: '',
  command: '',
  args: [],
  cwd: '',
  env: [],
  restart: 'on-failure',
  readiness: { kind: 'spawned' }
})

export function ProcessesPanel(): React.JSX.Element {
  const t = useT()
  const bridge = useMemo(processBridge, [])
  // `null` until the first read lands. An empty array here renders "No
  // processes yet", which is a claim about what is running under supervision --
  // made, before the fix, about a list nobody had fetched. The missing-bridge
  // case is already answered honestly above, so this only ever means "asked,
  // still waiting".
  const [rows, setRows] = useState<ManagedProcessView[] | null>(null)
  const [status, setStatus] = useState<Record<string, ProcessStatus>>({})
  const [openId, setOpenId] = useState<string | null>(null)
  const [logs, setLogs] = useState<ProcessLogLine[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<ProcessDraft>(emptyDraft)
  const [argsText, setArgsText] = useState('')

  // Held in a ref so the polling effect does not re-subscribe every time the
  // open row changes, which would restart the interval on each keystroke.
  const openRef = useRef<string | null>(null)
  openRef.current = openId

  const refresh = useCallback(async (): Promise<void> => {
    if (!bridge) return
    try {
      const [list, statuses] = await Promise.all([bridge.list(), bridge.status()])
      setRows(list)
      setStatus(Object.fromEntries(statuses.map((s) => [s.id, s])))
      const open = openRef.current
      // One capped page, and only for the row that is actually open. A closed
      // drawer costs nothing.
      setLogs(open ? await bridge.logs(open, PROCESS_LOG_PAGE) : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [bridge])

  useEffect(() => {
    void refresh()
  }, [refresh, openId])

  useEffect(() => {
    if (!bridge) return
    const id = setInterval(() => {
      // Nothing while the window is in the background. A supervised process is
      // watched by main whether or not anybody is looking at it; this poll only
      // exists to redraw a table.
      if (document.visibilityState === 'visible') void refresh()
    }, POLL_MS)
    return () => clearInterval(id)
  }, [bridge, refresh])

  const act = async (id: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(id)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
      await refresh()
    }
  }

  const setEnv = (i: number, next: ProcessEnvVar): void => {
    setDraft((d) => ({ ...d, env: d.env.map((e, j) => (j === i ? next : e)) }))
  }

  const submit = async (): Promise<void> => {
    if (!bridge) return
    const next: ProcessDraft = {
      ...draft,
      name: draft.name.trim(),
      command: draft.command.trim(),
      cwd: draft.cwd.trim(),
      // Whitespace-separated, which is a deliberate limit rather than a
      // shortcut: an argument containing a space needs quoting, quoting needs
      // a parser, and a parser here would be a shell — which is the one thing
      // this feature does not have. Nothing is ever handed to `sh`.
      args: argsText.split(/\s+/).filter(Boolean)
    }
    const problem = processDraftProblem(next)
    if (problem) {
      setError(problem)
      return
    }
    setError(null)
    try {
      await bridge.create(next)
      setAdding(false)
      setDraft(emptyDraft())
      setArgsText('')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (!bridge) {
    return (
      <div className="panel-body">
        <div className="s-desc">{t('processes.noBridge')}</div>
      </div>
    )
  }

  return (
    <div className="panel-body">
      <div className="content-header" style={{ paddingLeft: 0, paddingRight: 0 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 15 }}>{t('processes.title')}</h2>
          <div className="sub">{t('processes.sub')}</div>
        </div>
        <span className="spacer" />
        <button className="btn secondary size-28" onClick={() => setAdding((v) => !v)}>
          <Plus size={14} /> {t('processes.addProcess')}
        </button>
      </div>

      {/* Only what happened OUTSIDE the form — a start that failed, a remove
          that did not. While the form is open its own problem belongs beside
          its own footer, not in a banner above the fields it is about, where
          the user has to scroll back up past everything they just typed. */}
      {error && !adding && (
        <div className="s-desc danger" role="alert" style={{ marginBottom: 10 }}>
          {error}
        </div>
      )}

      {adding && (
        <div className="card" style={{ marginBottom: 12, padding: 12 }}>
          <label className="s-label">{t('processes.form.name')}</label>
          <input
            className="input"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder={t('processes.form.namePlaceholder')}
          />
          <label className="s-label">{t('processes.form.command')}</label>
          <input
            className="input"
            value={draft.command}
            onChange={(e) => setDraft({ ...draft, command: e.target.value })}
            placeholder="/usr/local/bin/node"
          />
          <label className="s-label">{t('processes.form.arguments')}</label>
          <input
            className="input"
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
            placeholder="server.js --port 3000"
          />
          <div className="s-desc">
            <Trans i18nKey="processes.form.argumentsHelp" components={{ code: <code /> }} />
          </div>
          <label className="s-label">{t('processes.form.cwd')}</label>
          <input
            className="input"
            value={draft.cwd}
            onChange={(e) => setDraft({ ...draft, cwd: e.target.value })}
            placeholder="/srv/api"
          />
          <label className="s-label">{t('processes.form.env')}</label>
          {draft.env.map((e, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
              <input
                className="input"
                style={{ flex: '0 0 34%' }}
                value={e.key}
                aria-label={t('processes.form.varName', { n: i + 1 })}
                onChange={(ev) => setEnv(i, { ...e, key: ev.target.value })}
                placeholder="NODE_ENV"
              />
              <select
                className="input"
                style={{ flex: '0 0 26%' }}
                aria-label={t('processes.form.varSource', { n: i + 1 })}
                value={e.kind}
                onChange={(ev) =>
                  setEnv(
                    i,
                    ev.target.value === 'vault'
                      ? { key: e.key, kind: 'vault', vaultEntryId: '', slot: 'password' }
                      : { key: e.key, kind: 'literal', value: '' }
                  )
                }
              >
                <option value="literal">{t('processes.form.source.literal')}</option>
                <option value="vault">{t('processes.form.source.vault')}</option>
              </select>
              {e.kind === 'literal' ? (
                <input
                  className="input"
                  value={e.value}
                  aria-label={t('processes.form.varValue', { n: i + 1 })}
                  onChange={(ev) => setEnv(i, { ...e, value: ev.target.value })}
                  placeholder="production"
                />
              ) : (
                <input
                  className="input"
                  value={e.vaultEntryId}
                  aria-label={t('processes.form.varVaultEntry', { n: i + 1 })}
                  onChange={(ev) => setEnv(i, { ...e, vaultEntryId: ev.target.value })}
                  placeholder={t('processes.form.vaultEntryPlaceholder')}
                />
              )}
              <button
                className="btn ghost size-28"
                aria-label={t('processes.form.removeVar', { n: i + 1 })}
                onClick={() => setDraft({ ...draft, env: draft.env.filter((_x, j) => j !== i) })}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          <button
            className="btn quiet size-24"
            onClick={() =>
              setDraft({
                ...draft,
                env: [...draft.env, { key: '', kind: 'literal', value: '' }]
              })
            }
          >
            <Plus size={13} /> {t('processes.form.addVar')}
          </button>
          <div className="s-desc">
            {t('processes.form.secretHelp')}
            {/* A vault entry is identified rather than PICKED, and that is a
                boundary rather than an oversight: a module may not reach
                `window.opsmaxx.vault` (MODULE_FORBIDDEN_BRIDGE), which
                returns every entry with its password in it. A picker needs
                main to offer names and ids WITHOUT values — a channel that
                does not exist yet, and adding one is a decision about the
                vault rather than about this panel. */}
          </div>

          <label className="s-label">{t('processes.form.restartLabel')}</label>
          <select
            className="input"
            value={draft.restart}
            onChange={(e) =>
              setDraft({ ...draft, restart: e.target.value as ProcessDraft['restart'] })
            }
          >
            <option value="never">{t('processes.form.restart.never')}</option>
            <option value="on-failure">{t('processes.form.restart.onFailure')}</option>
            <option value="always">{t('processes.form.restart.always')}</option>
          </select>
          <label className="s-label">{t('processes.form.readyWhen')}</label>
          <select
            className="input"
            value={draft.readiness.kind}
            onChange={(e) =>
              setDraft({
                ...draft,
                readiness:
                  e.target.value === 'log'
                    ? { kind: 'log', pattern: '', timeoutMs: 30_000 }
                    : { kind: 'spawned' }
              })
            }
          >
            <option value="spawned">{t('processes.form.ready.spawned')}</option>
            <option value="log">{t('processes.form.ready.log')}</option>
          </select>
          {draft.readiness.kind === 'log' && (
            <>
              <input
                className="input"
                value={draft.readiness.pattern}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    readiness: { kind: 'log', pattern: e.target.value, timeoutMs: 30_000 }
                  })
                }
                placeholder="listening on"
              />
              <div className="s-desc">{t('processes.form.readyHelp')}</div>
            </>
          )}
          {/* The dialog footer contract, in an inline panel: the commit is
              bottom-RIGHT and after the fields it commits, it is filled rather
              than the same unfilled grey as Cancel, and the reason it did not
              work sits beside it instead of at the top of the panel. */}
          <div className="inline-panel-footer">
            {error && (
              <span className="footer-note field-error" role="alert">
                {error}
              </span>
            )}
            <button className="btn secondary size-28" onClick={() => setAdding(false)}>
              {t('common.cancel')}
            </button>
            <button className="btn primary size-28" onClick={() => void submit()}>
              {t('processes.form.submit')}
            </button>
          </div>
        </div>
      )}

      {rows === null && !adding && (
        <div className="s-desc state-unknown">{t('processes.reading')}</div>
      )}

      {rows?.length === 0 && !adding && (
        // Was a single left-aligned line of body text with an inline icon —
        // its own grammar, in a product that already has one for this.
        <EmptyState
          compact
          title={t('processes.empty.title')}
          message={t('processes.empty.message')}
          // Not "Add a process" a second time: the header button says exactly
          // that eighty pixels above, and two controls with one name is a
          // thing a screen reader reads out twice and a person reads as a
          // choice between two options that do not differ.
          action={
            <button className="btn secondary size-28" onClick={() => setAdding(true)}>
              <Plus size={14} /> {t('processes.empty.action')}
            </button>
          }
        />
      )}

      {(rows ?? []).map((p) => {
        const st = status[p.id]
        const state = st?.state ?? 'stopped'
        const live = state === 'running' || state === 'starting'
        return (
          <div key={p.id} className="card" style={{ marginBottom: 8, padding: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong>{p.name}</strong>
              <span className={clsx('chip', STATE_CLASS[state])}>{t(STATE_LABEL[state])}</span>
              {st && st.pid > 0 && <span className="s-desc">pid {st.pid}</span>}
              {st && st.restarts > 0 && (
                <span className="s-desc">{t('processes.restarts', { count: st.restarts })}</span>
              )}
              <span className="spacer" />
              <button
                className="btn quiet size-24"
                disabled={busy === p.id || live}
                onClick={() => void act(p.id, () => bridge.start(p.id))}
              >
                <Play size={13} /> {t('processes.start')}
              </button>
              <button
                className="btn quiet size-24"
                disabled={busy === p.id || !live}
                onClick={() => void act(p.id, () => bridge.stop(p.id))}
              >
                <Square size={13} /> {t('processes.stop')}
              </button>
              <button
                className="btn quiet size-24"
                disabled={busy === p.id}
                onClick={() => void act(p.id, () => bridge.restart(p.id))}
              >
                <RotateCw size={13} /> {t('processes.restart')}
              </button>
              <button
                className="btn ghost size-24"
                disabled={busy === p.id}
                onClick={() => void act(p.id, () => bridge.remove(p.id))}
                aria-label={t('common.delete')}
                title={t('processes.removeTitle')}
              >
                <Trash2 size={13} />
              </button>
            </div>

            <div className="s-desc" style={{ marginTop: 4 }}>
              <Trans
                i18nKey="processes.commandIn"
                values={{ command: `${p.command} ${p.args.join(' ')}`, cwd: p.cwd }}
                components={{ code: <code /> }}
              />
            </div>

            {p.env.length > 0 && (
              <div className="s-desc">
                {/* Keys and where each value comes from. Never a value: main
                    does not send one, and there is nothing here that could
                    display one if it did. */}
                {p.env.map((e) => (
                  <span key={e.key} className="chip" style={{ marginRight: 4 }}>
                    {e.key}
                    {e.source === 'vault' ? ` ${t('processes.fromVault')}` : ''}
                  </span>
                ))}
              </div>
            )}

            {/* Why it is not running, when there is a why. Said on the row
                rather than in a toast: the answer has to still be there when
                somebody comes back to the tab. */}
            {st?.error && (
              <div className="s-desc danger" style={{ marginTop: 4 }}>
                {st.error}
              </div>
            )}

            <button
              className="btn quiet size-24"
              style={{ marginTop: 6 }}
              onClick={() => setOpenId(openId === p.id ? null : p.id)}
            >
              {openId === p.id ? t('processes.hideOutput') : t('processes.showOutput')}
            </button>

            {openId === p.id && (
              <pre
                className="log-drawer"
                style={{ maxHeight: 260, overflow: 'auto', marginTop: 6 }}
              >
                {logs.length === 0
                  ? t('processes.nothingYet')
                  : logs.map((l) => `${l.stream === 'stderr' ? '! ' : ''}${l.text}`).join('\n')}
              </pre>
            )}
          </div>
        )
      })}
    </div>
  )
}
