import { useMemo, useState } from 'react'
import { timerHealth, type TimerHealth } from '../../../../shared/systemdTimers'
import { CalendarClock, Pencil, Plus, RefreshCw, ShieldAlert } from 'lucide-react'
import { sshHopsFor } from '../../lib/ssh'
import { LOCAL_TARGET } from '../../../../shared/execTarget'
import { clsx } from '../../lib/format'
import {
  CRON_STATUS_HELP,
  cronEditRefusal,
  summariseCronSources
} from '../../../../shared/cron'
import type {
  CronEditTargetRef,
  CronEntry,
  CronSourceReport
} from '../../../../shared/cron'
import { openCronEdit } from '../../store/nav'
import type { Server } from '../../types'
import { PanelShell } from './PanelShell'

// What is scheduled across the estate — currently unanswerable without visiting
// every box.
//
// Reading came first on purpose. Cron's traps are all silent misreads rather
// than errors, so the parser earned trust against real hosts before anything
// was allowed to write — and two misreads turned up while it did.
//
// ---------------------------------------------------------------------------
// READ-ONLY, AND THE EDITOR IS ONE RAIL OVER
// ---------------------------------------------------------------------------
// This panel used to write. Add, change and remove sat on the rows, on a
// destination whose contract is that nothing in it writes to a server, and a
// contract with an exception in it is not a contract. The flow — plan against
// the host, show main's own summary of the bytes, take the typed confirmation,
// keep a timestamped copy on the server, write, read back, revert on mismatch —
// moved WHOLE to Operations › Jobs › Change a schedule (CronEditPanel). Nothing
// about what it checks changed; only where it lives.
//
// What is left here is the same rule, expressed as a pointer instead of a form.
// Only the connected account's own crontab can be changed at all, so only its
// rows offer one; /etc/crontab, /etc/cron.d, systemd timers and other accounts'
// crontabs each still say why not, ON THE ROW — "why can't I edit this one" is
// a question with an answer, and an absent control does not give it. A host
// whose own crontab was only partly read offers no pointer either, because a
// write replaces the whole file and the editor would only refuse: a pointer
// that lands on a refusal teaches a person the button is broken.

interface HostCron {
  serverId: string
  serverName: string
  entries: CronEntry[]
  unparsed: number
  /**
   * What each source had to say for itself.
   *
   * Optional because it arrives over IPC: a main process that has not been
   * taught to forward it sends nothing, and a panel that treated that as "all
   * five read fine" would be inventing the very reassurance this field exists
   * to withdraw.
   */
  sources?: CronSourceReport[]
  error?: string
}

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

/**
 * This machine, collected alongside the servers.
 *
 * Not a row in `servers`, which is persisted and mirrored into the MCP data
 * cache — see shared/execTarget.ts. The id is a sentinel no server can hold,
 * which is also what makes the Edit control disappear on this row for free:
 * every edit affordance below is already gated on `serverById.has(...)`, and
 * cron editing routes through a server-shaped approval.
 */
const LOCAL_ID = 'local'
const LOCAL_HOST = {
  serverId: LOCAL_ID,
  serverName: 'This machine',
  // The marker, in the slot a connection config occupies for a server. Main
  // reads it before it ever looks at the config's fields.
  cfg: LOCAL_TARGET as unknown as CronEditTargetRef['cfg']
}

const KIND_LABEL: Record<CronEntry['kind'], string> = {
  'user-crontab': 'user crontab',
  'system-crontab': '/etc/crontab',
  'cron.d': 'cron.d',
  'systemd-timer': 'systemd timer',
  'other-user-crontab': 'crontab spool'
}

/**
 * What a host's list of jobs is actually worth.
 *
 * This is the whole point of the change. "Nothing scheduled." under a host name
 * is a claim, and until now it was made just as confidently for a box whose
 * /etc/cron.d we were refused as for one that genuinely has nothing. An
 * operator has no way to tell those apart from the outside, so the panel has to
 * say which it is.
 */
/**
 * How many of a host's jobs cannot be edited, and why, grouped by the reason.
 *
 * A Map rather than a count, because the reasons are genuinely different — a
 * job in /etc/cron.d is refused for one cause and another account's crontab for
 * another — and collapsing them into "12 not editable" would hide the fact that
 * one of the two is fixable by connecting as a different account.
 *
 * Insertion order is entry order, so the reason attached to the first job on
 * screen is the first sentence under the heading.
 */
function notEditableByReason(host: HostCron): [string, number][] {
  const byReason = new Map<string, number>()
  for (const e of host.entries) {
    const refusal = cronEditRefusal(e.kind)
    if (refusal === null) continue
    byReason.set(refusal, (byReason.get(refusal) ?? 0) + 1)
  }
  return [...byReason]
}

