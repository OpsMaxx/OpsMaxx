import { useEffect, useState } from 'react'
import {
  X,
  Plus,
  Copy,
  Pencil,
  ArrowLeftToLine,
  ArrowRightToLine,
  Terminal as TerminalIcon,
  FolderOpen,
  Activity,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Columns3,
  Search,
  Server as ServerIcon,
  Monitor as MonitorIcon,
  HardDrive,
  Box,
  Download
} from 'lucide-react'
import {
  MAX_PANES,
  splitDirectionOf,
  useApp,
  useWorkspaceServers,
  useWorkspaceTabs
} from '../../store/app'
import type { TabPanes } from '../../store/app'
import { ContextMenu, MenuEntry } from '../connections/ContextMenu'
import { clsx } from '../../lib/format'
import { EmptyState } from '../common/EmptyState'
import { TerminalView } from '../terminal/TerminalView'
import { containerTransport, localTransport, sshTransport } from '../../lib/transport'
import { LocalShellMenu } from '../terminal/LocalShellMenu'
import { TabStrip } from './TabStrip'
import { PaneGrid } from './PaneGrid'
import { MonitorView } from './MonitorView'
import { MonitorStrip } from './MonitorStrip'
import { SftpView } from './SftpView'
import { RdpView } from '../rdp/RdpView'
import type { PanelView, Server, Tab, TabView } from '../../types'

const VIEWS: { id: PanelView; label: string; icon: React.ReactNode }[] = [
  { id: 'terminal', label: 'Terminal', icon: <TerminalIcon size={14} /> },
  { id: 'monitor', label: 'Monitor', icon: <Activity size={14} /> },
  { id: 'files', label: 'Files', icon: <FolderOpen size={14} /> }
]

// A single tab pane. Every view the user has opened (Terminal / Monitor /
// Files) stays mounted for the tab's lifetime — only visibility toggles — so
// the SSH shell, the SFTP browser (path/state) and the live monitor all
// survive switching views and switching between tabs. Views are mounted
// lazily: a view isn't created until it's first opened.
function TabPane({
  tab,
  server,
  tp,
  active
}: {
  tab: Tab
  server: Server | undefined
  // The tab's panes. Undefined only for a tab written into the store directly
  // rather than through one of the actions that create one — see Terminals().
  tp: TabPanes | undefined
  // Every tab stays mounted so sessions survive, so background work must be
  // gated on visibility rather than on being rendered.
  active: boolean
}): React.JSX.Element {
  // `TabView`, not `PanelView`: this runs for every kind of tab, including the
  // RDP one whose only view is 'desktop'. The pane styles below stay on
  // `PanelView`, because by the time they are called the tab is an SSH one.
  const [visited, setVisited] = useState<Set<TabView>>(() => new Set([tab.view]))
  useEffect(() => {
    setVisited((v) => (v.has(tab.view) ? v : new Set(v).add(tab.view)))
  }, [tab.view])

  const paneStyle = (view: PanelView): React.CSSProperties => ({
    display: tab.view === view ? 'flex' : 'none',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0
  })

  // A local tab still has no server and must never be handed one — that is
  // what the tab union exists to prevent. Monitor and the docked strip both
  // take a non-optional `Server`, so they stay SSH-only; Files does not any
  // more, because main serves this machine's half from node:fs behind the same
  // channel, so SftpView takes `server?: Server` and absent means here.
  if (tab.kind === 'local') {
    return (
      <>
        <div style={paneStyle('terminal')}>
          <Terminals tab={tab} tp={tp} />
        </div>
        {visited.has('files') && (
          <div style={paneStyle('files')}>
            <SftpView tabId={tab.id} />
          </div>
        )}
      </>
    )
  }

  if (!server) {
    return <EmptyState icon={<TerminalIcon size={26} />} title="Session unavailable" message="This server no longer exists." />
  }

  // Before the view-by-view rendering below, because an RDP tab has none of
  // those views: no terminal to dock a monitor strip under, and no SFTP
  // channel. It is one surface, and `paneStyle` would only ever hide it.
  if (tab.kind === 'rdp') {
    return <RdpView server={server} visible={active} />
  }

  return (
    <>
      {/* No terminal is started for a files-only account: sshd would refuse
          the shell, and the refusal is what used to mark the server offline
          and take the Files view down with it. */}
      {server.sftpOnly !== true && visited.has('terminal') && (
        <div style={paneStyle('terminal')}>
          <Terminals tab={tab} tp={tp} />
          {/* Docked under the terminal rather than a separate view, so host
              load can be watched while working. */}
          <MonitorStrip server={server} visible={active} />
        </div>
      )}
      {server.sftpOnly !== true && visited.has('monitor') && (
        <div style={paneStyle('monitor')}>
          <MonitorView server={server} visible={active && tab.view === 'monitor'} />
        </div>
      )}
      {visited.has('files') && (
        <div style={paneStyle('files')}>
          <SftpView server={server} tabId={tab.id} />
        </div>
      )}
    </>
  )
}

