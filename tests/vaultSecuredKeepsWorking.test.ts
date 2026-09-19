import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * The reported bug, end to end, against the real vault.
 *
 * Everything else in this change is tested in pieces. This is the piece the
 * user actually noticed: fifteen minutes after the last vault click, monitoring
 * stopped, the status bar said "Checks paused", and reconnecting meant typing
 * the master password again.
 *
 * So: a real vault with a real entry, the real idle timer, and the real
 * credential resolver — no vault mock. If this passes, a background sweep can
 * still authenticate after the timeout, which is the whole point.
 */

const secrets = new Map<string, string>()

vi.mock('../src/main/services/secrets', () => ({
  getSecret: (id: string) => secrets.get(id) ?? null
}))

const {
  vaultCreate,
  vaultSave,
  vaultDestroy,
  vaultStatus,
  vaultList,
  setVaultAutoLock,
  vaultLock
} = await import('../src/main/services/vault')
const { resolveSecrets, credentialResolvable, isVaultLockedError } = await import(
  '../src/main/services/credentialResolver'
)

const ENTRY = {
  id: 'v1',
  name: 'Prod login',
  kind: 'login' as const,
  url: '',
  username: 'deploy',
  password: 'hunter2',
  notes: '',
  tags: [],
  fields: [],
  createdAt: '',
  updatedAt: ''
}

beforeEach(async () => {
  vaultDestroy()
  secrets.clear()
  secrets.set('srv-vault', JSON.stringify({ vaultEntryId: 'v1' }))
  secrets.set('srv-keychain', JSON.stringify({ password: 'from-keychain' }))
  await vaultCreate('a-long-enough-password')
  vaultSave([ENTRY])
})
afterEach(() => {
  setVaultAutoLock(0)
  vi.useRealTimers()
})

describe('after the vault secures itself on the idle timer', () => {
  it('still resolves a server credential, so nothing background pauses', () => {
    vi.useFakeTimers()
    setVaultAutoLock(15)
    vi.advanceTimersByTime(15 * 60_000 + 1000)

    expect(vaultStatus().stage).toBe('secured')

    // The thing that used to throw VaultLockedError here, which is what
    // stopped the sweep, the CI poll, the scheduled backup and the reconnect.
    const cfg = resolveSecrets({ serverId: 'srv-vault', host: 'h', username: 'deploy' } as never)
    expect((cfg as { password?: string }).password).toBe('hunter2')

    // And the sampler gate agrees, so the target is not skipped either.
    expect(credentialResolvable('srv-vault')).toBe(true)
  })

  it('still refuses to hand the entries to the renderer', () => {
    vi.useFakeTimers()
    setVaultAutoLock(15)
    vi.advanceTimersByTime(15 * 60_000 + 1000)

    // The half the timer DOES take away. If this ever passes, securing
    // protects nothing and the timeout is decoration.
    const listed = vaultList()
    expect(listed.ok).toBe(false)
    expect(listed.entries).toBeUndefined()
  })

  it('does not postpone itself by resolving credentials', () => {
    vi.useFakeTimers()
    setVaultAutoLock(15)

    // Fourteen minutes of a monitoring sweep resolving every two minutes. This
    // used to reset the timer on every call, so on a real estate the vault
    // never secured itself at all.
    for (let m = 0; m < 14; m += 2) {
      vi.advanceTimersByTime(2 * 60_000)
      resolveSecrets({ serverId: 'srv-vault', host: 'h', username: 'deploy' } as never)
    }
    vi.advanceTimersByTime(2 * 60_000)

    expect(vaultStatus().stage).toBe('secured')
  })
})

describe('once the vault is fully locked', () => {
  it('refuses the vault-backed server and allows the keychain one', () => {
    vaultLock()

    expect(() =>
      resolveSecrets({ serverId: 'srv-vault', host: 'h', username: 'deploy' } as never)
    ).toThrow()
    try {
      resolveSecrets({ serverId: 'srv-vault', host: 'h', username: 'deploy' } as never)
    } catch (e) {
      // Recognisable, so the screen that asked offers an unlock.
      expect(isVaultLockedError(e)).toBe(true)
    }

    // The server that never referenced the vault is unaffected — the defect
    // that made one vault-backed server stop the whole estate being sampled.
    const other = resolveSecrets({ serverId: 'srv-keychain', host: 'h', username: 'x' } as never)
    expect((other as { password?: string }).password).toBe('from-keychain')
    expect(credentialResolvable('srv-keychain')).toBe(true)
    expect(credentialResolvable('srv-vault')).toBe(false)
  })
})

/**
 * And a wrong password must not undo it.
 *
 * `secured` is the state this whole file exists to protect: the vault is
 * unlocked and serving every background reader while the renderer holds no
 * plaintext. A surface that wants plaintext asks for the password again — and
 * `vaultUnlock`'s catch used to zero the key, the salt and the cache
 * unconditionally.
 *
 * So one typo did not merely fail. It tore down a working vault: the sweep,
 * the backups, CI polling and VPN autostart all stopped together, and the only
 * way back was typing the password correctly, which the user had no reason to
 * think was suddenly required because it had all been working a moment before.
 *
 * You cannot fail your way into a worse state than you started in.
 */
describe('a failed unlock attempt', () => {
  it('leaves a secured vault secured, and still resolving', async () => {
    const { vaultUnlock } = await import('../src/main/services/vault')
    vi.useFakeTimers()
    setVaultAutoLock(15)
    vi.advanceTimersByTime(15 * 60_000 + 1000)
    expect(vaultStatus().stage).toBe('secured')

    const bad = await vaultUnlock('not-the-password')
    expect(bad.ok).toBe(false)

    // The state is untouched...
    expect(vaultStatus().stage).toBe('secured')
    expect(vaultStatus().unlocked).toBe(true)
    // ...and, which is the point, background work still authenticates.
    const cfg = resolveSecrets({ serverId: 'srv-vault', host: 'h', username: 'deploy' } as never)
    expect((cfg as { password?: string }).password).toBe('hunter2')
  })

  it('leaves an open vault open', async () => {
    const { vaultUnlock } = await import('../src/main/services/vault')
    expect(vaultStatus().stage).toBe('open')

    expect((await vaultUnlock('wrong')).ok).toBe(false)

    expect(vaultStatus().stage).toBe('open')
    // `vaultList` answers an envelope, not an array — and the entries still
    // being readable is the half that matters: the cache survived.
    expect(vaultList()).toMatchObject({ ok: true })
    expect((vaultList() as { entries: unknown[] }).entries).toHaveLength(1)
  })

  it('still refuses, and still locks, when the vault was locked to begin with', async () => {
    // The fix must not turn a failed attempt into a successful one, nor leave
    // a locked vault reporting anything but locked.
    const { vaultUnlock } = await import('../src/main/services/vault')
    vaultLock()
    expect(vaultStatus().stage).toBe('locked')

    const bad = await vaultUnlock('wrong')
    expect(bad.ok).toBe(false)
    expect(vaultStatus().stage).toBe('locked')
    expect(vaultStatus().unlocked).toBe(false)
  })

  it('still opens on the right password after a failed attempt', async () => {
    const { vaultUnlock } = await import('../src/main/services/vault')
    vaultLock()
    expect((await vaultUnlock('wrong')).ok).toBe(false)
    expect((await vaultUnlock('a-long-enough-password')).ok).toBe(true)
    expect(vaultStatus().stage).toBe('open')
  })
})
