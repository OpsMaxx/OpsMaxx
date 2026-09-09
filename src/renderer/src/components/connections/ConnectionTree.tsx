import { useEffect, useMemo, useState } from 'react'
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
  Plug
} from 'lucide-react'
import { useApp, useWorkspaceFolders, useWorkspaceServers } from '../../store/app'
import { disambiguateServerNames } from '../../../../shared/serverNames'
import { rdpSecretId } from '../../../../shared/rdp'
import { clsx } from '../../lib/format'
import { toast } from '../../store/toast'
import { ContextMenu, MenuEntry } from './ContextMenu'
import type { Server } from '../../types'

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
  const openLocal = useApp((s) => s.openLocal)
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
        // and nothing else. The rest of this tree has the same gap, which is
        // worth fixing separately — but shipping a discoverability feature that
        // a keyboard cannot reach would be a strange way to start.
        <div
          key={sh.id}
          className="tree-row"
          role="button"
          tabIndex={0}
          title={sh.path}
          onClick={() => openLocal(sh)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return
            e.preventDefault()
            openLocal(sh)
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

  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [ctx, setCtx] = useState<Ctx | null>(null)
  const [folderCtx, setFolderCtx] = useState<{ x: number; y: number; id: string } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropFolder, setDropFolder] = useState<string | null>(null)

  const folderMenu = (id: string, name: string): MenuEntry[] => [
    { label: 'Rename', icon: <Route size={14} />, onClick: () => setRenaming(id) },
    { label: 'New subfolder', icon: <FolderPlus size={14} />, onClick: () => addFolder('New folder', id) },
    { separator: true, label: '' },
    { label: `Delete "${name}"`, icon: <Trash2 size={14} />, danger: true, onClick: () => deleteFolder(id) }
  ]

  const FolderLabel = ({ id, name }: { id: string; name: string }): React.JSX.Element =>
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
      onClick: () => {
        deleteServer(s.id)
        void window.opsmaxx?.secrets.delete(s.id)
        // The desktop's password lives under its own id, so deleting the
        // server's alone would leave it behind in the OS keychain — a
        // credential for a machine the app no longer knows about.
        void window.opsmaxx?.secrets.delete(rdpSecretId(s.id))
        toast(`${s.name} deleted`)
      }
    }
  ]

  const ServerRow = ({ s, nested }: { s: Server; nested?: boolean }): React.JSX.Element => (
    <div
      className={clsx('tree-row', activeTab?.kind === 'ssh' && activeTab.serverId === s.id && 'active')}
      style={nested ? undefined : { paddingLeft: 8 }}
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
      title={`${s.username}@${s.host}:${s.port} — double-click for a new session`}
    >
      <span className={clsx('status-dot', s.status)} />
      <span className="label">{labels.get(s.id) ?? s.name}</span>
      {s.route.length > 0 && <Route size={12} className="faint" />}
      <span className="spacer" />
      {s.favorite && <Star size={12} className="fav" fill="currentColor" />}
    </div>
  )

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

      {favorites.length > 0 && (
        <div className="tree-section">
          <div className="tree-section-label">
            <Star size={11} /> Favorites
          </div>
          {favorites.map((s) => (
            <ServerRow key={s.id} s={s} />
          ))}
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

        {rootFolders.map((f) => {
          const open = !collapsed[f.id]
          const childFolders = folders.filter((cf) => cf.parentId === f.id)
          const direct = serversIn(f.id)
          return (
            <div key={f.id}>
              <div
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
                <FolderLabel id={f.id} name={f.name} />
                <span className="spacer" />
                <span className="faint" style={{ fontSize: 11 }}>
                  {direct.length + childFolders.reduce((n, c) => n + serversIn(c.id).length, 0)}
                </span>
              </div>
              {open && (
                <div className="tree-children">
                  {childFolders.map((cf) => {
                    const copen = !collapsed[cf.id]
                    return (
                      <div key={cf.id}>
                        <div
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
                          <FolderLabel id={cf.id} name={cf.name} />
                        </div>
                        {copen && (
                          <div className="tree-children">
                            {serversIn(cf.id).map((s) => (
                              <ServerRow key={s.id} s={s} nested />
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                  {direct.map((s) => (
                    <ServerRow key={s.id} s={s} nested />
                  ))}
                </div>
              )}
            </div>
          )
        })}

        {serversIn(null).map((s) => (
          <ServerRow key={s.id} s={s} />
        ))}
      </div>

      <div className="tree-section">
        <div className="tree-section-label">
          <ServerIcon size={11} /> Recent
        </div>
        {recent.map((s) => (
          <div key={s.id} className="tree-row" onClick={() => openServer(s.id)}>
            <span className={clsx('status-dot', s.status)} />
            <span className="label">{labels.get(s.id) ?? s.name}</span>
          </div>
        ))}
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
    </>
  )
}
