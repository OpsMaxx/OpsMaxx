import type { ApiCollectionV2, Id, Route } from '../../../../../shared/apiModel'
import { useApp } from '../../../store/app'
import { t as tr, useT } from '../../../lib/i18n'

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
  if (route.kind === 'direct') return tr('http.routeSelect.thisMachine')
  if (route.kind === 'server')
    return servers.find((s) => s.id === route.serverId)?.name ?? tr('http.routeSelect.removedServer')
  return vpns.find((v) => v.id === route.vpnProfileId)?.name ?? tr('http.routeSelect.removedVpn')
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
  ariaLabel
}: {
  value: Route
  onChange: (route: Route) => void
  ariaLabel?: string
}): React.JSX.Element {
  const t = useT()
  const ws = useApp((s) => s.activeWorkspaceId)
  const servers = useApp((s) => s.servers).filter((s) => s.workspaceId === ws)
  const vpns = useApp((s) => s.vpns).filter((v) => v.workspaceId === ws)
  const current = encode(value)
  const known = current === 'direct' || [...servers.map((s) => `server:${s.id}`), ...vpns.map((v) => `vpn:${v.id}`)].includes(current)
  return (
    <select className="hc-input" aria-label={ariaLabel ?? t('http.routeSelect.sendFrom')} value={current} onChange={(e) => onChange(decode(e.target.value))}>
      <option value="direct">{t('http.routeSelect.thisMachine')}</option>
      {servers.length > 0 && (
        <optgroup label={t('http.routeSelect.servers')}>
          {servers.map((s) => (
            <option key={s.id} value={`server:${s.id}`}>
              {s.name}
            </option>
          ))}
        </optgroup>
      )}
      {vpns.length > 0 && (
        <optgroup label={t('http.routeSelect.vpnProfiles')}>
          {vpns.map((v) => (
            <option key={v.id} value={`vpn:${v.id}`}>
              {v.name}
            </option>
          ))}
        </optgroup>
      )}
      {!known && <option value={current}>{t('http.routeSelect.removed', { name: routeLabel(value) })}</option>}
    </select>
  )
}
