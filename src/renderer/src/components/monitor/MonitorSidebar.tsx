import { useMemo } from 'react'
import { Activity } from 'lucide-react'
import { useApp, useWorkspaceServers } from '../../store/app'
import { clsx } from '../../lib/format'
import { disambiguateServerNames } from '../../../../shared/serverNames'

export function MonitorSidebar(): React.JSX.Element {
  const servers = useWorkspaceServers()
  const openServer = useApp((s) => s.openServer)
  // Two servers sharing a name render identically, and this list is one of the
  // places a person picks one. The connection tree and the alert inbox were
  // given this; this list was missed. Nothing is added when every name in the
  // workspace is already unique — see shared/serverNames.ts.
  const labels = useMemo(() => disambiguateServerNames(servers), [servers])
  return (
    <div className="tree-section">
      <div className="tree-section-label">
        <Activity size={11} /> Servers <span className="count">{servers.length}</span>
      </div>
      {servers.map((s) => (
        <div key={s.id} className="tree-row" onClick={() => openServer(s.id, 'monitor')}>
          <span className={clsx('status-dot', s.status)} />
          <span className="label">{labels.get(s.id) ?? s.name}</span>
        </div>
      ))}
    </div>
  )
}
