import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { ChevronDown, ChevronRight, Folder, MoreHorizontal, Package } from 'lucide-react'
import {
  newId,
  type ApiCollectionV2,
  type ApiRequest,
  type Id,
  type Item,
  type RequestKind
} from '../../../../../shared/apiModel'
import { useApi } from '../../../store/api'
import { useApp } from '../../../store/app'
import { useHttp } from '../../../store/http'
import { toast } from '../../../store/toast'
import { isMac } from '../../../lib/shortcuts'
import { ContextMenu, type MenuEntry } from '../../connections/ContextMenu'
import { EmptyState } from '../../common/EmptyState'
import { DeleteCollectionDialog } from '../dialogs/DeleteCollectionDialog'
import { MoveToDialog } from '../dialogs/MoveToDialog'
import {
  collectionMenu,
  folderMenu,
  newRequest,
  requestMenu,
  withFreshIds,
  type TreeActions
} from './treeMenus'

export interface TreeRow {
  id: Id
  kind: 'collection' | 'folder' | 'request'
  colId: Id
  name: string
  depth: number
  parent: Id | null
  expandable: boolean
  expanded: boolean
  request?: ApiRequest
  collection?: ApiCollectionV2
}

const matches = (item: Item, q: string): boolean =>
  item.name.toLowerCase().includes(q) || (item.kind !== 'folder' && item.url.toLowerCase().includes(q))

const subtreeMatches = (items: Item[], q: string): boolean =>
  items.some((i) => matches(i, q) || (i.kind === 'folder' && subtreeMatches(i.items, q)))

/**
 * The rows the tree shows, in order. With a filter, a row is shown when it or
 * anything under it matches, and containers with a match inside are opened.
 */
export function visibleRows(collections: ApiCollectionV2[], expanded: ReadonlySet<Id>, query: string): TreeRow[] {
  const q = query.trim().toLowerCase()
  const out: TreeRow[] = []
  const walk = (colId: Id, items: Item[], depth: number, parent: Id): void => {
    for (const item of items) {
      if (q && !matches(item, q) && !(item.kind === 'folder' && subtreeMatches(item.items, q))) continue
      if (item.kind === 'folder') {
        const open = expanded.has(item.id) || (!!q && subtreeMatches(item.items, q))
        out.push({ id: item.id, kind: 'folder', colId, name: item.name, depth, parent, expandable: true, expanded: open })
        if (open) walk(colId, item.items, depth + 1, item.id)
      } else {
        out.push({ id: item.id, kind: 'request', colId, name: item.name, depth, parent, expandable: false, expanded: false, request: item })
      }
    }
  }
  for (const c of collections) {
    const inside = !!q && subtreeMatches(c.items, q)
    if (q && !c.name.toLowerCase().includes(q) && !inside) continue
    const open = expanded.has(c.id) || inside
    out.push({ id: c.id, kind: 'collection', colId: c.id, name: c.name, depth: 0, parent: null, expandable: true, expanded: open, collection: c })
    if (open) walk(c.id, c.items, 1, c.id)
  }
  return out
}

/** Removes a collection; the returned undo puts it back at its index. */
export function deleteCollection(colId: Id): () => void {
  const { collections } = useApi.getState()
  const index = collections.findIndex((c) => c.id === colId)
  if (index < 0) return () => {}
  const c = collections[index]
  useApi.setState({ collections: collections.filter((x) => x.id !== colId) })
  return () =>
    useApi.setState((s) =>
      s.collections.some((x) => x.id === c.id)
        ? s
        : { collections: [...s.collections.slice(0, index), c, ...s.collections.slice(index)] }
    )
}

