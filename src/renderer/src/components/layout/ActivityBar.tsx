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
  Wrench
} from 'lucide-react'
import { useApp } from '../../store/app'
import { clsx } from '../../lib/format'
import { openMonitor, openOperations, useNav } from '../../store/nav'
import type { ActivityView } from '../../types'

const items: { id: ActivityView; icon: React.ReactNode; label: string }[] = [
  { id: 'connections', icon: <Server size={20} />, label: 'Connections' },
  { id: 'databases', icon: <Database size={20} />, label: 'Databases' },
  { id: 'tunnels', icon: <Network size={20} />, label: 'Tunnels & VPN' },
  { id: 'http', icon: <Globe size={20} />, label: 'HTTP Client' },
  { id: 'monitor', icon: <Activity size={20} />, label: 'Monitoring' },
  { id: 'vault', icon: <KeyRound size={20} />, label: 'Vault' },
  { id: 'ai', icon: <Bot size={20} />, label: 'AI & MCP' }
]

export function ActivityBar(): React.JSX.Element {
  const activity = useApp((s) => s.activity)
  const setActivity = useApp((s) => s.setActivity)
  const toggleSidebar = useApp((s) => s.toggleSidebar)
  const backupDirty = useApp((s) => s.settings.backupDirty)
  // Two rail buttons, one `activity`. See the comment on the Operations button.
  const rail = useNav((s) => s.fleetRail)
  const monitorTab = useNav((s) => s.monitorTab)
  const operationsTab = useNav((s) => s.operationsTab)

  return (
    <div className="activitybar">
      <button className="activity-btn" title="Toggle sidebar" onClick={toggleSidebar}>
        <PanelLeft size={20} />
      </button>
      <div style={{ height: 8 }} />
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
            <button
              className={clsx('activity-btn', activity === 'monitor' && rail === 'monitor' && 'active')}
              title="Monitoring — reading the estate"
              onClick={() => openMonitor(monitorTab)}
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
      <div className="activity-spacer" />
      <button
        className={clsx('activity-btn', activity === 'settings' && 'active')}
        title={backupDirty ? 'Settings — backup out of date' : 'Settings'}
        onClick={() => setActivity('settings')}
      >
        <Settings size={20} />
        {backupDirty && <span className="activity-badge" />}
      </button>
    </div>
  )
}
