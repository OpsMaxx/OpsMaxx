import { describe, it, expect } from 'vitest'
import { credentialNote, type CredentialShape } from '../src/shared/credentialShape'

/**
 * What OpsMaxx offered, said out loud on an authentication failure.
 *
 * Reported as "the servers have stopped connecting, I think the private key
 * mechanism is not working anymore", against a card reading "All configured
 * authentication methods failed". That sentence belongs to the SSH SERVER and
 * reads identically whether a key was rejected or none was ever stored — and
 * the app is the only party that knows which. Not saying so is what turns a
 * missing credential into a suspected broken key mechanism.
 */

describe('the note under an authentication failure', () => {
  /**
   * The case the whole thing exists for. Every method failed because none was
   * offered, which no amount of checking the username will reveal.
   */
  it('says plainly when nothing was offered', () => {
    const note = credentialNote({ kind: 'none' })
    expect(note).toMatch(/no credential saved/i)
    expect(note).toMatch(/Edit connection/)
  })

  // A locked vault cannot supply anything, and that is a different fix from
  // any of the others: unlock it, do not go editing the connection.
  it('names a locked vault as the reason', () => {
    expect(credentialNote({ kind: 'vault', vaultLocked: true })).toMatch(/vault is locked/i)
  })

  it('adds nothing for an unlocked vault, which is simply a rejected credential', () => {
    expect(credentialNote({ kind: 'vault', vaultLocked: false })).toBeNull()
  })

  /**
   * The key case names the path, because the next question is always "which
   * key?" — and a path is not a secret: the connection editor shows it.
   */
  it('names the key it offered', () => {
    const note = credentialNote({ kind: 'key', keyPath: '~/.ssh/id_ed25519' })
    expect(note).toContain('~/.ssh/id_ed25519')
    expect(note).toMatch(/authorized_keys/)
  })

  it('says nothing extra for a key whose path is not known', () => {
    expect(credentialNote({ kind: 'key' })).toBeNull()
  })

  // An agent with no keys loaded offers nothing, and looks exactly like a
  // rejected credential from the server's side.
  it('points an agent user at ssh-add -l', () => {
    expect(credentialNote({ kind: 'agent' })).toMatch(/ssh-add -l/)
  })

  /**
   * A configured password that the server rejected is exactly what the generic
   * message already says. Repeating it in different words would be noise.
   */
  it('adds nothing when there is nothing useful to add', () => {
    expect(credentialNote({ kind: 'password' })).toBeNull()
    expect(credentialNote(null)).toBeNull()
  })

  // Nothing here may carry a value. The shape is the contract.
  it('never contains anything secret', () => {
    const shapes: CredentialShape[] = [
      { kind: 'none' },
      { kind: 'password' },
      { kind: 'agent' },
      { kind: 'vault', vaultLocked: true },
      { kind: 'key', keyPath: '/home/u/.ssh/id_rsa' }
    ]
    for (const s of shapes) {
      const note = credentialNote(s) ?? ''
      // A path is fine — the editor shows it. A secret never appears because
      // the type has nowhere to put one.
      expect(Object.keys(s).every((k) => ['kind', 'keyPath', 'vaultLocked'].includes(k))).toBe(true)
      expect(note).not.toMatch(/passphrase|password:/i)
    }
  })
})
