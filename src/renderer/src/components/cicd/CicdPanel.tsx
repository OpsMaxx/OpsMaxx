import { useEffect, useMemo, useState } from 'react'
import { Activity, KeyRound, Pencil, Plus, Settings2, Trash2 } from 'lucide-react'
import { PanelShell } from '../monitor/PanelShell'
import { EmptyState } from '../common/EmptyState'
import { UnlockVaultButton } from '../common/UnlockVaultButton'
import { isVaultLocked, withVaultUnlock } from '../../lib/withVaultUnlock'
import { clsx, duration } from '../../lib/format'
import { remoteText } from '../../../../shared/remoteText'
import { useApp } from '../../store/app'
import { TabStrip } from '../panel/TabStrip'
import { ContextMenu, type MenuEntry } from '../connections/ContextMenu'
import { StatusWord } from './Status'
import { CicdAccountsModal } from './CicdAccountsModal'
import { CicdConnectModal } from './CicdConnectModal'
import { CicdRunWorkbench } from './CicdRunWorkbench'
import { PipelineBrowser } from './PipelineBrowser'
import { QueuePanel } from './QueuePanel'
import {
  BUCKET_LABEL,
  BUCKET_ORDER,
  type CicdBucket,
  type CicdRow,
  PROVIDER_LABEL,
  cicdBridgeHas,
  cicdBridge,
  hostOf,
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
 *
 * ---------------------------------------------------------------------------
 * ONE TAB PER ACCOUNT, PLUS THE ONE THAT SEES ALL OF THEM
 * ---------------------------------------------------------------------------
 *
 * This screen used to flatten every connected account into one body, which put
 * every account's freshness line and every account's error banner in a stack
 * above a merged feed. Three accounts was already a wall, and none of it said
 * which account a reader should go and look at.
 *
 * The strip is DERIVED from the connection list rather than opened and closed
 * like session tabs: an account is a saved record, so every one of them is
 * always a tab and there is nothing to reopen. That is also why the strip has
 * no `×` — closing a tab here could only mean disconnecting the account, which
 * belongs behind a confirm rather than behind a 13px glyph. `TabStrip` takes
 * `onClose` optionally for exactly this case, so the keyboard model, the
 * overflow menu and the scroll-into-view all come along anyway.
 *
 * The dot on each tab is the account's own health, so the strip answers "which
 * one needs me" without being opened. `All accounts` keeps the ranked feed,
 * because "is anything broken anywhere" is a real question a per-account tab
 * cannot answer.
 *
 * ---------------------------------------------------------------------------
 * WHICH SUB-TABS EXIST DEPENDS ON THE PROVIDER
 * ---------------------------------------------------------------------------
 *
 * `Queue & capacity` is Jenkins-only — `getQueue` in main refuses every other
 * provider BY NAME, because GitHub exposes no queue a token can read and
 * GitLab's pending jobs are a different subject. The tab was offered anyway,
 * so selecting it on a GitHub account read, threw, and painted main's refusal
 * in red: a broken page for a screen that should never have been offered. It
 * is now absent unless something in view actually has a queue, which is the
 * same rule stated once in the UI instead of discovered once per click.
 */

/** How far off a read has to be before the number stops meaning "now". Not on
 *  `CicdPanelState`, which carries no interval — see the report. */
const DEFAULT_INTERVAL_SEC = 20

/** The cross-account tab's id. Not a connection id, and cannot collide with one:
 *  every real id is minted as `cicd-<base36>`. */
const ALL = 'all'

export function CicdPanel({
  connections: seed,
  bridge = cicdBridge(),
  intervalSec = DEFAULT_INTERVAL_SEC,
  canTrigger = false,
  onSaveConnection
}: {
  connections?: CicdConnection[]
  bridge?: CicdBridge
  intervalSec?: number
  /**
   * Whether the `cicdTrigger` module is on. Decided at the mount point, like
   * every other module, so this panel never reads the registry itself -- and so
   * `tests/moduleBoundaries.test.ts` can still find the guard where it looks.
   */
  canTrigger?: boolean
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
  /**
   * The connect modal, and WHICH account it is for.
   *
   * A discriminated union rather than the two strings this was, because those
   * two strings produced the same blank modal: "Update token" rendered a
   * NEW-connection form, so pressing it minted a fresh id and saved a SECOND
   * account with the same name beside the one whose token had expired. Both
   * then polled, both showed the same error, and — because an agent addresses
   * an account by name — both became unreachable from every CI tool.
   *
   * `CicdConnectModal` has taken an `editing` prop since it was written and
   * implements the whole edit path; nothing ever passed one.
   */
  const [connecting, setConnecting] = useState<
    { mode: 'new' } | { mode: 'edit'; connection: CicdConnection } | null
  >(null)
  /** The accounts list: open plainly, or open on one account's remove confirm. */
  const [accountsOpen, setAccountsOpen] = useState<
    { on: 'list' } | { on: 'remove'; connection: CicdConnection } | null
  >(null)
  /** Which account is on screen. `all` is the cross-account feed. */
  const [account, setAccount] = useState<string>(ALL)
  const [tabMenu, setTabMenu] = useState<{
    connection: CicdConnection
    x: number
    y: number
  } | null>(null)
  // Which half of the module is on screen. Activity is the landing view because
  // it answers "is anything broken"; Pipelines answers "what exists", which is a
  // different question and was previously unanswerable here at all.
  const [tab, setTab] = useState<'activity' | 'pipelines' | 'queue'>('activity')

  /**
   * The accounts the body is currently about.
   *
   * An id that no longer names anything falls back to every account rather than
   * to an empty screen: removing the account you were looking at should land on
   * the feed, not on a blank tab whose name is gone.
   */
  const inView = account !== ALL && connections.some((c) => c.id === account) ? account : ALL
  const scoped = useMemo(
    () => (inView === ALL ? connections : connections.filter((c) => c.id === inView)),
    [connections, inView]
  )

  // Jenkins is the only provider with a queue main can read. Offering the tab
  // for anything else is offering a page that can only fail.
  const hasQueue = scoped.some((c) => c.provider === 'jenkins')
  // A sub-tab that has just stopped existing under the reader — switching from
  // a Jenkins account to a GitHub one — must not leave the body on it.
  const subTab = tab === 'queue' && !hasQueue ? 'activity' : tab

  // Tell main the saved list changed. It carries nothing: main re-reads the
  // file it persists, so this is a nudge rather than a handover. `connections`
  // stays in the dependency list because a change to it is exactly when the
  // file has been rewritten and main needs to look again.
  useEffect(() => {
    if (!bridge) return
    void bridge.configure().catch(() => undefined)
  }, [bridge, connections])

  // Three different emptinesses the panel used to report with one sentence.
  // `unread` has answered nothing; `barren` answered and showed no pipelines at
  // all, which for Jenkins is what a credential that cannot see the jobs looks
  // like -- an empty list, not an error.
  // Every pipeline every connected account has told us about, flattened. The
  // browser groups it; nothing here fetches.
  const allPipelines = scoped.flatMap((c) => states.get(c.id)?.pipelines ?? [])

  /**
   * Accounts with a read IN FLIGHT right now, and accounts that simply have
   * nothing.
   *
   * These were one list and the conflation is the whole of the "GitHub Actions
   * doesn't fetch anything and shows nothing, as if the token didn't work"
   * report. GitHub discovery walks repositories, then each repository's
   * workflows, then each workflow's YAML -- tens of seconds -- and for all of
   * it the panel printed "Not read yet ... if it stays unread, the account is
   * not being polled", which is an accusation rather than a status. `reading`
   * comes from main (see `CicdPanelState.reading`) because the renderer has no
   * way to know: it does not make the request.
   */
  const reading = scoped.filter((c) => states.get(c.id)?.reading === true).map((c) => c.name)
  const unread = scoped
    .filter((c) => {
      const st = states.get(c.id)
      return st?.readAt === undefined && st?.reading !== true
    })
    .map((c) => c.name)
  const barren = scoped
    .filter((c) => {
      const st = states.get(c.id)
      return st?.readAt !== undefined && st.pipelines.length === 0
    })
    .map((c) => c.name)

  const { rows, olderThanWindow, neverRun } = useMemo(
    () => rankRows(scoped, states, seenAt, now),
    // `now` deliberately absent: the ranking must not resort itself every
    // second under the reader's cursor. It is recomputed when the data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scoped, states, seenAt]
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
    // The entry the account pointed at BEFORE this save. Re-saving an existing
    // account with a new token writes a new vault entry, and without this the
    // old one stays in the vault with nothing left pointing at it — a stored
    // credential for an account that no longer uses it, invisible to everything.
    const replaced = connection.vaultEntryId
    if (token !== '' && cicdBridgeHas(bridge, 'createSecret')) {
      // Through `withVaultUnlock`, because a vault WRITE needs the vault fully
      // open and `createSecret` says so by refusing. Without the offer, the only
      // thing standing between a verified account and a saved one was a locked
      // vault the user was never asked to open. Declining still throws, and the
      // modal now says so on the button rather than swallowing it.
      const vaultEntryId = await withVaultUnlock(
        `Unlocking lets OpsMaxx store the token for ${connection.name}.`,
        () => bridge!.createSecret(`CI/CD — ${connection.name}`, token)
      )
      record = { ...connection, vaultEntryId }
    }
    // `upsert`, not a bulk set: `connections` here is the ACTIVE workspace's
    // slice, and handing that to `setCicdConnections` would tell the store
    // every other workspace's connections had been deleted — releasing their
    // vault entries on the way out.
    upsert(record)
    // AFTER the upsert, never before: dropping the old entry first would leave
    // the account pointing at a vault entry that no longer exists for as long
    // as the write took, and permanently if the write then failed.
    if (
      replaced !== '' &&
      replaced !== record.vaultEntryId &&
      cicdBridgeHas(bridge, 'deleteSecrets')
    ) {
      void bridge!.deleteSecrets(replaced).catch(() => undefined)
    }
  }

  /** Every other account's name, so the form can refuse a duplicate. See the
   *  `existingNames` prop — two accounts sharing a name make both unreachable
   *  from every agent tool. */
  const takenNames = (editing?: CicdConnection): string[] =>
    connections.filter((c) => c.id !== editing?.id).map((c) => c.name)

  /**
   * Right-clicking a tab.
   *
   * Edit and Update token open the same form; they differ only in what the
   * reader came to change, and naming both is what makes the second one
   * findable at all — an expired token is the common reason to open this and
   * "Edit" does not read as the place to fix it. Remove goes through the
   * accounts list rather than deleting from here, because the confirm has to
   * name what else goes with it — but it opens ON this account, so the reader
   * does not have to find it again in a list they did not ask for.
   */
  const accountMenu = (c: CicdConnection): MenuEntry[] => [
    {
      label: 'Edit…',
      icon: <Pencil size={14} />,
      onClick: () => setConnecting({ mode: 'edit', connection: c })
    },
    {
      label: 'Update token…',
      icon: <KeyRound size={14} />,
      onClick: () => setConnecting({ mode: 'edit', connection: c })
    },
    { label: '', separator: true },
    {
      label: 'Remove…',
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: () => setAccountsOpen({ on: 'remove', connection: c })
    }
  ]

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
            Reading is what this module does on its own. Starting, cancelling and disabling live
            on the same screen but behind a second module — "Start a build" — because the
            consequence is that a deploy goes out, and that is a separate decision from being
            allowed to look.
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
            <button
              className="btn primary size-28"
              onClick={() => setConnecting({ mode: 'new' })}
            >
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
          {/* The navigation, pinned.
              `.content` in FleetMonitor is the scroll container, so one screen
              into a log or a pipeline tree neither the account tabs nor the
              Activity/Pipelines/Queue strip was on screen any more -- on a page
              whose whole job is to be several different pages. Both are in one
              block so they pin together; the freshness lines are deliberately
              NOT, because an account with a failure renders two or three lines
              of banner and a nav bar that grows to four lines is not a nav bar.
              See `.cicd-nav` in cicd.css. */}
          <div className="cicd-nav">
          <div className="cicd-accounts-strip">
            <TabStrip
              label="CI/CD account tabs"
              items={[
                {
                  id: ALL,
                  title: 'All accounts',
                  status: <AccountDot connections={connections} states={states} now={now} />,
                  tooltip:
                    connections.length === 1
                      ? 'The one connected account.'
                      : `Every connected account (${connections.length}), ranked together.`
                },
                ...connections.map((c) => ({
                  id: c.id,
                  title: c.name,
                  status: <AccountDot connections={[c]} states={states} now={now} />,
                  tooltip: `${c.name} — ${PROVIDER_LABEL[c.provider]} at ${hostOf(c.baseUrl)}`
                }))
              ]}
              activeId={inView}
              onSelect={setAccount}
              // Deliberately no `onClose` and no `onReorder`: the strip is
              // derived from the saved accounts, so there is nothing to close
              // that is not a disconnection, and nothing to reorder that is not
              // the list itself.
              onContextMenu={(id, x, y) => {
                const c = connections.find((k) => k.id === id)
                if (c) setTabMenu({ connection: c, x, y })
              }}
            >
              <button
                type="button"
                className="tab-new"
                title="Connect a CI account."
                aria-label="Connect a CI account"
                onClick={() => setConnecting({ mode: 'new' })}
              >
                <Plus size={16} />
              </button>
              <button
                type="button"
                className="tab-new"
                title="Edit or remove connected accounts."
                aria-label="Manage CI accounts"
                onClick={() => setAccountsOpen({ on: 'list' })}
              >
                <Settings2 size={15} />
              </button>
            </TabStrip>
          </div>

          <div className="segment modal-segment cicd-tabs">
            <button
              type="button"
              className={clsx('seg-btn', subTab === 'activity' && 'active')}
              aria-pressed={subTab === 'activity'}
              onClick={() => setTab('activity')}
            >
              Activity
            </button>
            <button
              type="button"
              className={clsx('seg-btn', subTab === 'pipelines' && 'active')}
              aria-pressed={subTab === 'pipelines'}
              onClick={() => setTab('pipelines')}
            >
              Pipelines
              {allPipelines.length > 0 && <span className="count">{allPipelines.length}</span>}
            </button>
            {/* Absent, not disabled. A greyed tab is still a claim that the
                screen exists and is merely unavailable; for GitHub and GitLab
                there is no queue to be unavailable. */}
            {hasQueue && (
              <button
                type="button"
                className={clsx('seg-btn', subTab === 'queue' && 'active')}
                aria-pressed={subTab === 'queue'}
                onClick={() => setTab('queue')}
              >
                Queue &amp; capacity
              </button>
            )}
          </div>
          </div>

          <Freshness
            connections={scoped}
            states={states}
            intervalSec={intervalSec}
            now={now}
            bridge={bridge}
            canRefresh={canRefresh}
            // On the cross-account tab only the accounts with something wrong
            // get a block of their own. Stacking every healthy account's two
            // lines above the feed is what pushed the feed off the screen, and
            // a healthy account's detail is one click away in its own tab.
            troubleOnly={inView === ALL && connections.length > 1}
            onUpdateToken={(connection) => setConnecting({ mode: 'edit', connection })}
          />

          {subTab === 'queue' ? (
            <QueuePanel
              // Only the accounts that HAVE a queue, so the panel's own default
              // lands on one. It defaulted to the first connection whatever its
              // provider, which on a GitHub-first list read, threw, and printed
              // main's refusal in red on arrival.
              connections={scoped.filter((c) => c.provider === 'jenkins')}
              bridge={bridge}
              canTrigger={canTrigger}
            />
          ) : subTab === 'pipelines' ? (
            <PipelineBrowser
              connections={scoped}
              pipelines={allPipelines}
              bridge={bridge}
              canTrigger={canTrigger}
              reading={reading.length > 0}
              onOpenRun={(connectionId, pipelineRef, run) =>
                setSelected({ connectionId, pipelineRef, runId: run.id })
              }
            />
          ) : (
          <>
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
            // "Every connected account answered" was printed whenever there were
            // no rows -- including when an account had never been read, and when
            // it had been read and showed no pipelines whatsoever. Claiming a
            // successful empty read that never happened sent the reader to look
            // at Jenkins, where the builds this panel said it had asked about
            // were sitting in plain sight.
            <EmptyState
              compact
              title={
                rows.length > 0
                  ? 'Nothing matched'
                  : reading.length > 0
                    ? 'Reading…'
                    : unread.length > 0
                      ? 'Not read yet'
                      : barren.length > 0
                        ? 'No pipelines to show'
                        : 'Nothing has run in the last 24 hours'
              }
              message={
                rows.length > 0
                  ? 'No run in the window matches that filter. Clear it to see the rest.'
                  : reading.length > 0
                    ? `${reading.join(', ')} ${reading.length === 1 ? 'is' : 'are'} being read now. GitHub in particular takes a while the first time — it lists the repositories, then each one's workflows, then reads each workflow to find out whether it can be started by hand. Nothing is wrong with the token while this line is up.`
                    : unread.length > 0
                    ? `${unread.join(', ')} ${unread.length === 1 ? 'has' : 'have'} not answered yet, so nothing below reflects ${unread.length === 1 ? 'it' : 'them'}. Press Refresh; if it stays unread, the account is not being polled.`
                    : barren.length > 0
                      ? `${barren.join(', ')} answered and listed no pipelines at all. That is what a credential with no access to the jobs looks like — the provider returns an empty list rather than refusing — so check what the token's account can see.`
                      : 'Every connected account answered, and none of its pipelines has produced a run inside the window.'
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
        </>
      )}

      {tabMenu && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          entries={accountMenu(tabMenu.connection)}
          onClose={() => setTabMenu(null)}
        />
      )}

      {accountsOpen !== null && (
        <CicdAccountsModal
          states={states}
          confirmRemove={accountsOpen.on === 'remove' ? accountsOpen.connection : undefined}
          onAdd={() => {
            setAccountsOpen(null)
            setConnecting({ mode: 'new' })
          }}
          onEdit={(connection) => {
            setAccountsOpen(null)
            setConnecting({ mode: 'edit', connection })
          }}
          onClose={() => setAccountsOpen(null)}
        />
      )}

      {connecting !== null && (
        <CicdConnectModal
          bridge={bridge}
          // Editing reuses the SAME record — its id, its workspace and its
          // existing vault pointer — so saving replaces the account rather than
          // appending a second one beside it. See the `connecting` state above.
          editing={connecting.mode === 'edit' ? connecting.connection : undefined}
          existingNames={takenNames(
            connecting.mode === 'edit' ? connecting.connection : undefined
          )}
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
  troubleOnly = false,
  onUpdateToken
}: {
  connections: CicdConnection[]
  states: Map<string, CicdPanelState>
  intervalSec: number
  now: number
  bridge?: CicdBridge
  canRefresh: boolean
  /**
   * Show only the accounts with something wrong, plus a line accounting for
   * the rest.
   *
   * Set on the cross-account tab. Every account's two lines and every account's
   * banner stacked above the feed is what pushed the feed off the screen, and
   * the accounts that were fine contributed all of the height and none of the
   * information. The count still states how many were checked, so the shorter
   * block is not a quieter claim — going silent about an account is exactly
   * what this panel is not allowed to do.
   */
  troubleOnly?: boolean
  onUpdateToken: (connection: CicdConnection) => void
}): React.JSX.Element {
  const rows = connections.map((c) => ({
    c,
    trouble: hasTrouble(states.get(c.id), intervalSec, now)
  }))
  const shown = troubleOnly ? rows.filter((r) => r.trouble) : rows
  const quiet = rows.length - shown.length
  return (
    <div className="cicd-freshness">
      {quiet > 0 && (
        <div className="panel-stats" data-testid="cicd-accounts-ok">
          <span>
            {quiet} of {rows.length} {rows.length === 1 ? 'account is' : 'accounts are'} answering
            on time
          </span>
          <span className="faint">
            Open an account&apos;s own tab for its last read and its request budget.
          </span>
        </div>
      )}
      {shown.map(({ c }) => {
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
        // A locked vault is not a CI failure, and it has a button rather than a
        // retry. The poller's error string already carries the marker all the
        // way from `cicd/service.ts resolveSecret`, and this panel was printing
        // it — so the row read `OPSMAXX_VAULT_LOCKED: …` at the user and
        // offered "Retry", which cannot succeed until something else happens
        // somewhere else. Checked BEFORE `expired`: a marker-carrying message
        // that happens to contain the word "token" is still a locked vault.
        const vaultShut = isVaultLocked(s?.error)
        return (
          <div key={c.id} className="cicd-fresh-row">
            <div className="row">
              <b className="ellipsis">{c.name}</b>
              <span className={clsx('ui-note', stale && 'state-unknown')} data-testid={`cicd-read-${c.id}`}>
                {/* "reading now" outranks both. It is the newest fact and the
                    only one of the three that is not a complaint. */}
                {s?.reading === true
                  ? 'reading now…'
                  : s?.readAt === undefined
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

            {vaultShut ? (
              <div className="panel-note is-alarm">
                <span className="grow">
                  {c.name} authenticates with a credential in the vault, and the vault is locked.
                  The runs below are the last ones read and are not being refreshed.
                </span>
                <UnlockVaultButton reason={`Unlocking resumes reading pipelines from ${c.name}.`} />
              </div>
            ) : expired ? (
              <div className="panel-note is-alarm">
                <span className="grow">
                  {c.name} refused the token. It has expired or been revoked — the runs below are
                  the last ones read and are not being refreshed.
                </span>
                <button className="btn secondary size-24" onClick={() => onUpdateToken(c)}>
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

/**
 * Whether this account is worth a block of its own.
 *
 * "Never read" counts. An account that has not answered is not a healthy one,
 * and it is exactly the state a freshly connected account that cannot dial
 * sits in — the one case where hiding it would hide the whole problem.
 */
function hasTrouble(s: CicdPanelState | undefined, intervalSec: number, now: number): boolean {
  if (!s) return true
  // A read in flight still earns a block, but only so the "reading now…" line
  // has somewhere to render. Without this it inherits the staleness test and
  // would be reported as late while it is in the middle of being on time.
  if (s.reading === true) return true
  return (
    s.error !== undefined || isRateLimited(s) || isStale(s.readAt, s.intervalSec ?? intervalSec, now)
  )
}

/**
 * One account's health, as the dot on its tab.
 *
 * Four roles and the unknown one is achromatic, the same rule the rows follow:
 * an account we have not managed to read is neither green nor red. Over a SET
 * of accounts it takes the WORST rather than a majority, so `All accounts` goes
 * red while any one account is failing instead of averaging the estate into
 * looking fine.
 */
function AccountDot({
  connections,
  states,
  now
}: {
  connections: readonly CicdConnection[]
  states: Map<string, CicdPanelState>
  now: number
}): React.JSX.Element | null {
  if (connections.length === 0) return null
  let role = 'is-ok'
  for (const c of connections) {
    const s = states.get(c.id)
    if (s?.error !== undefined) return <span className="state-dot is-alarm" aria-hidden="true" />
    if (isRateLimited(s)) role = 'is-watch'
    else if (
      s === undefined ||
      s.readAt === undefined ||
      isStale(s.readAt, s.intervalSec ?? DEFAULT_INTERVAL_SEC, now)
    ) {
      if (role !== 'is-watch') role = 'is-unknown'
    }
  }
  return <span className={clsx('state-dot', role)} aria-hidden="true" />
}
