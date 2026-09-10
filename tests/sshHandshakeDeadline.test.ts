import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The handshake deadline, and the second factor it used to cut off.
 *
 * Reported as "the servers have stopped connecting, I think the private key
 * mechanism is not working anymore". The connection was to a jump host whose
 * `ssh` output shows what OpsMaxx could not:
 *
 *     (ali_waqar@172.30.11.62) Verification code:
 *
 * `AuthenticationMethods publickey,keyboard-interactive` — the key IS
 * accepted, and then a person is asked for a code from their phone. The
 * handshake deadline was 20s for anything that was not agent auth, on the
 * reasoning that "for a password or a key there is nothing to approve". With
 * MFA there is, and the prompt dialog itself waits 120s — so the two
 * deadlines disagreed by a factor of six and the connection always died
 * first.
 *
 * It surfaced as "All configured authentication methods failed", which reads
 * as a rejected credential and sends somebody to check their key. Exactly the
 * conclusion it produced.
 */

const SSH = readFileSync(resolve(__dirname, '..', 'src/main/services/ssh.ts'), 'utf8')

describe('the deadline while nothing is being asked', () => {
  it('stays short, so a server that stalls still fails quickly', () => {
    expect(SSH).toContain('const HANDSHAKE_QUIET_MS = 20000')
    expect(SSH).toMatch(/armDeadline\(\s*HANDSHAKE_QUIET_MS/)
  })

  /**
   * An unreachable host is now caught by the TCP connect, not by the
   * handshake timer. That separation is what let the handshake deadline be
   * raised at all — one timer cannot be both short for a dead host and long
   * for a human.
   */
  it('is not the thing catching an unreachable host any more', () => {
    expect(SSH).toContain('const TCP_CONNECT_MS = 15000')
    expect(SSH).toMatch(/socket\.setTimeout\(TCP_CONNECT_MS/)
  })

  // A connected socket must not inherit the CONNECT deadline: a terminal
  // waiting on a person sends nothing for minutes and would be torn down.
  it('drops the socket deadline once connected', () => {
    expect(SSH).toContain('socket.setTimeout(0)')
  })
})

describe('the deadline once a person is asked', () => {
  it('is longer than the dialog the person is answering', () => {
    const human = Number(/const HANDSHAKE_HUMAN_MS = (\d+)/.exec(SSH)?.[1])
    // The prompt in main/index.ts gives up after 120s. The connection has to
    // outlive it, or the dialog closes onto a session that is already dead.
    expect(human).toBeGreaterThan(120000)
  })

  it('is armed by the keyboard-interactive challenge itself', () => {
    const handler = SSH.slice(SSH.indexOf("'keyboard-interactive'"))
    expect(handler).toMatch(/armDeadline\(\s*HANDSHAKE_HUMAN_MS/)
  })

  /**
   * Extended BEFORE the answering path is chosen. The saved-answer and
   * password shortcuts still have to complete against a deadline, and a
   * stored answer resolving instantly is not a reason to leave the short one
   * armed for whatever the server asks next.
   */
  it('extends before deciding how to answer', () => {
    const handler = SSH.slice(SSH.indexOf("'keyboard-interactive'"))
    const extend = handler.indexOf('HANDSHAKE_HUMAN_MS')
    const shortcut = handler.indexOf("hop.auth === 'password'")
    expect(extend).toBeGreaterThan(-1)
    expect(shortcut).toBeGreaterThan(extend)
  })

  // ssh2's own timer stays, purely so a bug in ours cannot hang a connection
  // forever — and it has to be the longest of the three.
  it('keeps a backstop longer than our own', () => {
    const human = Number(/const HANDSHAKE_HUMAN_MS = (\d+)/.exec(SSH)?.[1])
    const backstop = Number(/const HANDSHAKE_BACKSTOP_MS = (\d+)/.exec(SSH)?.[1])
    expect(backstop).toBeGreaterThan(human)
    expect(SSH).toContain('readyTimeout: HANDSHAKE_BACKSTOP_MS')
  })
})

describe('the deadline is always cleared', () => {
  // A timer left armed after the handshake would end a live session.
  it('clears on ready and on error', () => {
    expect(SSH).toMatch(/client\.on\('ready', \(\) => \{\s*clearDeadline\(\)/)
    expect(SSH).toMatch(/client\.on\('error', \(err\) => \{\s*clearDeadline\(\)/)
  })

  // Unref'd, so a pending handshake cannot hold the process open at quit.
  it('does not hold the process open', () => {
    expect(SSH).toContain('deadline.unref')
  })
})
