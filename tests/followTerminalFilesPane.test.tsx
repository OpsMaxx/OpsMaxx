// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { SftpView } from '../src/renderer/src/components/panel/SftpView'
import { useApp } from '../src/renderer/src/store/app'
import { useToasts } from '../src/renderer/src/store/toast'
import { REMOTE_CWD_BOOTSTRAP } from '../src/shared/shellIntegration'
import type { Server } from '../src/renderer/src/types'

/**
 * The Files pane's half of "follow terminal".
 *
 * The shell half — whether a real zsh or bash actually emits OSC 7 — is
 * tests/followTerminalCwd.test.ts, against real shells. This file is the other
 * end of the same wire: given a directory in the store, does the pane move, and
 * when it cannot, does it say so instead of showing a toggle that does nothing.
 *
 * Two things here are regressions, not new behaviour:
 *
 *  - a `cd` pushed to a LOCAL pane went out over `ssh.write`. A local session id
 *    means nothing to the SSH session map, so main looked it up, found nothing
 *    and returned — the link was half dead in exactly the direction nobody
 *    checked, and no error was raised at either end.
 *  - the link button was rendered `active` whenever `linked` was true, which it
 *    is by default, in every session including the ones where following is
 *    impossible. That is the whole user report: the button looks on.
 */

const SERVER: Server = {
  id: 'srv-a',
  workspaceId: 'ws-default',
  folderId: null,
  name: 'alpha',
  host: 'alpha.example.internal',
  port: 22,
  username: 'ops',
  auth: 'key',
  status: 'online',
  tags: [],
  favorite: false,
  os: 'linux',
  route: [],
  vpnProfileId: null,
  demo: false
}

const TAB = 'tab-1'
const PANE = 'pane-1'

/** An SFTP namespace that connects, and lists whatever it is asked for. */
function sftpStub(): { listed: string[]; sftp: Record<string, unknown> } {
  const listed: string[] = []
  return {
    listed,
    sftp: {
      connect: vi.fn(async () => ({ ok: true, data: { home: '/home/ops' } })),
      list: vi.fn(async (_key: string, p: string) => {
        listed.push(p)
        return { ok: true, data: [] }
      }),
      onExternalSaved: vi.fn(() => () => {})
    }
  }
}

/** One terminal pane in the tab, of the given kind, with a live session. */
function givePane(target: { kind: 'local'; shellId: string } | { kind: 'ssh'; serverId: string }): void {
  act(() => {
    useApp.setState({
      panes: { [TAB]: { direction: 'v', panes: [{ id: PANE, target }], activePaneId: PANE } },
      tabSession: { [PANE]: 'sess-1' }
    })
  })
}

function setIntegration(on: boolean): void {
  act(() => {
    useApp.setState({ settings: { ...useApp.getState().settings, shellIntegration: on } })
  })
}

const followButton = (): HTMLButtonElement =>
  screen.getByLabelText('Follow terminal') as HTMLButtonElement

/** A remote pane starts unlinked (a local one linked); this toggles it. */
const link = (): void => act(() => followButton().click())

const cdButton = (): HTMLButtonElement =>
  screen.getByLabelText('cd terminal here') as HTMLButtonElement

const realSetTabView = useApp.getState().setTabView
beforeEach(() => {
  act(() => useApp.setState({ panes: {}, tabSession: {}, tabCwd: {} }))
})
afterEach(() => {
  act(() => useApp.setState({ setTabView: realSetTabView }))
})

describe('the pane moves when the shell does', () => {
  it('lists the directory the terminal reported', async () => {
    const { listed, sftp } = sftpStub()
    stubBridge({ sftp, ssh: { write: vi.fn() }, local: { write: vi.fn() } })
    setIntegration(true)
    givePane({ kind: 'local', shellId: 'sh-1' })

    render(<SftpView tabId={TAB} />)
    await waitFor(() => expect(listed).toContain('/home/ops'))

    // Exactly what the OSC 7 handler in useTerminalSession does with a path.
    act(() => useApp.getState().setTabCwd(PANE, '/var/log'))
    await waitFor(() => expect(listed).toContain('/var/log'))
  })

  it('stays where the user browsed instead of snapping back to the terminal', async () => {
    const { listed, sftp } = sftpStub()
    stubBridge({ sftp, ssh: { write: vi.fn() }, local: { write: vi.fn() } })
    setIntegration(true)
    givePane({ kind: 'local', shellId: 'sh-1' })

    render(<SftpView tabId={TAB} />)
    await waitFor(() => expect(listed).toContain('/home/ops'))
    act(() => useApp.getState().setTabCwd(PANE, '/var/log'))
    await waitFor(() => expect(listed).toContain('/var/log'))

    // Browsing no longer moves the terminal, so the two now disagree. That
    // must not read as "the terminal moved" and list /var/log again.
    act(() => screen.getByTitle('Root').click())
    await waitFor(() => expect(listed.at(-1)).toBe('/'))
    await new Promise((r) => setTimeout(r, 50))
    expect(listed.at(-1)).toBe('/')

    // A real move in the terminal still lands.
    act(() => useApp.getState().setTabCwd(PANE, '/etc'))
    await waitFor(() => expect(listed.at(-1)).toBe('/etc'))
  })
})

