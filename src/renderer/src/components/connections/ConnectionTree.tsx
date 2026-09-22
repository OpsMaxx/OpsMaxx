import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  Star,
  Terminal as TerminalIcon,
  Activity,
  FolderTree,
  Copy,
  Pencil,
  Trash2,
  Route,
  Server as ServerIcon,
  Monitor,
  Plug,
  Cloud
} from 'lucide-react'
import { useApp, useWorkspaceFolders, useWorkspaceServers } from '../../store/app'
import { useFleet } from '../../store/fleet'
import { disambiguateServerNames } from '../../../../shared/serverNames'
import { rdpSecretId } from '../../../../shared/rdp'
import { clsx } from '../../lib/format'
import { distroIcon } from '../../lib/distroIcon'
import { cloudTargetSubtitle } from '../../../../shared/cloud'
import { toast } from '../../store/toast'
import { ContextMenu, MenuEntry } from './ContextMenu'
import { Modal } from '../common/Modal'
import type { Server, ServerStatus } from '../../types'

/**
 * What each status dot says, for anyone who cannot tell its colour — the dot's
 * shape carries the same distinction (see `.status-dot` in global.css).
 */
const STATUS_LABEL: Record<ServerStatus, string> = {
  online: 'Connected',
  idle: 'Idle',
  offline: 'Not connected',
  connecting: 'Connecting'
}

function StatusDot({ status }: { status: ServerStatus }): React.JSX.Element {
  const label = STATUS_LABEL[status]
  return <span className={clsx('status-dot', status)} role="img" aria-label={label} title={label} />
}

/** How many tags a row shows before it says "+N". The row is 28px tall and
 *  the name is the thing being scanned for, so the chips stay a hint. */
const ROW_TAGS = 2

interface Ctx {
  x: number
  y: number
  server: Server
}

/**
 * The shells on this machine, at the top of the connection list.
 *
 * A local terminal could already be opened three ways — the tab bar's caret
 * menu, the palette, and Ctrl+Shift+T — and a user looking at a list of things
 * to connect to found none of them, because the list was the one place that
 * never mentioned this machine.
 *
 * This is a SECOND mount-time caller of `refreshLocalShells`, which the shell
 * menu's header used to claim sole ownership of. That is fine and deliberate:
 * the call is idempotent and answered from main's cache unless `refresh` is
 * passed, and two independent surfaces both needing the list is a better reason
 * to call it twice than to make one of them depend on the other being mounted.
 * The sidebar is mounted earlier and more often than the tab bar, so in practice
 * this is now what populates the list the palette and the hotkey read.
 */
function LocalMachineSection({ query }: { query: string }): React.JSX.Element | null {
  const shells = useApp((s) => s.localShells)
  const refreshLocalShells = useApp((s) => s.refreshLocalShells)
  // Focus-or-open, not always-open: a server row in this same tree focuses the
  // tab it already has, and a shell row naming one thing had no business
  // meaning something else. `openLocal` is still what "New local shell" calls.
  const openShell = useApp((s) => s.focusOrOpenLocal)
  // Absence means enabled, matching main's own copy in services/localGate.ts.
  const enabled = useApp((s) => s.settings.localTerminalEnabled !== false)

  useEffect(() => {
    if (!enabled) return
    // refreshLocalShells swallows a missing bridge and resolves to an empty
    // list, which renders as nothing rather than as an error.
    void refreshLocalShells()
  }, [enabled, refreshLocalShells])

  const q = query.trim().toLowerCase()
  // The default shell first, then discovery order — chosen with `isDefault`
  // rather than by matching the id, which is an opaque path digest.
  const ordered = [...shells]
    .sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault))
    .filter((sh) => !q || sh.label.toLowerCase().includes(q))

  // Nothing to show is not an error state here: the section simply is not a
  // section. The shell menu already owns the "no shells found" message.
  if (!enabled || ordered.length === 0) return null

  return (
    <div className="tree-section">
      <div className="tree-section-label">
        <Monitor size={11} /> This machine
      </div>
      {ordered.map((sh) => (
        // role/tabIndex/onKeyDown because `.tree-row` is a div with an onClick
        // and nothing else. Buttons rather than rows of the tree below: these
        // are a flat list of actions with no folders to walk.
        <div
          key={sh.id}
          className="tree-row"
          role="button"
          tabIndex={0}
          title={sh.path}
          onClick={() => openShell(sh)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return
            e.preventDefault()
            openShell(sh)
          }}
        >
          <TerminalIcon size={12} />
          <span className="label">{sh.label}</span>
        </div>
      ))}
    </div>
  )
}