function SourceStatus({ sources }: { sources?: CronSourceReport[] }): React.JSX.Element {
  if (!sources || sources.length === 0) {
    return (
      <div className="faint">
        This server did not report which sources it managed to read, so this list may be incomplete.
      </div>
    )
  }
  const { answered, total, incomplete, usedSudo } = summariseCronSources(sources)
  const complete = incomplete.length === 0
  return (
    <div>
      <span className={clsx(complete ? 'faint' : 'warn')}>
        {complete ? `read all ${total} sources` : `read ${answered} of ${total} sources`}
      </span>
      {/* Reading as root is a thing that happened, not an implementation
          detail. It is surfaced for the same reason the Docker panel surfaces
          it: silent escalation is the wrong trade even when it is the only way
          to get an answer. */}
      {usedSudo && (
        <span className="faint" title="Some sources were readable only as root, and were read with sudo -n — which never prompts.">
          {' '}
          · read as root
        </span>
      )}
      {incomplete.map((s) => (
        <div key={s.id} className="state-unknown" style={{ marginTop: 2 }}>
          <ShieldAlert size={11} /> {s.label}: {CRON_STATUS_HELP[s.status]}
          {s.detail ? ` (${s.detail})` : ''}
        </div>
      ))}
    </div>
  )
}

export function CronPanel({ servers }: { servers: Server[] }): React.JSX.Element {
  const [rows, setRows] = useState<HostCron[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const eligible = useMemo(() => servers.filter((s) => s.status !== 'offline'), [servers])
  /**
   * "Did it actually work?" for one systemd timer.
   *
   * On demand, per timer, and it reads the SERVICE too: a timer can fire
   * perfectly every day into a service that fails every time, which is the case
   * this answers and which the schedule above cannot see.
   */
  const [timerHealthState, setTimerHealthState] = useState<{
    key: string
    health?: TimerHealth
    error?: string
  } | null>(null)
  const [timerLoading, setTimerLoading] = useState<string | null>(null)

  const loadTimerHealth = async (serverId: string, unit: string): Promise<void> => {
    const server = servers.find((sv) => sv.id === serverId)
    // A timer unit activates the service of the same stem. systemd allows an
    // explicit `Unit=`, and when it differs this reads the wrong service --
    // which is why the verdict names the unit it actually read.
    const service = unit.replace(/\.timer$/, '.service')
    const key = `${serverId}:${unit}`
    if (!server) return
    setTimerLoading(key)
    setTimerHealthState(null)
    try {
      const call = (
        window.opsmaxx as
          | {
              fleet?: {
                timer?: (
                  cfg: unknown,
                  t: string,
                  s: string
                ) => Promise<
                  { timer: Record<string, string>; service: Record<string, string> } | { error: string }
                >
              }
            }
          | undefined
      )?.fleet?.timer
      if (typeof call !== 'function') {
        setTimerHealthState({ key, error: 'This build cannot read timers. Restart the app to rebuild it.' })
        return
      }
      const res = await call(server, unit, service)
      if ('error' in res) {
        setTimerHealthState({ key, error: res.error })
        return
      }
      setTimerHealthState({ key, health: timerHealth({ ...res, nowMs: Date.now() }) })
    } catch (e) {
      setTimerHealthState({ key, error: e instanceof Error ? e.message : String(e) })
    } finally {
      setTimerLoading(null)
    }
  }

  const serverById = useMemo(() => new Map(servers.map((s) => [s.id, s])), [servers])

  /**
   * Whether this host's own crontab was read in full.
   *
   * `absent` counts: an account that has never scheduled anything HAS an empty
   * crontab, and the first job anybody adds goes into it. `partial`, `denied`
   * and `unknown` do not — a write replaces the whole file, so the part that
   * could not be read is the part it would delete.
   */
  const ownCrontabReadable = (h: HostCron): boolean => {
    const s = h.sources?.find((x) => x.id === 'user-crontab')
    return s !== undefined && (s.status === 'ok' || s.status === 'absent')
  }

  const collect = async (): Promise<void> => {
    setLoading(true)
    try {
      const res = await window.opsmaxx?.cron?.collect([
        ...eligible.map((s) => ({
          serverId: s.id,
          serverName: s.name,
          cfg: cfgFor(s)
        })),
        // Last, so the estate reads first and this machine is the tail of the
        // list rather than the headline.
        LOCAL_HOST
      ])
      setRows(res ?? [])
    } finally {
      // The handler catches per host today, so nothing here throws — but one
      // rejected invoke away, a button that never stops spinning is a UI that
      // has silently stopped working.
      setLoading(false)
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
  // remounts its whole subtree each time the parent renders. That mattered when
  // this held a confirmation input; it is kept because the reason has not
  // stopped being true, and the next person to put a control back in this cell
  // would rediscover it the hard way.
  const rowControls = (host: HostCron, entry: CronEntry): React.JSX.Element => {
    // The refusal is NOT printed here any more. It is a property of the source
    // kind, not of the row, so on a host whose jobs all come out of /etc/cron.d
    // the identical three words appeared on all twenty-six of them — the widest
    // column on the row carrying the least information on it. One roll-up per
    // host says the same thing once; see `notEditable` below.
    if (cronEditRefusal(entry.kind) !== null) return <span />
    // A job with no line behind it is one we cannot point at. It should not
    // happen for a crontab; if it ever does, saying so beats a button that
    // resolves to whatever line happens to match.
    //
    // `ownCrontabReadable` still gates the pointer, and that is not merely
    // tidiness: a crontab that was only half read is one a write would truncate,
    // so sending somebody to the editor for it would be sending them to a
    // refusal. A pointer that lands on "you cannot do this here" is the failure
    // this codebase names — worse than no pointer, because the user learns the
    // button is broken.
    if (entry.line === undefined || !ownCrontabReadable(host)) {
      return <span className="faint" />
    }
    if (!serverById.has(host.serverId)) return <span className="faint" />
    return (
      <button
        className="btn"
        data-testid={`edit-${host.serverId}`}
        title="Opens Operations › Jobs › Change a schedule, with this job filled in. Changing or removing it writes this account's whole crontab, so it happens on the rail where everything writes."
        onClick={() =>
          openCronEdit({
            serverId: host.serverId,
            line: entry.line,
            schedule: entry.schedule,
            command: entry.command,
            // Absent stays absent: spreading rather than assigning, so a job
            // with no stdin does not arrive carrying an empty one.
            ...(entry.input === undefined ? {} : { input: entry.input })
          })
        }
      >
        <Pencil size={12} />
      </button>
    )
  }

  const q = filter.trim().toLowerCase()
  const visible = (rows ?? []).map((h) => ({
    ...h,
    entries: q === '' ? h.entries : h.entries.filter((e) => `${e.command} ${e.origin} ${e.user ?? ''}`.toLowerCase().includes(q))
  }))
  const total = visible.reduce((n, h) => n + h.entries.length, 0)
  const failed = visible.filter((h) => h.error)
  const unparsed = visible.reduce((n, h) => n + h.unparsed, 0)
  const partial = visible.filter(
    (h) => !h.error && (h.sources?.length ?? 0) > 0 && summariseCronSources(h.sources ?? []).incomplete.length > 0
  ).length

  const readSchedules = (primary: boolean): React.JSX.Element => (
    <button
      className={primary ? 'btn primary sm' : 'btn ghost sm'}
      disabled={loading}
      onClick={() => void collect()}
    >
      <RefreshCw size={13} className={clsx(loading && 'spin')} /> {rows ? 'Refresh' : 'Read schedules'}
    </button>
  )

  return (
    <PanelShell
      icon={<CalendarClock size={14} />}
      title="Scheduled jobs"
      about={
        <p>
          Every crontab and systemd timer across the estate, and which of them this account was
          actually allowed to read.
        </p>
      }
      actions={
        <>
          {rows && (
            <input
              className="input"
              style={{ maxWidth: 220 }}
              placeholder="Filter by command or file…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
          {readSchedules(!rows)}
        </>
      }
    >

      {!rows && !loading && (
        // Before anything has been read this IS the panel, so it is framed as
        // an empty state rather than set at body weight beside the button.
        <div className="panel-empty">
          <p className="panel-empty-title">Nothing has been read yet.</p>
          <p className="panel-empty-body">
            Reads crontabs, /etc/crontab, /etc/cron.d, other accounts’ crontabs and systemd timers
            from every online server, and says which of those it was actually allowed to read.
            Sources that are root-only are retried with <span className="mono">sudo -n</span>, which
            never prompts for a password. Nothing is written or changed — this only looks.
          </p>
          <p className="panel-empty-body">
            Press <b>Read schedules</b> above to start.
          </p>
        </div>
      )}

      {rows && (
        <>
          <div className="panel-stats">
            <span>
              {total} job{total === 1 ? '' : 's'} across {visible.length - failed.length} server
              {visible.length - failed.length === 1 ? '' : 's'}
            </span>
            {/* Lines that looked like jobs but did not parse are counted, not
                hidden. A schedule silently missing from this view is a command
                running on a box that nobody knows about. */}
            {unparsed > 0 && <span className="state-unknown">{unparsed} line{unparsed === 1 ? '' : 's'} not understood</span>}
            {/* Counted across the estate as well as per host: with a dozen
                servers, a single host whose cron.d was refused is easy to
                scroll past, and it is exactly the host you would want to look
                at. */}
            {partial > 0 && (
              <span className="state-unknown">
                {partial} server{partial === 1 ? '' : 's'} only partly readable
              </span>
            )}
          </div>

          {failed.map((h) => (
            <div key={h.serverId} className="panel-note is-alarm">
              {h.serverName}: {h.error}
            </div>
          ))}

          {visible
            .filter((h) => !h.error)
            .map((h) => (
              <div key={h.serverId} style={{ marginTop: 10 }}>
                <div className="row panel-subtitle" style={{ gap: 8, alignItems: 'center' }}>
                  <span className="grow">
                    {h.serverName} <span className="faint">· {h.entries.length}</span>
                  </span>
                  {serverById.has(h.serverId) && ownCrontabReadable(h) && (
                    <button
                      className="btn"
                      data-testid={`add-${h.serverId}`}
                      title="Opens Operations › Jobs › Change a schedule, on this server. Writing a crontab changes a server, so it lives on the rail where everything does."
                      onClick={() =>
                        openCronEdit({ serverId: h.serverId, schedule: '0 3 * * *', command: '' })
                      }
                    >
                      <Plus size={12} /> Add job…
                    </button>
                  )}
                </div>
                <SourceStatus sources={h.sources} />
                {/* Once per host and per reason, not once per row. Still said
                    out loud: a row with no button beside it and no sentence
                    anywhere is indistinguishable from one that is still
                    loading, which is the failure this panel is built against. */}
                {notEditableByReason(h).map(([reason, n]) => (
                  <div
                    key={reason}
                    className="ui-note"
                    data-testid={`cron-not-editable-${h.serverId}`}
                  >
                    {n} of these cannot be edited from OpsMaxx: {reason}
                  </div>
                ))}
                {/* Why the pointer is not there, rather than simply not putting
                    it there. An operator looking at a host whose crontab we only
                    half read deserves the reason — and it is a real one: a write
                    replaces the whole file, so the part that could not be read is
                    the part it would delete. */}
                {!ownCrontabReadable(h) && (
                  <div className="faint">
                    This account’s crontab was not read in full, so nothing here can be edited.
                  </div>
                )}
                {h.entries.length === 0 && (
                  <div className="faint">
                    {q !== ''
                      ? 'Nothing matching.'
                      : // Only claimed when every source actually answered. On a
                        // host where /etc/cron.d was refused, "Nothing
                        // scheduled" is a sentence about our permissions
                        // wearing a sentence about the host.
                        (h.sources?.length ?? 0) > 0 &&
                          summariseCronSources(h.sources ?? []).incomplete.length === 0
                        ? 'Nothing scheduled.'
                        : 'Nothing found in the sources that could be read.'}
                  </div>
                )}
                {h.entries.map((e, i) => (
                  <div key={`${e.origin}:${i}`}>
                  <div className="cron-row">
                    <span className="chip">{KIND_LABEL[e.kind]}</span>
                    <span className="mono cron-when">
                      {e.kind === 'systemd-timer' ? (e.nextRun ? `next ${e.nextRun}` : 'no next run') : e.schedule}
                    </span>
                    {/* The schedule above says WHEN. This says whether the last
                        run worked, which is a different question and the only
                        one that catches a timer firing into a failing service. */}
                    {e.kind === 'systemd-timer' && (
                      <button
                        className="btn-ghost sm"
                        disabled={timerLoading === `${h.serverId}:${e.origin}`}
                        onClick={() => void loadTimerHealth(h.serverId, e.origin)}
                      >
                        {timerLoading === `${h.serverId}:${e.origin}` ? 'reading' : 'did it run?'}
                      </button>
                    )}
                    {/* Null means "a valid schedule I decline to describe".
                        A wrong sentence about when a job runs is worse than
                        none. */}
                    <span className="faint cron-desc">{e.description ?? ''}</span>
                    {/* `e.input` is the text after an unescaped `%`, which
                        cron pipes to the command on stdin rather than running.
                        Showing it inside the command would be showing a command
                        that is not the one that runs. */}
                    <span
                      className="mono grow cron-cmd"
                      title={e.input === undefined ? e.command : `${e.command}\n\nstdin:\n${e.input}`}
                    >
                      {e.command}
                      {e.input !== undefined && <span className="faint"> · stdin</span>}
                    </span>
                    {e.user && <span className="faint">{e.user}</span>}
                    {rowControls(h, e)}
                  </div>
                  {timerHealthState?.key === `${h.serverId}:${e.origin}` && (
                    <div
                      className={
                        timerHealthState.error !== undefined ||
                        (timerHealthState.health !== undefined &&
                          timerHealthState.health.verdict !== 'ok')
                          ? 'panel-note is-alarm'
                          : 'panel-note'
                      }
                    >
                      {/* A failed READ is not a verdict, and must not render
                          like one. */}
                      {timerHealthState.error ?? timerHealthState.health?.detail}
                    </div>
                  )}
                  </div>
                ))}
              </div>
            ))}
        </>
      )}
    </PanelShell>
  )
}
