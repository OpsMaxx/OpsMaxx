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
