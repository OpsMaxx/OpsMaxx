import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * A revoked device wipes itself, and can say so afterwards.
 *
 * The ordering is the whole of it. A wipe that starts before the tombstone is
 * written, or before live sessions are closed, is not a safer version of this
 * -- it is a machine holding half an estate's credentials and looking like a
 * fresh install, or a shell still open on a production host with the vault
 * that authorised it already deleted.
 */

let userData: string

vi.mock('electron', () => ({
  app: { getPath: () => userData }
}))

const revoke = await import('../src/main/services/addy/revoke')
const {
  REVOCATION_FILE,
  clearRevocation,
  isRevocationBlocking,
  revocationState,
  runRevocationWipe
} = revoke

const WHO = { accountId: 'acct-1', deviceId: 'dev-2', at: '2026-09-18T00:00:00.000Z' }

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'addy-revoke-'))
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

function tombstone(): unknown {
  return JSON.parse(readFileSync(join(userData, REVOCATION_FILE), 'utf8'))
}

describe('a revoked device wipes itself', () => {
  it('closes live sessions before deleting anything', async () => {
    const order: string[] = []
    await runRevocationWipe(WHO, {
      closeSessions: async () => {
        order.push('close')
      },
      wipe: () => {
        order.push('wipe')
        return { ok: true }
      }
    })
    expect(order).toEqual(['close', 'wipe'])
  })

  it('waits for the close to finish, not merely to start', async () => {
    // `closeSessions` returns a promise the wipe must await. An implementation
    // that called it without awaiting would still produce ['close', 'wipe']
    // above, because the synchronous part of it runs first -- so the ordering
    // test alone does not catch it and this one does.
    const order: string[] = []
    await runRevocationWipe(WHO, {
      closeSessions: async () => {
        await new Promise((r) => setTimeout(r, 5))
        order.push('close-finished')
      },
      wipe: () => {
        order.push('wipe')
        return { ok: true }
      }
    })
    expect(order).toEqual(['close-finished', 'wipe'])
  })

  it('writes the tombstone before the wipe, so an interrupted wipe resumes', async () => {
    let seenDuringWipe: { stage?: string } | null = null
    await runRevocationWipe(WHO, {
      closeSessions: async () => {},
      wipe: () => {
        // Whatever is on disk at the moment the deletion runs is what survives
        // a crash one instruction later.
        seenDuringWipe = tombstone() as { stage?: string }
        return { ok: true }
      }
    })
    expect(seenDuringWipe).not.toBeNull()
    expect(seenDuringWipe!.stage).toBe('wiping')
    expect(revocationState()?.stage).toBe('wiped')
  })

  it('records a failure with its reason rather than claiming success', async () => {
    const t = await runRevocationWipe(WHO, {
      closeSessions: async () => {},
      wipe: () => ({ ok: false, error: 'the vault file is held open' })
    })
    expect(t.stage).toBe('failed')
    expect(t.error).toBe('the vault file is held open')
    // Still blocking. A device that failed to wipe is the one case where
    // carrying on would be worst.
    expect(isRevocationBlocking()).toBe(true)
  })

  it('retries a previous failure but does not wipe twice', async () => {
    let wipes = 0
    const wipe = (): { ok: boolean; error?: string } =>
      wipes++ === 0 ? { ok: false, error: 'held open' } : { ok: true }

    await runRevocationWipe(WHO, { closeSessions: async () => {}, wipe })
    await runRevocationWipe(WHO, { closeSessions: async () => {}, wipe })
    expect(wipes).toBe(2)
    expect(revocationState()?.stage).toBe('wiped')

    // Third launch: already done, nothing to repeat.
    await runRevocationWipe(WHO, { closeSessions: async () => {}, wipe })
    expect(wipes).toBe(2)
  })
})

describe('the machine can be used again', () => {
  it('stops blocking once cleared, and keeps the record', async () => {
    await runRevocationWipe(WHO, { closeSessions: async () => {}, wipe: () => ({ ok: true }) })
    expect(isRevocationBlocking()).toBe(true)

    clearRevocation()

    expect(isRevocationBlocking()).toBe(false)
    // Kept, not deleted: it is what tells the next person looking at this
    // machine why it is empty.
    expect(revocationState()?.accountId).toBe('acct-1')
  })

  it('refuses to clear while data may still be on disk', async () => {
    await runRevocationWipe(WHO, {
      closeSessions: async () => {},
      wipe: () => ({ ok: false, error: 'held open' })
    })
    clearRevocation()
    expect(isRevocationBlocking()).toBe(true)
  })

  it('treats an unreadable tombstone as revoked, not as absent', () => {
    writeFileSync(join(userData, REVOCATION_FILE), 'not json at all')
    // The failure that matters is the one that unblocks a machine which should
    // stay blocked, so corruption resolves towards blocked.
    expect(isRevocationBlocking()).toBe(true)
  })
})

describe('the tombstone survives the wipe it triggers', () => {
  it('is not on the list of everything a wipe deletes', () => {
    // Read out of the real source rather than importing the list: importing
    // backup.ts pulls in Electron, the vault and the history store, and the
    // assertion is about the LIST, which is right there in the file.
    const src = readFileSync(resolve(__dirname, '..', 'src/main/services/backup.ts'), 'utf8')
    const i = src.indexOf('export const ALL_DATA_FILES')
    const j = src.indexOf('export const ALL_DATA_DIRS')
    expect(i).toBeGreaterThan(-1)
    expect(j).toBeGreaterThan(i)
    const lists = src.slice(i, j + 600)
    // Tidying it onto that list would make the wipe erase its own record of
    // having run, and the machine would look like a fresh install on the very
    // next launch -- the one state where the app carries on happily.
    expect(lists).not.toContain(REVOCATION_FILE)
  })

  it('and the wipe therefore leaves it readable', async () => {
    await runRevocationWipe(WHO, {
      closeSessions: async () => {},
      // A wipe that really did delete the file, to prove the tombstone is
      // rewritten afterwards rather than merely surviving by luck.
      wipe: () => {
        rmSync(join(userData, REVOCATION_FILE), { force: true })
        return { ok: true }
      }
    })
    expect(existsSync(join(userData, REVOCATION_FILE))).toBe(true)
    expect(revocationState()?.stage).toBe('wiped')
  })
})
