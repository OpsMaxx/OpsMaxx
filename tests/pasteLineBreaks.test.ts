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