export function ConnectionTree(): React.JSX.Element {
  const folders = useWorkspaceFolders()
  const servers = useWorkspaceServers()
  // Two servers with the same name render identically here and everywhere the
  // sidebar sends you. The suffix is added ONLY where a name actually collides,
  // so an estate of unique names is untouched — see shared/serverNames.ts.
  const labels = useMemo(() => disambiguateServerNames(servers), [servers])
  const openServer = useApp((s) => s.openServer)
  const newSession = useApp((s) => s.newSession)
  const openRdp = useApp((s) => s.openRdp)
  const toggleFavorite = useApp((s) => s.toggleFavorite)
  const openRouteEditor = useApp((s) => s.openRouteEditor)
  const openServerEditor = useApp((s) => s.openServerEditor)
  const addServer = useApp((s) => s.addServer)
  const deleteServer = useApp((s) => s.deleteServer)
  const addFolder = useApp((s) => s.addFolder)
  const renameFolder = useApp((s) => s.renameFolder)
  const deleteFolder = useApp((s) => s.deleteFolder)
  const moveServerToFolder = useApp((s) => s.moveServerToFolder)
  const activeTab = useApp((s) => s.activeTab())
  // The distribution each host reported, from the hourly facts sweep. Absent
  // until that has run, and then the row simply has no icon.
  const fleetFacts = useFleet((s) => s.facts)

  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [ctx, setCtx] = useState<Ctx | null>(null)
  const [folderCtx, setFolderCtx] = useState<{ x: number; y: number; id: string } | null>(null)
  /**
   * The server waiting to be deleted.
   *
   * Deleting one took a single click of a menu item and removed three things:
   * the server, its credential from the OS keychain, and the desktop password
   * stored under its own id. None of that comes back, and nothing anywhere said
   * so -- the only feedback was a toast reading "<name> deleted", after the
   * fact. Elsewhere in this app removing a container makes you type its name.
   */
  const [pendingDelete, setPendingDelete] = useState<Server | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropFolder, setDropFolder] = useState<string | null>(null)

  /**
   * Keyboard operation, as a WAI-ARIA tree with a roving tabindex.
   *
   * Every row was a div with an onClick and nothing else, so none of this list
   * could be reached without a mouse. Now exactly one row is a tab stop — the
   * one last focused — and the arrow keys move between rows the way they do in
   * any file tree. Rows are found in the DOM rather than from a second copy of
   * the render order below: what is on screen, in the order it is on screen,
   * is the definition of "next", and a parallel list would drift from it.
   *
   * A key is `fav:`, `srv:` or `folder:` plus the id, because a favourite is
   * drawn twice — once in Favorites, once in its folder — and those are two
   * rows to move between.
   */
  const treeRef = useRef<HTMLDivElement>(null)
  const [focusKey, setFocusKey] = useState<string | null>(null)
  useEffect(() => {
    // The tab stop has to exist. First render, and a collapse or search that
    // removed the focused row, both leave none — so fall back to the first.
    const items = [...(treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])]
    if (items.length > 0 && !items.some((el) => el.dataset.key === focusKey)) {
      setFocusKey(items[0].dataset.key ?? null)
    }
    // Everything that decides which rows exist.
  }, [focusKey, query, collapsed, servers, folders])

  const onTreeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const el = e.target as HTMLElement
    // A folder being renamed is an input inside its row, and its arrow keys
    // move a caret, not the tree.
    if (el.getAttribute('role') !== 'treeitem') return
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')]
    const i = items.indexOf(el)
    const level = (it: HTMLElement | undefined): number => Number(it?.getAttribute('aria-level') ?? 0)
    const expanded = el.getAttribute('aria-expanded')
    const folderId = el.dataset.folder
    let next: HTMLElement | undefined
    if (e.key === 'ArrowDown') next = items[i + 1]
    else if (e.key === 'ArrowUp') next = items[i - 1]
    else if (e.key === 'Home') next = items[0]
    else if (e.key === 'End') next = items[items.length - 1]
    else if (e.key === 'ArrowRight') {
      if (expanded === 'false' && folderId) setCollapsed((c) => ({ ...c, [folderId]: false }))
      else if (expanded === 'true' && level(items[i + 1]) > level(el)) next = items[i + 1]
    } else if (e.key === 'ArrowLeft') {
      if (expanded === 'true' && folderId) setCollapsed((c) => ({ ...c, [folderId]: true }))
      else next = items.slice(0, i).reverse().find((it) => level(it) < level(el))
    } else if (e.key === 'Enter') {
      // Exactly what a click does, by being one: `detail` is 0, so a server
      // row opens rather than starting a second session.
      el.click()
    } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      // Through the row's own contextmenu handler, so the keyboard gets the
      // same menu a right-click does, anchored under the row.
      const r = el.getBoundingClientRect()
      el.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 16, clientY: r.bottom })
      )
    } else return
    e.preventDefault()
    next?.focus()
  }

  const folderMenu = (id: string, name: string): MenuEntry[] => [
    { label: 'Rename', icon: <Route size={14} />, onClick: () => setRenaming(id) },
    { label: 'New subfolder', icon: <FolderPlus size={14} />, onClick: () => addFolder('New folder', id) },
    { separator: true, label: '' },
    { label: `Delete "${name}"`, icon: <Trash2 size={14} />, danger: true, onClick: () => deleteFolder(id) }
  ]

  // Called as a function, not rendered as <FolderLabel />: a component defined
  // inside this one is a new type on every render, so React remounted the
  // rename input — and threw away what was typed — whenever anything re-rendered.
  const folderLabel = (id: string, name: string): React.JSX.Element =>
    renaming === id ? (
      <input
        className="input"
        autoFocus
        style={{ height: 22, padding: '0 6px', flex: 1 }}
        defaultValue={name}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            renameFolder(id, (e.target as HTMLInputElement).value.trim() || name)
            setRenaming(null)
          }
          if (e.key === 'Escape') setRenaming(null)
        }}
        onBlur={(e) => {
          renameFolder(id, e.target.value.trim() || name)
          setRenaming(null)
        }}
      />
    ) : (
      <span className="label">{name}</span>
    )

  const q = query.trim().toLowerCase()
  const match = (s: Server): boolean =>
    !q || s.name.toLowerCase().includes(q) || s.host.includes(q) || s.tags.some((t) => t.includes(q))

  const favorites = servers.filter((s) => s.favorite && match(s))
  const rootFolders = folders.filter((f) => f.parentId === null)

  const serversIn = (folderId: string | null): Server[] =>
    servers.filter((s) => s.folderId === folderId && match(s))

  const rootServers = serversIn(null)

  const recent = useMemo(() => servers.slice(0, 3), [servers])

  const entries = (s: Server): MenuEntry[] => [
    { label: 'Connect', icon: <Plug size={14} />, onClick: () => openServer(s.id, 'terminal') },
    { label: 'New session', icon: <TerminalIcon size={14} />, onClick: () => newSession(s.id) },
    { label: 'Open monitor', icon: <Activity size={14} />, onClick: () => openServer(s.id, 'monitor') },
    // Only for a server that has RDP settings. Listed rather than always shown
    // and disabled: on a fleet of Linux hosts a permanently greyed entry is
    // three quarters of this menu's dead weight.
    ...(s.rdp
      ? [
          {
            label: 'Open remote desktop',
            icon: <Monitor size={14} />,
            onClick: () => openRdp(s.id)
          }
        ]
      : []),
    { separator: true, label: '' },
    { label: 'Edit server', icon: <Pencil size={14} />, onClick: () => openServerEditor(s.id) },
    { label: 'Edit jump route', icon: <Route size={14} />, onClick: () => openRouteEditor(s.id) },
    {
      label: s.favorite ? 'Remove favorite' : 'Add favorite',
      icon: <Star size={14} />,
      onClick: () => toggleFavorite(s.id)
    },
    {
      label: 'Duplicate',
      icon: <Copy size={14} />,
      onClick: () => {
        const id = addServer({ ...s, name: `${s.name} copy` })
        // A credential is held in the OS keychain under the server's own id,
        // so the copy starts without one. Saying so here beats an
        // authentication failure later that reads as the original having
        // broken. SSH-agent servers carry no stored credential either way.
        if (s.auth === 'agent') toast(`${s.name} copy added`, 'ok')
        else
          toast(`${s.name} copy was added without a credential.`, 'info', {
            label: 'Add one',
            run: () => openServerEditor(id)
          })
      }
    },
    { separator: true, label: '' },
    {
      label: 'Delete',
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: () => setPendingDelete(s)
    }
  ]

  // A render function for the same reason as `folderLabel`: as a component it
  // remounted on every render, which would drop keyboard focus from the row the
  // moment focusing it re-rendered the tree.
  const serverRow = (s: Server, key: string, level: number): React.JSX.Element => {
    const active = activeTab?.kind === 'ssh' && activeTab.serverId === s.id
    const distro = distroIcon(fleetFacts[s.id]?.facts?.distroId)
    return (
      <div
        key={key}
        role="treeitem"
        aria-level={level}
        aria-selected={active}
        data-key={key}
        tabIndex={focusKey === key ? 0 : -1}
        className={clsx('tree-row', active && 'active')}
        style={level > 1 ? undefined : { paddingLeft: 8 }}
        draggable
        onDragStart={() => setDragId(s.id)}
        onDragEnd={() => setDragId(null)}
        // Handled on mousedown via the click counter: the click handler swaps
        // the active tab, which re-renders this row, and a dblclick event that
        // lands on a replaced node never fires.
        onMouseDown={(e) => {
          if (e.detail >= 2) {
            e.preventDefault()
            newSession(s.id)
          }
        }}
        onClick={(e) => {
          if (e.detail >= 2) return
          openServer(s.id)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setCtx({ x: e.clientX, y: e.clientY, server: s })
        }}
        // A cloud server has no address to describe itself with: `host` is empty
        // by construction, so the ordinary user@host:port tooltip would read
        // "@:22". What identifies it is the provider and where the machine sits.
        title={`${
          s.cloud ? cloudTargetSubtitle(s.cloud) : `${s.username}@${s.host}:${s.port}`
        } — double-click for a new session`}
      >
        <StatusDot status={s.status} />
        {distro && (
          <span className="distro faint" role="img" aria-label={distro.label} title={distro.label}>
            <distro.Icon size={12} aria-hidden />
          </span>
        )}
        <span className="label">{labels.get(s.id) ?? s.name}</span>
        {s.cloud && <Cloud size={12} className="faint" />}
        {s.route.length > 0 && <Route size={12} className="faint" />}
        {s.tags.slice(0, ROW_TAGS).map((t) => (
          <span key={t} className="chip" title={t}>
            {t}
          </span>
        ))}
        {s.tags.length > ROW_TAGS && (
          <span className="chip" title={s.tags.slice(ROW_TAGS).join(', ')}>
            +{s.tags.length - ROW_TAGS}
          </span>
        )}
        <span className="spacer" />
        {s.favorite && <Star size={12} className="fav" fill="currentColor" />}
      </div>
    )
  }

  return (
    <>
      <div className="sidebar-search">
        <input
          className="input"
          style={{ height: 30, width: '100%' }}
          placeholder="Search connections…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {/* Above Favorites: this machine is the one target that is always there,
          needs no credential and cannot fail to resolve. */}
      <LocalMachineSection query={query} />

      {/* Three trees — Favorites, Connections, Recent — under ONE keyboard
          handler, so the arrows walk straight from one list into the next. The
          section headers sit between them rather than inside: a tree may hold
          only its rows, and the Connections header is a drop target with a
          button in it. */}
      <div
        ref={treeRef}
        onKeyDown={onTreeKeyDown}
        onFocus={(e) => {
          const key = (e.target as HTMLElement).dataset.key
          if (key) setFocusKey(key)
        }}
      >
        {favorites.length > 0 && (
          <div className="tree-section">
            <div className="tree-section-label">
              <Star size={11} /> Favorites
            </div>
            <div role="tree" aria-label="Favorites">
              {favorites.map((s) => serverRow(s, `fav:${s.id}`, 1))}
            </div>
          </div>
        )}

        <div className="tree-section">
          <div
            className={clsx('tree-section-label', dropFolder === '__root__' && 'dragover')}
            onDragOver={(e) => {
              if (dragId) {
                e.preventDefault()
                setDropFolder('__root__')
              }
            }}
            onDragLeave={() => setDropFolder(null)}
            onDrop={() => {
              if (dragId) moveServerToFolder(dragId, null)
              setDropFolder(null)
              setDragId(null)
            }}
          >
            <FolderTree size={11} /> Connections <span className="count">{servers.length}</span>
            <button
              className="icon-btn xs"
              title="New folder"
              onClick={(e) => {
                e.stopPropagation()
                setRenaming(addFolder('New folder', null))
              }}
            >
              <FolderPlus size={13} />
            </button>
          </div>

          {(rootFolders.length > 0 || rootServers.length > 0) && (
            <div role="tree" aria-label="Connections">
              {rootFolders.map((f) => {
                const open = !collapsed[f.id]
                const childFolders = folders.filter((cf) => cf.parentId === f.id)
                const direct = serversIn(f.id)
                return (
                  <div key={f.id}>
                    <div
                      role="treeitem"
                      aria-level={1}
                      aria-expanded={open}
                      data-key={`folder:${f.id}`}
                      data-folder={f.id}
                      tabIndex={focusKey === `folder:${f.id}` ? 0 : -1}
                      className={clsx('tree-row', dropFolder === f.id && 'dragover')}
                      onClick={() => renaming !== f.id && setCollapsed((c) => ({ ...c, [f.id]: !c[f.id] }))}
                      onDoubleClick={() => setRenaming(f.id)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        setFolderCtx({ x: e.clientX, y: e.clientY, id: f.id })
                      }}
                      onDragOver={(e) => {
                        if (dragId) {
                          e.preventDefault()
                          setDropFolder(f.id)
                        }
                      }}
                      onDragLeave={() => setDropFolder(null)}
                      onDrop={() => {
                        if (dragId) {
                          moveServerToFolder(dragId, f.id)
                          toast(`Moved to ${f.name}`)
                        }
                        setDropFolder(null)
                        setDragId(null)
                      }}
                    >
                      <ChevronRight size={14} className={clsx('chev', open && 'open')} />
                      {open ? (
                        <FolderOpen size={15} className="folder-icon" />
                      ) : (
                        <Folder size={15} className="folder-icon" />
                      )}
                      {folderLabel(f.id, f.name)}
                      <span className="spacer" />
                      <span className="faint" style={{ fontSize: 11 }}>
                        {direct.length + childFolders.reduce((n, c) => n + serversIn(c.id).length, 0)}
                      </span>
                    </div>
                    {open && (
                      <div className="tree-children" role="group">
                        {childFolders.map((cf) => {
                          const copen = !collapsed[cf.id]
                          return (
                            <div key={cf.id}>
                              <div
                                role="treeitem"
                                aria-level={2}
                                aria-expanded={copen}
                                data-key={`folder:${cf.id}`}
                                data-folder={cf.id}
                                tabIndex={focusKey === `folder:${cf.id}` ? 0 : -1}
                                className={clsx('tree-row', dropFolder === cf.id && 'dragover')}
                                onClick={() => renaming !== cf.id && setCollapsed((c) => ({ ...c, [cf.id]: !c[cf.id] }))}
                                onDoubleClick={() => setRenaming(cf.id)}
                                onContextMenu={(e) => {
                                  e.preventDefault()
                                  setFolderCtx({ x: e.clientX, y: e.clientY, id: cf.id })
                                }}
                                onDragOver={(e) => {
                                  if (dragId) {
                                    e.preventDefault()
                                    setDropFolder(cf.id)
                                  }
                                }}
                                onDragLeave={() => setDropFolder(null)}
                                onDrop={() => {
                                  if (dragId) {
                                    moveServerToFolder(dragId, cf.id)
                                    toast(`Moved to ${cf.name}`)
                                  }
                                  setDropFolder(null)
                                  setDragId(null)
                                }}
                              >
                                <ChevronRight size={14} className={clsx('chev', copen && 'open')} />
                                {copen ? (
                                  <FolderOpen size={15} className="folder-icon" />
                                ) : (
                                  <Folder size={15} className="folder-icon" />
                                )}
                                {folderLabel(cf.id, cf.name)}
                              </div>
                              {copen && (
                                <div className="tree-children" role="group">
                                  {serversIn(cf.id).map((s) => serverRow(s, `srv:${s.id}`, 3))}
                                </div>
                              )}
                            </div>
                          )
                        })}
                        {direct.map((s) => serverRow(s, `srv:${s.id}`, 2))}
                      </div>
                    )}
                  </div>
                )
              })}

              {rootServers.map((s) => serverRow(s, `srv:${s.id}`, 1))}
            </div>
          )}
        </div>

        <div className="tree-section">
          <div className="tree-section-label">
            <ServerIcon size={11} /> Recent
          </div>
          {recent.length > 0 && (
            <div role="tree" aria-label="Recent">
              {recent.map((s) => {
                const key = `recent:${s.id}`
                return (
                  <div
                    key={key}
                    role="treeitem"
                    aria-level={1}
                    data-key={key}
                    tabIndex={focusKey === key ? 0 : -1}
                    className="tree-row"
                    onClick={() => openServer(s.id)}
                    // The same menu as the server's row in the tree, which is
                    // also what Shift+F10 on this row opens.
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setCtx({ x: e.clientX, y: e.clientY, server: s })
                    }}
                  >
                    <StatusDot status={s.status} />
                    <span className="label">{labels.get(s.id) ?? s.name}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {ctx && (
        <ContextMenu x={ctx.x} y={ctx.y} entries={entries(ctx.server)} onClose={() => setCtx(null)} />
      )}
      {folderCtx && (
        <ContextMenu
          x={folderCtx.x}
          y={folderCtx.y}
          entries={folderMenu(folderCtx.id, folders.find((f) => f.id === folderCtx.id)?.name ?? '')}
          onClose={() => setFolderCtx(null)}
        />
      )}
      {pendingDelete && (
        <Modal
          title={`Delete ${pendingDelete.name}?`}
          onClose={() => setPendingDelete(null)}
          confirm={{
            label: 'Delete',
            destructive: true,
            onClick: () => {
              const s = pendingDelete
              setPendingDelete(null)
              deleteServer(s.id)
              void window.opsmaxx?.secrets.delete(s.id)
              // The desktop's password lives under its own id, so deleting the
              // server's alone would leave it behind in the OS keychain — a
              // credential for a machine the app no longer knows about.
              void window.opsmaxx?.secrets.delete(rdpSecretId(s.id))
              toast(`${s.name} deleted`)
            }
          }}
        >
          {/* Naming what else goes, because that is the part nobody expects:
              the entry disappearing from a list reads as reversible, and the
              credential it takes with it is not. */}
          <p className="s-desc">
            This removes the connection and its saved credential from the OS credential store,
            including any saved desktop password. Neither can be recovered from OpsMaxx
            afterwards.
          </p>
          <p className="s-desc">
            Nothing on {pendingDelete.host || 'the server'} itself is touched — no key is revoked
            and no session is ended.
          </p>
        </Modal>
      )}
    </>
  )
}
