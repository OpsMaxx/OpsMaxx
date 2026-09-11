import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { COMMANDS, resolveBindings } from '../src/renderer/src/lib/shortcuts'

const src = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')

/**
 * Two ways a terminal's keyboard stops being a keyboard.
 *
 * The first is arriving somewhere with no typing target: every tab and pane
 * shortcut moved the selection and left focus behind, so Ctrl+T, Ctrl+Tab,
 * Ctrl+1..9 and Ctrl+\ all ended with a reach for the mouse. The second is
 * taking a key the shell needed.
 */

describe('the active pane holds the keyboard', () => {
  const view = src('../src/renderer/src/components/terminal/TerminalView.tsx')

  it('focuses the terminal when its pane becomes active', () => {
    // The rule lives in the component that owns the xterm instance, so it
    // covers every route to a pane at once rather than being repeated in each
    // shortcut runner -- where the next runner added would forget it.
    expect(view).toMatch(/isActivePane/)
    expect(view).toMatch(/requestAnimationFrame\(\(\) => termRef\.current\?\.focus\(\)\)/)
  })

  it('does not let a background tab steal typing', () => {
    // A pane can be its tab's active pane while its tab is not the active tab.
    // Focusing on that alone would pull the keyboard out of the tab the user is
    // actually looking at.
    expect(view).toMatch(/holdingTabId === s\.activeTabId/)
  })
})

describe('keys the shell needs', () => {
  it('leaves Ctrl+F to readline off macOS', () => {
    // Cmd folds into Ctrl in this keymap, so one stored combo is Cmd+F on a Mac
    // and a real Ctrl+F everywhere else -- readline's forward-char, and
    // page-forward in less and vim. This is a terminal-scope binding, so it was
    // intercepted before xterm saw it.
    const bound = resolveBindings({})
    expect(bound['term-find-alt'] ?? '').toBe('')
  })

  it('still offers a find binding that collides with nothing', () => {
    const find = COMMANDS.find((c) => c.id === 'term-find')
    expect(find?.keys).toBe('Ctrl+Shift+F')
  })
})
