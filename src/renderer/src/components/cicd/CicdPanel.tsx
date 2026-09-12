import { useEffect, useMemo, useState } from 'react'
import { Activity } from 'lucide-react'
import { PanelShell } from '../monitor/PanelShell'
import { EmptyState } from '../common/EmptyState'
import { clsx, duration } from '../../lib/format'
import { remoteText } from '../../../../shared/remoteText'
import { useApp } from '../../store/app'
import { StatusWord } from './Status'
import { CicdConnectModal } from './CicdConnectModal'
import { CicdRunWorkbench } from './CicdRunWorkbench'
import {
  BUCKET_LABEL,
  BUCKET_ORDER,
  type CicdBucket,
  type CicdRow,
  cicdBridgeHas,
  cicdBridge,
  isStale,
  pathLabel,
  rankRows,
  useCicdConnectionList,
  useCicdState,
  useNow
} from './state'
import type { CicdBridge, CicdConnection, CicdPanelState } from '../../../../shared/cicd'

/**
 * The CI/CD landing view.
 *
 * NOT a list of every pipeline. A controller with two thousand jobs renders as
 * two thousand rows nobody reads, and the question somebody opens this for is
 * "what needs me" — so the rows are ranked into that shape and the 24-hour
 * window is stated rather than assumed.
 *
 * Two rules from `docs/design/panel-audit.md` do the most work here:
 *
 *  - Four status roles, and the unknown one is achromatic. A provider we could
 *    not reach renders as neither green nor red.
 *  - The panel never silently claims its data is current. The header states
 *    both the last SUCCESSFUL read and the interval, counting up live, and
 *    goes to `--state-unknown` once the number has stopped being a claim about
 *    now.
 *
 * A failed poll AGES rows. It never clears them: `CicdPanelState` carries
 * the last good pipelines alongside `error` precisely so a panel that mounts
 * mid-outage can still say what it last knew, and emptying the list would
 * replace a stale answer with a wrong one.
 */

/** How far off a read has to be before the number stops meaning "now". Not on
 *  `CicdPanelState`, which carries no interval — see the report. */
const DEFAULT_INTERVAL_SEC = 20