// The terminal half of a tab: its panes, or — for a tab that somehow has none —
// the single-pane rendering this file had before panes existed.
//
// The fallback is unreachable through the store, which mints `panes[tab.id]` in
// every action that creates a tab. It exists so that a tab written straight into
// state (a test, or a future session-restore path) still shows a working
// terminal instead of a blank rectangle; it just cannot be split, and its
// session is keyed by the tab id rather than a pane id.
function Terminals({ tab, tp }: { tab: Tab; tp: TabPanes | undefined }): React.JSX.Element {
  const servers = useApp((s) => s.servers)
  const localShells = useApp((s) => s.localShells)
  const setServerStatus = useApp((s) => s.setServerStatus)

  if (tp) return <PaneGrid tabId={tab.id} tp={tp} />

  if (tab.kind === 'local') {
    const shell = localShells.find((sh) => sh.id === tab.shellId)
    if (!shell) {
      return (
        <EmptyState
          icon={<TerminalIcon size={26} />}
          title="Session unavailable"
          message="This shell is no longer available on this machine."
        />
      )
    }
    return <TerminalView transport={localTransport(shell, tab.cwd)} tabId={tab.id} />
  }
  // An RDP tab never reaches here — TabPane returns RdpView before rendering
  // any terminal — but the narrowing has to say so, because everything below
  // reads fields that only an SSH tab has.
  if (tab.kind === 'rdp') {
    return (
      <EmptyState
        icon={<TerminalIcon size={26} />}
        title="Session unavailable"
        message="A remote desktop has no terminal."
      />
    )
  }
  const server = servers.find((sv) => sv.id === tab.serverId)
  if (!server) {
    return <EmptyState icon={<TerminalIcon size={26} />} title="Session unavailable" message="This server no longer exists." />
  }
  // A demo server has no transport: TerminalView falls through to the
  // simulated shell, which is what `server` is still passed for.
  const transport =
    server.demo === false
      ? tab.containerRef
        ? containerTransport(server, tab.containerRef, setServerStatus, tab.containerSudo === true)
        : sshTransport(server, setServerStatus)
      : undefined
  return <TerminalView transport={transport} server={server} tabId={tab.id} />
}

