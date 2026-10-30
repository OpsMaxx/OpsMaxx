import { Network } from 'lucide-react'
import { useApp, useWorkspaceTunnels } from '../../store/app'
import { clsx } from '../../lib/format'
import { useT } from '../../lib/i18n'

export function TunnelSidebar(): React.JSX.Element {
  const t = useT()
  const tunnels = useWorkspaceTunnels()
  // The tabs in the main pane are the navigation; this only marks which of the
  // three sections is the one on screen, so the sidebar is not silently
  // describing a list the user cannot currently see.
  const current = useApp((s) => s.tunnelsTab) === 'tunnels'
  return (
    <div className="tree-section">
      <div className={clsx('tree-section-label', current && 'active')}>
        <Network size={11} /> {t('tunnels.tab.tunnels')} <span className="count">{tunnels.length}</span>
      </div>
      {tunnels.map((tn) => (
        <div key={tn.id} className="tree-row" title={`${tn.listen} → ${tn.target}`}>
          <span className={clsx('status-dot', tn.status === 'active' ? 'online' : 'offline')} />
          <span className="label">{tn.name}</span>
          <span className="spacer" />
          <span className="faint" style={{ fontSize: 'var(--fs-xs)', textTransform: 'uppercase' }}>
            {tn.kind}
          </span>
        </div>
      ))}
    </div>
  )
}
