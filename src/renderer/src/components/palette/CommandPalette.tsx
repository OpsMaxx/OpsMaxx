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
  Bug,
  CornerDownLeft,
  ListChecks
} from 'lucide-react'
import { findLocalTab, useApp } from '../../store/app'
import { useClickOutside } from '../../hooks/useClickOutside'
import {
  AI_SECTIONS,
  AI_SECTION_LABEL_KEYS,
  SETTINGS_SECTIONS,
  SETTINGS_SECTION_LABEL_KEYS,
  openAi,
  openMonitor,
  openOperations,
  openSettings,
  openTunnels
} from '../../store/nav'
import { ACTIVITY_ITEMS } from '../layout/ActivityBar'
import { MODULES, isOperateModule, moduleEnabled } from '../../../../shared/modules'
import { reportBug } from '../../lib/reportBug'
import { fuzzyScore } from '../../lib/fuzzy'
import { templateTerminalText, type JobTemplate } from '../../../../shared/jobCompose'
import { httpPaletteCommands } from '../http/paletteCommands'
import { useT } from '../../lib/i18n'

interface Cmd {
  id: string
  group: string
  title: string
  sub?: string
  icon: React.ReactNode
  run: () => void
}

export function CommandPalette(): React.JSX.Element {
  const t = useT()
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

  // Saved job templates live in main, so they arrive a frame after the rest --
  // the one asynchronous group here. Only asked for when Jobs is switched on:
  // templates are part of that module, and a palette that listed them with it
  // off would be advertising a surface this install declined.
  const jobsOn = moduleEnabled(store.settings.modules, 'jobs')
  const [templates, setTemplates] = useState<JobTemplate[]>([])
  useEffect(() => {
    if (!jobsOn) return
    let live = true
    void window.opsmaxx?.jobTemplates
      ?.list()
      .then((r) => live && setTemplates(r?.templates ?? []))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [jobsOn])

  const commands = useMemo<Cmd[]>(() => {
    const list: Cmd[] = []
    store.workspaces
      .filter((w) => !w.hidden)
      .forEach((w) =>
        list.push({
          id: `ws-${w.id}`,
          group: t('palette.group.workspaces'),
          title: w.name,
          sub: t('palette.switchWorkspace'),
          icon: <Layers size={16} />,
          run: () => store.setWorkspace(w.id)
        })
      )
    store
      .workspaceServers()
      .forEach((s) =>
        list.push({
          id: `s-${s.id}`,
          group: t('palette.group.servers'),
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
      const tabs = store.workspaceTabs()
      const ws = store.activeId()
      store.localShells.forEach((sh) => {
        // Named entries in this palette take you to the thing they name. A
        // server row focuses its open tab rather than dialling a second
        // session; a shell row did the opposite, so "zsh" meant a new tab every
        // time no matter how many were already running. Identity — workspace,
        // shell id, cwd — lives in `findLocalTab` beside the action, which is
        // where the reasoning is written down.
        const open = findLocalTab(tabs, ws, sh.id)
        list.push({
          id: `local-${sh.id}`,
          group: t('palette.group.localShells'),
          title: sh.label,
          // The path, never the id: ids are opaque and mean nothing to a reader.
          sub: open
            ? t('palette.shellOpen', { path: sh.path })
            : sh.isDefault
              ? t('palette.shellDefault', { path: sh.path })
              : sh.path,
          icon: <TerminalIcon size={16} />,
          run: () => {
            store.setActivity('connections')
            store.focusOrOpenLocal(sh)
          }
        })
        // A second zsh is a real thing to want, so focusing must not be the only
        // thing on offer. Same idiom as Duplicate Current Tab above: a separate
        // row, present only while focusing is what the plain row would do, so
        // the deliberate path is one keystroke away rather than behind
        // reopening the palette on the tab you just landed on.
        if (open)
          list.push({
            id: `local-new-${sh.id}`,
            group: t('palette.group.localShells'),
            title: t('palette.newShellSession', { label: sh.label }),
            sub: t('palette.newShellSessionSub'),
            icon: <Plus size={16} />,
            run: () => {
              store.setActivity('connections')
              store.openLocal(sh)
            }
          })
      })
    }
    store
      .workspaceTunnels()
      .forEach((tn) =>
        list.push({
          id: `t-${tn.id}`,
          group: t('palette.group.tunnels'),
          title: tn.name,
          sub: `${tn.listen} → ${tn.target}`,
          icon: <Network size={16} />,
          // The entry is titled with this tunnel's name, so it has to land on
          // this tunnel. Opening the page and leaving the user to find it again
          // in the list is what a row named after one thing must not do.
          run: () => openTunnels({ kind: 'select', tunnelId: tn.id })
        })
      )

    const current = store.activeTab()
    // "Run in this terminal". It REQUESTS the paste confirmation in the active
    // pane and writes nothing: the pane shows every line, and only its button
    // sends them. One row per template, and only while the active pane is a
    // live session -- not a demo shell, not a dead or dormant one.
    const paneId = current ? (store.panes[current.id]?.activePaneId ?? current.id) : null
    if (current?.view === 'terminal' && paneId && store.pasteTargets[paneId]) {
      templates.forEach((tpl) => {
        const text = templateTerminalText(tpl)
        list.push({
          id: `tpl-${tpl.id}`,
          group: t('palette.group.jobTemplates'),
          title: t('palette.runTemplate', { name: tpl.name }),
          sub: t('palette.runTemplateSub', { count: text.split('\n').length }),
          icon: <ListChecks size={16} />,
          run: () => store.requestTerminalPaste(paneId, text)
        })
      })
    }
    const actions: Cmd[] = [
      // Opening a server from here focuses its existing tab, so duplicating is
      // the way to get a second session on the same box from the palette.
      ...(current
        ? [
            {
              id: 'a-dup',
              group: t('palette.group.actions'),
              title: t('palette.duplicateTab'),
              sub: current.title,
              icon: <Copy size={16} />,
              run: () => store.duplicateTab(current.id)
            }
          ]
        : []),
      { id: 'a-add', group: t('palette.group.actions'), title: t('palette.addServer'), icon: <Plus size={16} />, run: () => store.setModal('add-server') },
      { id: 'a-ws', group: t('palette.group.actions'), title: t('palette.newWorkspace'), icon: <Plus size={16} />, run: () => store.setModal('workspaces') },
      { id: 'a-mon', group: t('palette.group.actions'), title: t('palette.openFleetMonitor'), icon: <Activity size={16} />, run: () => openMonitor('overview') },
      { id: 'a-term', group: t('palette.group.actions'), title: t('palette.openConnections'), icon: <TerminalIcon size={16} />, run: () => store.setActivity('connections') },
      {
        id: 'a-import',
        group: t('palette.group.actions'),
        title: t('palette.importSsh'),
        sub: t('palette.importSshSub'),
        icon: <Download size={16} />,
        run: () => {
          store.setActivity('connections')
          store.setModal('import-ssh')
        }
      },
      // The same one click as the rail's bug button, for the half of this
      // audience that reaches for Ctrl+K before it reaches for a mouse. Both
      // call the one function, so neither can drift into saving or copying
      // without opening, or opening without either.
      {
        id: 'a-bug',
        group: t('palette.group.actions'),
        title: t('palette.reportBug'),
        sub: t('palette.reportBugSub'),
        icon: <Bug size={16} />,
        run: () => void reportBug()
      },
      { id: 'a-set', group: t('common.settings'), title: t('palette.openSettings'), icon: <Settings size={16} />, run: () => store.setActivity('settings') }
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
      group: t('palette.group.goTo'),
      title: t(a.labelKey),
      icon: a.icon,
      run: () => (a.id === 'monitor' ? openMonitor('overview') : store.setActivity(a.id))
    }))

    // Only the modules this install has switched on. Listing the rest would be
    // advertising through a control that cannot deliver them -- Settings >
    // Modules is where a module is turned on, and it says so.
    const modules: Cmd[] = MODULES.filter((m) => moduleEnabled(store.settings.modules, m.id)).map(
      (m) => ({
        id: `mod-${m.id}`,
        group: t(isOperateModule(m.id) ? 'palette.group.operations' : 'palette.group.monitoring'),
        title: t(m.labelKey),
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
      group: t('palette.group.ai'),
      title: t(AI_SECTION_LABEL_KEYS[id]),
      sub: t('palette.group.ai'),
      icon: <Bot size={16} />,
      run: () => openAi(id)
    }))

    const settingsPages: Cmd[] = SETTINGS_SECTIONS.map((id) => ({
      id: `set-${id}`,
      group: t('common.settings'),
      title: t(SETTINGS_SECTION_LABEL_KEYS[id]),
      sub: t('common.settings'),
      icon: <Settings size={16} />,
      run: () => openSettings(id)
    }))

    return [...actions, ...destinations, ...modules, ...aiPages, ...settingsPages, ...list, ...httpPaletteCommands(store)]
  }, [store, templates, t])

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
            placeholder={t('palette.placeholder')}
          />
          <span className="kbd">Esc</span>
        </div>
        <div className="palette-list">
          {filtered.length === 0 && <div className="palette-empty">{t('palette.noResults', { query: q })}</div>}
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
