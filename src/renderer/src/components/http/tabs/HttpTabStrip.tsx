import { useRef, useState, type ReactNode } from 'react'
import { ChevronDown, FolderOpen, LayoutPanelLeft, Layers, List, Loader2, Plus, X } from 'lucide-react'
import type { HttpTabState, Id, RequestKind } from '../../../../../shared/apiModel'
import { ContextMenu, type MenuEntry } from '../../connections/ContextMenu'
import { useHttp } from '../../../store/http'
import { useApi } from '../../../store/api'
import { useApp } from '../../../store/app'
import { useWsSessions } from '../../../store/wsSessions'
import { clsx } from '../../../lib/format'
import { keyLabel, withKey } from '../hotkeys'
import { layoutMenuEntries } from './layoutMenu'
import { requestClose } from './closing'
import { badgeFor, tabMenuEntries, tabTitle } from './tabMenus'
import { focusUrl } from '../focus'

interface Menu {
  x: number
  y: number
  entries: MenuEntry[]
}

export interface HttpTabStripProps {
  /** The environment picker (B), at the right of the strip. */
  envPicker?: ReactNode
  /** Whether an explicit Side by side is rendering stacked, for the Layout menu. */
  forced: boolean
}

const anchorOf = (el: HTMLElement): { x: number; y: number } => {
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.bottom + 4 }
}

export function newRequest(kind: RequestKind): void {
  useHttp.getState().openScratch(kind)
  focusUrl()
}

/**
 * The request-tab strip (§2.9): tabs with their glyphs, `+ ▾` right after the
 * last tab, the `⌄` list, the environment picker and `⊞` Layout.
 */
