import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_IDENTITIES } from '../src/main/services/sshKeys'

/**
 * An empty key field means what it means in `ssh`.
 *
 * Reported as "the servers have stopped connecting, I think the private key
 * mechanism is not working anymore", against an Edit Server dialog with
 * Private Key selected and the path field showing only its grey placeholder.
 *
 * OpenSSH with no `IdentityFile` does not refuse — it tries the default
 * identities, `~/.ssh/id_ed25519` first. OpsMaxx threw instead, so an empty
 * field meant "authenticate with nothing" and the server refused every
 * method. The field's own placeholder already read `~/.ssh/id_ed25519`: the
 * form described the behaviour the user expected and the code did the
 * opposite.
 */

describe('the identities tried when none is named', () => {
  /**
   * Order matters. It is the one `ssh host` already follows, so following it
   * is what makes OpsMaxx pick the same key the user's terminal picks — which
   * is the whole point of the fallback.
   */
  it('follows OpenSSH\'s own preference order', () => {
    expect(DEFAULT_IDENTITIES[0]).toBe('id_ed25519')
    expect([...DEFAULT_IDENTITIES]).toContain('id_rsa')
    expect([...DEFAULT_IDENTITIES]).toContain('id_ecdsa')
    // Modern first, legacy last: ed25519 must come before rsa and dsa.
    const idx = (n: string): number => DEFAULT_IDENTITIES.indexOf(n as never)
    expect(idx('id_ed25519')).toBeLessThan(idx('id_rsa'))
    expect(idx('id_rsa')).toBeLessThan(idx('id_dsa'))
  })

  it('never offers a public key as an identity', () => {
    for (const name of DEFAULT_IDENTITIES) expect(name.endsWith('.pub')).toBe(false)
  })
})

/**
 * `defaultIdentityPath` reads $HOME, so these drive it through a temporary
 * one rather than the developer's own ~/.ssh — a test that passed only on a
 * machine with a key in it would be testing the machine.
 */
describe('picking one off disk', () => {
  let home: string
  const realHome = process.env.HOME

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'opsmaxx-ssh-'))
    mkdirSync(join(home, '.ssh'), { recursive: true })
    process.env.HOME = home
  })
  afterEach(() => {
    process.env.HOME = realHome
    rmSync(home, { recursive: true, force: true })
  })

  const load = async (): Promise<typeof import('../src/main/services/sshKeys')> => {
    const m = await import('../src/main/services/sshKeys')
    return m
  }

  it('finds nothing when ~/.ssh holds no identity', async () => {
    const { defaultIdentityPath } = await load()
    expect(defaultIdentityPath()).toBeNull()
  })

  it('prefers ed25519 over rsa, as ssh does', async () => {
    writeFileSync(join(home, '.ssh', 'id_rsa'), 'x')
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'x')
    const { defaultIdentityPath } = await load()
    expect(defaultIdentityPath()).toBe(join(home, '.ssh', 'id_ed25519'))
  })

  it('falls through to rsa when there is no ed25519', async () => {
    writeFileSync(join(home, '.ssh', 'id_rsa'), 'x')
    const { defaultIdentityPath } = await load()
    expect(defaultIdentityPath()).toBe(join(home, '.ssh', 'id_rsa'))
  })

  // A directory named id_ed25519 is not a key, and must not be returned as
  // one — the read would fail with something far less obvious.
  it('ignores a directory with an identity\'s name', async () => {
    mkdirSync(join(home, '.ssh', 'id_ed25519'))
    writeFileSync(join(home, '.ssh', 'id_rsa'), 'x')
    const { defaultIdentityPath } = await load()
    expect(defaultIdentityPath()).toBe(join(home, '.ssh', 'id_rsa'))
  })
})
