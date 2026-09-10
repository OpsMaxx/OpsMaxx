import { describe, it, expect } from 'vitest'
import { classifyConnectionError } from '../src/renderer/src/lib/connectionError'

/**
 * A shell that exits cleanly closes what held it.
 *
 * `exit` is how somebody says they are finished, and answering it with a card
 * that has to be dismissed makes the ordinary end of a session a two-step one.
 * Every terminal emulator closes on a clean exit.
 *
 * The whole risk is in the OTHER direction, so that is what most of this
 * covers: a pane that vanished when a connection dropped would take the reason
 * with it, and that is the one moment the reason matters most. So the rule is
 * narrow by construction — it reuses the classifier that already tells a
 * deliberate exit from a failure, rather than inventing a second opinion.
 */

/** The rule the terminal applies when a session ends. */
function closesPane(dead: string | null, hasCloser: boolean, enabled: boolean): boolean {
  if (!dead || !hasCloser || !enabled) return false
  return classifyConnectionError(dead) === 'exited'
}

const CLEAN = 'Session closed · shell exited'

describe('a deliberate exit', () => {
  it('closes the pane', () => {
    expect(closesPane(CLEAN, true, true)).toBe(true)
  })

  it('stays open when the setting is off', () => {
    // For anyone who wants the scrollback to outlive the shell.
    expect(closesPane(CLEAN, true, false)).toBe(false)
  })

  it('stays open where there is nothing to close', () => {
    // The demo and empty paths pass no closer, and a rule that assumed one
    // would throw on the one screen that cannot act on it.
    expect(closesPane(CLEAN, false, true)).toBe(false)
  })
})

describe('an ending that is not an exit keeps its pane', () => {
  it('keeps a non-zero exit on screen', () => {
    // `shell exited with 3` is a shell that DIED. Closing the pane would throw
    // away the status that says so.
    expect(closesPane('Session closed · shell exited with 3', true, true)).toBe(false)
  })

  it('keeps a dropped connection on screen', () => {
    for (const reason of [
      'Session closed · connect ETIMEDOUT',
      'Session closed · connect ECONNREFUSED 10.0.0.4:22',
      'All configured authentication methods failed',
      'Host key verification failed',
      'getaddrinfo ENOTFOUND monkey-d-luffy'
    ]) {
      expect(closesPane(reason, true, true), reason).toBe(false)
    }
  })

  it('keeps an ending it cannot explain on screen', () => {
    // `unknown` exists to admit the app cannot say what happened. Closing on
    // it would discard the raw text, which is the only information there is.
    expect(closesPane('Session closed · flumox 42', true, true)).toBe(false)
  })

  it('does nothing while the session is alive', () => {
    expect(closesPane(null, true, true)).toBe(false)
  })
})
