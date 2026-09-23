import { useState } from 'react'
import { AlertTriangle, ChevronDown, Home, Server as ServerIcon, ShieldCheck } from 'lucide-react'
import { COLLECTION_GONE_SERVER_ID, type HttpTabState, type Id, type Route } from '../../../../shared/apiModel'
import { ContextMenu, type MenuEntry } from '../connections/ContextMenu'
import { useHttp } from '../../store/http'
import { useApi } from '../../store/api'
import { useApp } from '../../store/app'
import { clsx } from '../../lib/format'

export interface RouteChipProps {
  tabId: Id
  compact: boolean
}

/** A tab by id, whether it is in the strip or is a workspace's ghost. */
export const useTabOrGhost = (tabId: Id): HttpTabState | undefined =>
  useHttp((s) => s.tabs.find((t) => t.id === tabId) ?? Object.values(s.ghost).find((g) => g.id === tabId))

const sameRoute = (a: Route, b: Route): boolean =>
  a.kind === b.kind &&
  (a.kind !== 'server' || a.serverId === (b as typeof a).serverId) &&
  (a.kind !== 'vpn' || a.vpnProfileId === (b as typeof a).vpnProfileId)

/**
 * Where the request is sent from (§2.11). A scratch request owns its route and
 * the chip picks it. A saved request's route is its collection's: the chip
 * names it and its source, and changing it says it changes every request in
 * the collection (UX-M19).
 */
export function RouteChip({ tabId, compact }: RouteChipProps): React.JSX.Element | null {
  const tab = useTabOrGhost(tabId)
  const collections = useApi((s) => s.collections)
  const allServers = useApp((s) => s.servers)
  const allVpns = useApp((s) => s.vpns)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  if (!tab) return null

  const servers = allServers.filter((s) => s.workspaceId === tab.workspaceId)
  const vpns = allVpns.filter((v) => v.workspaceId === tab.workspaceId)
  const collection = tab.ref ? collections.find((c) => c.id === tab.ref!.collectionId) : undefined
  const route = useApi.getState().effectiveRoute(tab)

  const server = route.kind === 'server' ? servers.find((s) => s.id === route.serverId) : undefined
  const vpn = route.kind === 'vpn' ? vpns.find((v) => v.id === route.vpnProfileId) : undefined
  // The collection a saved request belonged to was deleted: there is no route to
  // pick, only somewhere new to save it (store/api's effectiveRoute, §3.4).
  const orphaned = route.kind === 'server' && route.serverId === COLLECTION_GONE_SERVER_ID
  const missing = (route.kind === 'server' && !server) || (route.kind === 'vpn' && !vpn)
  const name = orphaned
    ? 'Collection removed'
    : missing
      ? `${route.kind === 'server' ? 'Server' : 'VPN'} removed`
      : route.kind === 'direct'
        ? 'This machine'
        : (server?.name ?? vpn?.name ?? '')
  const text = collection && !missing ? `${name} · from collection` : name
  const label = `Route: ${text}${orphaned ? '. Requests will not be sent until it is saved to a collection' : missing ? '. Requests will not be sent' : ''}`
  const Icon = missing
    ? AlertTriangle
    : route.kind === 'direct'
      ? Home
      : route.kind === 'server'
        ? ServerIcon
        : ShieldCheck

  const choose = (next: Route): void => {
    if (!collection) return useHttp.getState().setRoute(tabId, next)
    useApi.getState().updateCollection(collection.id, {
      viaServerId: next.kind === 'server' ? next.serverId : null,
      vpnProfileId: next.kind === 'vpn' ? next.vpnProfileId : null
    })
  }
  const option = (next: Route, text: string, section?: string): MenuEntry => ({
    label: text,
    radio: 'route',
    checked: sameRoute(route, next),
    onClick: () => choose(next),
    ...(section ? { section } : {})
  })
  const entries: MenuEntry[] = [
    option(
      { kind: 'direct' },
      'This machine',
      collection ? `Changes it for every request in ${collection.name}` : 'Send from'
    ),
    ...servers.map((s, i) =>
      option({ kind: 'server', serverId: s.id }, s.name, i === 0 ? 'Through a server' : undefined)
    ),
    ...vpns.map((v, i) => option({ kind: 'vpn', vpnProfileId: v.id }, v.name, i === 0 ? 'Through a VPN' : undefined))
  ]

  return (
    <>
      <button
        className={clsx('hc-chip hc-route-chip', missing && 'hc-chip-danger', compact && 'hc-chip-icon')}
        data-hc-route-chip
        aria-label={label}
        title={label}
        aria-haspopup={orphaned ? 'dialog' : 'menu'}
        onClick={(e) => {
          if (orphaned) {
            useHttp.getState().activateTab(tabId)
            useHttp.getState().setOverlay('save')
            return
          }
          const r = e.currentTarget.getBoundingClientRect()
          setMenuAt({ x: r.left, y: r.bottom + 4 })
        }}
      >
        <Icon size={14} aria-hidden />
        {!compact && (
          <>
            <span className="hc-chip-text">{text}</span>
            <ChevronDown size={12} aria-hidden />
          </>
        )}
      </button>
      {menuAt && <ContextMenu x={menuAt.x} y={menuAt.y} entries={entries} onClose={() => setMenuAt(null)} />}
    </>
  )
}
