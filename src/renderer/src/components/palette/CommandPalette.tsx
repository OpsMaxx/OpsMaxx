import { useMemo, useRef, useState, useEffect } from 'react'
import {
  Search,
  Server as ServerIcon,
  Network,
  Layers,
  Settings,
  Plus,
  Copy,
  Terminal as TerminalIcon,
  Activity,
  Bot,
  Download,
  CornerDownLeft
} from 'lucide-react'
import { useApp } from '../../store/app'
import { useClickOutside } from '../../hooks/useClickOutside'
import {
  AI_SECTIONS,
  AI_SECTION_LABELS,
  SETTINGS_SECTIONS,
  SETTINGS_SECTION_LABELS,
  openAi,
  openMonitor,
  openOperations,
  openSettings,
  openTunnels
} from '../../store/nav'
import { ACTIVITY_ITEMS } from '../layout/ActivityBar'
import { MODULES, isOperateModule, moduleEnabled } from '../../../../shared/modules'
import { fuzzyScore } from '../../lib/fuzzy'

interface Cmd {
  id: string
  group: string
  title: string
  sub?: string
  icon: React.ReactNode
  run: () => void
}

export function CommandPalette(): React.JSX.Element {
  const store = useApp()
  const close = (): void => store.togglePalette(false)
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useClickOutside(ref, close)

  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const commands = useMemo<Cmd[]>(() => {
    const list: Cmd[] = []
    store.workspaces
      .filter((w) => !w.hidden)
      .forEach((w) =>
        list.push({
          id: `ws-${w.id}`,
          group: 'Workspaces',
          title: w.name,
          sub: 'Switch workspace',
          icon: <Layers size={16} />,
          run: () => store.setWorkspace(w.id)
        })
      )
    store
      .workspaceServers()
      .forEach((s) =>
        list.push({
          id: `s-${s.id}`,
          group: 'Servers',
          title: s.name,
          sub: `${s.username}@${s.host}`,
          icon: <ServerIcon size={16} />,
          run: () => {
            store.setActivity('connections')
            store.openServer(s.id, 'terminal')
          }
        })
      )
    // Shells on this machine. Read straight from the store slice — nothing is
    // fetched here, because a useMemo cannot await and a palette that populated
    // itself asynchronously would render its first frame without these. The
    // slice is filled by the tab bar's shell menu, which is mounted for the life
    // of the workspace panel.
    if (store.settings.localTerminalEnabled !== false) {
      store.localShells.forEach((sh) =>
        list.push({
          id: `local-${sh.id}`,
          group: 'Local Shells',
          title: sh.label,
          // The path, never the id: ids are opaque and mean nothing to a reader.
          sub: sh.isDefault ? `${sh.path} · default` : sh.path,
          icon: <TerminalIcon size={16} />,
          run: () => {
            store.setActivity('connections')
            store.openLocal(sh)
          }
        })
      )
    }
    store
      .workspaceTunnels()
      .forEach((t) =>
        list.push({
          id: `t-${t.id}`,
          group: 'Tunnels',
          title: t.name,
          sub: `${t.listen} → ${t.target}`,
          icon: <Network size={16} />,
          // The entry is titled with this tunnel's name, so it has to land on
          // this tunnel. Opening the page and leaving the user to find it again
          // in the list is what a row named after one thing must not do.
          run: () => openTunnels({ kind: 'select', tunnelId: t.id })
        })
      )

    const current = store.activeTab()
    const actions: Cmd[] = [
      // Opening a server from here focuses its existing tab, so duplicating is
      // the way to get a second session on the same box from the palette.
      ...(current
        ? [
            {
              id: 'a-dup',
              group: 'Actions',
              title: 'Duplicate Current Tab',
              sub: current.title,
              icon: <Copy size={16} />,
              run: () => store.duplicateTab(current.id)
            }
          ]
        : []),
      { id: 'a-add', group: 'Actions', title: 'Add Server', icon: <Plus size={16} />, run: () => store.setModal('add-server') },
      { id: 'a-ws', group: 'Actions', title: 'New Workspace', icon: <Plus size={16} />, run: () => store.setModal('workspaces') },
      { id: 'a-mon', group: 'Actions', title: 'Open Fleet Monitor', icon: <Activity size={16} />, run: () => openMonitor('overview') },
      { id: 'a-term', group: 'Actions', title: 'Open Connections', icon: <TerminalIcon size={16} />, run: () => store.setActivity('connections') },
      {
        id: 'a-import',
        group: 'Actions',
        title: 'Import Servers from ~/.ssh/config',
        sub: 'Bulk-import servers you already have, ProxyJump included',
        icon: <Download size={16} />,
        run: () => {
          store.setActivity('connections')
          store.setModal('import-ssh')
        }
      },
      { id: 'a-set', group: 'Settings', title: 'Open Settings', icon: <Settings size={16} />, run: () => store.setActivity('settings') }
    ]

    /**
     * Everywhere the app can go.
     *
     * Built from the same registries the chrome is built from -- the activity
     * bar's own list, the module registry, the settings section list -- rather
     * than from a hand-kept copy. The hand-kept copy is why Databases, Vault,
     * the HTTP client, AI & MCP, Operations, twenty monitor modules and
     * fourteen settings pages were all unreachable from Ctrl+K while the
     * walkthrough said it "reaches every server, workspace, tunnel and action
     * in the app".
     */
    const destinations: Cmd[] = ACTIVITY_ITEMS.map((a) => ({
      id: `go-${a.id}`,
      group: 'Go to',
      title: a.label,
      icon: a.icon,
      run: () => (a.id === 'monitor' ? openMonitor('overview') : store.setActivity(a.id))
    }))

    // Only the modules this install has switched on. Listing the rest would be
    // advertising through a control that cannot deliver them -- Settings >
    // Modules is where a module is turned on, and it says so.
    const modules: Cmd[] = MODULES.filter((m) => moduleEnabled(store.settings.modules, m.id)).map(
      (m) => ({
        id: `mod-${m.id}`,
        group: isOperateModule(m.id) ? 'Operations' : 'Monitoring',
        title: m.label,
        icon: <Activity size={16} />,
        run: () =>
          isOperateModule(m.id) ? openOperations(m.id as never) : openMonitor(m.id as never)
      })
    )

    // Every page of AI & MCP, not just the destination. Without this the
    // palette reached the panel and left you on whichever page it was last on,
    // and Approvals and Active Sessions had no pointer anywhere in the app.
    const aiPages: Cmd[] = AI_SECTIONS.map((id) => ({
      id: `ai-${id}`,
      group: 'AI & MCP',
      title: AI_SECTION_LABELS[id],
      sub: 'AI & MCP',
      icon: <Bot size={16} />,
      run: () => openAi(id)
    }))

    const settingsPages: Cmd[] = SETTINGS_SECTIONS.map((id) => ({
      id: `set-${id}`,
      group: 'Settings',
      title: SETTINGS_SECTION_LABELS[id],
      sub: 'Settings',
      icon: <Settings size={16} />,
      run: () => openSettings(id)
    }))

    return [...actions, ...destinations, ...modules, ...aiPages, ...settingsPages, ...list]
  }, [store])

  const filtered = useMemo(() => {
    const query = q.trim()
    if (!query) return commands
    // Scored rather than filtered, so "kbs" finds Keyboard Shortcuts and the
    // best match is the one under the cursor when you press Enter. A palette
    // matched with `includes` makes you type the beginning of a word you would
    // have to already know.
    return commands
      .map((c) => ({ c, score: fuzzyScore(query, `${c.title} ${c.sub ?? ''} ${c.group}`) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.c)
  }, [q, commands])

  useEffect(() => setIdx(0), [q])

  const exec = (c?: Cmd): void => {
    if (!c) return
    c.run()
    close()
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIdx((i) => Math.min(filtered.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIdx((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      exec(filtered[idx])
    }
  }

  // group rendering
  let lastGroup = ''

  return (
    <div className="palette-scrim">
      <div className="palette" ref={ref}>
        <div className="palette-input">
          <Search size={18} className="faint" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search servers, workspaces, tunnels, actions…"
          />
          <span className="kbd">Esc</span>
        </div>
        <div className="palette-list">
          {filtered.length === 0 && <div className="palette-empty">No results for “{q}”</div>}
          {filtered.map((c, i) => {
            const showGroup = c.group !== lastGroup
            lastGroup = c.group
            return (
              <div key={c.id}>
                {showGroup && <div className="palette-group">{c.group}</div>}
                <div
                  className={`palette-item${i === idx ? ' active' : ''}`}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => exec(c)}
                >
                  <span className="p-icon">{c.icon}</span>
                  <span className="p-title">{c.title}</span>
                  {c.sub && <span className="p-sub">{c.sub}</span>}
                  <span className="spacer" />
                  {i === idx && <CornerDownLeft size={14} className="faint" />}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
