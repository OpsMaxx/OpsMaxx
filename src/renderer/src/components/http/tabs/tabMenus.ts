import type { ApiRequest, HttpTabState, Id, Item } from '../../../../../shared/apiModel'
import type { MenuEntry } from '../../connections/ContextMenu'
import { useHttp } from '../../../store/http'
import { useApi } from '../../../store/api'
import { useApp } from '../../../store/app'
import { toast } from '../../../store/toast'
import { keyLabel } from '../hotkeys'
import { requestClose } from './closing'

/** The last non-empty path segment of a URL template, for a scratch tab's title. */
export function lastSegment(url: string): string {
  const path = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').split(/[?#]/)[0]
  const seg = path.split('/').filter(Boolean).at(-1)
  return seg ? `/${seg}` : '/'
}

/** What a tab is called in the strip (§2.9). The protocol badge is separate. */
export function tabTitle(tab: HttpTabState, req: ApiRequest | null): string {
  if (tab.kind === 'environments') return 'Environments'
  if (tab.kind === 'collection') {
    return useApi.getState().collections.find((c) => c.id === tab.ref?.collectionId)?.name ?? 'Collection'
  }
  if (!req) return 'Request'
  if (tab.ref) return req.name
  // A scratch tab has no name of its own: its last path segment beside the
  // method badge ("GET" + "/users"), or its protocol's default name.
  return req.url.trim() ? lastSegment(req.url) : req.name
}

/** The protocol badge text: the method for REST, WS and GQL otherwise (§2.2). */
export function badgeFor(req: ApiRequest | null): { text: string; className: string } | null {
  if (!req) return null
  if (req.kind === 'ws') return { text: 'WS', className: 'hc-m-other' }
  if (req.kind === 'graphql') return { text: 'GQL', className: 'hc-m-other' }
  const m = req.method.toUpperCase()
  const known = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m)
  return { text: m, className: `hc-m-${known ? m.toLowerCase() : 'other'}` }
}

/** The request-tab context menu (§2.6). */
export function tabMenuEntries(tabId: Id, opts: { onRename: () => void }): MenuEntry[] {
  const http = useHttp.getState()
  const ws = useApp.getState().activeWorkspaceId
  const strip = http.tabs.filter((t) => t.workspaceId === ws)
  const at = strip.findIndex((t) => t.id === tabId)
  const tab = strip[at]
  if (!tab) return []
  const saved = !!tab.ref?.requestId
  const dirty = http.isDirty(tabId)
  const isRequest = tab.kind === 'request'
  const others = strip.filter((t) => t.id !== tabId).map((t) => t.id)
  const right = strip.slice(at + 1).map((t) => t.id)
  const clean = strip.filter((t) => t.ref?.requestId && !http.isDirty(t.id)).map((t) => t.id)

  return [
    { label: 'New request', shortcut: keyLabel('new-terminal'), onClick: () => http.openScratch('http') },
    {
      label: 'Duplicate tab',
      shortcut: keyLabel('duplicate-tab'),
      disabled: !isRequest,
      onClick: () => http.duplicateTab(tabId)
    },
    { label: 'Rename…', disabled: !isRequest, onClick: opts.onRename },
    {
      label: 'Reveal in sidebar',
      disabled: !tab.ref,
      onClick: () => revealInSidebar(tab)
    },
    {
      label: 'Save',
      shortcut: keyLabel('http-save'),
      disabled: !isRequest,
      onClick: () => {
        http.activateTab(tabId)
        if (!http.saveInPlace(tabId)) http.setOverlay('save')
      }
    },
    {
      label: 'Revert changes',
      disabled: !saved || !dirty,
      onClick: () => revert(tabId)
    },
    { label: '', separator: true },
    { label: 'Close', shortcut: keyLabel('close-tab'), onClick: () => requestClose([tabId]) },
    { label: 'Close others', disabled: others.length === 0, onClick: () => requestClose(others) },
    { label: 'Close to the right', disabled: right.length === 0, onClick: () => requestClose(right) },
    { label: 'Close saved', disabled: clean.length === 0, onClick: () => requestClose(clean) },
    { label: 'Close all', onClick: () => requestClose(strip.map((t) => t.id)) }
  ]
}

/** Drops a saved tab's edits, with an undo toast that puts them back (§2.6). */
function revert(tabId: Id): void {
  const draft = useHttp.getState().tabs.find((t) => t.id === tabId)?.draft
  if (!draft) return
  useHttp.setState((s) => ({
    tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, draft: undefined, strippedFields: undefined } : t))
  }))
  toast('Changes reverted', 'info', { label: 'Undo', run: () => useHttp.getState().updateDraft(tabId, draft) })
}

/** Expands the tree down to the tab's request, or its collection. */
function revealInSidebar(tab: HttpTabState): void {
  if (!tab.ref) return
  const app = useApp.getState()
  if (app.sidebarCollapsed) app.toggleSidebar()
  const col = useApi.getState().collections.find((c) => c.id === tab.ref!.collectionId)
  const path = col && tab.ref.requestId ? folderPath(col.items, tab.ref.requestId) : []
  useHttp.setState((s) => ({
    sidebarTab: 'collections',
    expanded: [...new Set([...s.expanded, tab.ref!.collectionId, ...(path ?? [])])]
  }))
}

function folderPath(items: Item[], id: Id): Id[] | null {
  for (const item of items) {
    if (item.id === id) return []
    if (item.kind === 'folder') {
      const inner = folderPath(item.items, id)
      if (inner) return [item.id, ...inner]
    }
  }
  return null
}
