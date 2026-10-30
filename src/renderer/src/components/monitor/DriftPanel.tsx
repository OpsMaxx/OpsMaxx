import { useCallback, useEffect, useMemo, useState } from 'react'
import { FileDiff, Info, Pin, RefreshCw } from 'lucide-react'
import { bridgeHas } from '../../lib/bridge'
import { collectNow } from '../../lib/collectNow'
import { SweepProgress } from './SweepProgress'
import { useApp } from '../../store/app'
import {
  checkDriftWatch,
  driftWatchApprovalSentence,
  driftWatchId,
  driftWatchPhrase,
  verifyDriftWatchApproval,
  type DriftWatchProposal
} from '../../../../shared/driftWatch'
import { clsx } from '../../lib/format'
import type { Server } from '../../types'
import { NoteWhy, PanelShell } from './PanelShell'
import { SweepEmpty } from './SweepEmpty'
import { useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'
import type { MessageKey } from '../../../../shared/i18n'
import {
  DRIFT_NO_PUSH,
  DRIFT_PREVIEW_CHARS,
  DRIFT_RULE_ORDER,
  DRIFT_STATUS_HELP,
  DRIFT_WATCHES,
  compareDrift,
  driftCoverageSentence,
  driftRule,
  type DriftHostResult,
  type DriftVerdict,
  type DriftWatch,
  type HostDrift
} from '../../../../shared/drift'

// Configuration drift — roadmap item 25, the panel.
//
// Everything this panel can get wrong looks fine on screen, so what it renders
// is shaped around three refusals:
//
//  1. A host that could not be read never appears in the same column as a host
//     that matched. It gets its own row, its own word, and its status's own
//     explanation.
//  2. A host whose difference a rule removed is never labelled "identical". It
//     says "differs in ways I was told to ignore" and names the rules.
//  3. The rules are on the screen, not in the source. An operator disagreeing
//     with a verdict can read what each rule removes, with a worked example,
//     and the sentence saying why this file is compared under that set.

const VERDICT_LABEL: Record<DriftVerdict, MessageKey> = {
  baseline: 'monitor.drift.verdict.baseline',
  identical: 'monitor.drift.verdict.identical',
  'ignored-difference': 'monitor.drift.verdict.ignoredDifference',
  differs: 'monitor.drift.verdict.differs',
  absent: 'monitor.drift.verdict.absent',
  unread: 'monitor.drift.verdict.unread'
}

/** The class that decides the colour. `ignored-difference` is deliberately NOT
 *  the same as `identical`: it matches, and it is not the same answer. */
const VERDICT_CLASS: Record<DriftVerdict, string> = {
  baseline: 'ok',
  identical: 'ok',
  'ignored-difference': 'muted',
  differs: 'warn',
  absent: 'warn',
  unread: 'faint'
}

interface Entry {
  drift?: HostDrift
  at?: number
  error?: string
}

function Rules({ watchId }: { watchId: string }): React.JSX.Element | null {
  const t = useT()
  const watch = DRIFT_WATCHES.find((x) => x.id === watchId)
  if (!watch) return null
  // Rendered in the pipeline order, which is the order they actually run in —
  // the watch's own list order is not it, and showing a list in an order the
  // code does not use is worse than showing none.
  const rules = DRIFT_RULE_ORDER.filter((id) => watch.rules.includes(id)).map(driftRule)
  return (
    <div className="panel-note" data-testid="drift-rules">
      <Trans i18nKey="monitor.drift.rulesIntro" values={{ path: watch.path }} components={{ b: <b /> }} />
      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
        {rules.map((r) => (
          <li key={r.id}>
            <b>{r.label}</b> — {r.detail}{' '}
            <span className="faint">
              {t('monitor.drift.eg')} <code>{r.example.before}</code> → <code>{r.example.after}</code>
            </span>
          </li>
        ))}
      </ul>
      <div style={{ marginTop: 6 }}>
        <Info size={12} /> {watch.note}
      </div>
    </div>
  )
}

function Row({
  r,
  pinned,
  onPin
}: {
  r: DriftHostResult
  pinned: boolean
  onPin: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <tr>
      <td>
        <button
          className={clsx('btn ghost sm', pinned && 'active')}
          title={t('monitor.drift.pinTitle')}
          onClick={onPin}
        >
          <Pin size={11} />
        </button>{' '}
        {r.serverName}
      </td>
      <td className={VERDICT_CLASS[r.verdict]}>{t(VERDICT_LABEL[r.verdict])}</td>
      <td className="faint">
        {r.verdict === 'ignored-difference' && r.ignoredBy?.length ? (
          // The sentence this whole item turns on. "Candidates" and not "the
          // cause": proving which single rule is load-bearing would need both
          // files' contents, and not keeping those is the storage decision.
          t('monitor.drift.ignoredBy', {
            rules: r.ignoredBy.map((id) => driftRule(id).label.toLowerCase()).join(', ')
          })
        ) : r.verdict === 'unread' ? (
          <>{DRIFT_STATUS_HELP[r.status]}{r.detail ? ` (${r.detail})` : ''}</>
        ) : r.verdict === 'absent' ? (
          DRIFT_STATUS_HELP.absent
        ) : r.redacted ? (
          t('monitor.drift.redacted')
        ) : (
          ''
        )}
      </td>
    </tr>
  )
}

/**
 * This machine, alongside the estate.
 *
 * A sentinel id, never a row in `servers` — that list is persisted and mirrored
 * into the MCP data cache. See shared/execTarget.ts.
 *
 * Read on demand rather than by the fleet sweep. The sweep writes a hash per
 * watched file into the durable history store keyed by host, and a record of
 * this machine's configuration files does not belong in the estate's history.
 * `fleet:drift-local` returns a reading and keeps nothing.
 */
const LOCAL_ID = 'local'
const LOCAL_NAME = 'This machine'

export function DriftPanel({ servers }: { servers: Server[] }): React.JSX.Element {
  const t = useT()
  const [entries, setEntries] = useState<Record<string, Entry>>({})
  const [watchId, setWatchId] = useState<string>(DRIFT_WATCHES[0].id)
  // Item 46's operator-chosen watches, beside the catalogue rather than instead
  // of it. Re-validated here so a settings blob edited by hand cannot put a
  // path in the picker -- and AGAIN in main, which is the check that counts:
  // see services/driftWatchStore.ts.
  const stored = useApp((st) => st.settings.driftWatches)
  const setSettings = useApp((st) => st.setSettings)
  const custom = useMemo(() => {
    const out: DriftWatch[] = []
    for (const p of stored) {
      const c = checkDriftWatch(p, [...DRIFT_WATCHES, ...out])
      if (c.ok) out.push(c.watch)
    }
    return out
  }, [stored])
  const allWatches = useMemo(() => [...DRIFT_WATCHES, ...custom], [custom])
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<DriftWatchProposal>({
    path: '',
    label: '',
    comment: '#',
    rules: [...DRIFT_RULE_ORDER]
  })
  const [phrase, setPhrase] = useState('')
  const check = checkDriftWatch(draft, allWatches)

  const addWatch = (): void => {
    // Both guards are the function's own preconditions and BOTH are currently
    // redundant with the disabled button below -- a mutation removing the
    // approval check survives the tests for exactly that reason, and it is
    // recorded here rather than defended with a test that would only be
    // testing the mutation. They stay because a disabled button is a UI state
    // and this is a function: the next caller may not be a button. What is NOT
    // redundant is main's own re-validation, which is the check that counts —
    // see services/driftWatchStore.ts.
    if (!check.ok) return
    if (!verifyDriftWatchApproval(draft.path.trim(), phrase)) return
    setSettings({ driftWatches: [...stored, { ...draft, path: draft.path.trim() }] })
    setAdding(false)
    setPhrase('')
    setDraft({ path: '', label: '', comment: '#', rules: [...DRIFT_RULE_ORDER] })
  }

  const removeWatch = (path: string): void => {
    setSettings({ driftWatches: stored.filter((p) => p.path.trim() !== path) })
    if (watchId === driftWatchId(path)) setWatchId(DRIFT_WATCHES[0].id)
  }
  const [pinned, setPinned] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [showRules, setShowRules] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const fleet = window.opsmaxx?.fleet as Record<string, unknown> | undefined
    if (!bridgeHas(fleet, 'drift')) return
    const next: Record<string, Entry> = {}

    // Taken now, not read from the sweep — the sweep does not visit this
    // machine. A probe answers `{ ok }`, so it is adapted into the same Entry
    // the cached servers use and the comparison below stays one code path.
    const readLocal = async (): Promise<void> => {
      if (!bridgeHas(fleet, 'driftLocal')) return
      const at = Date.now()
      try {
        const r = await window.opsmaxx?.fleet?.driftLocal?.({ serverName: LOCAL_NAME })
        if (!r) return
        next[LOCAL_ID] = r.ok ? { drift: r.drift, at } : { error: `${r.reason}: ${r.detail}`, at }
      } catch (e) {
        next[LOCAL_ID] = { error: e instanceof Error ? e.message : String(e), at }
      }
    }

    await Promise.all([
      readLocal(),
      ...servers.map(async (s) => {
        const r = await window.opsmaxx?.fleet?.drift(s.id)
        if (r) next[s.id] = { drift: r.drift, at: r.at, error: r.error }
      })
    ])
    setEntries(next)
  }, [servers])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = async (): Promise<void> => {
    setBusy(true)
    try {
      // Collect, not just sweep: this probe keeps its own hourly clock, and a
      // plain sweep does not clear it — so pressing this re-read metrics and
      // skipped drift entirely. See lib/collectNow.
      await collectNow()
      await load()
    } finally {
      setBusy(false)
    }
  }

  const watch = allWatches.find((x) => x.id === watchId) ?? allWatches[0]

  /** The estate, then this machine — last, so the fleet reads first. */
  const hosts = useMemo(
    () => [
      ...servers.map((s) => ({ id: s.id, name: s.name })),
      // Only when the channel is actually wired. A build without it would
      // otherwise show a row that can never be filled, which reads as a host
      // that has never been collected rather than as a missing feature.
      ...(bridgeHas(window.opsmaxx?.fleet as Record<string, unknown> | undefined, 'driftLocal')
        ? [{ id: LOCAL_ID, name: LOCAL_NAME }]
        : [])
    ],
    [servers]
  )

  const comparison = useMemo(
    () =>
      compareDrift({
        watch,
        baselineServerId: pinned,
        hosts: hosts.map((s) => ({
          serverId: s.id,
          serverName: s.name,
          drift: entries[s.id]?.drift,
          error: entries[s.id]?.error
        }))
      }),
    [watch, pinned, hosts, entries]
  )

  const sentence = driftCoverageSentence(comparison.coverage)
  const collected = hosts.filter((s) => entries[s.id]?.drift).length

  return (
    <PanelShell
      icon={<FileDiff size={14} />}
      title={t('modules.drift.label')}
      about={
        <>
          <p>{t('monitor.drift.about')}</p>
          {/* Behind the disclosure for the reason written out in PatchPanel:
              this states a limit of what the app WRITES, not a limit of what it
              read, so no number on the page becomes misleading without it. It
              is still on this panel, where someone looking for the button that
              fixes three diverging hosts will look. */}
          <p data-testid="drift-no-push">{DRIFT_NO_PUSH}</p>
        </>
      }
      actions={
        <>
          <select
            className="input sm"
            aria-label={t('monitor.drift.watchedFile')}
            value={watchId}
            onChange={(e) => setWatchId(e.target.value)}
          >
            {allWatches.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
          <button className="btn ghost sm" onClick={() => setAdding((a) => !a)}>
            {adding ? t('common.cancel') : t('monitor.drift.watchAFile')}
          </button>
          <div className="check-now">
            <button
              className="btn ghost sm"
              disabled={busy}
              onClick={() => void refresh()}
              title={t('monitor.drift.checkTitle')}
            >
              <RefreshCw size={13} className={clsx(busy && 'spin')} />
              {busy ? t('monitor.common.checking') : t('monitor.common.checkNow')}
            </button>
            <SweepProgress active={busy} label={t('monitor.drift.progressLabel')} />
          </div>
        </>
      }
    >
      {adding && (
        <div className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <div className="r-title">{t('monitor.drift.watchAnother')}</div>
          <input
            className="input mono"
            aria-label={t('monitor.drift.path')}
            placeholder="/etc/logrotate.conf"
            value={draft.path}
            onChange={(e) => setDraft({ ...draft, path: e.target.value })}
          />
          <input
            className="input"
            aria-label={t('monitor.drift.label')}
            placeholder={t('monitor.drift.labelPlaceholder')}
            value={draft.label}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
          {/* The refusal, with its own sentence. Every one of these is a
              different thing to do about it, and "invalid path" would be none
              of them. */}
          {!check.ok ? (
            draft.path.trim() === '' ? (
              <div className="s-note faint">{t('monitor.drift.pathHint')}</div>
            ) : (
              <div className="s-note is-alarm">{check.detail}</div>
            )
          ) : (
            <>
              {/* What is being asserted, said before it is typed. */}
              <div className="s-note warn">{driftWatchApprovalSentence(check.watch.path)}</div>
              <input
                className="input mono"
                aria-label={t('monitor.drift.typeToConfirm', { phrase: driftWatchPhrase(check.watch.path) })}
                placeholder={driftWatchPhrase(check.watch.path)}
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
              />
            </>
          )}
          <div className="row-actions">
            <button
              className="btn primary"
              disabled={!check.ok || !verifyDriftWatchApproval(draft.path.trim(), phrase)}
              onClick={addWatch}
            >
              {t('common.add')}
            </button>
          </div>
        </div>
      )}

      {custom.length > 0 && (
        <table className="mini-table">
          <tbody>
            {custom.map((w) => (
              <tr key={w.id}>
                <td className="mono">{w.path}</td>
                <td className="faint">{w.label}</td>
                <td>
                  <button
                    className="btn ghost sm"
                    aria-label={t('monitor.drift.stopWatchingPath', { path: w.path })}
                    onClick={() => removeWatch(w.path)}
                  >
                    {t('monitor.drift.stopWatching')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {collected === 0 ? (
        <SweepEmpty
          subject={t('monitor.drift.emptySubject')}
          busy={busy}
          onCheckNow={() => void refresh()}
          note={t('monitor.drift.emptyNote')}
        />
      ) : (
        <>
          <div className="panel-stats">
            {/* Each count is one text node rather than a number beside a word.
                A React fragment splits `{n} match{...}` into three nodes, which
                reads identically and is not the same string — and a headline
                nobody can find is a headline nobody reads. */}
            <span>
              <span>{t('monitor.drift.matches', { count: comparison.matching })}</span>
              {comparison.diverging > 0 && (
                <span className="state-watch">
                  {` · ${t('monitor.drift.differ', { count: comparison.diverging })}`}
                </span>
              )}
              {comparison.coverage.absent.length > 0 && (
                <span className="state-unknown">
                  {` · ${t('monitor.drift.noFile', { count: comparison.coverage.absent.length })}`}
                </span>
              )}
            </span>
            <button className="btn ghost sm" onClick={() => setShowRules((v) => !v)}>
              {t(showRules ? 'monitor.drift.hideRules' : 'monitor.drift.showRules', {
                count: watch.rules.length
              })}
            </button>
          </div>

          {showRules && <Rules watchId={watch.id} />}

          {comparison.baselineServerId === null ? (
            <div className="panel-note is-unknown" data-testid="drift-no-baseline">
              {pinned ? t('monitor.drift.noBaselinePinned') : t('monitor.drift.noBaselineNone')}
            </div>
          ) : (
            comparison.baselineChosen && (
              <div className="panel-note" data-testid="drift-chosen-baseline">
                {t('monitor.drift.chosenBaseline')}
              </div>
            )
          )}

          {sentence && (
            <div className="panel-note is-unknown" data-testid="drift-coverage">
              {sentence}
            </div>
          )}

          <div className="inv-scroll">
            <table className="table inv-table">
              <thead>
                <tr>
                  <th>{t('monitor.drift.host')}</th>
                  <th>{t('monitor.drift.comparedWith')}</th>
                  <th>{t('monitor.drift.why')}</th>
                </tr>
              </thead>
              <tbody>
                {comparison.results.map((r) => (
                  <Row
                    key={r.serverId}
                    r={r}
                    pinned={comparison.baselineServerId === r.serverId}
                    onPin={() => setPinned(pinned === r.serverId ? undefined : r.serverId)}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel-note faint">
            {/* The privacy claim stays on the page; the mechanism behind it
                folds. What a reader must not have to expand for is that the
                file itself is never stored — the two-hashes-and-a-status
                detail is how that is achieved, which is a different question
                and one most people never ask. */}
            {t('monitor.drift.overHashes')}
            <NoteWhy summary={t('monitor.drift.howItWorks')}>
              {t('monitor.drift.howItWorksBody', { chars: DRIFT_PREVIEW_CHARS })}
            </NoteWhy>
          </div>
        </>
      )}
    </PanelShell>
  )
}