export function HttpTabStrip({ envPicker, forced }: HttpTabStripProps): React.JSX.Element {
  const ws = useApp((s) => s.activeWorkspaceId)
  const allTabs = useHttp((s) => s.tabs)
  const activeId = useHttp((s) => s.activeTab[ws] ?? null)
  const ghostId = useHttp((s) => s.ghost[ws]?.id ?? null)
  const closedStack = useHttp((s) => s.closedStack)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [renaming, setRenaming] = useState<Id | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const dragId = useRef<Id | null>(null)
  const tabs = allTabs.filter((t) => t.workspaceId === ws)
  const active = tabs.find((t) => t.id === activeId)

  const openMenu = (at: { x: number; y: number }, entries: MenuEntry[]): void => setMenu({ ...at, entries })
  const tabMenu = (tab: HttpTabState, at: { x: number; y: number }): void =>
    openMenu(at, tabMenuEntries(tab.id, { onRename: () => setRenaming(tab.id) }))

  const focusTab = (id: Id): void => {
    useHttp.getState().activateTab(id)
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-hc-tab="${id}"]`)?.focus())
  }

  const onTabKey = (e: React.KeyboardEvent, tab: HttpTabState, index: number): void => {
    if (renaming) return
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (step) {
      e.preventDefault()
      focusTab(tabs[(index + step + tabs.length) % tabs.length].id)
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      focusTab(tabs[e.key === 'Home' ? 0 : tabs.length - 1].id)
    } else if (e.key === 'Delete') {
      e.preventDefault()
      requestClose([tab.id])
    } else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault()
      tabMenu(tab, anchorOf(e.currentTarget as HTMLElement))
    } else if (e.key === 'F2') {
      e.preventDefault()
      setRenaming(tab.id)
    }
  }

  const listEntries = (): MenuEntry[] => {
    const recent = closedStack
      .filter((c) => c.tab.workspaceId === ws)
      .slice(-10)
      .reverse()
    const title = (t: HttpTabState): string => tabTitle(t, useHttp.getState().requestFor(t.id) ?? t.draft ?? null)
    return [
      ...tabs.map((t, i) => ({
        label: title(t),
        radio: 'open-tab',
        checked: t.id === activeId,
        onClick: () => focusTab(t.id),
        ...(i === 0 ? { section: 'Open tabs' } : {})
      })),
      ...recent.map((c, i) => ({
        label: tabTitle(c.tab, c.tab.draft ?? null),
        onClick: () => {
          // Reopen that one: move it to the top of the stack first.
          useHttp.setState((s) => ({ closedStack: [...s.closedStack.filter((x) => x !== c), c] }))
          useHttp.getState().reopenClosed()
        },
        ...(i === 0 ? { section: 'Recently closed' } : {})
      })),
      { label: '', separator: true },
      {
        label: 'Reopen closed tab',
        shortcut: keyLabel('reopen-tab'),
        disabled: recent.length === 0,
        onClick: () => useHttp.getState().reopenClosed()
      }
    ]
  }

  const drop = (index: number): void => {
    if (dragId.current) {
      const from = tabs.findIndex((t) => t.id === dragId.current)
      // `reorder` takes the slot the tab ends up in; dropping right of itself shifts by one.
      useHttp.getState().reorder(dragId.current, from < index ? index - 1 : index)
    }
    dragId.current = null
    setDropAt(null)
  }

  return (
    <div className="hc-tabstrip">
      <div
        className="hc-tabs"
        onDragOver={(e) => dragId.current && e.preventDefault()}
        onDrop={() => drop(dropAt ?? tabs.length)}
      >
        <div className="hc-tablist" role="tablist" aria-label="Request tabs">
          {tabs.map((tab, index) => (
            <Tab
              key={tab.id}
              tab={tab}
              active={tab.id === activeId}
              dropBefore={dropAt === index}
              renaming={renaming === tab.id}
              onRenamed={() => {
                setRenaming(null)
                // Back to the tab the rename started from, not to the document body.
                requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-hc-tab="${tab.id}"]`)?.focus())
              }}
              onKeyDown={(e) => onTabKey(e, tab, index)}
              onMenu={(at) => tabMenu(tab, at)}
              onDragStart={() => (dragId.current = tab.id)}
              onDragOver={(e) => {
                if (!dragId.current) return
                e.preventDefault()
                const r = e.currentTarget.getBoundingClientRect()
                setDropAt(e.clientX < r.left + r.width / 2 ? index : index + 1)
              }}
            />
          ))}
        </div>
        {/* + follows the last tab, so it is where the eye is when the strip is short (UX-M15). */}
        <span className="hc-strip-tools">
          <button
            className="icon-btn sm"
            aria-label={withKey('New HTTP request', 'new-terminal')}
            title={withKey('New HTTP request', 'new-terminal')}
            onClick={() => newRequest('http')}
          >
            <Plus size={14} />
          </button>
          <button
            className="icon-btn xs"
            aria-label="New WebSocket or GraphQL request"
            title="New WebSocket or GraphQL request"
            aria-haspopup="menu"
            onClick={(e) =>
              openMenu(anchorOf(e.currentTarget), [
                { label: 'HTTP request', onClick: () => newRequest('http') },
                { label: 'WebSocket', onClick: () => newRequest('ws') },
                { label: 'GraphQL request', onClick: () => newRequest('graphql') }
              ])
            }
          >
            <ChevronDown size={12} />
          </button>
        </span>
      </div>
      <span className="hc-strip-spacer" />
      <span className="hc-strip-tools">
        <button
          className="icon-btn sm"
          aria-label="Open tabs and recently closed"
          title="Open tabs and recently closed"
          aria-haspopup="menu"
          onClick={(e) => openMenu(anchorOf(e.currentTarget), listEntries())}
        >
          <List size={14} />
        </button>
        {envPicker}
        <button
          className="icon-btn sm"
          aria-label="Layout (panels and splits)"
          title="Layout (panels and splits)"
          aria-haspopup="menu"
          onClick={(e) => {
            const tabId = active?.id ?? ghostId
            const req = tabId ? useHttp.getState().requestFor(tabId) : null
            openMenu(anchorOf(e.currentTarget), layoutMenuEntries({ tabId, kind: req?.kind ?? null, forced }))
          }}
        >
          <LayoutPanelLeft size={14} />
        </button>
      </span>
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />}
    </div>
  )
}