/** A copy of a collection, with fresh ids throughout, placed after it. */
export function duplicateCollection(colId: Id): Id | null {
  const { collections } = useApi.getState()
  const index = collections.findIndex((c) => c.id === colId)
  if (index < 0) return null
  const c = collections[index]
  const copy: ApiCollectionV2 = {
    ...c,
    id: newId('col'),
    name: `${c.name} copy`,
    items: c.items.map(withFreshIds),
    // A pending certificate review carries over: the copy has the same
    // connection settings, and must not send them unreviewed.
    variables: c.variables.map((v) => ({ ...v, id: newId('var') }))
  }
  useApi.setState({ collections: [...collections.slice(0, index + 1), copy, ...collections.slice(index + 1)] })
  return copy.id
}

const setExpanded = (ids: Id[], open: boolean): void => {
  for (const id of ids) useHttp.getState().setExpanded(id, open)
}

const BADGE: Record<RequestKind, string> = { http: '', ws: 'WS', graphql: 'GQL' }

export function MethodBadge({ request }: { request: Pick<ApiRequest, 'kind'> & { method?: string } }): React.JSX.Element {
  const text = request.kind === 'http' ? (request.method ?? 'GET').toUpperCase() : BADGE[request.kind]
  const known = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(text)
  return <span className={`hc-mbadge hc-mbadge--${known ? text.toLowerCase() : request.kind === 'http' ? 'other' : request.kind}`}>{text}</span>
}

type Menu = { x: number; y: number; entries: MenuEntry[] }

export interface CollectionTreeProps {
  query: string
  renaming: Id | null
  setRenaming: (id: Id | null) => void
  /** Tree-delete undos, newest last. Held by the sidebar so they outlive a tab switch. */
  undo: MutableRefObject<(() => void)[]>
  onNewCollection: () => void
  onImport: (collectionId?: Id) => void
}

/**
 * The collections tree: a `tree` of `treeitem`s with roving focus. Arrows
 * move and open, Enter opens a preview tab, Mod+Enter a pinned one, F2
 * renames, Mod+Backspace or Delete deletes (plain Backspace never does),
 * Mod+Z undoes the last delete, Shift+F10 opens the row menu.
 */
