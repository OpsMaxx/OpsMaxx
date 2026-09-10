import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * A background check must not answer a second factor, and must not guess.
 *
 * The reported failure — servers refusing to connect with "All configured
 * authentication methods failed", while plain `ssh` to the same host worked —
 * was traced by its workaround: turning OFF background monitoring cleared it.
 *
 * The fleet sampler already passed `allowPrompt: false`, and the comments at
 * those call sites say "this is the unattended caller". The
 * keyboard-interactive handler ignored the flag. So every sweep against an
 * MFA host raised a verification-code dialog attached to nothing the user had
 * done, and when nobody answered it resolved to `finish([])` — a WRONG
 * answer, submitted on every sweep interval.
 *
 * That is the serious half. Repeated failed authentications trip MaxAuthTries,
 * fail2ban or an account lockout, and the user's own interactive connections
 * then fail too — which reads as a broken credential and is really a server
 * that has stopped listening to this client.
 */

const SSH = readFileSync(resolve(__dirname, '..', 'src/main/services/ssh.ts'), 'utf8')
const MAIN = readFileSync(resolve(__dirname, '..', 'src/main/index.ts'), 'utf8')

/** The keyboard-interactive handler, which is where all of this happens. */
const HANDLER = SSH.slice(SSH.indexOf("'keyboard-interactive'"), SSH.indexOf("client.on('error'"))

describe('an unattended connection facing a second factor', () => {
  it('respects the flag the background callers already pass', () => {
    expect(HANDLER).toContain('if (!allowPrompt)')
  })

  /**
   * The bug in one line: an empty answer is a wrong answer, and spending one
   * per sweep is what locks the account out.
   */
  it('never submits an empty answer instead of prompting', () => {
    const unattended = HANDLER.slice(HANDLER.indexOf('if (!allowPrompt)'))
    const stop = unattended.indexOf('reject(')
    const emptyAnswer = unattended.indexOf('finish([])')
    expect(stop).toBeGreaterThan(-1)
    // It ends the connection; it does not fall through to an empty answer.
    expect(emptyAnswer === -1 || emptyAnswer > stop).toBe(true)
  })

  it('ends the connection rather than leaving it hanging', () => {
    const unattended = HANDLER.slice(HANDLER.indexOf('if (!allowPrompt)'))
    expect(unattended).toContain('client.end()')
    expect(unattended).toContain('clearDeadline()')
  })

  // The refusal has to say what to do, or it reads as the host being down.
  it('says how to authenticate it instead', () => {
    expect(HANDLER).toMatch(/asks for a second factor/)
    expect(HANDLER).toMatch(/from a terminal tab|turn off background checking/)
  })
})

describe('a stored answer', () => {
  /**
   * Still usable unattended: it is not a guess and needs nobody. Registered
   * separately from the prompter precisely so "may use a saved answer" and
   * "may raise a dialog" stop being the same permission — folding them
   * together is what left the sampler prompting.
   */
  it('is available to a background connection', () => {
    const unattended = HANDLER.slice(HANDLER.indexOf('if (!allowPrompt)'))
    const stored = unattended.indexOf('storedKbAnswer')
    const stop = unattended.indexOf('reject(')
    expect(stored).toBeGreaterThan(-1)
    expect(stored, 'a stored answer must be tried before giving up').toBeLessThan(stop)
  })

  it('is provided separately from the prompter', () => {
    expect(SSH).toContain('export function setStoredKbAnswer')
    expect(MAIN).toContain('setStoredKbAnswer(')
    // And the prompter still exists for the interactive path.
    expect(MAIN).toContain('setSshPrompter(')
  })

  // Only a single-prompt challenge, which is what a TOTP is. Replaying one
  // saved string into a multi-part challenge would answer the wrong question.
  it('is used only for a single-prompt challenge', () => {
    const provider = MAIN.slice(MAIN.indexOf('setStoredKbAnswer('))
    expect(provider.slice(0, 400)).toContain('prompts.length !== 1')
  })
})

describe('the interactive path is untouched', () => {
  it('still prompts when a person is there', () => {
    expect(HANDLER).toContain('void prompter({')
  })

  // A password-auth server asking one hidden question is asking for the
  // password, and that shortcut must keep working for both kinds of caller.
  it('still answers a password server from the stored password', () => {
    expect(HANDLER).toContain("hop.auth === 'password' && hop.password && single")
  })
})
