// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { RESET_STALE_MODES } from '../src/renderer/src/hooks/useTerminalSession'

// A reconnect reuses the terminal. When the session died under a TUI (the
// laptop slept, the vault locked), the TUI's mouse tracking stayed on and every
// mouse move was typed into the new shell as `35;90;36M35;90;35M…`. Parsed by
// the real xterm, so a mode the reset misses fails here rather than on a user.

const write = (term: Terminal, data: string): Promise<void> => new Promise((r) => term.write(data, r))

describe('reconnect resets modes the dead session left on', () => {
  it('turns off mouse tracking, focus reports, cursor keys and the alternate screen', async () => {
    const term = new Terminal({ allowProposedApi: true })
    // What a TUI like tmux, htop or Claude Code switches on.
    await write(term, '\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[?1h\x1b[?2004h\x1b[?25l')
    expect(term.modes.mouseTrackingMode).toBe('any')
    expect(term.buffer.active.type).toBe('alternate')

    await write(term, RESET_STALE_MODES)

    expect(term.modes.mouseTrackingMode).toBe('none')
    expect(term.modes.sendFocusMode).toBe(false)
    expect(term.modes.applicationCursorKeysMode).toBe(false)
    expect(term.modes.bracketedPasteMode).toBe(false)
    expect(term.buffer.active.type).toBe('normal')
    term.dispose()
  })

  it('leaves the cursor where it was on the normal screen', async () => {
    const term = new Terminal({ allowProposedApi: true })
    await write(term, '\x1b7' + 'line\r\n'.repeat(5))
    const y = term.buffer.active.cursorY
    await write(term, RESET_STALE_MODES)
    expect(term.buffer.active.cursorY).toBe(y)
    term.dispose()
  })
})