export function CollectionTree(props: CollectionTreeProps): React.JSX.Element {
  const { query, renaming, setRenaming, undo } = props
  const ws = useApp((s) => s.activeWorkspaceId)
  const all = useApi((s) => s.collections)
  const collections = useMemo(() => all.filter((c) => c.workspaceId === ws), [all, ws])
  const expandedList = useHttp((s) => s.expanded)
  const expanded = useMemo(() => new Set(expandedList), [expandedList])
  const activeRef = useHttp((s) => s.tabs.find((t) => t.id === s.activeTab[ws])?.ref)
  const rows = useMemo(() => visibleRows(collections, expanded, query), [collections, expanded, query])

  const [focusId, setFocusId] = useState<Id | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [deleting, setDeleting] = useState<ApiCollectionV2 | null>(null)
  const [moving, setMoving] = useState<{ colId: Id; itemId: Id } | null>(null)
  const nodes = useRef(new Map<Id, HTMLDivElement>())
  const wantFocus = useRef(false)
  const current = rows.find((r) => r.id === focusId) ?? rows[0]

  useEffect(() => {
    if (!wantFocus.current || !focusId) return
    wantFocus.current = false
    nodes.current.get(focusId)?.focus()
  }, [focusId, rows])

  const focusRow = (id: Id | undefined): void => {
    if (!id) return
    wantFocus.current = true
    setFocusId(id)
    if (id === focusId) nodes.current.get(id)?.focus()
  }

  const pushUndo = (fn: () => void, label: string, key: string): void => {
    let done = false
    const once = (): void => {
      if (done) return
      done = true
      undo.current = undo.current.filter((f) => f !== once)
      fn()
    }
    undo.current.push(once)
    toast(`Deleted ${label}`, 'info', { label: 'Undo', run: once }, { key })
  }

  const actions: TreeActions = {
    newRequest: (colId, parentId, kind) => {
      const req = newRequest(kind)
      useApi.getState().addItem(colId, parentId, req)
      setExpanded([colId, ...(parentId ? [parentId] : [])], true)
      useHttp.getState().openRequest({ collectionId: colId, requestId: req.id }, { preview: false })
    },
    newFolder: (colId, parentId) => {
      const id = newId('fld')
      useApi.getState().addItem(colId, parentId, { kind: 'folder', id, name: 'New folder', items: [] })
      setExpanded([colId, ...(parentId ? [parentId] : [])], true)
      setRenaming(id)
    },
    openSettings: (colId) => useHttp.getState().openCollectionTab(colId, 'overview'),
    rename: (id) => setRenaming(id),
    duplicate: (colId, id) => {
      const copy = id === colId ? duplicateCollection(colId) : useApi.getState().duplicateItem(colId, id)
      if (copy) focusRow(copy)
    },
    reimport: (colId) => props.onImport(colId),
    remove: (colId, id) => {
      if (id === colId) {
        const c = collections.find((x) => x.id === colId)
        if (c) setDeleting(c)
        return
      }
      const row = rows.find((r) => r.id === id)
      const at = rows.findIndex((r) => r.id === id)
      const next = rows.slice(at + 1).find((r) => r.depth <= (row?.depth ?? 0)) ?? rows[at - 1]
      pushUndo(useApi.getState().deleteItem(colId, id), row?.name ?? 'item', `http-tree-delete-${id}`)
      focusRow(next?.id)
    },
    open: (colId, reqId, preview) => useHttp.getState().openRequest({ collectionId: colId, requestId: reqId }, { preview }),
    moveTo: (colId, itemId) => setMoving({ colId, itemId })
  }

  const menuFor = (r: TreeRow): MenuEntry[] =>
    r.kind === 'collection'
      ? collectionMenu(r.collection!, actions)
      : r.kind === 'folder'
        ? folderMenu(r.colId, r.id, actions)
        : requestMenu(r.colId, r.request!, actions)

  const toggle = (r: TreeRow): void => setExpanded([r.id], !r.expanded)

  const commitRename = (r: TreeRow, name: string): void => {
    setRenaming(null)
    const n = name.trim()
    if (n && n !== r.name) {
      if (r.kind === 'collection') useApi.getState().updateCollection(r.id, { name: n })
      else useApi.getState().renameItem(r.colId, r.id, n)
    }
    focusRow(r.id)
  }

  const onKeyDown = (e: React.KeyboardEvent, r: TreeRow, i: number): void => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    const mod = isMac() ? e.metaKey : e.ctrlKey
    const k = e.key
    let handled = true
    if (k === 'ArrowDown') focusRow(rows[i + 1]?.id)
    else if (k === 'ArrowUp') focusRow(rows[i - 1]?.id)
    else if (k === 'Home') focusRow(rows[0]?.id)
    else if (k === 'End') focusRow(rows.at(-1)?.id)
    else if (k === 'ArrowRight') {
      if (r.expandable && !r.expanded) toggle(r)
      else if (r.expandable) focusRow(rows[i + 1]?.id)
    } else if (k === 'ArrowLeft') {
      if (r.expandable && r.expanded) toggle(r)
      else focusRow(r.parent ?? undefined)
    } else if (k === 'Enter') {
      if (r.kind === 'request') actions.open(r.colId, r.id, !mod)
      else toggle(r)
    } else if (k === 'F2') setRenaming(r.id)
    else if (k === 'Delete' || (k === 'Backspace' && mod)) actions.remove(r.colId, r.id)
    else if (mod && k.toLowerCase() === 'z' && !e.shiftKey) undo.current.at(-1)?.()
    else if (mod && k.toLowerCase() === 'd') actions.duplicate(r.colId, r.id)
    else if ((k === 'F10' && e.shiftKey) || k === 'ContextMenu') {
      const b = (e.currentTarget as HTMLElement).getBoundingClientRect()
      setMenu({ x: b.left + 16, y: b.bottom, entries: menuFor(r) })
    } else handled = false
    if (handled) e.preventDefault()
  }

  if (collections.length === 0) {
    return (
      <EmptyState
        compact
        title="No collections yet"
        message="Save a request, or import an OpenAPI spec or a cURL command."
        action={
          <div className="hc-empty-actions">
            <button type="button" className="btn primary sm" onClick={props.onNewCollection}>
              New collection
            </button>
            <button type="button" className="btn sm" onClick={() => props.onImport()}>
              Import…
            </button>
          </div>
        }
      />
    )
  }

  return (
    <>
      <div role="tree" aria-label="Collections" className="hc-tree">
        {rows.length === 0 && <p className="hc-tree-empty">Nothing matches “{query}”.</p>}
        {rows.map((r, i) => {
          const selected = r.kind === 'request' ? activeRef?.requestId === r.id : r.kind === 'collection' && activeRef?.collectionId === r.id && !activeRef.requestId
          return (
            <div
              key={r.id}
              ref={(el) => {
                if (el) nodes.current.set(r.id, el)
                else nodes.current.delete(r.id)
              }}
              role="treeitem"
              aria-level={r.depth + 1}
              aria-expanded={r.expandable ? r.expanded : undefined}
              aria-selected={selected}
              tabIndex={r.id === current?.id ? 0 : -1}
              className={`hc-tree-row${selected ? ' is-selected' : ''}`}
              style={{ paddingLeft: 8 + r.depth * 14 }}
              onFocus={(e) => {
                if (e.target === e.currentTarget) setFocusId(r.id)
              }}
              onKeyDown={(e) => onKeyDown(e, r, i)}
              onClick={(e) => {
                setFocusId(r.id)
                if (r.kind !== 'request') return toggle(r)
                actions.open(r.colId, r.id, !(isMac() ? e.metaKey : e.ctrlKey))
              }}
              onDoubleClick={() => r.kind === 'request' && actions.open(r.colId, r.id, false)}
              onAuxClick={(e) => {
                if (e.button === 1 && r.kind === 'request') actions.open(r.colId, r.id, false)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                setFocusId(r.id)
                setMenu({ x: e.clientX, y: e.clientY, entries: menuFor(r) })
              }}
            >
              <span className="hc-tree-chevron" aria-hidden="true">
                {r.expandable && (r.expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
              </span>
              {r.kind === 'collection' && <Package size={13} aria-hidden="true" />}
              {r.kind === 'folder' && <Folder size={13} aria-hidden="true" />}
              {r.request && <MethodBadge request={r.request} />}
              {renaming === r.id ? (
                <input
                  className="hc-tree-rename"
                  aria-label={`Rename ${r.name}`}
                  defaultValue={r.name}
                  autoFocus
                  onFocus={(e) => e.currentTarget.select()}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(r, e.currentTarget.value)
                    else if (e.key === 'Escape') {
                      e.stopPropagation()
                      setRenaming(null)
                      focusRow(r.id)
                    }
                  }}
                  onBlur={(e) => renaming === r.id && commitRename(r, e.currentTarget.value)}
                />
              ) : (
                <span className="hc-tree-name">{r.name}</span>
              )}
              <button
                type="button"
                tabIndex={-1}
                className="hc-icon-btn hc-tree-more"
                aria-label={`Actions for ${r.name}`}
                title="Actions"
                onClick={(e) => {
                  e.stopPropagation()
                  const b = e.currentTarget.getBoundingClientRect()
                  setMenu({ x: b.left, y: b.bottom, entries: menuFor(r) })
                }}
              >
                <MoreHorizontal size={13} aria-hidden="true" />
              </button>
            </div>
          )
        })}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />}
      {deleting && (
        <DeleteCollectionDialog
          collection={deleting}
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            const at = rows.findIndex((r) => r.id === deleting.id)
            const next = rows.slice(at + 1).find((r) => r.depth === 0) ?? rows.slice(0, at).reverse().find((r) => r.depth === 0)
            pushUndo(deleteCollection(deleting.id), deleting.name, `http-tree-delete-${deleting.id}`)
            focusRow(next?.id)
          }}
        />
      )}
      {moving && <MoveToDialog colId={moving.colId} itemId={moving.itemId} onClose={() => setMoving(null)} />}
    </>
  )
}
