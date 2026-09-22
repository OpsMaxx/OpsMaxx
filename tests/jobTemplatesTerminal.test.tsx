// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { stubBridge } from './setup/renderer'
import { CommandPalette } from '../src/renderer/src/components/palette/CommandPalette'
import {
  PasteConfirm,
  pasteEffect,
  useTerminalPasteRequest
} from '../src/renderer/src/components/terminal/PasteConfirm'
import { useApp } from '../src/renderer/src/store/app'
import { defaultModuleState } from '../src/shared/modules'
import type { JobTemplate } from '../src/shared/jobCompose'
import type { Server } from '../src/renderer/src/types'

// "Run in this terminal" from a saved job template. The palette row REQUESTS
// the paste confirmation and writes nothing; the pane shows every line, one
// line included; only the confirmation's button sends anything.

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

const oneLiner: JobTemplate = {
  id: 'tpl-1',
  name: 'Reload nginx',
  steps: '# a note, never pasted\nsystemctl reload nginx',
  rollback: '',
  rebootLast: false,
  updatedAt: 1
}

// Every way the renderer could put bytes into a shell. None may be called by
// choosing the template.
const writes = { ssh: vi.fn(), local: vi.fn() }

beforeEach(() => {
  writes.ssh.mockReset()
  writes.local.mockReset()
  stubBridge({
    jobTemplates: { list: vi.fn(async () => ({ templates: [oneLiner], problem: null, path: '/x' })) },
    ssh: { write: writes.ssh },
    local: { write: writes.local }
  })
  useApp.setState((s) => ({
    servers: [web],
    tabs: [],
    panes: {},
    activeWorkspaceId: 'ws-default',
    pasteRequest: null,
    pasteTargets: {},
    settings: { ...s.settings, modules: { ...defaultModuleState(), jobs: true } }
  }))
  useApp.getState().openServer(web.id, 'terminal')
  // The live RealTerminal a real app would have mounted for that tab.
  useApp.setState({ pasteTargets: { [activePane()]: true } })
})

function activePane(): string {
  const tab = useApp.getState().tabs[0]
  return useApp.getState().panes[tab.id]?.activePaneId ?? tab.id
}

function row(container: HTMLElement, title: string): Element | undefined {
  return [...container.querySelectorAll('.palette-item')].find(
    (el) => el.querySelector('.p-title')?.textContent === title
  )
}

describe('run a saved template in this terminal', () => {
  it('requests the confirmation for the active pane and writes nothing', async () => {
    const { container } = render(<CommandPalette />)
    await waitFor(() => expect(row(container, 'Run in this terminal: Reload nginx')).toBeTruthy())
    await userEvent.click(row(container, 'Run in this terminal: Reload nginx') as HTMLElement)

    expect(useApp.getState().pasteRequest).toMatchObject({ paneId: activePane(), text: 'systemctl reload nginx' })
    expect(writes.ssh).not.toHaveBeenCalled()
    expect(writes.local).not.toHaveBeenCalled()
  })

  it('is not offered with the Jobs module off', async () => {
    useApp.setState((s) => ({ settings: { ...s.settings, modules: defaultModuleState() } }))
    const { container } = render(<CommandPalette />)
    await new Promise((r) => setTimeout(r, 0))
    expect(row(container, 'Run in this terminal: Reload nginx')).toBeUndefined()
  })

  it('shows every line, a single one included, and sends only on confirm', async () => {
    const paste = vi.fn()
    // TerminalView's wiring, minus xterm: the hook opens PasteConfirm and the
    // confirm button is the only thing that pastes.
    function Pane(): React.JSX.Element | null {
      const [text, setText] = useState<string | null>(null)
      useTerminalPasteRequest('pane-1', true, setText)
      return text === null ? null : (
        <PasteConfirm
          text={text}
          lines={text.split('\n').length}
          server="web"
          full
          onCancel={() => setText(null)}
          onConfirm={() => paste(text)}
        />
      )
    }
    const long = Array.from({ length: 20 }, (_, i) => `echo ${i}`).join('\n')

    render(<Pane />)
    useApp.getState().requestTerminalPaste('pane-1', 'systemctl reload nginx')
    await screen.findByText('Paste 1 line into web?')
    expect(screen.getByText('systemctl reload nginx')).toBeTruthy()
    // Consumed, so a remount does not ask again.
    expect(useApp.getState().pasteRequest).toBeNull()
    expect(paste).not.toHaveBeenCalled()

    await userEvent.click(screen.getByText('Cancel'))
    expect(paste).not.toHaveBeenCalled()

    useApp.getState().requestTerminalPaste('pane-1', long)
    await screen.findByText('Paste 20 lines into web?')
    // All twenty, not the first twelve a clipboard paste previews.
    expect(document.querySelector('.paste-preview')?.textContent).toBe(long)
    expect(paste).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: /^Paste$/ }))
    expect(paste).toHaveBeenCalledWith(long)
  })

  it('ignores a request for another pane', async () => {
    const open = vi.fn()
    function Pane(): null {
      useTerminalPasteRequest('pane-1', true, open)
      return null
    }
    render(<Pane />)
    act(() => useApp.setState({ pasteRequest: { paneId: 'pane-2', text: 'rm -rf /', nonce: 1 } }))
    await new Promise((r) => setTimeout(r, 0))
    expect(open).not.toHaveBeenCalled()
    expect(useApp.getState().pasteRequest).not.toBeNull()
  })

  it('is not offered for a pane that is not a live session', async () => {
    // A demo shell never registers; a dead or dormant one withdraws.
    useApp.setState({ pasteTargets: {} })
    const { container } = render(<CommandPalette />)
    await new Promise((r) => setTimeout(r, 0))
    expect(row(container, 'Run in this terminal: Reload nginx')).toBeUndefined()
  })

  it('never leaves a request waiting for a pane that is not a target', () => {
    useApp.getState().requestTerminalPaste('no-such-pane', 'rm -rf /')
    expect(useApp.getState().pasteRequest).toBeNull()
  })

  it('withdraws when its session dies, and drops a request that races the death', async () => {
    const open = vi.fn()
    function Pane({ live }: { live: boolean }): null {
      useTerminalPasteRequest('pane-1', live, open)
      return null
    }
    const view = render(<Pane live />)
    expect(useApp.getState().pasteTargets['pane-1']).toBe(true)

    view.rerender(<Pane live={false} />)
    expect(useApp.getState().pasteTargets['pane-1']).toBeUndefined()
    act(() => useApp.setState({ pasteRequest: { paneId: 'pane-1', text: 'reboot', nonce: 9 } }))
    await new Promise((r) => setTimeout(r, 0))
    expect(open).not.toHaveBeenCalled()
    expect(useApp.getState().pasteRequest).toBeNull()

    view.unmount()
    expect(useApp.getState().pasteTargets).not.toHaveProperty('pane-1')
  })
})

