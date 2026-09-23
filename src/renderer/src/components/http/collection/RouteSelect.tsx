import type { ApiCollectionV2, Id, Route } from '../../../../../shared/apiModel'
import { useApp } from '../../../store/app'

/** A collection's route, from the fields it is stored in. */
export function collectionRoute(c: Pick<ApiCollectionV2, 'viaServerId' | 'vpnProfileId'>): Route {
  if (c.vpnProfileId) return { kind: 'vpn', vpnProfileId: c.vpnProfileId }
  if (c.viaServerId) return { kind: 'server', serverId: c.viaServerId }
  return { kind: 'direct' }
}

/** The collection fields that store a route. */
export function routeFields(route: Route): Pick<ApiCollectionV2, 'viaServerId' | 'vpnProfileId'> {
  return {
    viaServerId: route.kind === 'server' ? route.serverId : null,
    vpnProfileId: route.kind === 'vpn' ? route.vpnProfileId : null
  }
}

/** "This machine", a server's name, a VPN profile's name, or that it is gone. */
export function routeLabel(route: Route): string {
  const { servers, vpns } = useApp.getState()
  if (route.kind === 'direct') return 'This machine'
  if (route.kind === 'server') return servers.find((s) => s.id === route.serverId)?.name ?? 'a removed server'
  return vpns.find((v) => v.id === route.vpnProfileId)?.name ?? 'a removed VPN profile'
}

const encode = (r: Route): string =>
  r.kind === 'direct' ? 'direct' : r.kind === 'server' ? `server:${r.serverId}` : `vpn:${r.vpnProfileId}`

function decode(v: string): Route {
  if (v.startsWith('server:')) return { kind: 'server', serverId: v.slice(7) as Id }
  if (v.startsWith('vpn:')) return { kind: 'vpn', vpnProfileId: v.slice(4) as Id }
  return { kind: 'direct' }
}

/** Send from: This machine, a saved server, or a VPN profile, in this workspace. */
export function RouteSelect({
  value,
  onChange,
  ariaLabel = 'Send from'
}: {
  value: Route
  onChange: (route: Route) => void
  ariaLabel?: string
}): React.JSX.Element {
  const ws = useApp((s) => s.activeWorkspaceId)
  const servers = useApp((s) => s.servers).filter((s) => s.workspaceId === ws)
  const vpns = useApp((s) => s.vpns).filter((v) => v.workspaceId === ws)
  const current = encode(value)
  const known = current === 'direct' || [...servers.map((s) => `server:${s.id}`), ...vpns.map((v) => `vpn:${v.id}`)].includes(current)
  return (
    <select className="hc-input" aria-label={ariaLabel} value={current} onChange={(e) => onChange(decode(e.target.value))}>
      <option value="direct">This machine</option>
      {servers.length > 0 && (
        <optgroup label="Servers">
          {servers.map((s) => (
            <option key={s.id} value={`server:${s.id}`}>
              {s.name}
            </option>
          ))}
        </optgroup>
      )}
      {vpns.length > 0 && (
        <optgroup label="VPN profiles">
          {vpns.map((v) => (
            <option key={v.id} value={`vpn:${v.id}`}>
              {v.name}
            </option>
          ))}
        </optgroup>
      )}
      {!known && <option value={current}>{routeLabel(value)} (removed)</option>}
    </select>
  )
}
