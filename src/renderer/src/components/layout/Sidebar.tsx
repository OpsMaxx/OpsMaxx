import { useCallback, useRef } from 'react'
import { Plus, FolderPlus, Network, Download } from 'lucide-react'
import { useApp } from '../../store/app'
import { clsx } from '../../lib/format'
import { ConnectionTree } from '../connections/ConnectionTree'
import { TunnelSidebar } from '../tunnels/TunnelSidebar'
import { VpnSidebar } from '../vpn/VpnSidebar'
import { MonitorSidebar } from '../monitor/MonitorSidebar'
import { DatabaseSidebar } from '../databases/DatabaseSidebar'
import { HttpSidebar } from '../http/HttpSidebar'
import { VaultSidebar } from '../vault/VaultSidebar'
import { useVault } from '../../store/vault'
import { openTunnels, useNav } from '../../store/nav'
import { MODULES, isPromotedModule, type ModuleId } from '../../../../shared/modules'
import { useT } from '../../lib/i18n'
import type { MessageKey } from '../../../../shared/i18n'

const titles: Record<string, MessageKey> = {
  connections: 'layout.activity.connections',
  databases: 'layout.activity.databases',
  tunnels: 'layout.activity.tunnels',
  http: 'layout.activity.http',
  // Overridden below when the Operations rail is showing, and again when a
  // promoted module is: all of them share one ActivityView, so this map alone
  // titled the Operations sidebar "Fleet Monitor" while the page beside it said
  // Operations — and would now do the same to Docker and Kubernetes.
  monitor: 'layout.sidebar.fleetMonitor',
  vault: 'layout.activity.vault'
}

export function Sidebar(): React.JSX.Element | null {
  const t = useT()
  const activity = useApp((s) => s.activity)
  const fleetRail = useNav((s) => s.fleetRail)
  const monitorTab = useNav((s) => s.monitorTab)
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

  // What the header says. Three cases share `activity === 'monitor'`: the
  // Operations rail, a promoted module's own destination, and Monitoring itself.
  // The registry `labelKey` is used for a promoted module rather than a second
  // copy of the four names, so renaming a module renames its sidebar with it.
  const promotedKey =
    activity === 'monitor' && fleetRail === 'monitor' && isPromotedModule(monitorTab as ModuleId)
      ? MODULES.find((m) => m.id === monitorTab)?.labelKey
      : undefined
  const promotedTitle = promotedKey ? t(promotedKey) : null
  const title =
    activity === 'monitor' && fleetRail === 'operations'
      ? t('layout.activity.operations')
      : (promotedTitle ?? (titles[activity] ? t(titles[activity]) : ''))

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-header">
        <span className="sidebar-title">
          {title}
        </span>
        <div className="sidebar-actions">
          {activity === 'connections' && (
            <>
              <button className="icon-btn" title={t('layout.sidebar.newFolder')} onClick={() => addFolder(t('layout.sidebar.newFolderName'))}>
                <FolderPlus size={15} />
              </button>
              <button
                className="icon-btn"
                title={t('layout.sidebar.importSsh')}
                onClick={() => setModal('import-ssh')}
              >
                <Download size={15} />
              </button>
              <button className="icon-btn" title={t('layout.sidebar.addServer')} onClick={() => setModal('add-server')}>
                <Plus size={16} />
              </button>
            </>
          )}
          {activity === 'databases' && (
            <button className="icon-btn" title={t('layout.sidebar.addDatabase')} onClick={() => setModal('add-database')}>
              <Plus size={16} />
            </button>
          )}
          {activity === 'tunnels' && (
            <button
              className="icon-btn"
              title={t('layout.sidebar.newTunnel')}
              onClick={() => openTunnels({ kind: 'create' })}
            >
              <Network size={15} />
            </button>
          )}
          {/* Monitoring only. A monitor group is a Monitoring layout, and the
              two rails share one ActivityView — so gating on `activity` alone
              put "New monitor group" in the header of the Operations pane,
              where it makes nothing a person on that rail could want. */}
          {activity === 'monitor' && fleetRail === 'monitor' && (
            <button
              className="icon-btn"
              title={t('layout.sidebar.newMonitorGroup')}
              onClick={() => addMonitorGroup(t('layout.sidebar.newMonitorGroupName'))}
            >
              <FolderPlus size={15} />
            </button>
          )}
          {activity === 'vault' && vaultUnlocked && (
            <button className="icon-btn" title={t('layout.sidebar.newEntry')} onClick={() => void addVaultEntry()}>
              <Plus size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="sidebar-scroll">
        {activity === 'connections' && <ConnectionTree />}
        {activity === 'databases' && <DatabaseSidebar />}
        {activity === 'http' && <HttpSidebar />}
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