export function CicdPanel({
  connections: seed,
  bridge = cicdBridge(),
  intervalSec = DEFAULT_INTERVAL_SEC,
  onSaveConnection
}: {
  connections?: CicdConnection[]
  bridge?: CicdBridge
  intervalSec?: number
  onSaveConnection?: (connection: CicdConnection, token: string) => void | Promise<void>
}): React.JSX.Element {
  const stored = useCicdConnectionList()
  const upsert = useApp((s) => s.upsertCicdConnection)
  const connections = seed ?? stored
  // The preload half is a separate file and can be older than this panel.
  const canRefresh = cicdBridgeHas(bridge, 'refresh')
  const states = useCicdState(bridge)
  const now = useNow()

  // When the panel was opened. A failure that arrived after this is new to the
  // reader; one that was already there is not, and the ranking says so.
  const [seenAt] = useState(() => Date.now())
  const [filter, setFilter] = useState('')
  const [bucket, setBucket] = useState<CicdBucket | 'all'>('all')
  const [selected, setSelected] = useState<{ connectionId: string; pipelineRef: string; runId: string } | null>(null)
  const [connecting, setConnecting] = useState<'new' | 'token' | null>(null)

  // Tell main the saved list changed. It carries nothing: main re-reads the
  // file it persists, so this is a nudge rather than a handover. `connections`
  // stays in the dependency list because a change to it is exactly when the
  // file has been rewritten and main needs to look again.
  useEffect(() => {
    if (!bridge) return
    void bridge.configure().catch(() => undefined)
  }, [bridge, connections])

  const { rows, olderThanWindow, neverRun } = useMemo(
    () => rankRows(connections, states, seenAt, now),
    // `now` deliberately absent: the ranking must not resort itself every
    // second under the reader's cursor. It is recomputed when the data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connections, states, seenAt]
  )

  const needle = filter.trim().toLowerCase()
  const shown = rows.filter(
    (r) =>
      (bucket === 'all' || r.bucket === bucket) &&
      (needle === '' ||
        r.pipeline.name.toLowerCase().includes(needle) ||
        r.connectionName.toLowerCase().includes(needle) ||
        pathLabel(r.pipeline).toLowerCase().includes(needle) ||
        (r.run.branch ?? '').toLowerCase().includes(needle))
  )

  const open = selected
    ? rows.find(
        (r) =>
          r.connectionId === selected.connectionId &&
          r.pipeline.ref === selected.pipelineRef &&
          r.run.id === selected.runId
      )
    : undefined
  const openConnection = open ? connections.find((c) => c.id === open.connectionId) : undefined

  /**
   * Store the token, then the connection that points at it — in that order.
   *
   * The token exists in this component for exactly as long as this function
   * runs. `createSecret` hands it to main, main writes the vault entry, and
   * what comes back is an id; the record that reaches the store and then
   * `opsmaxx-data.json` carries the id and never the secret.
   *
   * Order matters and is not cosmetic. Saving the connection first would leave
   * a row pointing at a vault entry that does not exist if the vault is locked
   * — a connection that cannot dial and cannot explain why. Failing here
   * leaves nothing saved at all, which is the honest outcome.
   */
  const save = async (connection: CicdConnection, token: string): Promise<void> => {
    if (onSaveConnection) {
      await onSaveConnection(connection, token)
      if (seed) return
      upsert(connection)
      return
    }
    if (seed) return
    let record = connection
    if (token !== '' && cicdBridgeHas(bridge, 'createSecret')) {
      const vaultEntryId = await bridge!.createSecret(`CI/CD — ${connection.name}`, token)
      record = { ...connection, vaultEntryId }
    }
    // `upsert`, not a bulk set: `connections` here is the ACTIVE workspace's
    // slice, and handing that to `setCicdConnections` would tell the store
    // every other workspace's connections had been deleted — releasing their
    // vault entries on the way out.
    upsert(record)
  }

  return (
    <PanelShell
      icon={<Activity size={16} />}
      title="CI/CD"
      about={
        <>
          <p className="ui-note">
            Pipelines, runs and logs from Jenkins, GitLab CI and GitHub Actions accounts you
            connect. OpsMaxx polls them on a timer and never receives a webhook, so everything
            here is as fresh as the last successful read — which the header states.
          </p>
          <p className="ui-note">
            Reading a run is all this module does. Starting one is a separate module on the
            Operations rail, because the consequence is that a deploy goes out.
          </p>
        </>
      }
      actions={
        connections.length > 0 && (
          <button
            className="btn primary size-28"
            disabled={!canRefresh}
            title={
              canRefresh
                ? 'Read every connected account now, ignoring the timer.'
                : 'This build cannot read on demand. Restart the app to rebuild the bridge.'
            }
            onClick={() => void bridge?.refresh().catch(() => undefined)}
          >
            Refresh
          </button>
        )
      }
      testId="cicd-panel"
    >
      {connections.length === 0 ? (
        <EmptyState
          icon={<Activity size={22} />}
          title="No CI account is connected"
          message="Connect a Jenkins, GitLab or GitHub account and OpsMaxx will watch its pipelines. Nothing is polled until one exists."
          action={
            <button className="btn primary size-28" onClick={() => setConnecting('new')}>
              Connect an account
            </button>
          }
        />
      ) : open && openConnection ? (
        <CicdRunWorkbench
          connection={openConnection}
          pipeline={open.pipeline}
          run={open.run}
          bridge={bridge}
          onClose={() => setSelected(null)}
        />
      ) : (
        <>
          <Freshness
            connections={connections}
            states={states}
            intervalSec={intervalSec}
            now={now}
            bridge={bridge}
            canRefresh={canRefresh}
            onUpdateToken={() => setConnecting('token')}
          />

          <div className="row cicd-filters">
            <input
              className="input"
              value={filter}
              placeholder="Filter by pipeline, branch or account…"
              aria-label="Filter runs"
              onChange={(e) => setFilter(e.target.value)}
            />
            <select
              className="input"
              value={bucket}
              aria-label="Show"
              onChange={(e) => setBucket(e.target.value as CicdBucket | 'all')}
            >
              <option value="all">Everything</option>
              {BUCKET_ORDER.map((b) => (
                <option key={b} value={b}>
                  {BUCKET_LABEL[b]}
                </option>
              ))}
            </select>
            <span className="spacer" />
            <button className="btn secondary size-28" onClick={() => setConnecting('new')}>
              Connect an account
            </button>
          </div>

          <div className="panel-stats" data-testid="cicd-counts">
            <span>
              {shown.length} of {rows.length} {rows.length === 1 ? 'run' : 'runs'} in the last 24
              hours
            </span>
            {olderThanWindow > 0 && (
              <span className="faint">
                {olderThanWindow} last ran longer ago than that and {olderThanWindow === 1 ? 'is' : 'are'} not
                shown
              </span>
            )}
            {neverRun > 0 && <span className="faint">{neverRun} have never run</span>}
          </div>

          {shown.length === 0 ? (
            <EmptyState
              compact
              title={rows.length === 0 ? 'Nothing has run in the last 24 hours' : 'Nothing matched'}
              message={
                rows.length === 0
                  ? 'Every connected account answered, and none of its pipelines has produced a run inside the window.'
                  : 'No run in the window matches that filter. Clear it to see the rest.'
              }
            />
          ) : (
            <div className="cicd-rows">
              {BUCKET_ORDER.filter((b) => shown.some((r) => r.bucket === b)).map((b) => (
                <div key={b}>
                  <div className="ui-label cicd-bucket">
                    {BUCKET_LABEL[b]} · {shown.filter((r) => r.bucket === b).length}
                  </div>
                  {shown
                    .filter((r) => r.bucket === b)
                    .map((r) => (
                      <RunRow
                        key={`${r.connectionId}:${r.pipeline.ref}:${r.run.id}:${r.run.attempt}`}
                        row={r}
                        onOpen={() =>
                          setSelected({
                            connectionId: r.connectionId,
                            pipelineRef: r.pipeline.ref,
                            runId: r.run.id
                          })
                        }
                      />
                    ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {connecting !== null && (
        <CicdConnectModal
          bridge={bridge}
          // Always `save`. This was gated on the optional `onSaveConnection`
          // prop, and nothing in the app passed one — so the Connect button was
          // permanently disabled and no connection could be created at all.
          // `save` now stores the token through the bridge itself; the prop is
          // an override for a host that wants to do it differently, not a
          // precondition for saving.
          onSave={save}
          onClose={() => setConnecting(null)}
        />
      )}
    </PanelShell>
  )
}

/**
 * One run.
 *
 * Every row carries a WORD as well as a shape. Colour is never the only signal
 * and, in this feature area, colour is not even the most important one: the
 * distinction between "failed" and "we could not read it" is the whole point,
 * and only the word and the hollow ring survive a reader who sees neither red
 * nor green.
 */
function RunRow({ row, onOpen }: { row: CicdRow; onOpen: () => void }): React.JSX.Element {
  const path = pathLabel(row.pipeline)
  return (
    <button className={clsx('cicd-row', row.stale && 'is-stale')} onClick={onOpen}>
      <StatusWord outcome={row.run.outcome} />
      <span className="grow ellipsis">
        {path && <span className="faint">{path} / </span>}
        {row.pipeline.name}
      </span>
      <span className="mono ellipsis cicd-row-label">{row.run.label}</span>
      {row.run.branch !== undefined && (
        <span className="mono ellipsis faint">{remoteText(row.run.branch)}</span>
      )}
      {row.run.actor !== undefined && (
        /* remoteText: anyone who can open a pull request writes this. */
        <span className="ellipsis faint">{remoteText(row.run.actor)}</span>
      )}
      <span className="faint cicd-row-age">
        {row.run.startedAt === undefined ? '—' : `${duration(row.run.startedAt)} ago`}
      </span>
      {row.stale && <span className="state-unknown">not re-read</span>}
    </button>
  )
}

/**
 * How fresh this is, per connection, and what is wrong when something is.
 *
 * The three degraded states are deliberately not one:
 *
 *  - UNREACHABLE is an alarm. The rows below it age; they are the last good
 *    answer and the note says how many attempts have failed.
 *  - RATE-LIMITED is a WATCH, not an unknown. We know the data — we just
 *    cannot refresh it, and painting that as "not measured" would be a
 *    heavier claim than the truth.
 *  - AN EXPIRED TOKEN is a standing note with the one action that fixes it,
 *    and it does NOT clear the rows either.
 *
 * The kind is read off `error` text because `CicdPanelState` carries no
 * discriminant for it — noted in the report rather than papered over.
 */
function Freshness({
  connections,
  states,
  intervalSec,
  now,
  bridge,
  canRefresh,
  onUpdateToken
}: {
  connections: CicdConnection[]
  states: Map<string, CicdPanelState>
  intervalSec: number
  now: number
  bridge?: CicdBridge
  canRefresh: boolean
  onUpdateToken: () => void
}): React.JSX.Element {
  return (
    <div className="cicd-freshness">
      {connections.map((c) => {
        const s = states.get(c.id)
        // The connection's OWN cadence when main has reported one. GitHub polls
        // at 60s against its hourly budget and Jenkins at 15s; judging both
        // against one guess flagged a perfectly healthy GitHub account as stale
        // on every cycle. The prop is only the fallback for a state that has
        // not arrived yet.
        const every = s?.intervalSec ?? intervalSec
        const stale = isStale(s?.readAt, every, now)
        const limited = isRateLimited(s)
        const expired = s?.error !== undefined && /401|unauthor|expired|invalid token/i.test(s.error)
        return (
          <div key={c.id} className="cicd-fresh-row">
            <div className="row">
              <b className="ellipsis">{c.name}</b>
              <span className={clsx('ui-note', stale && 'state-unknown')} data-testid={`cicd-read-${c.id}`}>
                {s?.readAt === undefined
                  ? 'never read'
                  : `Read ${duration(s.readAt)} ago`}{' '}
                · every {every}s
              </span>
              {s?.budget !== undefined && (
                <span className="ui-note">
                  {s.budget.remaining} of {s.budget.limit} requests left
                  {s.budget.resetAt !== undefined &&
                    `, resets in ${Math.max(0, Math.round((s.budget.resetAt - now) / 1000))}s`}
                </span>
              )}
            </div>

            {expired ? (
              <div className="panel-note is-alarm">
                <span className="grow">
                  {c.name} refused the token. It has expired or been revoked — the runs below are
                  the last ones read and are not being refreshed.
                </span>
                <button className="btn secondary size-24" onClick={onUpdateToken}>
                  Update token
                </button>
              </div>
            ) : limited ? (
              <div className="panel-note is-watch">
                {c.name} has run out of request budget. Nothing is wrong with the runs below —
                they simply cannot be refreshed until the provider&apos;s window resets.
              </div>
            ) : (
              s?.error !== undefined && (
                <div className="panel-note is-alarm">
                  <span className="grow">
                    {hostOf(c.baseUrl)} could not be read ({s.failures}{' '}
                    {s.failures === 1 ? 'attempt' : 'attempts'}): {s.error}. The runs below are
                    ageing, not gone.
                  </span>
                  <button
                    className="btn secondary size-24"
                    disabled={!canRefresh}
                    title={canRefresh ? undefined : 'This build cannot read on demand.'}
                    onClick={() => void bridge?.refresh(c.id).catch(() => undefined)}
                  >
                    Retry
                  </button>
                </div>
              )
            )}
          </div>
        )
      })}
    </div>
  )
}

function isRateLimited(s: CicdPanelState | undefined): boolean {
  if (!s) return false
  if (s.budget !== undefined && s.budget.remaining <= 0) return true
  return s.error !== undefined && /rate limit|429|too many requests/i.test(s.error)
}

/** The host, for a note that has to name the machine rather than the account.
 *  A URL the user typed may not parse; showing it whole beats throwing. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}
