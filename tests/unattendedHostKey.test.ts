import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { classifyConnectionError } from '../src/renderer/src/lib/connectionError'

const SSH = readFileSync(
  fileURLToPath(new URL('../src/main/services/ssh.ts', import.meta.url)),
  'utf8'
)

/**
 * "2 of 2 servers online" and two Unreachable alerts, at the same time.
 *
 * A background sweep runs with `allowPrompt: false`, because establishing trust
 * for the first time is a decision that needs a person present. So against a
 * server the user has only ever reached interactively, every sweep refused the
 * host key and failed -- and the failure was reported as "did not answer the
 * last check", which is not merely unhelpful, it is false. The host answered.
 * We hung up on it.
 *
 * The root cause was that the key was filed under `127.0.0.1:<ephemeral port>`
 * and so could never match twice; that is fixed separately. This is about the
 * report, which would have named the problem in one sentence and instead sent
 * the user looking for a network fault.
 */

describe('when our own verifier refuses', () => {
  it('is told apart from the host going away', () => {
    expect(SSH).toMatch(/let refusedHostKey = false/)
    expect(SSH).toMatch(/if \(!ok\) refusedHostKey = true/)
    expect(SSH).toMatch(/if \(refusedHostKey\) \{/)
  })

  it('says what to do about it when a background check is what refused', () => {
    // The one error a user can finish in a single action: connect once
    // interactively and confirm the fingerprint.
    expect(SSH).toMatch(/a background check is not allowed to ask for one/)
    expect(SSH).toMatch(/checks will run on their own after that/)
  })

  it('names the server rather than the loopback port it was reached on', () => {
    expect(SSH).toMatch(/hop\.hostKeyId \?\? `\$\{hop\.host\}:\$\{hop\.port \|\| 22\}`/)
  })
})

describe('classifying it', () => {
  it('recognises ssh2’s own wording', () => {
    // `Host denied (verification failed)` matched none of the previous patterns
    // -- not "host key", not "host verification" -- so the classifier called it
    // generic and the UI offered no route out.
    expect(classifyConnectionError('Host denied (verification failed)')).toBe('host-key')
  })

  it('recognises our own', () => {
    expect(
      classifyConnectionError('OpsMaxx has no trusted host key for db01:22, and a background check is not allowed to ask for one.')
    ).toBe('host-key')
  })

  it('still recognises the ones it always did', () => {
    expect(classifyConnectionError('Host key verification failed')).toBe('host-key')
    expect(classifyConnectionError('fingerprint mismatch')).toBe('host-key')
  })

  it('does not swallow an unrelated denial', () => {
    // "denied" alone is a password rejection, not a host-key problem.
    expect(classifyConnectionError('Permission denied (publickey,password)')).not.toBe('host-key')
  })
})
