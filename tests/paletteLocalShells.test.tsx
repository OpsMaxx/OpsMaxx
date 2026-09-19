// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { CommandPalette } from '../src/renderer/src/components/palette/CommandPalette'
import { useApp } from '../src/renderer/src/store/app'
import type { LocalShell } from '../src/shared/local'
import type { Server, Workspace } from '../src/renderer/src/types'

/**
 * Ctrl+K on a local shell opened a new tab every time.
 *
 * A server named in this palette takes you to the tab already connected to it.
 * A shell named in the same palette, in the same list, spawned another one —
 * so someone bouncing between their editor and their shell with the keyboard
 * ended the morning with nine zsh tabs and no way to have noticed it happening.
 *
 * These render the real CommandPalette and click its real rows, then read the
 * store's real tabs. The failure this suite is written against is a test that
 * asserts the palette "calls focusOrOpenLocal" — that passes just as happily
 * against a row wired to a function that opens a tab regardless, which is
 * exactly the bug. What gets asserted here is the tab count and which tab is
 * active, which is what the user was complaining about.
 */

const zsh: LocalShell = {
  id: 'darwin-zsh-b663616e',
  label: 'zsh',
  kind: 'posix',
  path: '/bin/zsh',
  args: ['-l'],
  isDefault: true
}

// Same readable prefix, different path digest: two genuinely different shells
// that a test comparing anything parsed out of an id would merge.
const brewZsh: LocalShell = {
  id: 'darwin-zsh-11f4c0a2',
  label: 'zsh (homebrew)',
  kind: 'posix',
  path: '/opt/homebrew/bin/zsh',
  args: ['-l']
}

// The distro is the distinguishing part of a WSL id — the path is the same
// wsl.exe for every one of them (src/shared/local.ts).
const ubuntu: LocalShell = {
  id: 'wsl:Ubuntu-24.04',
  label: 'Ubuntu-24.04 (WSL)',
  kind: 'wsl',
  path: 'C:\\Windows\\System32\\wsl.exe',
  args: ['-d', 'Ubuntu-24.04']
}

const debian: LocalShell = {
  id: 'wsl:Debian',
  label: 'Debian (WSL)',
  kind: 'wsl',
  path: 'C:\\Windows\\System32\\wsl.exe',
  args: ['-d', 'Debian']
}

const web: Server = {
  id: 'srv-web',
  workspaceId: 'ws-default',
  folderId: null,
  name: 'web',
  host: 'example.test',
  port: 22,
  username: 'root',
  auth: 'key',
  status: 'offline',
  tags: [],
  favorite: false,
  os: 'Linux',
  route: [],
  vpnProfileId: null
}

const WORKSPACES: Workspace[] = [
  { id: 'ws-default', name: 'Personal', color: 'cyan', hidden: false, locked: false, hasPassword: false },
  { id: 'ws-other', name: 'Client', color: 'purple', hidden: false, locked: false, hasPassword: false }
]

function seed(shells: LocalShell[]): void {
  useApp.setState({
    tabs: [],
    activeTabId: null,
    panes: {},
    tabSession: {},
    tabCwd: {},
    servers: [web],
    localShells: shells,
    workspaces: WORKSPACES,
    activeWorkspaceId: 'ws-default'
  })
}

/** One palette row, found the way a reader finds it: by the name on it. */
function row(container: HTMLElement, title: string): HTMLElement {
  const hit = [...container.querySelectorAll('.palette-item')].find(
    (el) => el.querySelector('.p-title')?.textContent === title
  )
  expect(hit, `the palette has no entry named "${title}"`).toBeTruthy()
  return hit as HTMLElement
}

function rowOrNull(container: HTMLElement, title: string): Element | undefined {
  return [...container.querySelectorAll('.palette-item')].find(
    (el) => el.querySelector('.p-title')?.textContent === title
  )
}

const tabs = (): ReturnType<typeof useApp.getState>['tabs'] => useApp.getState().tabs

beforeEach(() => {
  stubBridge({})
  seed([zsh, brewZsh])
})

