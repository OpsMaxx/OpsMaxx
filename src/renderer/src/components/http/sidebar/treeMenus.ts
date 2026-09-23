import {
  defaults,
  newId,
  type ApiCollectionV2,
  type ApiRequest,
  type Id,
  type Item,
  type RequestKind,
  routeKeyOf,
  type Route,
  type SentView
} from '../../../../../shared/apiModel'
import { toCurl } from '../../../../../shared/curl'
import type { HistoryEntry } from '../../../../../shared/httpHistory'
import type { MenuEntry } from '../../connections/ContextMenu'
import { isMac } from '../../../lib/shortcuts'
import { toast } from '../../../store/toast'
import { useApi } from '../../../store/api'
import { useHttp } from '../../../store/http'
import { copyAsCurl as copyTabAsCurl } from '../../../lib/httpSend'
import { collectionRoute, routeLabel } from '../collection/RouteSelect'

// The §2.6 menus for the sidebar's rows, as data. The tree and the history
// list attach behaviour through `TreeActions`; the items and their order live
// here, so the menus can be checked item by item.

/** Shortcut text for this platform. */
export const keys = (): { dup: string; del: string; newTab: string; curl: string } =>
  isMac()
    ? { dup: '⌘D', del: '⌘⌫', newTab: '⌘Enter', curl: '⇧⌘C' }
    : { dup: 'Ctrl+D', del: 'Del', newTab: 'Ctrl+Enter', curl: 'Ctrl+Shift+C' }

export interface TreeActions {
  newRequest: (colId: Id, parentId: Id | null, kind: RequestKind) => void
  newFolder: (colId: Id, parentId: Id | null) => void
  openSettings: (colId: Id) => void
  rename: (id: Id) => void
  duplicate: (colId: Id, id: Id) => void
  reimport: (colId: Id) => void
  remove: (colId: Id, id: Id) => void
  open: (colId: Id, reqId: Id, preview: boolean) => void
  moveTo: (colId: Id, id: Id) => void
}

const SEP: MenuEntry = { separator: true, label: '' }

const newItems = (a: TreeActions, colId: Id, parentId: Id | null): MenuEntry[] => [
  { label: 'New HTTP request', onClick: () => a.newRequest(colId, parentId, 'http') },
  { label: 'New WebSocket', onClick: () => a.newRequest(colId, parentId, 'ws') },
  { label: 'New GraphQL request', onClick: () => a.newRequest(colId, parentId, 'graphql') },
  { label: 'New folder', onClick: () => a.newFolder(colId, parentId) }
]

export function collectionMenu(c: ApiCollectionV2, a: TreeActions): MenuEntry[] {
  const k = keys()
  return [
    ...newItems(a, c.id, null),
    SEP,
    { label: 'Open collection settings', onClick: () => a.openSettings(c.id) },
    { label: 'Rename', shortcut: 'F2', onClick: () => a.rename(c.id) },
    { label: 'Duplicate', shortcut: k.dup, onClick: () => a.duplicate(c.id, c.id) },
    ...(c.importedFrom ? [{ label: 'Re-import from OpenAPI…', onClick: () => a.reimport(c.id) }] : []),
    SEP,
    { label: 'Delete collection…', shortcut: k.del, danger: true, onClick: () => a.remove(c.id, c.id) }
  ]
}

export function folderMenu(colId: Id, folderId: Id, a: TreeActions): MenuEntry[] {
  const k = keys()
  return [
    ...newItems(a, colId, folderId),
    SEP,
    { label: 'Rename', shortcut: 'F2', onClick: () => a.rename(folderId) },
    { label: 'Duplicate', shortcut: k.dup, onClick: () => a.duplicate(colId, folderId) },
    SEP,
    { label: 'Delete folder', shortcut: k.del, danger: true, onClick: () => a.remove(colId, folderId) }
  ]
}

export function requestMenu(colId: Id, req: ApiRequest, a: TreeActions): MenuEntry[] {
  const k = keys()
  return [
    { label: 'Open', shortcut: 'Enter', onClick: () => a.open(colId, req.id, true) },
    { label: 'Open in new tab', shortcut: k.newTab, onClick: () => a.open(colId, req.id, false) },
    SEP,
    { label: 'Rename', shortcut: 'F2', onClick: () => a.rename(req.id) },
    { label: 'Duplicate', shortcut: k.dup, onClick: () => a.duplicate(colId, req.id) },
    { label: 'Move to…', onClick: () => a.moveTo(colId, req.id) },
    SEP,
    ...copyItems(req, { collectionId: colId }),
    SEP,
    { label: 'Delete', shortcut: k.del, danger: true, onClick: () => a.remove(colId, req.id) }
  ]
}

