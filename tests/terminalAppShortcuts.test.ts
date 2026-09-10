import { describe, it, expect } from 'vitest'

/**
 * Cmd+T while the terminal has focus.
 *
 * Reported as new-tab shortcuts not working at all — and they did not, because
 * the terminal always has focus. `useHotkeys` skips events inside a terminal
 * and the terminal dispatches them with scope `'terminal'`, where an `'app'`
 * binding does not apply.
 *
 * Refusing app bindings there is RIGHT for the Control key, on every platform:
 * it is what keeps Ctrl+W, Ctrl+K and Ctrl+L reaching the shell. The problem
 * is that `comboFrom` folds Ctrl and Cmd into one token, so the refusal caught
 * Command too — and Command is not a shell modifier on macOS. No readline
 * binding uses it, and every Mac terminal opens a tab on Cmd+T. The refusal
 * took a shortcut from the app and gave nothing to the shell.
 */

type Scope = 'app' | 'terminal' | 'global'

/** The rule, as the dispatcher applies it. */
function scopeApplies(scope: Scope, where: 'app' | 'terminal', appModifier = false): boolean {
  if (scope === 'global' || scope === where) return true
  return scope === 'app' && where === 'terminal' && appModifier
}

describe('an app binding pressed inside a terminal', () => {
  it('fires when the modifier was Command', () => {
    // Cmd+T, Cmd+W, Cmd+N — what a Mac user presses without thinking.
    expect(scopeApplies('app', 'terminal', true)).toBe(true)
  })

  it('does not fire when the modifier was Control', () => {
    // The whole reason the refusal exists. Ctrl+W is delete-word and Ctrl+K is
    // kill-line; taking either would break the shell to open a tab.
    expect(scopeApplies('app', 'terminal', false)).toBe(false)
  })
})

describe('what the exception must not change', () => {
  it('leaves global bindings firing everywhere', () => {
    expect(scopeApplies('global', 'terminal', false)).toBe(true)
    expect(scopeApplies('global', 'app', false)).toBe(true)
  })

  it('keeps terminal bindings out of the app', () => {
    expect(scopeApplies('terminal', 'app', true)).toBe(false)
  })

  it('leaves app bindings working in the app, modifier or not', () => {
    expect(scopeApplies('app', 'app', false)).toBe(true)
    expect(scopeApplies('app', 'app', true)).toBe(true)
  })
})

describe('which events count as the app modifier', () => {
  const usedAppModifier = (mac: boolean, meta: boolean, ctrl: boolean): boolean =>
    mac && meta && !ctrl

  it('is Command on macOS', () => {
    expect(usedAppModifier(true, true, false)).toBe(true)
  })

  it('is never Control, even on macOS', () => {
    expect(usedAppModifier(true, false, true)).toBe(false)
  })

  it('is not Cmd+Ctrl together — the shell still has a claim', () => {
    expect(usedAppModifier(true, true, true)).toBe(false)
  })

  it('is nothing at all off macOS', () => {
    // On Windows and Linux the app modifier IS Control, so there is no key
    // here a terminal is not entitled to.
    expect(usedAppModifier(false, true, false)).toBe(false)
    expect(usedAppModifier(false, false, true)).toBe(false)
  })
})
