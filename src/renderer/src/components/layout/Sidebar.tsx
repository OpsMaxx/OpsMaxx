import { useCallback, useRef } from 'react'
import { Plus, FolderPlus, Network, Download } from 'lucide-react'
import { useApp } from '../../store/app'
import { clsx } from '../../lib/format'
import { ConnectionTree } from '../connections/ConnectionTree'
import { TunnelSidebar } from '../tunnels/TunnelSidebar'
import { VpnSidebar } from '../vpn/VpnSidebar'
import { MonitorSidebar } from '../monitor/MonitorSidebar'
import { DatabaseSidebar } from '../databases/DatabaseSidebar'
import { ApiSidebar } from '../http/ApiSidebar'
import { VaultSidebar } from '../vault/VaultSidebar'
import { useVault } from '../../store/vault'
import { useNav } from '../../store/nav'

const titles: Record<string, string> = {
  connections: 'Connections',
  databases: 'Databases',
  tunnels: 'Tunnels & VPN',
  http: 'HTTP Client',
  // Overridden below when the Operations rail is showing: the two share one
  // ActivityView, so this map alone titled the Operations sidebar "Fleet
  // Monitor" while the page beside it said Operations.
  monitor: 'Fleet Monitor',
  vault: 'Vault'
}

export function Sidebar(): React.JSX.Element | null {
  const activity = useApp((s) => s.activity)
  const fleetRail = useNav((s) => s.fleetRail)
  const collapsed = useApp((s) => s.sidebarCollapsed)
  const width = useApp((s) => s.sidebarWidth)
  const setWidth = useApp((s) => s.setSidebarWidth)
  const setModal = useApp((s) => s.setModal)
  const addFolder = useApp((s) => s.addFolder)
  const addMonitorGroup = useApp((s) => s.addMonitorGroup)
  const vaultUnlocked = useVault((s) => s.unlocked)
  const addVaultEntry = useVault((s) => s.addEntry)
  const dragging = useRef(false)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragging.current = true
      const startX = e.clientX
      const startW = width
      const move = (ev: MouseEvent): void => {
        if (dragging.current) setWidth(startW + (ev.clientX - startX))
      }
      const up = (): void => {
        dragging.current = false
        document.removeEventListener('mousemove', move)
        document.removeEventListener('mouseup', up)
      }
      document.addEventListener('mousemove', move)
      document.addEventListener('mouseup', up)
    },
    [width, setWidth]
  )

  if (activity === 'settings' || activity === 'ai' || collapsed) return null

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-header">
        <span className="sidebar-title">
          {activity === 'monitor' && fleetRail === 'operations' ? 'Operations' : (titles[activity] ?? '')}
        </span>
        <div className="sidebar-actions">
          {activity === 'connections' && (
            <>
              <button className="icon-btn" title="New folder" onClick={() => addFolder('New folder')}>
                <FolderPlus size={15} />
              </button>
              <button
                className="icon-btn"
                title="Import from ~/.ssh/config"
                onClick={() => setModal('import-ssh')}
              >
                <Download size={15} />
              </button>
              <button className="icon-btn" title="Add server" onClick={() => setModal('add-server')}>
                <Plus size={16} />
              </button>
            </>
          )}
          {activity === 'databases' && (
            <button className="icon-btn" title="Add database" onClick={() => setModal('add-database')}>
              <Plus size={16} />
            </button>
          )}
          {activity === 'tunnels' && (
            <button className="icon-btn" title="New tunnel">
              <Network size={15} />
            </button>
          )}
          {activity === 'http' && (
            <button className="icon-btn" title="Add an API" onClick={() => setModal('add-api')}>
              <Plus size={16} />
            </button>
          )}
          {/* Monitoring only. A monitor group is a Monitoring layout, and the
              two rails share one ActivityView — so gating on `activity` alone
              put "New monitor group" in the header of the Operations pane,
              where it makes nothing a person on that rail could want. */}
          {activity === 'monitor' && fleetRail === 'monitor' && (
            <button
              className="icon-btn"
              title="New monitor group"
              onClick={() => addMonitorGroup('New group')}
            >
              <FolderPlus size={15} />
            </button>
          )}
          {activity === 'vault' && vaultUnlocked && (
            <button className="icon-btn" title="New entry" onClick={() => void addVaultEntry()}>
              <Plus size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="sidebar-scroll">
        {activity === 'connections' && <ConnectionTree />}
        {activity === 'databases' && <DatabaseSidebar />}
        {activity === 'http' && <ApiSidebar />}
        {activity === 'tunnels' && (
          <>
            <TunnelSidebar />
            <VpnSidebar />
          </>
        )}
        {activity === 'monitor' && <MonitorSidebar />}
        {activity === 'vault' && <VaultSidebar />}
      </div>

      <div
        className={clsx('resizer', dragging.current && 'dragging')}
        onMouseDown={onMouseDown}
      />
    </aside>
  )
}
