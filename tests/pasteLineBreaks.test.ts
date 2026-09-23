// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { stubBridge } from './setup/renderer'
import { setupTerminalUX } from '../src/renderer/src/hooks/useTerminalSession'

// A clipboard paste of more than one command asks first. xterm sends every
// line break of a paste as a carriage return, which the shell takes as Enter,
// so a LONE \r separates two commands exactly as \n does. It used to go
// straight through, because only \n was looked for.

function pasteVia(clip: string): { confirm: ReturnType<typeof vi.fn>; written: ReturnType<typeof vi.fn> } {
  stubBridge({ clipboard: { read: () => clip, write: vi.fn() } })
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
  dispose()
  return { confirm, written }
}

describe('what counts as more than one line', () => {
  it('asks for two commands separated by a lone carriage return, and writes nothing', () => {
    const { confirm, written } = pasteVia('echo safe\rrm -rf /tmp/x')
    expect(confirm).toHaveBeenCalledWith('echo safe\rrm -rf /tmp/x', 2)
    expect(written).not.toHaveBeenCalled()
  })

  it('still asks for \\n and \\r\\n', () => {
    expect(pasteVia('a\nb').confirm).toHaveBeenCalledWith('a\nb', 2)
    expect(pasteVia('a\r\nb').confirm).toHaveBeenCalledWith('a\r\nb', 2)
  })

  it('still lets one command with its trailing newline through, as it always did', () => {
    for (const clip of ['ls -la\n', 'ls -la\r', 'ls -la\r\n', 'ls -la']) {
      const { confirm, written } = pasteVia(clip)
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
  stubBridge({ clipboard: { read: () => clip, write: vi.fn() } })
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

  it('leaves the shortcut and right-click paths working', () => {
    const t = mount('a\rb')
    const handled = t.key(
      new KeyboardEvent('keydown', { key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true })
    )
    expect(handled).toBe(false)
    expect(t.confirm).toHaveBeenCalledTimes(1)
    t.host.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    expect(t.confirm).toHaveBeenCalledTimes(2)
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
