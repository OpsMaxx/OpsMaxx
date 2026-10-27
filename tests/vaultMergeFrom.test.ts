import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VaultEntry } from '../src/shared/vault'

/**
 * Folding a vault that sync set aside into the one in use.
 *
 * A machine joining an account with its own vault adopts the account's and
 * keeps its own as a conflict copy: sync carries the vault as ciphertext and
 * can open neither. The chooser could only keep one whole copy, which threw
 * the other machine's credentials away. Opened with the master password it was
 * made with, its entries are added by id instead.
 */

const userData = mkdtempSync(join(tmpdir(), 'opsmaxx-vault-merge-'))
vi.mock('electron', () => ({
  app: { getPath: () => userData },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../src/main/services/secrets', () => ({ getSecret: () => null }))

const { vaultCreate, vaultUnlock, vaultLock, vaultList, vaultSave, vaultDestroy, vaultMergeFrom } =
  await import('../src/main/services/vault')

const FILE = join(userData, 'opsmaxx-vault.json')
const MINE = 'account-master-1234'
const THEIRS = 'joining-machine-5678'

const entry = (id: string, secret: string): VaultEntry => ({
  id,
  name: id,
  kind: 'login',
  url: '',
  username: 'root',
  password: secret,
  notes: '',
  tags: [],
  fields: [],
  createdAt: '',
  updatedAt: ''
})

/** The set-aside copy as the conflict list hands it over: the file's text. */
async function otherCopy(password: string, entries: VaultEntry[]): Promise<string> {
  await vaultCreate(password)
  vaultSave(entries)
  const text = readFileSync(FILE, 'utf8')
  vaultDestroy()
  return text
}

const names = (): string[] => {
  const r = vaultList()
  if (!r.ok) throw new Error(r.error)
  return (r.entries ?? []).map((e) => `${e.id}:${e.name}:${e.password}`)
}

beforeEach(() => {
  vaultDestroy()
  rmSync(FILE, { force: true })
})

describe('adding a set-aside vault to the one in use', () => {
  it('adds its entries by id, skips identical ones, and keeps a differing one as a second entry', async () => {
    const copy = await otherCopy(THEIRS, [
      entry('shared', 'same'),
      entry('clash', 'theirs'),
      entry('only-theirs', 'x')
    ])
    await vaultCreate(MINE)
    vaultSave([entry('shared', 'same'), entry('clash', 'mine')])

    const r = await vaultMergeFrom(copy, THEIRS)

    expect(r).toEqual({ ok: true, added: 2 })
    const after = names()
    expect(after[0]).toBe('shared:shared:same')
    expect(after[1]).toBe('clash:clash:mine')
    // Nothing chosen between: the other machine's credential is there too,
    // under a new id so neither is lost or ambiguous.
    expect(after[2]).toMatch(/^[0-9a-f-]{36}:clash \(other copy\):theirs$/)
    expect(after[3]).toBe('only-theirs:only-theirs:x')

    // Written to disk under the vault in use's password, not held in memory.
    vaultLock()
    expect((await vaultUnlock(MINE)).ok).toBe(true)
    expect(names()).toHaveLength(4)
  })

  it('refuses the wrong password and changes nothing', async () => {
    const copy = await otherCopy(THEIRS, [entry('only-theirs', 'x')])
    await vaultCreate(MINE)
    vaultSave([entry('mine', 'y')])

    const r = await vaultMergeFrom(copy, 'not-the-password')

    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/does not open the other copy/)
    expect(names()).toEqual(['mine:mine:y'])
  })

  it('needs the vault in use open', async () => {
    const copy = await otherCopy(THEIRS, [entry('only-theirs', 'x')])
    await vaultCreate(MINE)
    vaultLock()

    const r = await vaultMergeFrom(copy, THEIRS)

    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/locked/)
  })

  it('refuses something that is not a vault file', async () => {
    await vaultCreate(MINE)
    expect(await vaultMergeFrom('{"servers":[]}', THEIRS)).toEqual({
      ok: false,
      error: 'The other copy is not a vault file.'
    })
  })
})
