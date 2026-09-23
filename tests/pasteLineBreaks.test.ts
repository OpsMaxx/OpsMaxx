// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { stubBridge } from './setup/renderer'
import { setupTerminalUX } from '../src/renderer/src/hooks/useTerminalSession'

// A clipboard paste of more than one command asks first. xterm sends every
// line break of a paste as a carriage return, which the shell takes as Enter,
// so a LONE \r separates two commands exactly as \n does. It used to go
// straight through, because only \n was looked for.

/** The clipboard is read through main now, so a paste settles a tick later. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

async function pasteVia(
  clip: string
): Promise<{ confirm: ReturnType<typeof vi.fn>; written: ReturnType<typeof vi.fn> }> {
  stubBridge({ clipboard: { read: vi.fn(async () => clip), write: vi.fn() } })
  const written = vi.fn()
  const term = {
    getSelection: () => '',
    onSelectionChange: () => ({ dispose: () => {} }),
    attachCustomKeyEventHandler: () => {},
    paste: written
  } as unknown as Terminal
  const host = document.createElement('div')
  const confirm = vi.fn()
  const dispose = setupTerminalUX(term, host, undefined, confirm)
  // Right-click is paste here, PuTTY style.
  host.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  await settle()
  dispose()
  return { confirm, written }
}

describe('what counts as more than one line', () => {
  it('asks for two commands separated by a lone carriage return, and writes nothing', async () => {
    const { confirm, written } = await pasteVia('echo safe\rrm -rf /tmp/x')
    expect(confirm).toHaveBeenCalledWith('echo safe\rrm -rf /tmp/x', 2)
    expect(written).not.toHaveBeenCalled()
  })

  it('still asks for \\n and \\r\\n', async () => {
    expect((await pasteVia('a\nb')).confirm).toHaveBeenCalledWith('a\nb', 2)
    expect((await pasteVia('a\r\nb')).confirm).toHaveBeenCalledWith('a\r\nb', 2)
  })

  it('still lets one command with its trailing newline through, as it always did', async () => {
    for (const clip of ['ls -la\n', 'ls -la\r', 'ls -la\r\n', 'ls -la']) {
      const { confirm, written } = await pasteVia(clip)
      expect(confirm, JSON.stringify(clip)).not.toHaveBeenCalled()
      expect(written).toHaveBeenCalledWith(clip)
    }
  })
})

// ---------------------------------------------------------------------------
// Every route into a paste goes through the same guard
// ---------------------------------------------------------------------------
//
// xterm listens for 'paste' on its helper textarea and sends the text straight
// to the session. The Edit menu's Paste and an unbound Cmd+V produce exactly
// that event, so they used to skip the confirmation. The textarea listener
// below stands in for xterm's own.

function mount(clip: string): {
  confirm: ReturnType<typeof vi.fn>
  written: ReturnType<typeof vi.fn>
  xtermSent: ReturnType<typeof vi.fn>
  textarea: HTMLTextAreaElement
  key: (e: KeyboardEvent) => boolean
  host: HTMLDivElement
  dispose: () => void
} {
  stubBridge({ clipboard: { read: vi.fn(async () => clip), write: vi.fn() } })
  const written = vi.fn()
  let key: (e: KeyboardEvent) => boolean = () => true
  const term = {
    getSelection: () => '',
    onSelectionChange: () => ({ dispose: () => {} }),
    attachCustomKeyEventHandler: (h: (e: KeyboardEvent) => boolean) => {
      key = h
    },
    paste: written
  } as unknown as Terminal
  const host = document.createElement('div')
  const xterm = document.createElement('div')
  xterm.className = 'xterm'
  const textarea = document.createElement('textarea')
  textarea.className = 'xterm-helper-textarea'
  xterm.appendChild(textarea)
  host.appendChild(xterm)
  document.body.appendChild(host)
  const xtermSent = vi.fn()
  textarea.addEventListener('paste', (e) =>
    xtermSent((e as ClipboardEvent).clipboardData?.getData('text/plain'))
  )
  const confirm = vi.fn()
  const dispose = setupTerminalUX(term, host, undefined, confirm)
  return {
    confirm,
    written,
    xtermSent,
    textarea,
    key: (e) => key(e),
    host,
    dispose: () => {
      dispose()
      host.remove()
    }
  }
}

/** A paste event as a menu or an unbound Cmd+V delivers it. jsdom has no
 *  ClipboardEvent constructor worth using, so the data is attached by hand. */
function pasteEvent(target: HTMLElement, text: string): Event {
  const ev = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/plain' ? text : '') }
  })
  target.dispatchEvent(ev)
  return ev
}

describe('a DOM paste event cannot go around the confirmation', () => {
  it('asks for multi-line text and writes nothing, through either xterm or us', () => {
    const t = mount('')
    const ev = pasteEvent(t.textarea, 'echo one\recho two\recho three\r')
    expect(t.confirm).toHaveBeenCalledWith('echo one\recho two\recho three\r', 3)
    expect(t.written).not.toHaveBeenCalled()
    expect(t.xtermSent).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(true)
    t.dispose()
  })

  it('sends one line once, and only once', () => {
    const t = mount('')
    pasteEvent(t.textarea, 'uptime')
    expect(t.confirm).not.toHaveBeenCalled()
    expect(t.written).toHaveBeenCalledTimes(1)
    expect(t.written).toHaveBeenCalledWith('uptime')
    expect(t.xtermSent).not.toHaveBeenCalled()
    t.dispose()
  })

  it('leaves the shortcut and right-click paths working, reading the clipboard through main', async () => {
    const t = mount('a\rb')
    const read = (window as unknown as { opsmaxx: { clipboard: { read: ReturnType<typeof vi.fn> } } })
      .opsmaxx.clipboard.read
    const handled = t.key(
      new KeyboardEvent('keydown', { key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true })
    )
    expect(handled).toBe(false)
    await settle()
    expect(t.confirm).toHaveBeenCalledTimes(1)
    t.host.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await settle()
    expect(read).toHaveBeenCalledTimes(2)
    expect(t.confirm).toHaveBeenCalledTimes(2)
    // One line by right-click: read, guarded, written once.
    const one = mount('uptime')
    one.host.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await settle()
    expect(one.written).toHaveBeenCalledTimes(1)
    expect(one.written).toHaveBeenCalledWith('uptime')
    one.dispose()
    expect(t.written).not.toHaveBeenCalled()
    t.dispose()
  })

  it('stops listening when the terminal is torn down', () => {
    const t = mount('')
    t.dispose()
    document.body.appendChild(t.host)
    pasteEvent(t.textarea, 'a\rb')
    expect(t.confirm).not.toHaveBeenCalled()
    expect(t.xtermSent).toHaveBeenCalledTimes(1)
    t.host.remove()
  })
})

// The deprecation this replaced: Electron logs "Accessing 'clipboard.readText'
// from the renderer process is deprecated" whenever the preload touches its
// `clipboard` module. The preload must not import it; main answers instead.
describe('the clipboard is read through main', () => {
  it('is not taken from Electron in the preload', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const preload = readFileSync(resolve(__dirname, '../src/preload/index.ts'), 'utf8')
    const main = readFileSync(resolve(__dirname, '../src/main/index.ts'), 'utf8')
    expect(preload).not.toMatch(/import\s*\{[^}]*\bclipboard\b[^}]*\}\s*from 'electron'/)
    expect(preload).toMatch(/ipcRenderer\.invoke\('clipboard:read'\)/)
    expect(main).toMatch(/ipcMain\.handle\('clipboard:read'/)
  })
})
