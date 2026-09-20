import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VaultEntry } from '../src/shared/vault'

/**
 * The vault file replaced underneath a running process.
 *
 * Sync carries `opsmaxx-vault.json` as an opaque collection, and when another
 * device's copy wins it is written straight to disk — which is correct, and is
 * the only half that existed. This module read that file ONCE, at unlock, and
 * served `cache` for the rest of the session; `vaultStatus` says so in as many
 * words ("re-reading it on every status poll would be a file read per poll for
 * an answer that cannot have changed"). The file could not change under it
 * until sync could write it, and then it could.
 *
 * What that produced, reported from a real pair of devices: the second machine
 * imported every server and none of the credentials, could log in to nothing,
 * and its monitoring stayed empty because the sampler skips a target whose
 * credential it cannot resolve. The pulled vault was on disk the whole time.
 *
 * The half worse than that is the write. `vaultSave` re-encrypts `cache` under
 * the key and salt this process is still holding and atomically replaces the
 * file — so one edit after a pull puts the OLD device's vault back over the
 * new one, and the next sync pass sees a local change with no remote one and
 * pushes it as the account's winner. Every other device's credentials, gone,
 * from one save.
 */

const userData = mkdtempSync(join(tmpdir(), 'opsmaxx-vault-external-'))
vi.mock('electron', () => ({
  app: { getPath: () => userData },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../src/main/services/secrets', () => ({ getSecret: () => null }))

const {
  vaultCreate,
  vaultUnlock,
  vaultList,
  vaultSave,
  vaultStatus,
  vaultDestroy,
  vaultExternalChange
} = await import('../src/main/services/vault')

const FILE = join(userData, 'opsmaxx-vault.json')

const PASSWORD_A = 'device-a-master-1234'
const PASSWORD_B = 'device-b-master-5678'

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

/** A vault file as some other device would have written it: its own salt, its
 *  own password, its own entries. Left locked and removed afterwards, so the
 *  bytes are all that survives. */
async function foreignVaultBytes(password: string, entries: VaultEntry[]): Promise<Buffer> {
  rmSync(FILE, { force: true })
  vaultDestroy()
  await vaultCreate(password)
  vaultSave(entries)
  const bytes = readFileSync(FILE)
  vaultDestroy()
  rmSync(FILE, { force: true })
  return bytes
}

beforeEach(() => {
  vaultDestroy()
  rmSync(FILE, { force: true })
})

describe('a vault file replaced by sync', () => {
  it('locks, rather than going on serving the entries it can no longer read', async () => {
    const theirs = await foreignVaultBytes(PASSWORD_B, [entry('theirs', 'their-secret')])

    await vaultCreate(PASSWORD_A)
    vaultSave([entry('mine', 'my-secret')])
    expect(vaultList().ok).toBe(true)

    // Sync pulls the account's copy and writes it. Nothing tells this module.
    writeFileSync(FILE, theirs)
    const r = vaultExternalChange()

    expect(r.relocked).toBe(true)
    expect(vaultStatus().unlocked).toBe(false)
    // The entries this process was holding are for a file that is no longer
    // there. Serving them is the reported symptom, one layer down.
    expect(vaultList().ok).toBe(false)
  })

  it('opens with the other device’s master password, because the salt travelled with it', async () => {
    const theirs = await foreignVaultBytes(PASSWORD_B, [entry('theirs', 'their-secret')])

    await vaultCreate(PASSWORD_A)
    vaultSave([entry('mine', 'my-secret')])
    writeFileSync(FILE, theirs)
    vaultExternalChange()

    const opened = await vaultUnlock(PASSWORD_B)
    expect(opened.ok).toBe(true)
    const list = vaultList()
    expect(list.ok && list.entries?.map((e) => e.id)).toEqual(['theirs'])
  })

  it('cannot then write the copy it was holding back over the file', async () => {
    const theirs = await foreignVaultBytes(PASSWORD_B, [entry('theirs', 'their-secret')])

    await vaultCreate(PASSWORD_A)
    vaultSave([entry('mine', 'my-secret')])
    writeFileSync(FILE, theirs)
    vaultExternalChange()

    // THE DATA-LOSS PATH. Before this existed the save succeeded, re-encrypted
    // the stale cache under the old key and salt, and the next sync pass
    // pushed it as the account's winner.
    const saved = vaultSave([entry('mine', 'my-secret')])
    expect(saved.ok).toBe(false)
    expect(readFileSync(FILE).equals(theirs)).toBe(true)
  })

  it('stays open when the arriving copy is one this key can still read', async () => {
    await vaultCreate(PASSWORD_A)
    vaultSave([entry('later', 'later-secret')])
    const sameLineage = readFileSync(FILE)
    vaultSave([entry('earlier', 'earlier-secret')])

    // Two devices sharing one vault's lineage share its salt, so the same
    // master password derives the same key and the arriving copy opens. There
    // is nothing to lock here — only contents moved.
    writeFileSync(FILE, sameLineage)
    const r = vaultExternalChange()

    expect(r.relocked).toBe(false)
    const list = vaultList()
    expect(list.ok && list.entries?.map((e) => e.id)).toEqual(['later'])
  })

  it('does nothing to a vault that was already locked', async () => {
    const theirs = await foreignVaultBytes(PASSWORD_B, [entry('theirs', 'their-secret')])
    writeFileSync(FILE, theirs)

    // Nothing is held, so there is nothing to invalidate and nothing to say.
    // The next unlock reads the file, which is the copy that just arrived.
    const r = vaultExternalChange()

    expect(r.relocked).toBe(false)
    expect(existsSync(FILE)).toBe(true)
    expect(vaultStatus().unlocked).toBe(false)
  })
})
