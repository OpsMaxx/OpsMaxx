import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VaultEntry } from '../src/shared/vault'

/**
 * A vault file that arrived by sync chooses nothing about how it is opened.
 *
 * The file carries its own scrypt parameters and salt, and since sync it can
 * come from another device. Parameters nothing ever wrote could make each
 * unlock attempt take most of an hour; a salt edited by a key holder would be
 * adopted and then sealed into every later save, locking every device out.
 */

const userData = mkdtempSync(join(tmpdir(), 'opsmaxx-vault-trust-'))
vi.mock('electron', () => ({
  app: { getPath: () => userData },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../src/main/services/secrets', () => ({ getSecret: () => null }))

const { vaultCreate, vaultUnlock, vaultLock, vaultSave, vaultDestroy, vaultExternalChange, vaultMergeFrom } =
  await import('../src/main/services/vault')

const FILE = join(userData, 'opsmaxx-vault.json')
const PASSWORD = 'correct-horse-battery'
const entry = (id: string): VaultEntry => ({
  id,
  name: id,
  kind: 'login',
  url: '',
  username: 'root',
  password: 's',
  notes: '',
  tags: [],
  fields: [],
  createdAt: '',
  updatedAt: ''
})
const read = (): Record<string, unknown> => JSON.parse(readFileSync(FILE, 'utf8'))

beforeEach(() => {
  vaultDestroy()
  rmSync(FILE, { force: true })
})

describe('a vault file that arrived from elsewhere', () => {
  it('is refused, without running scrypt, when it asks for settings OpsMaxx never writes', async () => {
    await vaultCreate(PASSWORD)
    vaultSave([entry('a')])
    vaultLock()
    writeFileSync(FILE, JSON.stringify({ ...read(), kdf: { N: 32768, r: 8, p: 65000 } }))

    const started = Date.now()
    const r = await vaultUnlock(PASSWORD)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/settings OpsMaxx never writes/)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('still opens a vault written at the legacy settings', async () => {
    await vaultCreate(PASSWORD)
    vaultSave([entry('a')])
    vaultLock()
    // Current-settings file relabelled as legacy would not decrypt, so this
    // only checks the gate lets the legacy triple through to scrypt.
    writeFileSync(FILE, JSON.stringify({ ...read(), kdf: { N: 32768, r: 8, p: 1 } }))
    const r = await vaultUnlock(PASSWORD)
    expect(r.error ?? '').not.toMatch(/settings OpsMaxx never writes/)
  })

  it('refuses the same settings when merging a set-aside copy', async () => {
    await vaultCreate(PASSWORD)
    const other = JSON.stringify({ ...read(), kdf: { N: 1 << 20, r: 8, p: 3 } })
    const r = await vaultMergeFrom(other, PASSWORD)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/settings OpsMaxx never writes/)
  })

  it('keeps its own salt when a copy it opens carries a different one', async () => {
    await vaultCreate(PASSWORD)
    vaultSave([entry('a')])
    const realSalt = read().salt
    // Same ciphertext, same key, edited salt field.
    writeFileSync(FILE, JSON.stringify({ ...read(), salt: Buffer.alloc(16, 7).toString('base64') }))

    expect(vaultExternalChange().relocked).toBe(false)
    vaultSave([entry('a'), entry('b')])
    expect(read().salt).toBe(realSalt)

    vaultLock()
    expect((await vaultUnlock(PASSWORD)).ok).toBe(true)
  })
})