describe('the confirmation says what pasting will do', () => {
  it('names each of the three behaviours, not only the alarming one', () => {
    expect(pasteEffect('a\nb', true)).toBe('Nothing runs until you press Enter')
    expect(pasteEffect('a\nb\n', true)).toBe('Nothing runs until you press Enter')
    expect(pasteEffect('a\nb\n', false)).toBe('Every line runs as soon as it is pasted')
    expect(pasteEffect('a\nb', false)).toBe('All but the last line run now; the last waits for Enter')
    expect(pasteEffect('a', false)).toBe('It waits for you to press Enter')
  })

  it('does not call a shell on this computer remote', () => {
    const noop = (): void => {}
    render(<PasteConfirm text="ls" lines={1} server="zsh" local full onConfirm={noop} onCancel={noop} />)
    expect(screen.getByText(/This is a shell on this computer/)).toBeTruthy()
    expect(screen.queryByText(/remote shell/)).toBeNull()
  })

  it('says "Paste", not "Paste and run", when nothing will run on paste', () => {
    const noop = (): void => {}
    render(<PasteConfirm text={'a\nb'} lines={2} server="web" bracketed onConfirm={noop} onCancel={noop} />)
    expect(screen.getByText('Nothing runs until you press Enter')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Paste$/ })).toBeTruthy()
  })
})

describe('the Enter that chose the template does not also confirm it', () => {
  it('writes nothing when Enter is pressed twice through the palette', async () => {
    const paste = vi.fn()
    function Pane(): React.JSX.Element | null {
      const [text, setText] = useState<string | null>(null)
      useTerminalPasteRequest(activePane(), true, setText)
      return text === null ? null : (
        <PasteConfirm
          text={text}
          lines={1}
          server="web"
          full
          onCancel={() => setText(null)}
          onConfirm={() => paste(text)}
        />
      )
    }
    const { container } = render(
      <>
        <Pane />
        <CommandPalette />
      </>
    )
    await waitFor(() => expect(row(container, 'Run in this terminal: Reload nginx')).toBeTruthy())
    await userEvent.type(container.querySelector('.palette-input input') as HTMLElement, 'Run in this terminal')
    // The first Enter runs the palette entry; the second -- a key repeat, or a
    // second tap -- lands on whatever the dialog focused.
    await userEvent.keyboard('{Enter}')
    await screen.findByText('Paste 1 line into web?')
    await userEvent.keyboard('{Enter}')
    expect(paste).not.toHaveBeenCalled()
    expect(writes.ssh).not.toHaveBeenCalled()
  })
})