// Two different empty states wearing one set of words.
//
// It used to say, always: "No open sessions. Select a server from the sidebar
// to open a terminal, or add your first connection to get started." On a fresh
// install the sidebar it points at reads `CONNECTIONS 0`, so the first half of
// the sentence describes an action the reader cannot take — and the headline
// names a session problem when the actual state is "there are no servers".
//
// The other half of the defect is what it did NOT offer. This audience
// overwhelmingly already has a ~/.ssh/config; the tour promotes importing it and
// the command palette advertises it as "Bulk-import servers you already have,
// ProxyJump included". Here it appeared only as an unlabelled download arrow in
// the sidebar header, so the fastest path in was the one nobody could see.
//
// The config is probed rather than assumed. `sshConfig.read()` already
// separates "no such file" from "could not read it", and Import is only made
// the primary action when a file was actually found — promoting it on a machine
// with no config would send a first-run user to a dialog that can only tell
// them there is nothing there.
function NoTabs(): React.JSX.Element {
  const setModal = useApp((s) => s.setModal)
  const servers = useWorkspaceServers()
  // null while the probe is outstanding: not "no config", which would make the
  // buttons jump once the answer arrives.
  const [config, setConfig] = useState<{ found: boolean; count: number } | null>(null)

  useEffect(() => {
    let live = true
    void window.opsmaxx?.sshConfig?.read().then((r) => {
      if (!live) return
      setConfig(r?.ok ? { found: true, count: r.hosts?.length ?? 0 } : { found: false, count: 0 })
    })
    return () => {
      live = false
    }
  }, [])

  // Servers exist, so the original sentence is finally true.
  if (servers.length > 0) {
    return (
      <EmptyState
        icon={<ServerIcon size={26} />}
        title="No open sessions"
        message="Select a server from the sidebar to open a terminal."
      />
    )
  }

  const importFirst = config?.found === true
  return (
    <EmptyState
      icon={<ServerIcon size={26} />}
      title="No servers yet"
      message={
        importFirst
          ? `OpsMaxx found ${config.count} host${config.count === 1 ? '' : 's'} in your ~/.ssh/config. Import them, or add one by hand.`
          : 'Add a connection to get started, or import the ones you already have from ~/.ssh/config.'
      }
      action={
        <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
          <button
            className={clsx('btn', importFirst && 'primary')}
            onClick={() => setModal('import-ssh')}
          >
            <Download size={15} /> Import from ~/.ssh/config
          </button>
          <button
            className={clsx('btn', !importFirst && 'primary')}
            onClick={() => setModal('add-server')}
          >
            <Plus size={15} /> Add Server
          </button>
        </div>
      }
    />
  )
}

/**
 * What KIND of thing a tab is talking to.
 *
 * With shells on this machine, servers and desktops sharing one strip, the
 * title stops being enough to tell them apart — "web" could be any of them —
 * and the panel is the only other place that says which. A glyph in the tab
 * answers it without switching to find out.
 */
function TabKindIcon({ tab }: { tab: Tab }): React.JSX.Element {
  const size = 13
  if (tab.kind === 'rdp') return <MonitorIcon size={size} className="tab-kind" />
  if (tab.kind === 'local') return <HardDrive size={size} className="tab-kind" />
  // A shell inside a container is still an SSH tab, but it is not a shell on
  // the host and the strip is the only place that difference is visible.
  if (tab.containerRef) return <Box size={size} className="tab-kind" />
  return <TerminalIcon size={size} className="tab-kind" />
}

