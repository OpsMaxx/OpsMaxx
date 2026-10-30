import { useCallback, useEffect, useState } from 'react'
import { CalendarClock, Pencil, Plus, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react'
import { clsx } from '../../lib/format'
import { useT } from '../../lib/i18n'
import { sshHopsFor } from '../../lib/ssh'
import { openMonitor, useNav } from '../../store/nav'
import {
  cronEditRefusal,
  describeSchedule,
  isValidCronSchedule,
  summariseCronSources
} from '../../../../shared/cron'
import type {
  CronEditBridge,
  CronEditPlanReply,
  CronEditRequest,
  CronEditTargetRef,
  CronEntry,
  CronSourceReport
} from '../../../../shared/cron'
import { approvalFor, planBroadcast } from '../../../../shared/broadcast'
import type { Server } from '../../types'
import { PanelShell } from '../monitor/PanelShell'

// Writing a crontab — the write half of what used to be one Monitoring tab.
//
// CronPanel reads every crontab, /etc/crontab, /etc/cron.d, other accounts'
// spools and systemd timers across the estate, and says which of those it was
// actually allowed to read. That whole view is a read and it stays where it is.
// The three controls that WROTE — add, edit, remove — are here, because the
// destination they were on says nothing in it writes to a server, and a
// contract with an exception in it is not a contract.
//
// A SUB-TAB OF JOBS RATHER THAN A MODULE OF ITS OWN, and the argument is on the
// sub-tab strip in OperationsView: Jobs' subject is already "make this server
// run something", and a crontab is that sentence with "every day at three" in
// it. The alternative — a fourth top-level Operations tab for one form — buys
// nothing and costs the property the rail is built on, which is that the
// dangerous side of the app is small enough to hold in your head.
//
// Nothing here builds a command. The panel sends the change it wants, main
// reads the crontab, works out the exact bytes and hands them back to be
// confirmed; the confirmation is the broadcast/job approval record, because a
// cron edit is a write to the file that decides what runs unattended.

interface HostCron {
  serverId: string
  serverName: string
  entries: CronEntry[]
  unparsed: number
  /** What each source had to say for itself. Optional because it arrives over
   *  IPC: a main process that has not been taught to forward it sends nothing,
   *  and treating that as "all five read fine" would invent the reassurance
   *  this field exists to withdraw. */
  sources?: CronSourceReport[]
  error?: string
}

/**
 * The edit channels, or null when this build's main process has none.
 *
 * Checked at runtime rather than assumed: a main process that has not been
 * taught these answers nothing, and a button that silently does nothing is
 * worse than no button.
 */
function editBridge(): CronEditBridge | null {
  const c = (window.opsmaxx as { cron?: Partial<CronEditBridge> } | undefined)?.cron
  return c && typeof c.planEdit === 'function' && typeof c.write === 'function' ? (c as CronEditBridge) : null
}

// Duplicated from CronPanel rather than imported from it, deliberately: an
// Operations panel that imported a Monitoring panel to borrow ten lines would
// tie the write surface's build to the read surface's file, which is the
// coupling the split exists to remove.
const cfgFor = (s: Server): CronEditTargetRef['cfg'] => ({
  sessionId: `cron-${s.id}`,
  cols: 80,
  rows: 24,
  serverId: s.id,
  host: s.host,
  port: s.port,
  username: s.username,
  auth: s.auth === 'password' || s.auth === 'agent' ? s.auth : 'key',
  hops: sshHopsFor(s)
})

/** One job being written, identified by the line it came from — never by position. */
interface Draft {
  /** The line as read, when an existing job is being changed. Absent when adding. */
  line?: string
  schedule: string
  command: string
  /** The text cron pipes to the command on stdin, when the job has any. Carried
   *  through the edit and never shown in the command box: it is not part of the
   *  command, and an update that dropped it would change what the job is fed
   *  without changing anything the operator can see. */
  input?: string
}

/** A planned change, waiting for the operator to answer for it. */
interface Pending {
  target: CronEditTargetRef
  reply: CronEditPlanReply
  runId: string
}

/** The form for one job: a schedule and a command, and nothing clever. */
function JobForm({
  draft,
  onChange,
  onReview,
  onCancel,
  busy
}: {
  draft: Draft
  onChange: (d: Draft) => void
  onReview: () => void
  onCancel: () => void
  busy: boolean
}): React.JSX.Element {
  const t = useT()
  const scheduleOk = isValidCronSchedule(draft.schedule)
  // The same sentence the Monitoring list shows, computed by the same function,
  // so what the operator reads before saving is what they will read afterwards.
  // `null` means "a valid schedule this will not describe" — a wrong sentence
  // about when a job runs is worse than none.
  const described = scheduleOk ? describeSchedule(draft.schedule) : null
  return (
    <div className="panel-note" style={{ display: 'grid', gap: 6, marginTop: 6 }}>
      <div className="row" style={{ gap: 6, alignItems: 'center' }}>
        <input
          className="input mono"
          style={{ maxWidth: 170 }}
          placeholder="0 3 * * *"
          aria-label={t('operations.cron.scheduleLabel')}
          value={draft.schedule}
          onChange={(e) => onChange({ ...draft, schedule: e.target.value })}
        />
        <input
          className="input mono grow"
          placeholder="/usr/bin/backup --all"
          aria-label={t('operations.cron.commandLabel')}
          value={draft.command}
          onChange={(e) => onChange({ ...draft, command: e.target.value })}
        />
      </div>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <span className={clsx(scheduleOk ? 'faint' : 'warn')}>
          {scheduleOk
            ? (described ?? t('operations.cron.scheduleNoReading'))
            : t('operations.cron.scheduleInvalid')}
        </span>
        <span className="grow" />
        <button className="btn" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button
          className="btn"
          disabled={busy || !scheduleOk || draft.command.trim() === ''}
          onClick={onReview}
        >
          {t('operations.cron.reviewChange')}
        </button>
      </div>
    </div>
  )
}

export function CronEditPanel({ servers }: { servers: Server[] }): React.JSX.Element {
  const t = useT()
  const [serverId, setServerId] = useState<string | null>(null)
  const [host, setHost] = useState<HostCron | null>(null)
  const [loading, setLoading] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [phrase, setPhrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  const bridge = editBridge()
  // NOT filtered by `status`. It is written on the edge of a connect and never
  // re-asserted, so it reads `offline` for any host this session has not
  // opened — and what runs here goes over SSH, which dials on demand. Removing
  // a row for a stale field took away the one action that would refresh it.
  // See lib/hostChoices.ts.
  const eligible = servers
  const server = servers.find((s) => s.id === serverId) ?? null

  const jump = useNav((s) => s.operationsJump)
  const [honoured, setHonoured] = useState(0)

  /**
   * Read ONE server's schedules.
   *
   * One rather than the estate, and that is the difference from the Monitoring
   * panel rather than an omission. A write replaces the whole crontab of one
   * account on one host; reading twelve hosts to edit one of them is a probe
   * nobody asked for, and the fleet-wide reading already exists one rail over.
   */
  const collect = useCallback(
    async (id: string): Promise<HostCron | null> => {
      const s = servers.find((x) => x.id === id)
      if (!s) return null
      setLoading(true)
      try {
        const res = await window.opsmaxx?.cron?.collect([
          { serverId: s.id, serverName: s.name, cfg: cfgFor(s) }
        ])
        const h = (res ?? [])[0] ?? null
        setHost(h)
        return h
      } finally {
        // The handler catches per host today, so nothing here throws — but one
        // rejected invoke away, a button that never stops spinning is a UI that
        // has silently stopped working.
        setLoading(false)
      }
    },
    [servers]
  )

  // A jump fills the form in and reads the host it names. It does not plan and
  // it does not write: the operator still sees main's summary of the bytes and
  // still answers for it. `nonce` rather than a value comparison, so asking
  // twice about the same job re-fills rather than being swallowed.
  useEffect(() => {
    if (!jump || jump.kind !== 'cron-edit' || jump.nonce === honoured) return
    setHonoured(jump.nonce)
    setServerId(jump.serverId)
    setPending(null)
    setNote(null)
    setDraft({
      line: jump.line,
      schedule: jump.schedule,
      command: jump.command,
      ...(jump.input === undefined ? {} : { input: jump.input })
    })
    void collect(jump.serverId)
  }, [jump, honoured, collect])

  /**
   * Whether this host's own crontab was read in full.
   *
   * `absent` counts: an account that has never scheduled anything HAS an empty
   * crontab, and the first job anybody adds goes into it. `partial`, `denied`
   * and `unknown` do not — a write replaces the whole file, so the part that
   * could not be read is the part it would delete.
   */
  const ownCrontabReadable = (h: HostCron | null): boolean => {
    const s = h?.sources?.find((x) => x.id === 'user-crontab')
    return s !== undefined && (s.status === 'ok' || s.status === 'absent')
  }

  /** Read the crontab, work out the exact bytes, and hold them for confirmation. */
  const review = async (req: CronEditRequest): Promise<void> => {
    if (!bridge || !server || !host) return
    setBusy(true)
    setNote(null)
    try {
      const target: CronEditTargetRef = {
        serverId: server.id,
        serverName: server.name,
        cfg: cfgFor(server)
      }
      const reply = await bridge.planEdit(target, req, { sources: host.sources })
      if (!reply.ok || !reply.command) {
        setPending(null)
        setNote({ ok: false, text: reply.reason ?? t('operations.cron.planFailed') })
        return
      }
      setPhrase('')
      setPending({ target, reply, runId: `cron-edit-${Date.now().toString(36)}` })
    } finally {
      setBusy(false)
    }
  }

  /**
   * Answer for the change, and make it.
   *
   * The plan is re-derived here rather than carried from `review`, because that
   * is what the record is FOR: main re-derives it a third time and refuses if
   * the two disagree, so a plan computed once and passed around would be one
   * fact where the model wants two that must agree.
   */
  const apply = async (): Promise<void> => {
    const command = pending?.reply.command
    if (!bridge || !pending || command === undefined) return
    const { target, reply, runId } = pending
    const ref = { serverId: target.serverId, serverName: target.serverName }
    const plan = planBroadcast(command, [ref])
    const needed = plan.confirmation.kind === 'type-to-confirm' ? plan.confirmation.phrase : null
    if (needed !== null && phrase.trim() !== needed) return
    setBusy(true)
    try {
      const res = await bridge.write(target, {
        before: reply.before ?? '',
        after: reply.after ?? '',
        token: reply.token ?? '',
        runId,
        approval: approvalFor({
          surface: 'broadcast',
          commands: [command],
          targets: [ref],
          plan,
          phrase: needed,
          confirmedAt: Date.now()
        })
      })
      setNote({
        ok: res.ok,
        text: res.ok
          ? t('operations.cron.changed', {
              path: res.backupPath ?? t('operations.cron.backupPathFallback')
            })
          : res.detail
      })
      setPending(null)
      setDraft(null)
      // Read it again rather than patching the list from what we sent. The host
      // is the only thing that knows what its crontab says now.
      await collect(target.serverId)
    } finally {
      setBusy(false)
    }
  }

  /**
   * Edit and remove, or the reason there is neither.
   *
   * The refusal is shown ON THE ROW rather than by leaving the buttons out.
   * "Why can't I edit this one" is a question with a real answer — /etc/cron.d
   * is root-owned and package-managed, a systemd timer is two unit files and a
   * daemon-reload — and a control that is simply absent does not give it.
   */
  // Called, not rendered as <RowControls/>. A component DEFINED inside another
  // component is a new component type on every render, so React unmounts and
  // remounts its whole subtree each time the parent renders — which here meant
  // the confirmation's input lost focus after the first keystroke and the word
  // the operator was asked to type could never be typed.
  const rowControls = (entry: CronEntry): React.JSX.Element => {
    const refusal = cronEditRefusal(entry.kind)
    if (refusal !== null) {
      return (
        <span className="faint" title={refusal}>
          {t('operations.cron.notEditable')}
        </span>
      )
    }
    // A job with no line behind it is one we cannot point at. It should not
    // happen for a crontab; if it ever does, saying so beats a button that
    // resolves to whatever line happens to match.
    if (entry.line === undefined || !ownCrontabReadable(host)) {
      return <span className="faint" />
    }
    return (
      <span className="row" style={{ gap: 4 }}>
        <button
          className="btn"
          disabled={busy}
          title={t('operations.cron.changeJob')}
          onClick={() => {
            setPending(null)
            setNote(null)
            setDraft({
              line: entry.line,
              schedule: entry.schedule,
              command: entry.command,
              ...(entry.input === undefined ? {} : { input: entry.input })
            })
          }}
        >
          <Pencil size={12} />
        </button>
        <button
          className="btn"
          disabled={busy}
          title={t('operations.cron.removeJob')}
          onClick={() => {
            setDraft(null)
            if (entry.line !== undefined) void review({ op: 'remove', line: entry.line })
          }}
        >
          <Trash2 size={12} />
        </button>
      </span>
    )
  }

  const ref = pending
    ? { serverId: pending.target.serverId, serverName: pending.target.serverName }
    : null
  const plan = pending?.reply.command ? planBroadcast(pending.reply.command, [ref!]) : null
  const needed =
    plan && plan.confirmation.kind === 'type-to-confirm' ? plan.confirmation.phrase : null

  return (
    <PanelShell
      icon={<CalendarClock size={14} />}
      title={t('operations.cron.title')}
      about={<p>{t('operations.cron.about')}</p>}
      actions={
        <>
          <select
            className="input"
            aria-label={t('operations.common.server')}
            value={serverId ?? ''}
            onChange={(e) => {
              setServerId(e.target.value === '' ? null : e.target.value)
              setHost(null)
              setDraft(null)
              setPending(null)
              setNote(null)
            }}
          >
            <option value="">{t('operations.common.chooseServer')}</option>
            {eligible.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            className="btn"
            disabled={loading || serverId === null}
            onClick={() => serverId && void collect(serverId)}
          >
            <RefreshCw size={13} className={clsx(loading && 'spin')} /> {t('operations.cron.readServer')}
          </button>
        </>
      }
    >
      {!bridge && (
        <div className="panel-note is-alarm">{t('operations.cron.noBridge')}</div>
      )}

      {note && <div className={clsx('panel-note', note.ok ? '' : 'is-alarm')}>{note.text}</div>}

      {host === null ? (
        <div className="panel-empty">
          <p className="panel-empty-title">{t('operations.cron.emptyTitle')}</p>
          <p className="panel-empty-body">{t('operations.cron.emptyBody')}</p>
          <div className="panel-empty-actions">
            <button className="btn ghost sm" onClick={() => openMonitor('cron')}>
              {t('operations.cron.openScheduled')}
            </button>
          </div>
        </div>
      ) : host.error ? (
        <div className="panel-note is-alarm">
          {t('operations.cron.hostError', { server: host.serverName, error: host.error })}
        </div>
      ) : (
        <>
          {/* Why the buttons are not there, rather than simply not putting them
              there. An operator looking at a host whose crontab we only half
              read deserves the reason. */}
          {!ownCrontabReadable(host) ? (
            <div className="panel-note is-unknown" data-testid="cron-unreadable">
              <ShieldAlert size={12} /> {t('operations.cron.unreadable', { server: host.serverName })}
            </div>
          ) : (
            <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 6 }}>
              <span className="faint">
                {summariseCronSources(host.sources ?? []).incomplete.length > 0
                  ? t('operations.cron.someUnreadable')
                  : t('operations.cron.allRead')}
              </span>
              <span className="grow" />
              <button
                className="btn"
                disabled={busy}
                onClick={() => {
                  setPending(null)
                  setNote(null)
                  setDraft({ schedule: '0 3 * * *', command: '' })
                }}
              >
                <Plus size={12} /> {t('operations.cron.addJob')}
              </button>
            </div>
          )}

          {draft !== null && draft.line === undefined && (
            <JobForm
              draft={draft}
              busy={busy}
              onChange={setDraft}
              onCancel={() => {
                setDraft(null)
                setPending(null)
              }}
              onReview={() =>
                void review({ op: 'add', schedule: draft.schedule.trim(), command: draft.command })
              }
            />
          )}

          {host.entries.length === 0 && (
            <div className="faint" style={{ marginTop: 8 }}>
              {/* Only claimed when every source actually answered. On a host
                  where /etc/cron.d was refused, "Nothing scheduled" is a
                  sentence about our permissions wearing a sentence about the
                  host. */}
              {(host.sources?.length ?? 0) > 0 &&
              summariseCronSources(host.sources ?? []).incomplete.length === 0
                ? t('operations.cron.nothingScheduled')
                : t('operations.cron.nothingFound')}
            </div>
          )}

          {host.entries.map((e, i) => (
            <div key={`${e.origin}:${i}`}>
              <div className="cron-row">
                <span className="mono cron-when">
                  {e.kind === 'systemd-timer'
                    ? e.nextRun
                      ? t('operations.cron.nextRun', { when: e.nextRun })
                      : t('operations.cron.noNextRun')
                    : e.schedule}
                </span>
                <span className="faint cron-desc">{e.description ?? ''}</span>
                <span
                  className="mono grow cron-cmd"
                  title={e.input === undefined ? e.command : `${e.command}\n\nstdin:\n${e.input}`}
                >
                  {e.command}
                  {e.input !== undefined && <span className="faint"> · stdin</span>}
                </span>
                {e.user && <span className="faint">{e.user}</span>}
                {rowControls(e)}
              </div>
              {draft !== null && draft.line !== undefined && draft.line === e.line && (
                <JobForm
                  draft={draft}
                  busy={busy}
                  onChange={setDraft}
                  onCancel={() => {
                    setDraft(null)
                    setPending(null)
                  }}
                  onReview={() => {
                    if (draft.line !== undefined)
                      void review({
                        op: 'update',
                        line: draft.line,
                        schedule: draft.schedule.trim(),
                        command: draft.command,
                        ...(draft.input === undefined ? {} : { input: draft.input })
                      })
                  }}
                />
              )}
            </div>
          ))}

          {/* What is about to happen, in the words of the thing that will do
              it. The summary and the backup are main's, not this panel's — the
              panel never builds a command and never works out the bytes, so
              there is nothing here that could describe the change differently
              from the change. */}
          {pending?.reply.command && (
            <div className="panel-note" style={{ display: 'grid', gap: 6, marginTop: 10 }}>
              <div className="mono">
                {pending.reply.summary}
              </div>
              <div className="faint">
                {t('operations.cron.replaceNote', { server: pending.target.serverName })}
              </div>
              {pending.reply.addedFinalNewline && (
                <div className="state-watch">
                  <ShieldAlert size={11} /> {t('operations.cron.finalNewline')}
                </div>
              )}
              {needed !== null && (
                <input
                  className="input mono"
                  style={{ maxWidth: 120 }}
                  aria-label={t('operations.common.confirmPhrase')}
                  placeholder={t('operations.common.typePhrase', { phrase: needed })}
                  value={phrase}
                  onChange={(ev) => setPhrase(ev.target.value)}
                />
              )}
            </div>
          )}

          {/* The execute slot at the FOOT of the card, never top-right beside
              the read control — see .op-actionbar and BroadcastPanel for the
              argument. The sentence on the left names the one server this
              lands on, because "Apply" without a hostname is the button that
              gets pressed on the wrong box. */}
          <div className="op-actionbar">
            <span className="op-actionbar-what" data-testid="cron-target">
              {pending?.reply.command
                ? t('operations.cron.writesTarget', {
                    server: host.serverName,
                    account: server?.username ?? t('operations.cron.connectedAccount')
                  })
                : t('operations.cron.reviewHint')}
            </span>
            <span className="grow" />
            {pending !== null && (
              <button className="btn ghost" disabled={busy} onClick={() => setPending(null)}>
                {t('common.cancel')}
              </button>
            )}
            <button
              className="btn danger"
              data-testid="cron-apply"
              disabled={
                busy || pending === null || (needed !== null && phrase.trim() !== needed)
              }
              onClick={() => void apply()}
            >
              {t('operations.cron.applyTo', { server: host.serverName })}
            </button>
          </div>
        </>
      )}
    </PanelShell>
  )
}
