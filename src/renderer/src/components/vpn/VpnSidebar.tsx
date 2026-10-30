import { Globe, Share2 } from 'lucide-react'
import { useApp, useWorkspaceVpns } from '../../store/app'
import { clsx } from '../../lib/format'
import type { VpnProfile, VpnStatus } from '../../types'
import { HealthDot, frpSummary, handshakeLabel, vpnHealth } from './VpnStatusCard'
import { t as tr, useT } from '../../lib/i18n'

const KIND_TAG: Record<VpnProfile['spec']['kind'], string> = {
  wireguard: 'wg',
  openvpn: 'ovpn',
  frp: 'frp',
  tailscale: 'ts',
  ngrok: 'ngrok'
}

// The one-line summary behind a row's tooltip. For WireGuard the handshake age
// is the thing worth surfacing: the dot is already amber, and this says why.
function hover(profile: VpnProfile, status: VpnStatus | undefined): string {
  const spec = profile.spec
  if (spec.kind === 'frp') {
    return frpSummary(spec)
  }
  if (spec.kind === 'wireguard') {
    const peer = spec.peers[0]?.endpoint ?? tr('vpn.sidebar.noPeer')
    return `${peer} · ${handshakeLabel(status?.stats?.lastHandshakeSec)}`
  }
  if (spec.kind === 'ngrok') {
    const first = spec.tunnels[0]
    return first ? tr('vpn.sidebar.publishesPort', { port: first.localPort }) : tr('vpn.sidebar.noEndpoints')
  }
  if (spec.kind === 'tailscale') {
    // A mesh has no single endpoint to name, and the daemon is not ours.
    return tr('vpn.sidebar.tailscaleAttached')
  }
  const r = spec.remotes?.[0]
  return r ? `${r.host}:${r.port} ${r.proto}` : 'OpenVPN'
}

export function VpnSidebar(): React.JSX.Element {
  const t = useT()
  const profiles = useWorkspaceVpns()
  const vpnStatuses = useApp((s) => s.vpnStatuses)
  // See TunnelSidebar: a marker, not a control. The tabs above the content do
  // the navigating.
  const tab = useApp((s) => s.tunnelsTab)

  const vpns = profiles.filter((p) => p.spec.kind !== 'frp')
  const frps = profiles.filter((p) => p.spec.kind === 'frp')

  const rows = (list: VpnProfile[]): React.JSX.Element[] =>
    list.map((p) => {
      const status = vpnStatuses[p.id]
      return (
        <div key={p.id} className="tree-row" title={hover(p, status)}>
          <HealthDot health={vpnHealth(status)} />
          <span className="label">{p.name}</span>
          <span className="spacer" />
          <span className="faint" style={{ fontSize: 'var(--fs-xs)', textTransform: 'uppercase' }}>
            {KIND_TAG[p.spec.kind]}
          </span>
        </div>
      )
    })

  return (
    <>
      <div className="tree-section">
        <div className={clsx('tree-section-label', tab === 'vpn' && 'active')}>
          <Globe size={11} /> {t('vpn.sidebar.vpn')} <span className="count">{vpns.length}</span>
        </div>
        {rows(vpns)}
      </div>
      <div className="tree-section">
        <div className={clsx('tree-section-label', tab === 'frp' && 'active')}>
          <Share2 size={11} /> {t('vpn.sidebar.reverseProxies')} <span className="count">{frps.length}</span>
        </div>
        {rows(frps)}
      </div>
    </>
  )
}
