import {
  Server,
  Database,
  Network,
  Activity,
  KeyRound,
  Bot,
  Globe,
  Settings,
  PanelLeft,
  Wrench,
  Bug,
  Container,
  Ship,
  GitBranch,
  SquareActivity
} from 'lucide-react'
import { useApp } from '../../store/app'
import { clsx } from '../../lib/format'
import { reportBug } from '../../lib/reportBug'
import { openMonitor, openOperations, useNav } from '../../store/nav'
import { MODULES, PROMOTED_MODULE_IDS, moduleEnabled, type ModuleId } from '../../../../shared/modules'
import type { ActivityView } from '../../types'

/**
 * The app's top-level destinations.
 *
 * Exported because the command palette lists them too, and a palette built from
 * its own private copy is how six of these ended up unreachable from Ctrl+K
 * while the walkthrough claimed it reached every action in the app.
 */
export const ACTIVITY_ITEMS: { id: ActivityView; icon: React.ReactNode; label: string }[] = [
  { id: 'connections', icon: <Server size={20} />, label: 'Connections' },
  { id: 'databases', icon: <Database size={20} />, label: 'Databases' },
  { id: 'tunnels', icon: <Network size={20} />, label: 'Tunnels & VPN' },
  { id: 'http', icon: <Globe size={20} />, label: 'HTTP Client' },
  { id: 'monitor', icon: <Activity size={20} />, label: 'Monitoring' },
  { id: 'vault', icon: <KeyRound size={20} />, label: 'Vault' },
  { id: 'ai', icon: <Bot size={20} />, label: 'AI & MCP' }
]

/**
 * The icon for each promoted module.
 *
 * Here rather than in the registry because src/shared/modules.ts is imported by
 * the main process, which has no React in it. Keyed by the id so a module
 * promoted without an icon is a compile error rather than a blank button, and
 * tests/promotedModules.test.ts pins this map against PROMOTED_MODULE_IDS.
 */
const PROMOTED_ICONS: Record<string, React.ReactNode> = {
  docker: <Container size={20} />,
  // A ship's wheel is the project's own logo and the one silhouette an operator
  // reads as Kubernetes at 44px without a label.
  kubernetes: <Ship size={20} />,
  cicd: <GitBranch size={20} />,
  // Deliberately not another waveform. `Activity` is Monitoring's icon and this
  // button's whole argument is that local processes are NOT that.
  processes: <SquareActivity size={20} />
}

/**
 * What each promoted button says on hover.
 *
 * A tooltip per id rather than the registry `label`, because the rail is where
 * the subject distinction has to be legible: "Monitoring — reading the estate"
 * sits two buttons up, and `processes` is here precisely because it is not that.
 */
const PROMOTED_TITLES: Record<string, string> = {
  docker: 'Docker — containers, compose projects and images',
  kubernetes: 'Kubernetes — clusters, pods and workloads',
  cicd: 'CI/CD — pipelines and run history',
  processes: 'Local processes — programs running on this machine'
}

const items = ACTIVITY_ITEMS