export function WorkspacePanel(): React.JSX.Element {
  // Tabs shown in the bar: this workspace only.
  const tabs = useWorkspaceTabs()
  // Every tab in every workspace stays mounted, so switching workspace does
  // not tear down a session and kill whatever command is running in it.
  const allTabs = useApp((s) => s.tabs)
  const activeTabId = useApp((s) => s.activeTabId)
  const setActiveTab = useApp((s) => s.setActiveTab)
  const closeTab = useApp((s) => s.closeTab)
  const moveTab = useApp((s) => s.moveTab)
  const requestTerminalFind = useApp((s) => s.requestTerminalFind)
  const setTabView = useApp((s) => s.setTabView)
  const setModal = useApp((s) => s.setModal)
  const newSession = useApp((s) => s.newSession)
  const openLocalById = useApp((s) => s.openLocalById)
  const duplicateTab = useApp((s) => s.duplicateTab)
  const renameTab = useApp((s) => s.renameTab)
  const closeOtherTabs = useApp((s) => s.closeOtherTabs)
  const closeTabsToLeft = useApp((s) => s.closeTabsToLeft)
  const closeTabsToRight = useApp((s) => s.closeTabsToRight)
  const closeAllTabs = useApp((s) => s.closeAllTabs)
  const servers = useApp((s) => s.servers)
  const localShells = useApp((s) => s.localShells)
  const active = tabs.find((t) => t.id === activeTabId) ?? null
  const panes = useApp((s) => s.panes)
  const toggleSplit = useApp((s) => s.toggleSplit)
  const splitPane = useApp((s) => s.splitPane)
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tabId: string } | null>(null)
  // Which tab the context menu asked to rename. The strip owns the editor.
  const [renaming, setRenaming] = useState<{ id: string; nonce: number } | null>(null)

  const server = active?.kind === 'ssh' ? servers.find((s) => s.id === active.serverId) : undefined
  const filesOnly = server?.sftpOnly === true
  // Null while the tab holds a single pane: `TabPanes.direction` always holds a
  // letter, but there is no split to highlight until there are two panes. This
  // is the replacement for reading `tabSplit[id]`, which is gone.
  const activeSplit = splitDirectionOf(panes, active?.id)
  const activePaneCount = active ? panes[active.id]?.panes.length ?? 1 : 1
  const atPaneCap = activePaneCount >= MAX_PANES
  // What the viewbar says the tab is talking to. An SSH tab names the account;
  // a local one names the shell it started, which is the only comparable fact
  // and the one the dead-session overlay shows too.
  const activeShellPath =
    active?.kind === 'local'
      ? localShells.find((sh) => sh.id === active.shellId)?.path
      : undefined
  // A new session on whatever the current tab is: another shell on the same
  // server, another shell of the same kind on this machine, or — with no tab
  // at all — the only thing left to offer, which is adding a server.
  const addTab = (): void => {
    if (active?.kind === 'ssh') newSession(active.serverId)
    else if (active?.kind === 'local') openLocalById(active.shellId, active.cwd)
    else setModal('add-server')
  }

  const tabMenuEntries = (tabId: string): MenuEntry[] => {
    const idx = tabs.findIndex((t) => t.id === tabId)
    return [
      {
        label: 'Rename…',
        icon: <Pencil size={14} />,
        // The strip owns the editor; this only asks for it. A nonce, because
        // asking twice for the same tab must be two events.
        onClick: () => setRenaming({ id: tabId, nonce: Date.now() })
      },
      { label: 'Duplicate Tab', icon: <Copy size={14} />, onClick: () => duplicateTab(tabId) },
      { separator: true, label: '' },
      { label: 'Close', icon: <X size={14} />, onClick: () => closeTab(tabId) },
      {
        label: 'Close Others',
        icon: <X size={14} />,
        disabled: tabs.length < 2,
        onClick: () => closeOtherTabs(tabId)
      },
      {
        label: 'Close All to the Left',
        icon: <ArrowLeftToLine size={14} />,
        disabled: idx <= 0,
        onClick: () => closeTabsToLeft(tabId)
      },
      {
        label: 'Close All to the Right',
        icon: <ArrowRightToLine size={14} />,
        disabled: idx === tabs.length - 1,
        onClick: () => closeTabsToRight(tabId)
      },
      { separator: true, label: '' },
      { label: 'Close All Tabs', icon: <X size={14} />, danger: true, onClick: () => closeAllTabs() }
    ]
  }

  return (
    <div className="main">
      <TabStrip
        label="Session tabs"
        items={tabs.map((t) => {
          const srv = t.kind === 'ssh' || t.kind === 'rdp' ? servers.find((s) => s.id === t.serverId) : undefined
          return {
            id: t.id,
            title: t.title,
            // The kind, at a glance. With local shells, servers and desktops
            // in one strip the name alone stops being enough: "web" could be
            // any of the three, and the icon is the only thing that says
            // which without reading the panel.
            icon: <TabKindIcon tab={t} />,
            status: srv ? <span className={clsx('status-dot', srv.status)} /> : undefined,
            // The full name plus what it is connected to, because the title
            // itself is ellipsised at 220px and a truncated hostname is the
            // one thing a user hovers a tab to find out.
            tooltip: srv ? `${t.title} — ${srv.name}` : t.title
          }
        })}
        activeId={activeTabId}
        onSelect={setActiveTab}
        onClose={closeTab}
        onReorder={moveTab}
        onContextMenu={(tabId, x, y) => setTabMenu({ x, y, tabId })}
        onRename={renameTab}
        renameRequest={renaming ?? undefined}
      >
        {/* A split button: the plus repeats whatever the current tab is, the
            caret opens the list of shells on this machine. */}
        <button className="tab-new" title="New session" onClick={addTab}>
          <Plus size={16} />
        </button>
        <LocalShellMenu />
      </TabStrip>

      {tabMenu && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          entries={tabMenuEntries(tabMenu.tabId)}
          onClose={() => setTabMenu(null)}
        />
      )}

      {/* The viewbar used to be gated on `active && server`, which left a local
          tab with no viewbar and therefore no split controls. The three-view
          segment is the only SSH-only half; the split controls belong to any
          terminal. An SSH tab whose server is gone still shows nothing, which is
          the case the old condition was actually covering. */}
      {active && (active.kind === 'local' || server) && (
        <div className="viewbar">
          {/* A local tab gets Terminal and Files, not Monitor: the monitor
              views take a non-optional Server, and the collector behind them
              reads /proc and Linux `df` semantics — on a Mac or a Windows box
              it would draw numbers that look right and are not. */}
          {/* Terminal and Monitor both run commands, which a files-only
              account cannot do. Offering them and letting them fail is the
              behaviour this flag exists to remove. */}
          <div className="segment">
            {VIEWS.filter((v) =>
              filesOnly ? v.id === 'files' : active.kind === 'ssh' || v.id !== 'monitor'
            ).map((v) => (
              <button
                key={v.id}
                className={clsx('seg-btn', active.view === v.id && 'active')}
                onClick={() => setTabView(active.id, v.id)}
              >
                {v.icon} {v.label}
              </button>
            ))}
          </div>
          <span className="spacer" />
          <div className="server-meta mono">
            {server ? `${server.username}@${server.host}:${server.port}` : activeShellPath ?? ''}
          </div>
          {active.view === 'terminal' && (
            <div className="row" style={{ gap: 2 }}>
              {/* Was a button with no onClick — the only visible affordance
                  for search, pointing at nothing. Sends the request to the
                  ACTIVE pane, since a split tab has more than one terminal
                  and the toolbar sits above all of them. */}
              <button
                className="icon-btn"
                title="Find in terminal"
                onClick={() =>
                  requestTerminalFind(panes[active.id]?.activePaneId ?? active.id)
                }
              >
                <Search size={15} />
              </button>
              <button
                className={clsx('icon-btn', activeSplit === 'v' && 'active')}
                title="Split vertical"
                onClick={() => toggleSplit(active.id, 'v')}
              >
                <SplitSquareHorizontal size={15} />
              </button>
              <button
                className={clsx('icon-btn', activeSplit === 'h' && 'active')}
                title="Split horizontal"
                onClick={() => toggleSplit(active.id, 'h')}
              >
                <SplitSquareVertical size={15} />
              </button>
              {/* The two buttons above are toggles — they take a tab between
                  one pane and two, which is the contract they have always had.
                  Panes three and four are reachable only from here, and the cap
                  is shown as a disabled button rather than enforced silently
                  when it is pressed. */}
              <button
                className="icon-btn"
                disabled={atPaneCap}
                title={
                  atPaneCap
                    ? `Maximum of ${MAX_PANES} panes per tab`
                    : 'Add a pane on the same target'
                }
                onClick={() => splitPane(active.id, activeSplit ?? 'v')}
              >
                <Columns3 size={15} />
              </button>
            </div>
          )}
        </div>
      )}

      <div className="panel-body">
        {/* Rendered inline rather than as an early return: returning early
            would unmount every pane, killing sessions in other workspaces. */}
        {tabs.length === 0 && <NoTabs />}
        {allTabs.map((t) => (
          <div
            key={t.id}
            className="tab-pane"
            style={{ display: t.id === activeTabId ? 'flex' : 'none' }}
          >
            <TabPane
              tab={t}
              // A local tab has no server and must never be handed one. An RDP
              // tab has the same server an SSH tab does — it is the same saved
              // machine — so it is looked up the same way; what differs is the
              // session, not the target.
              server={
                t.kind === 'local' ? undefined : servers.find((s) => s.id === t.serverId)
              }
              tp={panes[t.id]}
              active={t.id === activeTabId}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
