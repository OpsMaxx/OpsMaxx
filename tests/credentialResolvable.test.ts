import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Whether one record's credential can be read, asked per record.
 *
 * The predicate this replaces was per-APP — `vaultStatus().unlocked` — and
 * three background services gated on it. So a server whose password lives in
 * the OS keychain stopped being sampled because some OTHER server happened to
 * reference a vault entry. The vault is where a credential is supposed to
 * live, which made the old gate punish the recommended choice hardest.
 */

const secrets = new Map<string, string>()
let unlocked = true
let exists = true

vi.mock('../src/main/services/secrets', () => ({
  getSecret: (id: string) => secrets.get(id) ?? null
}))

vi.mock('../src/main/services/vault', () => ({
  vaultStatus: () => ({
    exists,
    unlocked,
    stage: unlocked ? 'open' : 'locked',
    entryCount: 0
  }),
  vaultEntriesForResolve: () => (unlocked ? [] : null)
}))

const { credentialResolvable } = await import('../src/main/services/credentialResolver')

beforeEach(() => {
  secrets.clear()
  unlocked = true
  exists = true
  secrets.set('vault-backed', JSON.stringify({ vaultEntryId: 'v1' }))
  secrets.set('keychain-backed', JSON.stringify({ password: 'hunter2' }))
})

describe('whether a credential can be resolved', () => {
  it('blocks only the vault-backed record when the vault is locked', () => {
    unlocked = false
    expect(credentialResolvable('vault-backed')).toBe(false)
    expect(credentialResolvable('keychain-backed')).toBe(true)
    // No stored credential at all is not a vault problem either: whatever
    // fails later, it will not be this.
    expect(credentialResolvable('unknown')).toBe(true)
  })

  it('allows everything while the vault is open', () => {
    expect(credentialResolvable('vault-backed')).toBe(true)
    expect(credentialResolvable('keychain-backed')).toBe(true)
  })

  it('allows everything while the vault is merely secured', () => {
    // The stage that keeps background work alive. `unlocked` stays true
    // because the key is still in main; only the renderer's copy went.
    unlocked = true
    expect(credentialResolvable('vault-backed')).toBe(true)
  })

  it('treats a machine with no vault as no obstacle', () => {
    // A vault that does not exist is not a locked vault — those installs keep
    // their credentials in the OS keychain and everything works.
    exists = false
    unlocked = false
    expect(credentialResolvable('vault-backed')).toBe(true)
  })
})