export interface HistoryActions {
  sendAgain: (e: HistoryEntry) => void
  openRequest: (e: HistoryEntry) => void
  openAsNew: (e: HistoryEntry) => void
  saveToCollection: (e: HistoryEntry) => void
  remove: (e: HistoryEntry) => void
}

/** Whether the saved request a history entry came from still exists. */
export function historySourceExists(e: HistoryEntry): boolean {
  return !!e.requestRef && useApi.getState().findRequest(e.requestRef.collectionId, e.requestRef.requestId) !== null
}

export function historyMenu(e: HistoryEntry, a: HistoryActions): MenuEntry[] {
  return [
    { label: 'Send again', onClick: () => a.sendAgain(e) },
    ...(historySourceExists(e) ? [{ label: 'Open request', onClick: () => a.openRequest(e) }] : []),
    { label: 'Open as new request', onClick: () => a.openAsNew(e) },
    { label: 'Save to collection…', onClick: () => a.saveToCollection(e) },
    ...copyItems(e.request, { route: e.route }),
    SEP,
    { label: 'Delete entry', danger: true, onClick: () => a.remove(e) }
  ]
}

function copyItems(req: ApiRequest, from: CurlSource): MenuEntry[] {
  return [
    {
      label: 'Copy as cURL',
      shortcut: keys().curl,
      disabled: req.kind === 'ws',
      onClick: () => void copyAsCurl(req, from)
    },
    { label: 'Copy URL', onClick: () => copyText(req.url) }
  ]
}

export function copyText(text: string): void {
  window.opsmaxx?.clipboard?.write(text)
}

/** Where a copied request would be sent from: its collection, or a history entry's route. */
export interface CurlSource {
  collectionId?: Id
  route?: Route
}

/**
 * Copy a request as cURL, masked, the way Send would send it. A request that
 * is open in a tab goes through the send layer's own copy (auth, variables and
 * route exactly as Send builds them). Otherwise the saved template is copied
 * with its collection's route and certificate settings, so `-k` and the
 * custom-CA note follow the collection; `{{vars}}` stay as written.
 */
export async function copyAsCurl(req: ApiRequest, from: CurlSource = {}): Promise<void> {
  if (req.kind === 'ws') return
  const open = from.collectionId
    ? useHttp.getState().tabs.find((t) => t.ref?.collectionId === from.collectionId && t.ref?.requestId === req.id)
    : undefined
  if (open) {
    await copyTabAsCurl(open.id, { secrets: 'mask' })
    return
  }
  const c = from.collectionId ? useApi.getState().collections.find((x) => x.id === from.collectionId) : undefined
  const route = from.route ?? (c ? collectionRoute(c) : { kind: 'direct' as const })
  const sent: SentView = {
    method: req.kind === 'http' ? req.method : 'POST',
    url: req.url,
    headers: req.headers.filter((h) => h.enabled && h.key).map((h) => [h.key, h.value]),
    route: { key: routeKeyOf(route), label: routeLabel(route) },
    tls: c?.insecureTls ? 'unverified' : c?.caPem ? 'custom-ca' : 'verified',
    // -L only when the request follows redirects at all.
    maxRedirects: req.kind === 'http' ? (req.settings.followRedirects ? req.settings.maxRedirects : 0) : 5,
    timeoutMs: req.settings.timeoutMs ?? c?.timeoutMs ?? 30_000,
    bodyBytes: 0
  }
  try {
    const { text, notes } = toCurl(req, sent, { secrets: 'mask' })
    copyText(text)
    toast(['Copied as cURL (secrets masked).', ...notes].join(' '), 'ok')
  } catch {
    toast('Could not copy this request as cURL.', 'error')
  }
}

/** A new, empty request of this kind. */
export function newRequest(kind: RequestKind): ApiRequest {
  return defaults[kind]()
}

/** A deep copy with fresh ids, for duplicating a subtree. */
export function withFreshIds(item: Item): Item {
  return item.kind === 'folder'
    ? { ...item, id: newId('fld'), items: item.items.map(withFreshIds) }
    : { ...item, id: newId('req') }
}

/** Requests in a subtree, for counts. */
export function countRequests(items: Item[]): number {
  return items.reduce((n, i) => n + (i.kind === 'folder' ? countRequests(i.items) : 1), 0)
}
