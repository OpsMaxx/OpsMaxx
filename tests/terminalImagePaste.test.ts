// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { stubBridge } from './setup/renderer'
import { setupTerminalUX } from '../src/renderer/src/hooks/useTerminalSession'
import { containerTransport, sshTransport } from '../src/renderer/src/lib/transport'
import type { Server } from '../src/renderer/src/types'

// Claude Code on a server reads the server's clipboard, so an image copied here
// never reached it. A remote terminal now offers the image instead: from any
// paste that finds no text, and from Ctrl+V, which is Claude Code's own key for
// an image. Text paste is the path tests/pasteLineBreaks.test.ts guards; these
// check it is untouched when an image route is present.

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function mount(clip: string, offer?: boolean): {
  onImage: ReturnType<typeof vi.fn> | undefined
  written: ReturnType<typeof vi.fn>
  input: ReturnType<typeof vi.fn>
  confirm: ReturnType<typeof vi.fn>
  key: (e: KeyboardEvent) => boolean
  host: HTMLDivElement
  dispose: () => void
} {
  stubBridge({ clipboard: { read: vi.fn(async () => clip), write: vi.fn() } })
  const written = vi.fn()
  const input = vi.fn()
  let key: (e: KeyboardEvent) => boolean = () => true
  const term = {
    getSelection: () => '',
    onSelectionChange: () => ({ dispose: () => {} }),
    attachCustomKeyEventHandler: (h: (e: KeyboardEvent) => boolean) => {
      key = h
    },
    paste: written,
    input
  } as unknown as Terminal
  const host = document.createElement('div')
  const confirm = vi.fn()
  const onImage = offer === undefined ? undefined : vi.fn(async () => offer)
  const dispose = setupTerminalUX(term, host, undefined, confirm, onImage)
  return { onImage, written, input, confirm, key: (e) => key(e), host, dispose }
}

const ctrlV = (): KeyboardEvent =>
  new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: true, cancelable: true })

function pasteEvent(target: HTMLElement, text: string): void {
  const ev = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/plain' ? text : '') }
  })
  target.dispatchEvent(ev)
}

describe('a paste with no text', () => {
  it('offers the image, from right-click, the shortcut and a paste event alike', async () => {
    const t = mount('', true)
    t.host.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await settle()
    t.key(new KeyboardEvent('keydown', { key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true }))
    await settle()
    pasteEvent(t.host, '')
    await settle()
    expect(t.onImage).toHaveBeenCalledTimes(3)
    expect(t.written).not.toHaveBeenCalled()
    t.dispose()
  })

  it('does nothing where no image can be delivered, as before', async () => {
    const t = mount('')
    pasteEvent(t.host, '')
    await settle()
    expect(t.written).not.toHaveBeenCalled()
    t.dispose()
  })
})

describe('text paste is unchanged by it', () => {
  it('pastes one line and never looks for an image', async () => {
    const t = mount('uptime', true)
    t.host.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await settle()
    expect(t.written).toHaveBeenCalledWith('uptime')
    expect(t.onImage).not.toHaveBeenCalled()
    t.dispose()
  })

  it('still confirms multi-line text', async () => {
    const t = mount('a\rb', true)
    t.host.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await settle()
    expect(t.confirm).toHaveBeenCalledWith('a\rb', 2)
    expect(t.onImage).not.toHaveBeenCalled()
    t.dispose()
  })
})

describe('Ctrl+V', () => {
  it('offers the image and sends nothing to the shell', async () => {
    const t = mount('', true)
    const ev = ctrlV()
    expect(t.key(ev)).toBe(false)
    // Or the browser's own paste would follow it on Linux and Windows.
    expect(ev.defaultPrevented).toBe(true)
    await settle()
    expect(t.onImage).toHaveBeenCalledTimes(1)
    expect(t.input).not.toHaveBeenCalled()
    t.dispose()
  })

  it('is a plain ^V when there is no image -- vim block select, quoted insert', async () => {
    const t = mount('', false)
    expect(t.key(ctrlV())).toBe(false)
    await settle()
    expect(t.input).toHaveBeenCalledWith('\x16')
    t.dispose()
  })

  it('is left to xterm entirely in a terminal that cannot take an image', () => {
    const t = mount('')
    expect(t.key(ctrlV())).toBe(true)
    expect(t.input).not.toHaveBeenCalled()
    t.dispose()
  })

  it('leaves Ctrl+Shift+V, Cmd+V and Ctrl+Alt+V alone', async () => {
    const t = mount('x', true)
    t.key(new KeyboardEvent('keydown', { key: 'v', metaKey: true, ctrlKey: true }))
    t.key(new KeyboardEvent('keydown', { key: 'v', altKey: true, ctrlKey: true }))
    await settle()
    expect(t.input).not.toHaveBeenCalled()
    expect(t.onImage).not.toHaveBeenCalled()
    t.dispose()
  })
})

describe('which terminals can take an image', () => {
  const server = {
    id: 's1',
    name: 'box',
    host: '10.0.0.4',
    port: 22,
    username: 'ops',
    auth: 'key'
  } as unknown as Server

  it('a login shell on a server can', () => {
    expect(sshTransport(server, () => {}).pasteImage).toBeTypeOf('function')
  })

  it('a container shell cannot: the file would be on the host', () => {
    expect(containerTransport(server, 'web', () => {}).pasteImage).toBeUndefined()
  })

  it('surfaces main refusing, rather than pasting nothing in silence', async () => {
    stubBridge({ ssh: { pasteImage: vi.fn(async () => ({ ok: false, error: 'This terminal is not connected.' })) } })
    await expect(sshTransport(server, () => {}).pasteImage!('sess', new Uint8Array())).rejects.toThrow(
      'This terminal is not connected.'
    )
  })
})