export function ActivityBar(): React.JSX.Element {
  const activity = useApp((s) => s.activity)
  const setActivity = useApp((s) => s.setActivity)
  const toggleSidebar = useApp((s) => s.toggleSidebar)
  const backupDirty = useApp((s) => s.settings.backupDirty)
  // Two rail buttons, one `activity`. See the comment on the Operations button.
  const rail = useNav((s) => s.fleetRail)
  const monitorTab = useNav((s) => s.monitorTab)
  const operationsTab = useNav((s) => s.operationsTab)
  const modules = useApp((s) => s.settings.modules)

  // Promoted modules that are actually switched on.
  //
  // Gated on `moduleEnabled` rather than always shown, unlike the two fleet
  // buttons above. Those two always have somewhere to go -- an empty estate
  // still has an Overview -- where a rail button for a module that is off would
  // open a tab FleetMonitor does not render, which is the "pointer that opens
  // the wrong place" the nav store was written against.
  //
  // It also makes the module switches mean something visible: answering the
  // container question during setup makes an icon APPEAR, which is the only
  // feedback in the app that says a first-run answer did anything.
  const promoted = MODULES.filter(
    (m) => PROMOTED_MODULE_IDS.includes(m.id) && moduleEnabled(modules, m.id)
  )

  // Monitoring is only "here" when the visible tab is one of its own. Without
  // this, standing on Docker lit both the Docker button and Monitoring, so the
  // rail claimed two destinations at once.
  const onPromotedTab = PROMOTED_MODULE_IDS.includes(monitorTab as ModuleId)

  return (
    <div className="activitybar">
      <button className="activity-btn" title="Toggle sidebar" onClick={toggleSidebar}>
        <PanelLeft size={20} />
      </button>
      <div style={{ height: 8 }} />
      {/* The destinations scroll; the sidebar toggle above and Report a bug and
          Settings below do not.

          This is not styling for its own sake, it is a reachability fix that
          promotion made necessary. The rail is a fixed column inside
          `.app-body { overflow: hidden }`, and the window may be 640px tall --
          576px of it left for this column after the title and status bars. Eleven
          buttons needed 520px and fit. The four promoted modules take it to
          fifteen buttons and about 696px, so 120px fell off the BOTTOM, and the
          two things at the bottom are the bug report and Settings -- the latter
          being the only route to the page that turns a module off again. A rail
          that grew a Docker icon by hiding the way to switch it back off would be
          a bad trade.
          Only this middle section scrolls, so the two fixed controls keep their
          positions whatever is enabled and whatever the window is doing. */}
      <div className="activity-scroll">
      {items.map((it) =>
        it.id === 'monitor' ? (
          // Monitoring and Operations are two destinations that share one
          // `activity` value, distinguished by `fleetRail`. They are separate
          // places to the user — separate icons, separate tab strips, separate
          // registers — and one mounted tree underneath, because
          // LogTailPanel stops its remote command on unmount and BroadcastPanel
          // holds a live run. Giving Operations its own ActivityView would mean
          // App.tsx mounting a second subtree and unmounting the first every
          // time somebody crossed between them, which is the behaviour
          // FleetMonitor's tab strip has always gone out of its way to avoid.
          //
          // Clicking a rail restores the tab it was last on rather than
          // resetting to the first one: crossing to Operations to start a
          // broadcast and coming back should land where you left, not on
          // Overview.
          <div key="fleet" style={{ display: 'contents' }}>
            {/* `onClick` restores the last MONITORING tab. `monitorTab` also
                holds the promoted tabs, so pressing Monitoring while standing on
                Docker would otherwise be a no-op that leaves Docker on screen
                with Monitoring lit. */}
            <button
              className={clsx(
                'activity-btn',
                activity === 'monitor' && rail === 'monitor' && !onPromotedTab && 'active'
              )}
              title="Monitoring — reading the estate"
              onClick={() => openMonitor(onPromotedTab ? 'overview' : monitorTab)}
            >
              <Activity size={20} />
            </button>
            <button
              className={clsx(
                'activity-btn',
                activity === 'monitor' && rail === 'operations' && 'active'
              )}
              title="Operations — changing the estate"
              onClick={() => openOperations(operationsTab)}
            >
              {/* A spanner rather than another waveform. The two rails differ by
                  what they DO to a server, so the icons have to differ by more
                  than hue — an operator glancing at a 44px column reads the
                  silhouette and nothing else. */}
              <Wrench size={20} />
            </button>
            {/* The promoted modules, immediately after the two fleet buttons.
                Here rather than at the top of the rail because they ARE fleet
                work -- a container runs on one of these servers -- and the four
                destinations above them (connections, databases, tunnels, HTTP)
                are the ones whose order people already have in their hands.
                Adding to the middle of a rail somebody has learned is the one
                change that makes every position below it wrong. */}
            {promoted.map((m) => (
              <button
                key={m.id}
                className={clsx(
                  'activity-btn',
                  activity === 'monitor' && rail === 'monitor' && monitorTab === m.id && 'active'
                )}
                title={PROMOTED_TITLES[m.id] ?? m.label}
                onClick={() => openMonitor(m.id)}
              >
                {PROMOTED_ICONS[m.id]}
              </button>
            ))}
          </div>
        ) : (
          <button
            key={it.id}
            className={clsx('activity-btn', activity === it.id && 'active')}
            title={it.label}
            onClick={() => setActivity(it.id)}
          >
            {it.icon}
          </button>
        )
      )}
      </div>
      {/* Directly above the gear, because that is where a person looks for help
          — and because this rail is the only chrome that is on screen on every
          view, whatever is open. The status bar was the other candidate and it
          is the wrong shape for this: every chip there reports a state, three of
          them appear only when something is wrong, and they compete for one row
          of horizontal space that already holds the workspace, the session
          count, the approval countdown, the alert count, the backup warning, the
          update indicator and the local metric. A permanent action chip in that
          row either pushes a warning off a narrow window or teaches that a chip
          may or may not be a status — and this control has to be found by
          someone who has never gone looking for it.

          It does not take an `active` class: it opens a browser, so there is no
          view here for the rail to be showing. */}
      <button
        className="activity-btn"
        title="Report a bug — copies your diagnostics and opens the issue form"
        onClick={() => void reportBug()}
      >
        <Bug size={20} />
      </button>
      <button
        className={clsx('activity-btn', activity === 'settings' && 'active')}
        // The dot's meaning lives on the button, not on the dot. Every control
        // in this rail says what it is through `title` and nothing else, and a
        // `title` covers its descendants — so hovering the dot answers "what is
        // this red thing" without the dot needing a tooltip of its own, and a
        // screen reader gets the same sentence as the button's name rather than
        // an unnamed decoration next to a button called "Settings". A bare dot
        // reads equally as "update available" or "something is broken"; naming
        // the export is the whole fix. It does NOT promise to open Backup &
        // Restore — this button opens Settings where it left off, and the
        // status-bar chip is the one that lands on the page.
        title={
          backupDirty
            ? 'Settings — backup out of date: stored connections have changed since the last export'
            : 'Settings'
        }
        onClick={() => setActivity('settings')}
      >
        <Settings size={20} />
        {backupDirty && <span className="activity-badge" aria-hidden />}
      </button>
    </div>
  )
}
