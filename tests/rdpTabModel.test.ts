import { describe, it, expect, beforeEach } from 'vitest'
import { useApp } from '../src/renderer/src/store/app'
import type { Server } from '../src/renderer/src/types'

// An RDP tab is a third member of the tab union, and every one of these tests
// exists because adding it silently broke something that already worked, or
// left a path that typechecks and renders nothing.
//
// The recurring cause is that `PanelView` gained a 'desktop' member so that
// `view` stays one field across every kind of tab. That makes shapes like an
// SSH tab holding `view: 'desktop'` type-correct and unrenderable, so the
// places that build or mutate a tab have to refuse them explicitly.

const server = (over: Partial<Server> = {}): Server => ({
  id: 'srv-win',
  workspaceId: 'ws-default',
  folderId: null,
  name: 'Win Box',
  host: 'win.example.test',
  port: 22,
  username: 'admin',
  auth: 'password',
  status: 'offline',
  tags: [],
  favorite: false,
  os: 'Windows',
  route: [],
  vpnProfileId: null,
  rdp: { port: 3389, nla: true },
  ...over
})

const reset = (servers: Server[] = [server()]): void => {
  useApp.setState({
    tabs: [],
    activeTabId: null,
    tabSession: {},
    tabCwd: {},
    panes: {},
    servers,
    localShells: [],
    workspaces: [
      { id: 'ws-default', name: 'Personal', color: 'cyan', hidden: false, locked: false, hasPassword: false }
    ],
    activeWorkspaceId: 'ws-default'
  })
}

describe('opening a remote desktop', () => {
  beforeEach(() => reset())

  it('opens a tab of its own kind, on the desktop view', () => {
    useApp.getState().openRdp('srv-win')
    const [tab] = useApp.getState().tabs
    expect(tab.kind).toBe('rdp')
    expect(tab.view).toBe('desktop')
    expect(tab.kind === 'rdp' && tab.serverId).toBe('srv-win')
  })

  it('refuses a server with no RDP settings', () => {
    reset([server({ rdp: undefined })])
    useApp.getState().openRdp('srv-win')
    expect(useApp.getState().tabs).toHaveLength(0)
  })

  it('refuses an unknown server', () => {
    useApp.getState().openRdp('nope')
    expect(useApp.getState().tabs).toHaveLength(0)
  })

  it('opens a second desktop rather than focusing the first', () => {
    // A second desktop is a second session on the host. Raising the existing
    // tab instead would look like the request was ignored.
    useApp.getState().openRdp('srv-win')
    useApp.getState().openRdp('srv-win')
    expect(useApp.getState().tabs).toHaveLength(2)
  })

  it('numbers desktops against other desktops, not against terminals', () => {
    useApp.getState().newSession('srv-win')
    useApp.getState().openRdp('srv-win')
    const rdp = useApp.getState().tabs.filter((t) => t.kind === 'rdp')
    // The first desktop on this host, even though a terminal is already open.
    expect(rdp[0].title).toBe('Win Box')
  })
})

describe('duplicating a remote desktop', () => {
  beforeEach(() => reset())

  it('produces another desktop, not an SSH tab showing nothing', () => {
    // The bug this covers: `duplicateOf` had no rdp branch, so it fell through
    // to the SSH copy and emitted `kind: 'ssh'` carrying `view: 'desktop'`.
    // That typechecks — 'desktop' is a PanelView — and renders as an empty
    // pane, because the SSH body matches its views by name.
    useApp.getState().openRdp('srv-win')
    const [original] = useApp.getState().tabs
    useApp.getState().duplicateTab(original.id)

    const tabs = useApp.getState().tabs
    expect(tabs).toHaveLength(2)
    expect(tabs.every((t) => t.kind === 'rdp')).toBe(true)
    expect(tabs.every((t) => t.view === 'desktop')).toBe(true)
  })

  it('never leaves an SSH tab on the desktop view', () => {
    useApp.getState().newSession('srv-win')
    const [ssh] = useApp.getState().tabs
    useApp.getState().duplicateTab(ssh.id)
    for (const t of useApp.getState().tabs) {
      if (t.kind === 'ssh') expect(t.view).not.toBe('desktop')
    }
  })
})

describe('views and splits on a remote desktop', () => {
  beforeEach(() => reset())

  it('cannot be switched to a terminal or files view', () => {
    useApp.getState().openRdp('srv-win')
    const [tab] = useApp.getState().tabs
    useApp.getState().setTabView(tab.id, 'files')
    expect(useApp.getState().tabs[0].view).toBe('desktop')
  })

  it('does not let another kind of tab be switched to the desktop view', () => {
    // Symmetric to the above: 'desktop' is in the shared union so `view` stays
    // one field, not so an SSH tab can be sent to a session it does not have.
    useApp.getState().newSession('srv-win')
    const [tab] = useApp.getState().tabs
    useApp.getState().setTabView(tab.id, 'desktop')
    expect(useApp.getState().tabs[0].view).toBe('terminal')
  })

  it('cannot be split', () => {
    // Ctrl+\ reaches toggleSplit whatever is on screen, and an RDP tab renders
    // RdpView rather than PaneGrid — so a second pane would count toward
    // MAX_PANES and never be drawn.
    useApp.getState().openRdp('srv-win')
    const [tab] = useApp.getState().tabs
    useApp.getState().toggleSplit(tab.id, 'v')
    expect(useApp.getState().panes[tab.id].panes).toHaveLength(1)

    useApp.getState().splitPane(tab.id, 'h')
    expect(useApp.getState().panes[tab.id].panes).toHaveLength(1)
  })

  it('still starts with exactly one pane, on its own target', () => {
    useApp.getState().openRdp('srv-win')
    const [tab] = useApp.getState().tabs
    const tp = useApp.getState().panes[tab.id]
    expect(tp.panes).toHaveLength(1)
    expect(tp.panes[0].target).toEqual({ kind: 'rdp', serverId: 'srv-win' })
  })
})

describe('saving a server', () => {
  beforeEach(() => reset([]))

  it('keeps the RDP settings a new server was created with', () => {
    // `addServer` builds the record field by field rather than spreading its
    // input, so an optional field it does not name is dropped. The editor sent
    // `rdp` and the saved server came back without it, which made the feature
    // work only for servers that already existed.
    const id = useApp.getState().addServer({
      name: 'Win Box',
      host: 'win.example.test',
      username: 'admin',
      auth: 'password',
      rdp: { port: 3390, domain: 'CORP', nla: false }
    })
    const saved = useApp.getState().servers.find((s) => s.id === id)
    expect(saved?.rdp).toEqual({ port: 3390, domain: 'CORP', nla: false })
  })

  it('keeps the files-only flag a new server was created with', () => {
    // The same bug, on a field that predates RDP: a server saved with "Files
    // only" ticked came back without it, and the app opened a terminal against
    // an account with no shell — the exact failure the flag exists to prevent.
    const id = useApp.getState().addServer({
      name: 'Backup drop',
      host: 'drop.example.test',
      username: 'backup',
      sftpOnly: true
    })
    expect(useApp.getState().servers.find((s) => s.id === id)?.sftpOnly).toBe(true)
  })

  it('leaves both absent when they were not asked for', () => {
    // Absent, not false: `undefined` is what every consumer reads as "this
    // server does not do that", and a present-but-off record would offer the
    // menu entry anyway.
    const id = useApp.getState().addServer({ name: 'Plain', host: 'plain.example.test' })
    const saved = useApp.getState().servers.find((s) => s.id === id)
    expect(saved?.rdp).toBeUndefined()
    expect(saved?.sftpOnly).toBeUndefined()
  })
})