describe('browsing types nothing into the terminal', () => {
  // The user report: open a server's Files tab beside a terminal running Claude
  // Code, click into folders, and the bootstrap plus one `cd` per click landed
  // in Claude Code's input box. Following was on by default.
  it('sends nothing down the SSH session while unlinked', async () => {
    const { listed, sftp } = sftpStub()
    const sshWrite = vi.fn()
    stubBridge({ sftp, ssh: { write: sshWrite }, local: { write: vi.fn() } })
    givePane({ kind: 'ssh', serverId: SERVER.id })

    render(<SftpView server={SERVER} tabId={TAB} />)
    await waitFor(() => expect(listed).toContain('/home/ops'))
    act(() => {
      screen.getByTitle('Root').click()
    })
    await waitFor(() => expect(listed).toContain('/'))
    expect(sshWrite).not.toHaveBeenCalled()
  })

  it('sends nothing to a linked local shell either', async () => {
    const { listed, sftp } = sftpStub()
    const localWrite = vi.fn()
    stubBridge({ sftp, ssh: { write: vi.fn() }, local: { write: localWrite } })
    setIntegration(true)
    givePane({ kind: 'local', shellId: 'sh-1' })

    render(<SftpView tabId={TAB} />)
    await waitFor(() => expect(listed).toContain('/home/ops'))
    expect(followButton().getAttribute('aria-pressed')).toBe('true')
    act(() => screen.getByTitle('Root').click())
    await waitFor(() => expect(listed).toContain('/'))
    expect(localWrite).not.toHaveBeenCalled()
  })
})

describe('cd terminal here', () => {
  it('types one cd, unsubmitted, down the LOCAL channel and shows the terminal', async () => {
    const { listed, sftp } = sftpStub()
    const sshWrite = vi.fn()
    const localWrite = vi.fn()
    const setTabView = vi.fn()
    stubBridge({ sftp, ssh: { write: sshWrite }, local: { write: localWrite } })
    setIntegration(true)
    givePane({ kind: 'local', shellId: 'sh-1' })
    act(() => useApp.setState({ setTabView }))

    render(<SftpView tabId={TAB} />)
    await waitFor(() => expect(listed).toContain('/home/ops'))
    act(() => useApp.getState().setTabCwd(PANE, '/srv'))
    await waitFor(() => expect(listed.at(-1)).toBe('/srv'))
    act(() => cdButton().click())

    // No newline: the user sees it land and presses Enter.
    expect(localWrite).toHaveBeenCalledWith('sess-1', " cd '/srv'")
    expect(sshWrite).not.toHaveBeenCalled()
    expect(setTabView).toHaveBeenCalledWith(TAB, 'terminal')
  })

  it('works on an unlinked remote pane without sending the bootstrap', async () => {
    const { listed, sftp } = sftpStub()
    const sshWrite = vi.fn()
    stubBridge({ sftp, ssh: { write: sshWrite }, local: { write: vi.fn() } })
    givePane({ kind: 'ssh', serverId: SERVER.id })

    render(<SftpView server={SERVER} tabId={TAB} />)
    await waitFor(() => expect(listed).toContain('/home/ops'))
    act(() => cdButton().click())
    expect(sshWrite.mock.calls).toEqual([['sess-1', " cd '/home/ops'"]])
  })

  it('refuses a local shell that does not report its folder (cmd, PowerShell, WSL)', async () => {
    const { listed, sftp } = sftpStub()
    const localWrite = vi.fn()
    stubBridge({ sftp, ssh: { write: vi.fn() }, local: { write: localWrite } })
    setIntegration(true)
    givePane({ kind: 'local', shellId: 'sh-1' })

    render(<SftpView tabId={TAB} />)
    await waitFor(() => expect(listed).toContain('/home/ops'))
    expect(cdButton().getAttribute('aria-disabled')).toBe('true')
    act(() => cdButton().click())
    expect(localWrite).not.toHaveBeenCalled()
    expect(useToasts.getState().toasts.at(-1)?.message).toMatch(/reports its folder/i)
  })

  it('refuses, and says why, with no terminal in the tab', async () => {
    const { listed, sftp } = sftpStub()
    const localWrite = vi.fn()
    stubBridge({ sftp, ssh: { write: vi.fn() }, local: { write: localWrite } })
    setIntegration(true)

    render(<SftpView tabId={TAB} />)
    await waitFor(() => expect(listed).toContain('/home/ops'))
    expect(cdButton().getAttribute('aria-disabled')).toBe('true')
    act(() => cdButton().click())
    expect(localWrite).not.toHaveBeenCalled()
    expect(useToasts.getState().toasts.at(-1)?.message).toMatch(/no local shell open in this tab/i)
  })
})