interface TabProps {
  tab: HttpTabState
  active: boolean
  dropBefore: boolean
  renaming: boolean
  onRenamed: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
  onMenu: (at: { x: number; y: number }) => void
  onDragStart: () => void
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void
}

function Tab(p: TabProps): React.JSX.Element {
  const { tab } = p
  const req = useHttp((s) => s.requestFor(tab.id))
  // Subscribed so a collection rename or a save re-renders the title and the dirty dot.
  useApi((s) => s.collections)
  const dirty = useHttp((s) => s.isDirty(tab.id))
  const sending = useHttp((s) => s.responses[tab.id]?.status === 'sending')
  const connected = useWsSessions((s) => s.sessions[tab.id]?.state === 'open')
  const title = tabTitle(tab, req)
  const badge = tab.kind === 'request' ? badgeFor(req) : null
  const close = (e: React.MouseEvent): void => {
    e.stopPropagation()
    requestClose([tab.id])
  }
  const state = [dirty && 'unsaved changes', sending && 'sending', connected && 'connected', tab.preview && 'preview']
    .filter(Boolean)
    .join(', ')

  return (
    <div
      role="tab"
      data-hc-tab={tab.id}
      aria-selected={p.active}
      aria-label={state ? `${badge ? `${badge.text} ` : ''}${title} (${state})` : undefined}
      tabIndex={p.active ? 0 : -1}
      className={clsx('hc-tab', tab.preview && 'hc-preview', p.dropBefore && 'hc-drop-before')}
      title={title}
      draggable={!p.renaming}
      onClick={() => useHttp.getState().activateTab(tab.id)}
      onDoubleClick={() => useHttp.getState().pin(tab.id)}
      onAuxClick={(e) => {
        if (e.button === 1) close(e)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        p.onMenu({ x: e.clientX, y: e.clientY })
      }}
      onKeyDown={p.onKeyDown}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        p.onDragStart()
      }}
      onDragOver={p.onDragOver}
    >
      {badge ? (
        <span className={clsx('hc-badge', badge.className)}>{badge.text}</span>
      ) : tab.kind === 'collection' ? (
        <FolderOpen size={13} aria-hidden />
      ) : tab.kind === 'environments' ? (
        <Layers size={13} aria-hidden />
      ) : null}
      {p.renaming && req ? (
        <RenameInput tab={tab} initial={req.name} onDone={p.onRenamed} />
      ) : (
        <span className="hc-tab-title">{title}</span>
      )}
      <span className="hc-tab-glyph">
        {sending ? (
          <Loader2 size={12} className="spin" aria-label="Sending" />
        ) : connected ? (
          <span className="hc-live-dot" role="img" aria-label="Connected" />
        ) : dirty ? (
          <span className="hc-dirty" role="img" aria-label="Unsaved changes" />
        ) : null}
        {!sending && (
          <button
            className={clsx('icon-btn xs hc-close', !dirty && !connected && 'hc-clean')}
            tabIndex={-1}
            aria-label={withKey(`Close ${title}`, 'close-tab')}
            title={withKey('Close', 'close-tab')}
            onClick={close}
          >
            <X size={12} />
          </button>
        )}
      </span>
    </div>
  )
}

function RenameInput({
  tab,
  initial,
  onDone
}: {
  tab: HttpTabState
  initial: string
  onDone: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const commit = (): void => {
    const name = value.trim()
    const http = useHttp.getState()
    const req = http.requestFor(tab.id)
    if (name && req && name !== req.name) {
      // A saved request is renamed where it is saved; a scratch one in its draft.
      if (tab.ref?.requestId && !tab.draft) useApi.getState().renameItem(tab.ref.collectionId, tab.ref.requestId, name)
      else http.updateDraft(tab.id, { ...req, name })
    }
    onDone()
  }
  return (
    <input
      className="input hc-tab-rename"
      aria-label="Tab name"
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') onDone()
      }}
    />
  )
}
