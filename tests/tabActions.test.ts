import { describe, it, expect, beforeEach } from 'vitest'
import { useApp } from '../src/renderer/src/store/app'
import type { LocalShell } from '../src/shared/local'

/**
 * The tab actions, driven through the real store.
 *
 * lib/tabs.ts proves the rules in isolation; this proves they are actually
 * WIRED — that reorder translates between visible and absolute positions, that
 * every close route feeds the reopen stack, and that a reopened tab comes back
 * with pane state rather than as a record nothing can render.
 */

const shell = (id: string, label: string): LocalShell => ({
  id,
  label,
  kind: 'posix',
  path: `/bin/${label}`,
  args: [],
  isDefault: false
})

const zsh = shell('darwin-zsh-1', 'zsh')
const bash = shell('darwin-bash-2', 'bash')

const ws = (id: string, name: string): NonNullable<ReturnType<typeof useApp.getState>['workspaces']>[number] => ({
  id,
  name,
  color: 'cyan',
  hidden: false,
  locked: false,
  hasPassword: false
})

const reset = (): void => {
  useApp.setState({
    tabs: [],
    activeTabId: null,
    closedTabs: [],
    tabSession: {},
    tabCwd: {},
    panes: {},
    servers: [],
    localShells: [zsh, bash],
    workspaces: [ws('ws-a', 'A'), ws('ws-b', 'B')],
    activeWorkspaceId: 'ws-a'
  })
}

const titles = (): string[] => useApp.getState().tabs.map((t) => t.title)
const visible = (): string[] =>
  useApp
    .getState()
    .tabs.filter((t) => t.workspaceId === useApp.getState().activeWorkspaceId)
    .map((t) => t.title)

/** Three local tabs in the active workspace, named for their shell. */
const openThree = (): void => {
  const s = useApp.getState()
  s.openLocal(zsh) // zsh
  s.openLocal(bash) // bash
  s.openLocal(zsh) // zsh (2)
}

describe('naming sessions, through the store', () => {
  beforeEach(reset)

  it('numbers repeats on the same shell', () => {
    openThree()
    expect(titles()).toEqual(['zsh', 'bash', 'zsh (2)'])
  })

  /**
   * Numbering is per workspace, because the strip is.
   *
   * Counting across every workspace made the FIRST bash in this workspace
   * "bash (2)" on the strength of a bash on a screen the user is not looking
   * at — a name that reads as a mistake and points at nothing visible.
   */
  it('numbers within the workspace, not across all of them', () => {
    useApp.setState({ activeWorkspaceId: 'ws-b' })
    useApp.getState().openLocal(bash)
    useApp.setState({ activeWorkspaceId: 'ws-a' })
    useApp.getState().openLocal(bash)
    expect(visible()).toEqual(['bash'])
  })

  /**
   * The collision the old counting version produced: open zsh, zsh (2),
   * zsh (3); close zsh (2); the count is two, so the next is named "zsh (3)"
   * and two tabs share one name.
   */
  it('reuses the gap a closed session left instead of colliding', () => {
    const s = useApp.getState()
    s.openLocal(zsh)
    s.openLocal(zsh)
    s.openLocal(zsh)
    expect(titles()).toEqual(['zsh', 'zsh (2)', 'zsh (3)'])

    const second = useApp.getState().tabs[1].id
    useApp.getState().closeTab(second)
    useApp.getState().openLocal(zsh)

    const now = titles()
    expect(now).toEqual(['zsh', 'zsh (3)', 'zsh (2)'])
    expect(new Set(now).size).toBe(now.length)
  })
})

describe('reordering', () => {
  beforeEach(reset)

  it('moves a tab to the position it was dropped on', () => {
    openThree()
    const first = useApp.getState().tabs[0].id
    useApp.getState().moveTab(first, 2)
    expect(visible()).toEqual(['bash', 'zsh (2)', 'zsh'])
  })

  /**
   * The strip renders ONE workspace, so a drop index is an index into that
   * workspace's tabs while `tabs` holds every workspace's. Without the
   * translation a drag reorders tabs on another screen, or lands this one
   * among them.
   */
  it('leaves other workspaces untouched, and keeps their order', () => {
    const s = useApp.getState()
    s.openLocal(zsh) // ws-a: zsh
    useApp.setState({ activeWorkspaceId: 'ws-b' })
    useApp.getState().openLocal(bash) // ws-b: bash
    useApp.getState().openLocal(zsh) // ws-b: zsh
    useApp.setState({ activeWorkspaceId: 'ws-a' })
    useApp.getState().openLocal(bash) // ws-a: bash

    const before = useApp
      .getState()
      .tabs.filter((t) => t.workspaceId === 'ws-b')
      .map((t) => t.title)

    const firstOfA = useApp.getState().tabs.find((t) => t.workspaceId === 'ws-a')!.id
    useApp.getState().moveTab(firstOfA, 1)

    expect(visible()).toEqual(['bash', 'zsh'])
    expect(
      useApp
        .getState()
        .tabs.filter((t) => t.workspaceId === 'ws-b')
        .map((t) => t.title)
    ).toEqual(before)
  })

  it('ignores a tab that does not exist', () => {
    openThree()
    const before = visible()
    useApp.getState().moveTab('nope', 0)
    expect(visible()).toEqual(before)
  })
})