describe('asking a remote shell to report', () => {
  it('types the bootstrap into an SSH session once, and never into a local one', async () => {
    const { listed, sftp } = sftpStub()
    const sshWrite = vi.fn()
    stubBridge({ sftp, ssh: { write: sshWrite }, local: { write: vi.fn() } })
    givePane({ kind: 'ssh', serverId: SERVER.id })

    const view = render(<SftpView server={SERVER} tabId={TAB} />)
    await waitFor(() => expect(listed).toContain('/home/ops'))
    link()
    await waitFor(() => expect(sshWrite).toHaveBeenCalledWith('sess-1', REMOTE_CWD_BOOTSTRAP))
    expect(sshWrite.mock.calls.filter((c) => c[1] === REMOTE_CWD_BOOTSTRAP)).toHaveLength(1)

    // A local pane is spawned by this app and instrumented at spawn; typing a
    // snippet into it would echo a line of shell at the user for nothing.
    view.unmount()
    const second = sftpStub()
    const localWrite = vi.fn()
    stubBridge({ sftp: second.sftp, ssh: { write: vi.fn() }, local: { write: localWrite } })
    setIntegration(true)
    givePane({ kind: 'local', shellId: 'sh-1' })
    render(<SftpView tabId={TAB} />)
    await waitFor(() => expect(second.listed).toContain('/home/ops'))
    expect(localWrite).not.toHaveBeenCalled()
  })

  it('says it asked, not that it failed, when linking a remote shell', async () => {
    const { listed, sftp } = sftpStub()
    stubBridge({ sftp, ssh: { write: vi.fn() }, local: { write: vi.fn() } })
    givePane({ kind: 'ssh', serverId: SERVER.id })
    act(() => useToasts.setState({ toasts: [] }))

    render(<SftpView server={SERVER} tabId={TAB} />)
    await waitFor(() => expect(listed).toContain('/home/ops'))
    link()
    const t = useToasts.getState().toasts.at(-1)
    expect(t?.kind).toBe('info')
    expect(t?.message).toMatch(/asked the shell/i)
  })

  it('types nothing into a pane focus moves to, until the link is clicked there', async () => {
    const { listed, sftp } = sftpStub()
    const sshWrite = vi.fn()
    stubBridge({ sftp, ssh: { write: sshWrite }, local: { write: vi.fn() } })
    const target = { kind: 'ssh' as const, serverId: SERVER.id }
    const focus = (activePaneId: string): void =>
      act(() => {
        useApp.setState({
          panes: {
            [TAB]: { direction: 'v', panes: [{ id: 'pa', target }, { id: 'pb', target }], activePaneId }
          },
          tabSession: { pa: 'sess-a', pb: 'sess-b' }
        })
      })
    focus('pa')

    render(<SftpView server={SERVER} tabId={TAB} />)
    await waitFor(() => expect(listed).toContain('/home/ops'))
    link()
    // Pane B may be running Claude Code. Focusing it is not a request.
    focus('pb')
    focus('pa')
    focus('pb')
    const sent = (s: string): number =>
      sshWrite.mock.calls.filter((c) => c[0] === s && c[1] === REMOTE_CWD_BOOTSTRAP).length
    expect(sent('sess-a')).toBe(1)
    expect(sent('sess-b')).toBe(0)
    expect(followButton().title).toMatch(/click to ask this shell/i)

    // Still linked, so the click asks B rather than unlinking.
    link()
    expect(sent('sess-b')).toBe(1)
    expect(followButton().getAttribute('aria-pressed')).toBe('true')
  })

  it('types nothing when the terminal reconnects under a new session', async () => {
    const { listed, sftp } = sftpStub()
    const sshWrite = vi.fn()
    stubBridge({ sftp, ssh: { write: sshWrite }, local: { write: vi.fn() } })
    givePane({ kind: 'ssh', serverId: SERVER.id })

    render(<SftpView server={SERVER} tabId={TAB} />)
    await waitFor(() => expect(listed).toContain('/home/ops'))
    link()
    expect(sshWrite).toHaveBeenCalledTimes(1)
    act(() => useApp.setState({ tabSession: { [PANE]: 'sess-2' } }))
    expect(sshWrite).toHaveBeenCalledTimes(1)
  })
})

