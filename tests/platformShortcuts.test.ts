import { describe, expect, it } from 'vitest'
import { COMMANDS, scopesOverlap } from '../src/renderer/src/lib/shortcuts'

/**
 * The keyboard on Windows and Linux.
 *
 * `comboFrom` folds Cmd into Ctrl, so one stored binding means "the platform's
 * app modifier". On a Mac that is Cmd, which no shell wants. Off a Mac it is
 * Control, which the shell is entitled to -- so `scopeApplies` refuses app
 * bindings inside a terminal, and since the terminal always has focus, those
 * users had five working keys out of thirty-three: no New Tab, no Close Tab, no
 * Go to Tab N, no Split.
 *
 * The defaults now follow what those users' own terminals bind -- Ctrl+Shift
 * for actions, Alt for tab digits, as in Windows Terminal and GNOME Terminal --
 * and those are combos readline does not claim.
 */

const keysFor = (c: (typeof COMMANDS)[number], mac: boolean): string =>
  mac ? c.keys : (c.winKeys ?? c.keys)

describe('every app action is reachable from a terminal', () => {
  for (const mac of [true, false]) {
    const platform = mac ? 'macOS' : 'Windows and Linux'

    it(`on ${platform}, tab management uses a modifier the shell has no claim on`, () => {
      // The four that were dead, plus split. `app` scope only reaches a focused
      // terminal through the app-modifier gate, so their binding has to carry
      // one: Cmd on a Mac (stored as Ctrl), Ctrl+Shift or Alt elsewhere.
      const mustReach = ['new-terminal', 'close-tab', 'select-tab-1', 'select-tab-last', 'split-v']
      for (const id of mustReach) {
        const cmd = COMMANDS.find((c) => c.id === id)
        expect(cmd, id).toBeDefined()
        const keys = keysFor(cmd!, mac)
        const qualified = mac
          ? keys.startsWith('Ctrl+') // folds to Cmd
          : /^(Ctrl\+Shift\+|Alt\+)/.test(keys)
        expect(qualified, `${id} is bound to ${keys} on ${platform}`).toBe(true)
      }
    })

    it(`on ${platform}, no two commands that can both fire share a binding`, () => {
      const clashes: string[] = []
      for (let i = 0; i < COMMANDS.length; i++) {
        for (let j = i + 1; j < COMMANDS.length; j++) {
          const a = COMMANDS[i]
          const b = COMMANDS[j]
          if (a.fixed || b.fixed) continue
          const ka = keysFor(a, mac)
          const kb = keysFor(b, mac)
          if (!ka || ka !== kb) continue
          if (!scopesOverlap(a.scope, b.scope)) continue
          clashes.push(`${a.id} and ${b.id} both on ${ka}`)
        }
      }
      expect(clashes).toEqual([])
    })
  }
})

describe('a platform default is a default, not a second command', () => {
  it('never gives a command a winKeys equal to its keys', () => {
    // A redundant override is one more thing to keep in step for no gain.
    const pointless = COMMANDS.filter((c) => c.winKeys && c.winKeys === c.keys).map((c) => c.id)
    expect(pointless).toEqual([])
  })

  it('leaves Shift-qualified bindings alone', () => {
    // These already carry a modifier the shell has no claim on, on every
    // platform. Duplicating them per-platform would be churn.
    for (const c of COMMANDS) {
      if (c.scope !== 'app') continue
      if (!c.keys.startsWith('Ctrl+Shift+')) continue
      // new-local-terminal is the one exception, and it has a reason: Ctrl+Shift+T
      // is New Tab off macOS, so the local shell moves aside there.
      if (c.id === 'new-local-terminal') continue
      expect(c.winKeys, `${c.id} does not need a platform binding`).toBeUndefined()
    }
  })
})