describe('selecting by number', () => {
  beforeEach(reset)

  it('goes to the nth visible tab, and 9 to the last', () => {
    openThree()
    useApp.getState().selectTabByNumber(1)
    expect(useApp.getState().activeTab()?.title).toBe('zsh')
    useApp.getState().selectTabByNumber(9)
    expect(useApp.getState().activeTab()?.title).toBe('zsh (2)')
  })

  it('does nothing when that position is empty', () => {
    openThree()
    useApp.getState().selectTabByNumber(1)
    useApp.getState().selectTabByNumber(7)
    expect(useApp.getState().activeTab()?.title).toBe('zsh')
  })

  // Counting the array rather than the visible list would jump to a tab on
  // another screen, blanking the panel.
  it('counts only the active workspace', () => {
    useApp.getState().openLocal(zsh)
    useApp.setState({ activeWorkspaceId: 'ws-b' })
    useApp.getState().openLocal(bash)
    useApp.getState().selectTabByNumber(1)
    expect(useApp.getState().activeTab()?.title).toBe('bash')
  })
})

describe('reopening a closed tab', () => {
  beforeEach(reset)

  it('puts it back where it was, and makes it active', () => {
    openThree()
    const middle = useApp.getState().tabs[1].id
    useApp.getState().closeTab(middle)
    expect(visible()).toEqual(['zsh', 'zsh (2)'])

    useApp.getState().reopenClosedTab()
    expect(visible()).toEqual(['zsh', 'bash', 'zsh (2)'])
    expect(useApp.getState().activeTab()?.title).toBe('bash')
  })

  // A tab with no panes is not renderable — reopening a bare record would put
  // an empty frame on screen.
  it('comes back with pane state', () => {
    openThree()
    useApp.getState().closeTab(useApp.getState().tabs[0].id)
    useApp.getState().reopenClosedTab()
    const tab = useApp.getState().activeTab()!
    expect(useApp.getState().panes[tab.id]?.panes).toHaveLength(1)
  })

  // The old id keyed pane state that was pruned on close; reusing it would let
  // a stale entry attach itself to the new tab.
  it('gives the reopened tab a fresh id', () => {
    openThree()
    const closed = useApp.getState().tabs[0].id
    useApp.getState().closeTab(closed)
    useApp.getState().reopenClosedTab()
    expect(useApp.getState().tabs.some((t) => t.id === closed)).toBe(false)
  })

  it('walks back a bulk close one tab at a time, newest first', () => {
    openThree()
    const keep = useApp.getState().tabs[0].id
    useApp.getState().closeOtherTabs(keep)
    expect(visible()).toEqual(['zsh'])

    useApp.getState().reopenClosedTab()
    useApp.getState().reopenClosedTab()
    expect(visible()).toEqual(['zsh', 'bash', 'zsh (2)'])
  })

  it('does nothing when nothing has been closed', () => {
    openThree()
    const before = visible()
    useApp.getState().reopenClosedTab()
    expect(visible()).toEqual(before)
  })

  /**
   * Reopening into a workspace that is not on screen would appear to do
   * nothing while consuming the undo — the worst of both outcomes.
   */
  it('will not reopen into a workspace the user has left', () => {
    useApp.getState().openLocal(zsh)
    const onA = useApp.getState().tabs[0].id
    useApp.getState().closeTab(onA)

    useApp.setState({ activeWorkspaceId: 'ws-b' })
    useApp.getState().reopenClosedTab()
    expect(useApp.getState().tabs).toHaveLength(0)

    // And it is still there when the user goes back.
    useApp.setState({ activeWorkspaceId: 'ws-a' })
    useApp.getState().reopenClosedTab()
    expect(visible()).toEqual(['zsh'])
  })

  it('is bounded, so a long session cannot grow it without limit', () => {
    for (let i = 0; i < 30; i++) {
      useApp.getState().openLocal(zsh)
      useApp.getState().closeTab(useApp.getState().tabs[0].id)
    }
    expect(useApp.getState().closedTabs.length).toBeLessThanOrEqual(10)
  })
})

describe('which tab takes over on close, through the store', () => {
  beforeEach(reset)

  it('takes the one on the right', () => {
    openThree()
    useApp.getState().setActiveTab(useApp.getState().tabs[1].id)
    useApp.getState().closeTab(useApp.getState().tabs[1].id)
    expect(useApp.getState().activeTab()?.title).toBe('zsh (2)')
  })

  it('falls back left at the end of the strip', () => {
    openThree()
    useApp.getState().closeTab(useApp.getState().tabs[2].id)
    expect(useApp.getState().activeTab()?.title).toBe('bash')
  })

  it('ends with nothing active when the last tab goes', () => {
    useApp.getState().openLocal(zsh)
    useApp.getState().closeTab(useApp.getState().tabs[0].id)
    expect(useApp.getState().activeTabId).toBeNull()
  })
})
