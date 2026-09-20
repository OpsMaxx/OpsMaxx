import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A vault file that is there and cannot be read.
 *
 * `readFile` swallows any parse failure and answers null, and null also means
 * "no vault". Collapsing the two put the app somewhere it could not leave,
 * holding two sentences that contradict each other and neither of which says
 * what happened:
 *
 *   - unlocking said "No vault has been created yet"
 *   - creating said "A vault already exists on this machine"
 *
 * Both true from where they stood. Together, a dead end.
 *
 * The reassuring half is pinned here too, because it is the question worth
 * answering first: NOTHING IS LOST. `vaultCreate` refuses while the file is
 * present, so a damaged vault cannot be overwritten by a new one.
 */

const userData = mkdtempSync(join(tmpdir(), 'opsmaxx-vault-damaged-'))
vi.mock('electron', () => ({
  app: { getPath: () => userData },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../src/main/services/secrets', () => ({ getSecret: () => null }))

const { vaultStatus, vaultUnlock, vaultCreate } = await import('../src/main/services/vault')

const FILE = join(userData, 'opsmaxx-vault.json')

/** Whatever a half-written file, a truncated sync or a disk error leaves. */
const damage = (body: string): void => writeFileSync(FILE, body)

beforeEach(() => rmSync(FILE, { force: true }))

describe('a vault file that cannot be read', () => {
  it('is reported as damaged, not as absent', () => {
    damage('{"version":1,"salt":"AAAA",')
    const s = vaultStatus()

    expect(s.exists).toBe(true)
    expect(s.damaged).toBe(true)
  })

  it('says so when unlocked, instead of "no vault has been created"', async () => {
    damage('not json at all')
    const r = await vaultUnlock('any-password-at-all')

    expect(r.ok).toBe(false)
    // The sentence that was wrong. A user whose vault is sitting right there
    // being told it was never created has nothing to act on.
    expect(r.error).not.toMatch(/No vault has been created/)
    // What they need instead: that no password can help, where the file is,
    // and that it is safe.
    expect(r.error).toMatch(/could not be read/i)
    expect(r.error).toContain(FILE)
    expect(r.error).toMatch(/backup|move that file aside/i)
  })

  it('does not let a new vault overwrite it', async () => {
    damage('{ truncated')
    const r = await vaultCreate('a-long-enough-password')

    expect(r.ok).toBe(false)
    // The file is untouched — this is a dead end, not a deletion.
    expect(existsSync(FILE)).toBe(true)
    expect(vaultStatus().damaged).toBe(true)
  })

  it('is not claimed for a vault that is merely absent', () => {
    const s = vaultStatus()
    expect(s.exists).toBe(false)
    expect(s.damaged).toBeUndefined()
  })

  it('is not claimed for a healthy vault', async () => {
    expect((await vaultCreate('a-long-enough-password')).ok).toBe(true)
    // Unlocked, so the file parsed. Nothing should be re-reading it to say so.
    expect(vaultStatus().damaged).toBeUndefined()
  })
})
