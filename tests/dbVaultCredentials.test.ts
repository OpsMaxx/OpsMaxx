import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { VaultEntry } from '../src/shared/vault'

/**
 * A database's credential, in both shapes it comes in.
 *
 * The password shape has referenced the vault for a while. The CONNECTION
 * STRING shape did not, and it was the last credential class the vault could
 * not hold: a URI carries its own password inside it, so a connection saved
 * that way lived only in the OS keychain — machine-local, uncarried by any
 * backup, and three copies whenever three connections used the same string.
 */

const secrets = new Map<string, string>()
let entries: VaultEntry[] = []
let unlocked = true

vi.mock('../src/main/services/secrets', () => ({
  getSecret: (id: string) => secrets.get(id) ?? null
}))

vi.mock('../src/main/services/vault', () => ({
  vaultStatus: () => ({
    exists: true,
    unlocked,
    stage: unlocked ? 'open' : 'locked',
    entryCount: entries.length
  }),
  vaultEntriesForResolve: () => (unlocked ? entries : null)
}))

const { resolveDbSecrets, credentialSourceFor, isVaultLockedError } = await import(
  '../src/main/services/credentialResolver'
)

const URI = 'postgresql://app:s3cr3t@db.internal:5432/prod'

// The generic's own shape, so `cfg.uri` and `cfg.password` are members the
// compiler knows about. `{ id }` alone narrows T to exactly that, and every
// assertion below reads a field it does not have.
type DbCfg = { id: string; password?: string; uri?: string }
const cfgFor = (id: string): DbCfg => ({ id })

const entry = (patch: Partial<VaultEntry>): VaultEntry => ({
  id: 'v1',
  name: 'Prod connection string',
  kind: 'key',
  url: '',
  username: '',
  password: '',
  notes: '',
  tags: [],
  fields: [],
  createdAt: '',
  updatedAt: '',
  ...patch
})

beforeEach(() => {
  secrets.clear()
  unlocked = true
  entries = [entry({ password: URI })]
})

describe('a database that references a connection string in the vault', () => {
  it('resolves the whole URI out of the entry', () => {
    secrets.set('db1', JSON.stringify({ vaultUriEntryId: 'v1' }))
    const cfg = resolveDbSecrets(cfgFor('db1'))
    expect(cfg.uri).toBe(URI)
    // The password slot stays empty: this shape carries its credential inside
    // the string, and filling both would send a password the URI did not name.
    expect(cfg.password).toBeUndefined()
  })

  it('is reported as vault-backed, so a locked vault skips it rather than failing it', () => {
    secrets.set('db1', JSON.stringify({ vaultUriEntryId: 'v1' }))
    expect(credentialSourceFor('db1')).toEqual({ source: 'vault', vaultEntryId: 'v1' })
  })

  it('fails clearly when the vault is locked, with no fall-back', () => {
    secrets.set('db1', JSON.stringify({ vaultUriEntryId: 'v1', uri: 'postgresql://stale@old/db' }))
    unlocked = false
    // The legacy field is deliberately NOT used: connecting with a stale copy
    // of a string the user has since rotated is worse than a clear refusal.
    let caught: unknown
    try {
      resolveDbSecrets(cfgFor('db1'))
    } catch (e) {
      caught = e
    }
    expect(isVaultLockedError(caught)).toBe(true)
  })

  it('still works while the vault is only secured', () => {
    // The stage that keeps unattended work alive. A scheduled dump or a size
    // sample must not stop because nobody clicked anything for 15 minutes.
    secrets.set('db1', JSON.stringify({ vaultUriEntryId: 'v1' }))
    expect(resolveDbSecrets(cfgFor('db1')).uri).toBe(URI)
  })
})

describe('the shapes that came before it', () => {
  it('still resolves a vault-backed password', () => {
    entries = [entry({ id: 'v2', kind: 'login', password: 'hunter2' })]
    secrets.set('db2', JSON.stringify({ vaultEntryId: 'v2' }))
    expect(resolveDbSecrets(cfgFor('db2')).password).toBe('hunter2')
  })

  it('still resolves a keychain URI written before the vault held them', () => {
    secrets.set('db3', JSON.stringify({ uri: URI }))
    expect(resolveDbSecrets(cfgFor('db3')).uri).toBe(URI)
    expect(credentialSourceFor('db3').source).toBe('keychain')
  })

  it('still resolves a legacy plain-string secret', () => {
    // Not JSON at all — the oldest form. A SyntaxError means "this is the
    // password", and only a SyntaxError does.
    secrets.set('db4', 'just-a-password')
    expect(resolveDbSecrets(cfgFor('db4')).password).toBe('just-a-password')
  })
})