describe('a local shell in the palette behaves like a server in the palette', () => {
  it('focuses the open tab instead of opening a second one', async () => {
    useApp.getState().openLocal(zsh)
    const first = tabs()[0]
    // Somewhere else, so "still active" cannot be mistaken for "never moved".
    useApp.getState().openLocal(brewZsh)
    expect(useApp.getState().activeTabId).not.toBe(first.id)

    const { container } = render(<CommandPalette />)
    await userEvent.click(row(container, 'zsh'))

    expect(tabs()).toHaveLength(2)
    expect(useApp.getState().activeTabId).toBe(first.id)
  })

  it('is the same behaviour the server row has, side by side', async () => {
    // The user's report was the inconsistency, not either half on its own, so
    // both halves are exercised in one test against one palette.
    useApp.getState().openServer(web.id)
    useApp.getState().openLocal(zsh)
    const [serverTab, shellTab] = tabs()

    const { container } = render(<CommandPalette />)
    await userEvent.click(row(container, 'web'))
    expect(tabs()).toHaveLength(2)
    expect(useApp.getState().activeTabId).toBe(serverTab.id)

    const second = render(<CommandPalette />)
    await userEvent.click(row(second.container, 'zsh'))
    expect(tabs()).toHaveLength(2)
    expect(useApp.getState().activeTabId).toBe(shellTab.id)
  })

  it('opens a tab when there is not one yet', async () => {
    const { container } = render(<CommandPalette />)
    await userEvent.click(row(container, 'zsh'))

    expect(tabs()).toHaveLength(1)
    expect(tabs()[0]).toMatchObject({ kind: 'local', shellId: zsh.id })
  })
})

describe('what counts as the same shell', () => {
  it('tells two shells apart by their whole id, not by their label', async () => {
    useApp.getState().openLocal(zsh)

    const { container } = render(<CommandPalette />)
    await userEvent.click(row(container, 'zsh (homebrew)'))

    // /bin/zsh is not /opt/homebrew/bin/zsh. Focusing the first would hand the
    // user a different binary under the name they asked for.
    expect(tabs()).toHaveLength(2)
    expect(tabs()[1]).toMatchObject({ shellId: brewZsh.id })
  })

  it('tells two WSL distributions apart', async () => {
    seed([ubuntu, debian])
    useApp.getState().openLocal(ubuntu)

    const { container } = render(<CommandPalette />)
    await userEvent.click(row(container, 'Debian (WSL)'))

    // Same wsl.exe, same kind, different machine. Identity that stopped at
    // "wsl" would have focused Ubuntu.
    expect(tabs()).toHaveLength(2)
    expect(tabs()[1]).toMatchObject({ shellId: debian.id })

    // And the one that IS Ubuntu still focuses.
    const again = render(<CommandPalette />)
    await userEvent.click(row(again.container, 'Ubuntu-24.04 (WSL)'))
    expect(tabs()).toHaveLength(2)
    expect(useApp.getState().activeTabId).toBe(tabs()[0].id)
  })

  it('does not hand back a shell that was started somewhere else', async () => {
    // The palette asks for a shell in its default directory. A tab started in
    // /srv/app is a different session doing different work.
    useApp.getState().openLocal(zsh, '/srv/app')

    const { container } = render(<CommandPalette />)
    await userEvent.click(row(container, 'zsh'))

    expect(tabs()).toHaveLength(2)
    const fresh = tabs()[1]
    expect(fresh.kind).toBe('local')
    expect(fresh.kind === 'local' && fresh.cwd).toBeUndefined()
  })

  it('does not focus a tab in a workspace the user cannot see', async () => {
    useApp.setState({ activeWorkspaceId: 'ws-other' })
    useApp.getState().openLocal(zsh)
    useApp.setState({ activeWorkspaceId: 'ws-default' })

    const { container } = render(<CommandPalette />)
    await userEvent.click(row(container, 'zsh'))

    // The strip shows one workspace's tabs, so focusing the other one's would
    // look like the palette did nothing at all.
    expect(tabs()).toHaveLength(2)
    expect(tabs()[1].workspaceId).toBe('ws-default')
    expect(useApp.getState().activeTabId).toBe(tabs()[1].id)
  })
})

describe('a second shell is still one keystroke away', () => {
  it('offers an explicit additional-session row once a shell is open', async () => {
    const before = render(<CommandPalette />)
    // Nothing open yet: the plain row already opens a new shell, so a second
    // row saying the same thing would be noise.
    expect(rowOrNull(before.container, 'New zsh Session')).toBeUndefined()
    before.unmount()

    useApp.getState().openLocal(zsh)
    const { container } = render(<CommandPalette />)
    await userEvent.click(row(container, 'New zsh Session'))

    expect(tabs()).toHaveLength(2)
    expect(tabs().map((t) => t.title)).toEqual(['zsh', 'zsh (2)'])
    expect(useApp.getState().activeTabId).toBe(tabs()[1].id)
  })

  it('leaves Duplicate Current Tab working on a local tab', async () => {
    // The palette's existing escape hatch for "another one of these", which is
    // what the Servers group has always relied on.
    useApp.getState().openLocal(zsh, '/srv/app')

    const { container } = render(<CommandPalette />)
    await userEvent.click(row(container, 'Duplicate Current Tab'))

    expect(tabs()).toHaveLength(2)
    expect(tabs()[1]).toMatchObject({ kind: 'local', shellId: zsh.id, cwd: '/srv/app' })
  })
})
