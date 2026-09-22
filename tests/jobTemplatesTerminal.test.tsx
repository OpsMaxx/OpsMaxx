// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { stubBridge } from './setup/renderer'
import { CommandPalette } from '../src/renderer/src/components/palette/CommandPalette'
import {
  PasteConfirm,
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
    jobTemplates: { list: vi.fn(async () => [oneLiner]) },
    ssh: { write: writes.ssh },
    local: { write: writes.local }
  })
  useApp.setState((s) => ({
    servers: [web],
    tabs: [],
    panes: {},
    activeWorkspaceId: 'ws-default',
    pasteRequest: null,
    settings: { ...s.settings, modules: { ...defaultModuleState(), jobs: true } }
  }))
  useApp.getState().openServer(web.id, 'terminal')
})

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

    const tab = useApp.getState().tabs[0]
    const pane = useApp.getState().panes[tab.id]?.activePaneId ?? tab.id
    expect(useApp.getState().pasteRequest).toMatchObject({ paneId: pane, text: 'systemctl reload nginx' })
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
      useTerminalPasteRequest('pane-1', setText)
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

    await userEvent.click(screen.getByText('Paste and run'))
    expect(paste).toHaveBeenCalledWith(long)
  })

  it('ignores a request for another pane', async () => {
    const open = vi.fn()
    function Pane(): null {
      useTerminalPasteRequest('pane-1', open)
      return null
    }
    render(<Pane />)
    useApp.getState().requestTerminalPaste('pane-2', 'rm -rf /')
    await new Promise((r) => setTimeout(r, 0))
    expect(open).not.toHaveBeenCalled()
    expect(useApp.getState().pasteRequest).not.toBeNull()
  })
})
