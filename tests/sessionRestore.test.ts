import { describe, expect, it, beforeEach } from 'vitest'
import { useApp } from '../src/renderer/src/store/app'

/**
 * The window, remembered across restarts.
 *
 * Nothing survived a launch: `persist.ts` wrote workspaces, servers, tunnels
 * and settings, and the tab slice was touched by neither `save()` nor
 * `replaceAll`. Warp, iTerm2 and tmux all restore, so the first minute of every
 * session was rebuilding a layout the app had just discarded.
 *
 * The constraint that shapes the whole feature: every tab is MOUNTED at once --
 * background tabs are hidden with `display: none` rather than unmounted, so
 * switching workspaces does not kill their sessions. Restoring tabs and
 * dialling the estate are therefore the same act unless something stops it, and
 * an app that opens eight authenticated sessions because it launched has made a
 * decision that is not its to make.
 */

const WS = 'ws-1'
const SRV = 'srv-1'

const base = {
  workspaces: [{ id: WS, name: 'Personal' }],
  servers: [{ id: SRV, name: 'Web01', workspaceId: WS }],
  settings: {}
} as never

beforeEach(() => {
  useApp.setState({ tabs: [], activeTabId: null, panes: {}, tabSession: {} } as never)
})

const tab = (id: string, over: Record<string, unknown> = {}): unknown => ({
  id,
  kind: 'ssh',
  workspaceId: WS,
  serverId: SRV,
  title: 'Web01',
  view: 'terminal',
  ...over
})

describe('restoring the window', () => {
  it('brings the tabs back', () => {
    useApp.getState().replaceAll({ ...(base as object), tabs: [tab('t1'), tab('t2')], activeTabId: 't2' } as never)
    const s = useApp.getState()
    expect(s.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(s.activeTabId).toBe('t2')
  })

  it('brings them back dormant, so nothing dials on launch', () => {
    useApp.getState().replaceAll({ ...(base as object), tabs: [tab('t1')] } as never)
    expect(useApp.getState().tabs[0].dormant).toBe(true)
  })

  it('never restores a shell id from a process that has exited', () => {
    // A stale id matches nothing, or -- worse -- matches something new.
    useApp.setState({ tabSession: { t1: 'shell-from-last-run' } } as never)
    useApp.getState().replaceAll({ ...(base as object), tabs: [tab('t1')] } as never)
    expect(useApp.getState().tabSession).toEqual({})
  })

  it('drops a tab whose server is gone', () => {
    // It could only ever render "Session unavailable".
    useApp
      .getState()
      .replaceAll({ ...(base as object), tabs: [tab('t1'), tab('t2', { serverId: 'deleted' })] } as never)
    expect(useApp.getState().tabs.map((t) => t.id)).toEqual(['t1'])
  })

  it('drops a tab whose workspace is gone', () => {
    useApp
      .getState()
      .replaceAll({ ...(base as object), tabs: [tab('t1', { workspaceId: 'gone' })] } as never)
    expect(useApp.getState().tabs).toEqual([])
  })

  it('keeps a local tab, which needs no server', () => {
    useApp.getState().replaceAll({
      ...(base as object),
      tabs: [tab('t1', { kind: 'local', serverId: undefined, shellId: 'zsh' })]
    } as never)
    expect(useApp.getState().tabs).toHaveLength(1)
  })

  it('re-points the active tab when the one in front did not survive', () => {
    useApp.getState().replaceAll({
      ...(base as object),
      tabs: [tab('t1'), tab('gone', { serverId: 'deleted' })],
      activeTabId: 'gone'
    } as never)
    expect(useApp.getState().activeTabId).toBe('t1')
  })

  it('drops pane layouts belonging to tabs that did not survive', () => {
    useApp.getState().replaceAll({
      ...(base as object),
      tabs: [tab('t1')],
      panes: {
        t1: { direction: 'v', activePaneId: 'p1', panes: [{ id: 'p1' }] },
        ghost: { direction: 'v', activePaneId: 'p9', panes: [{ id: 'p9' }] }
      }
    } as never)
    expect(Object.keys(useApp.getState().panes)).toEqual(['t1'])
  })

  it('leaves the window alone when a save predates the feature', () => {
    // Saves written before this have no `tabs` key at all, and must not be
    // read as "the user had no tabs".
    useApp.setState({ tabs: [tab('live')] } as never)
    useApp.getState().replaceAll(base)
    expect(useApp.getState().tabs.map((t) => t.id)).toEqual(['live'])
  })
})

describe('waking a restored tab', () => {
  it('clears the flag so a later drop is an ordinary reconnect', () => {
    useApp.getState().replaceAll({ ...(base as object), tabs: [tab('t1')] } as never)
    useApp.getState().wakeTab('t1')
    expect(useApp.getState().tabs[0].dormant).toBeUndefined()
  })
})
