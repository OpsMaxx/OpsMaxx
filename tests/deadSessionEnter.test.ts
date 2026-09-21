import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Enter on a dead session must reconnect — and must NOT steal Enter from the
// card's own buttons.
//
// The first version of this handler sat on `.terminal-wrap` with no target
// check. That wrapper contains the dead-session card, the find bar and the
// paste confirmation, so it saw their keys too. The worst case is a rejected
// credential: `auth` advice is `{ retry: false, edit: true }`, so there is no
// Reconnect button at all and "Edit connection" is the autofocused one —
// pressing Enter on it would cancel the button's own activation with
// preventDefault() and silently reconnect instead, offering exactly the action
// the advice table exists to say is known not to work.
//
// The guard is a POSITIVE test for the terminal, not a list of overlays to
// exclude, because a list is wrong the moment somebody adds the next overlay.

const SRC = readFileSync(
  resolve(__dirname, '..', 'src/renderer/src/components/terminal/TerminalView.tsx'),
  'utf8'
)

/** The real predicate, lifted out of the component so it can be driven with
 *  DOM-shaped inputs without mounting xterm. Kept in step with the source by
 *  the assertion at the end of this file. */
function fromTerminalItself(target: { closest: (s: string) => unknown; classList: Set<string> }): boolean {
  return target.closest('.xterm-host') !== null || target.classList.has('terminal-wrap')
}

const inTerminal = { closest: (s: string) => (s === '.xterm-host' ? {} : null), classList: new Set<string>() }
const theWrapper = { closest: () => null, classList: new Set(['terminal-wrap']) }
const aCardButton = { closest: () => null, classList: new Set(['btn', 'primary']) }
const theFindBar = { closest: () => null, classList: new Set(['input']) }

describe('Enter on a dead session', () => {
  it('reconnects when it came from the terminal', () => {
    expect(fromTerminalItself(inTerminal)).toBe(true)
  })

  it('reconnects when focus is on the wrapper, which is where a click on the scrollback leaves it', () => {
    // The dead terminal is deliberately still selectable, so reading the error
    // text is the ordinary way focus ends up here. That was the whole reported
    // symptom: Enter stopped working once you had clicked.
    expect(fromTerminalItself(theWrapper)).toBe(true)
  })

  it('leaves the card\'s own buttons alone', () => {
    // On an auth fault there is no Reconnect button and Edit connection is
    // autofocused. Hijacking Enter there reconnects instead of editing, and
    // reconnecting is the thing that just failed.
    expect(fromTerminalItself(aCardButton)).toBe(false)
  })

  it('leaves the find bar alone', () => {
    // Searching a dead pane is intended — the card says the scrollback is
    // kept. Enter there means "next match", not "throw this away and redial".
    expect(fromTerminalItself(theFindBar)).toBe(false)
  })
})

describe('the handler in the source', () => {
  it('is guarded by the target check, not just by `dead`', () => {
    expect(SRC).toMatch(/dead && e\.key === 'Enter' && !recovery\.active && fromTerminalItself\(e\.target\)/)
  })

  it('tests for the terminal rather than listing overlays to exclude', () => {
    // A blacklist inherits the bug every time an overlay is added, and is
    // wrong the moment a class is renamed. An earlier draft of this listed a
    // class that did not exist at all.
    const fn = SRC.slice(SRC.indexOf('function fromTerminalItself'))
    expect(fn.slice(0, 400)).toMatch(/closest\('\.xterm-host'\)/)
    expect(fn.slice(0, 400)).toMatch(/classList\.contains\('terminal-wrap'\)/)
  })
})