describe('a remembered remote folder', () => {
  // tabCwd survives reconnects and restarts. A new shell behind it has never
  // been asked, so the stale folder must not pass for a followed one.
  it('is ignored until this session is asked, and linking asks it', async () => {
    const { listed, sftp } = sftpStub()
    const sshWrite = vi.fn()
    stubBridge({ sftp, ssh: { write: sshWrite }, local: { write: vi.fn() } })
    givePane({ kind: 'ssh', serverId: SERVER.id })
    act(() => useApp.setState({ tabCwd: { [PANE]: '/old/dir' } }))

    render(<SftpView server={SERVER} tabId={TAB} />)
    await waitFor(() => expect(listed).toContain('/home/ops'))
    expect(listed).not.toContain('/old/dir')
    link()
    expect(sshWrite).toHaveBeenCalledWith('sess-1', REMOTE_CWD_BOOTSTRAP)
  })
})

describe('a files-only account', () => {
  it('says there is no terminal, instead of waiting for one forever', async () => {
    const { listed, sftp } = sftpStub()
    const sshWrite = vi.fn()
    stubBridge({ sftp, ssh: { write: sshWrite }, local: { write: vi.fn() } })
    // initialPanes still gives the tab an ssh pane; no terminal ever starts.
    act(() => {
      useApp.setState({
        panes: { [TAB]: { direction: 'v', panes: [{ id: PANE, target: { kind: 'ssh', serverId: SERVER.id } }], activePaneId: PANE } },
        tabSession: {}
      })
    })

    render(<SftpView server={{ ...SERVER, sftpOnly: true }} tabId={TAB} />)
    await waitFor(() => expect(listed).toContain('/home/ops'))
    expect(followButton().getAttribute('aria-disabled')).toBe('true')
    expect(followButton().title).toMatch(/no terminal/i)
    expect(cdButton().title).toMatch(/no terminal/i)
    act(() => followButton().click())
    expect(sshWrite).not.toHaveBeenCalled()
  })
})

describe('the button does not claim to work when it cannot', () => {
  it('is disabled, and names the reason, when the tab has no terminal to follow', async () => {
    const { listed, sftp } = sftpStub()
    stubBridge({ sftp, ssh: { write: vi.fn() }, local: { write: vi.fn() } })
    setIntegration(true)
    // No panes at all: the Files tab is open on its own.

    render(<SftpView tabId={TAB} />)
    await waitFor(() => expect(listed).toContain('/home/ops'))

    const btn = followButton()
    expect(btn.getAttribute('aria-disabled')).toBe('true')
    expect(btn.className).not.toContain('active')
    expect(btn.title).toMatch(/no local shell open in this tab/i)

    // And clicking it explains rather than silently toggling a dead link.
    act(() => btn.click())
    expect(useToasts.getState().toasts[0]?.message).toMatch(/no local shell open in this tab/i)
    expect(btn.className).not.toContain('active')
  })

  it('is disabled, and offers the setting, when shell integration is off', async () => {
    const { listed, sftp } = sftpStub()
    stubBridge({ sftp, ssh: { write: vi.fn() }, local: { write: vi.fn() } })
    setIntegration(false)
    givePane({ kind: 'local', shellId: 'sh-1' })

    render(<SftpView tabId={TAB} />)
    await waitFor(() => expect(listed).toContain('/home/ops'))

    const btn = followButton()
    expect(btn.getAttribute('aria-disabled')).toBe('true')
    expect(btn.title).toMatch(/shell integration, which is off/i)

    act(() => btn.click())
    // With the one control that turns it on, not just a complaint.
    expect(useToasts.getState().toasts[0]?.action?.label).toMatch(/shell integration/i)
  })

  it('does not look active while a reachable shell has still said nothing', async () => {
    const { listed, sftp } = sftpStub()
    stubBridge({ sftp, ssh: { write: vi.fn() }, local: { write: vi.fn() } })
    setIntegration(true)
    givePane({ kind: 'local', shellId: 'sh-1' })

    render(<SftpView tabId={TAB} />)
    await waitFor(() => expect(listed).toContain('/home/ops'))

    // Linked by default, but nothing has been reported: it must not be lit.
    const waiting = followButton()
    expect(waiting.getAttribute('aria-disabled')).toBe('false')
    expect(waiting.className).not.toContain('active')
    expect(waiting.title).toMatch(/has not reported a directory/i)

    act(() => useApp.getState().setTabCwd(PANE, '/srv'))
    await waitFor(() => expect(followButton().className).toContain('active'))
    expect(followButton().title).toMatch(/following the terminal \(\/srv\)/i)
  })
})
