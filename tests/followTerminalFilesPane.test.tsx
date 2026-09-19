// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
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

beforeEach(() => {
  act(() => useApp.setState({ panes: {}, tabSession: {}, tabCwd: {} }))
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

  it('pushes cd to a LOCAL shell over the local channel, not the SSH one', async () => {
    const { listed, sftp } = sftpStub()
    const sshWrite = vi.fn()
    const localWrite = vi.fn()
    stubBridge({ sftp, ssh: { write: sshWrite }, local: { write: localWrite } })
    setIntegration(true)
    givePane({ kind: 'local', shellId: 'sh-1' })

    render(<SftpView tabId={TAB} />)
    await waitFor(() => expect(listed).toContain('/home/ops'))

    // The breadcrumb's root button is the cheapest real navigation there is.
    act(() => {
      screen.getByTitle('Root').click()
    })
    await waitFor(() => expect(localWrite).toHaveBeenCalled())
    expect(localWrite.mock.calls[0][1]).toContain('cd ')
    expect(sshWrite).not.toHaveBeenCalled()
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
