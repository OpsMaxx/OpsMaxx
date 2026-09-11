import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { COMMANDS, isMac, resolveBindings } from '../src/renderer/src/lib/shortcuts'

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

  it('waits for the pane to be genuinely visible, not merely marked visible', () => {
    // The first attempt at this asked on the next animation frame and did not
    // work. A background tab is hidden by `display: none` on an ancestor,
    // `focus()` inside a hidden subtree is silently a no-op, and a rAF callback
    // runs BEFORE that frame's style and layout pass -- so the pane React had
    // just marked visible frequently still was not. The call succeeded, changed
    // nothing, and reported nothing, which is exactly why switching tabs still
    // left the cursor dead until you clicked inside.
    expect(view).toMatch(/new IntersectionObserver/)
    expect(view).toMatch(/e\.isIntersecting/)
  })

  it('focuses the terminal when its pane becomes active', () => {
    // The rule lives in the component that owns the xterm instance, so it
    // covers every route to a pane at once rather than being repeated in each
    // shortcut runner -- where the next runner added would forget it.
    expect(view).toMatch(/isActivePane/)
    expect(view).toMatch(/requestAnimationFrame\(take\)/)
    expect(view).toMatch(/termRef\.current\?\.focus\(\)/)
  })

  it('does not let a background tab steal typing', () => {
    // A pane can be its tab's active pane while its tab is not the active tab.
    // Focusing on that alone would pull the keyboard out of the tab the user is
    // actually looking at.
    expect(view).toMatch(/holdingTabId === s\.activeTabId/)
  })
})

describe('keys the shell needs', () => {
  it('leaves Ctrl+F to readline off macOS, and keeps Cmd+F on it', () => {
    // Cmd folds into Ctrl in this keymap, so ONE stored combo is Cmd+F on a Mac
    // -- harmless, and what every Mac app does -- and a real Ctrl+F everywhere
    // else: readline's forward-char, and page-forward in less and vim. It is a
    // terminal-scope binding, so it was intercepted before xterm saw it, and
    // moving the cursor right at a prompt opened a find bar.
    //
    // Asserted against the running platform rather than a fixed value, because
    // the binding is deliberately not the same on both.
    const bound = resolveBindings({}).get('term-find-alt') ?? ''
    expect(bound).toBe(isMac() ? 'Ctrl+F' : '')
  })

  it('still offers a find binding that collides with nothing', () => {
    const find = COMMANDS.find((c) => c.id === 'term-find')
    expect(find?.keys).toBe('Ctrl+Shift+F')
  })
})
