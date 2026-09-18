import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteFileSync } from '../atomicWrite'
import type { BackupResult } from '../../../shared/backup'

/**
 * What a device does when the roster says it is no longer a device.
 *
 * Revocation is the one operation in addy that has to work against a machine
 * that does not want it to. Everything else the account owner does is
 * cooperative; this is not, and the whole value of the feature is the case
 * where the laptop is in someone else's hands. That puts two hard limits on
 * what this can honestly claim, and both belong in the code rather than only
 * in a threat model:
 *
 *  - It runs on next launch, when the device next reads the roster. A machine
 *    that is never opened again, or opened offline forever, never hears. This
 *    removes the ACCOUNT's data from a device that rejoins the world; it is
 *    not a remote kill switch and must never be described as one.
 *  - It is defeated by an attacker who has already copied the disk, or who
 *    stops the app running. The realistic case it does cover is the ordinary
 *    one: a laptop that is lost, sold, handed back at the end of a contract,
 *    or simply no longer trusted, and then opened again by whoever has it.
 *
 * Against that, deleting is still strictly better than not deleting, and it is
 * what the account owner believes "revoke" did.
 */

/**
 * The tombstone, and the one file here that a wipe deliberately does NOT
 * delete.
 *
 * It is written BEFORE the wipe starts, not after, and that ordering is the
 * point of it. A wipe interrupted halfway -- a crash, a pulled power cable, a
 * force quit by someone who has worked out what is happening -- otherwise
 * leaves a machine holding roughly half an estate's credentials and looking
 * exactly like a fresh install, which is the one state where the app would
 * cheerfully carry on. With the tombstone written first, an interrupted wipe
 * resumes on the next launch instead.
 *
 * It holds identifiers and a timestamp: which account revoked this device and
 * when. No key, and nothing that was in the data it replaced.
 *
 * Deliberately absent from ALL_DATA_FILES, and `tests/addyRevokeWipe.test.ts`
 * asserts that absence, because a future edit that tidied it onto that list
 * would make the wipe erase its own record of having run.
 */
export const REVOCATION_FILE = 'opsmaxx-addy-revoked.json'

export type RevocationStage = 'wiping' | 'wiped' | 'failed'

export interface RevocationTombstone {
  accountId: string
  deviceId: string
  /** ISO 8601, from the roster entry rather than this machine's clock where
   *  one is available -- a revoked device's clock is not evidence. */
  at: string
  stage: RevocationStage
  /** Present only on `failed`, and shown to whoever is holding the machine:
   *  they are the only person who can act on it. */
  error?: string
  /**
   * The user acknowledged it and asked to use the machine again.
   *
   * The tombstone is KEPT rather than deleted, because the record of having
   * been revoked and wiped is worth more than the few bytes: it is what tells
   * the next person looking at this machine why it is empty. Only the blocking
   * stops.
   */
  cleared?: boolean
}

const tombstonePath = (): string => join(app.getPath('userData'), REVOCATION_FILE)

export function revocationState(): RevocationTombstone | null {
  try {
    const p = tombstonePath()
    if (!existsSync(p)) return null
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as RevocationTombstone
    // A tombstone that does not parse into a stage is treated as present, not
    // as absent. The failure that matters is the one that unblocks a machine
    // that should stay blocked, so a corrupt file resolves towards blocked.
    if (parsed && typeof parsed === 'object') {
      return { ...parsed, stage: parsed.stage ?? 'failed' }
    }
    return { accountId: '', deviceId: '', at: '', stage: 'failed' }
  } catch {
    return { accountId: '', deviceId: '', at: '', stage: 'failed' }
  }
}

function writeTombstone(t: RevocationTombstone): void {
  // Through the shared atomic helper, for the same reason the restore writer
  // uses it: a torn tombstone is a machine that does not know it was revoked.
  atomicWriteFileSync(tombstonePath(), JSON.stringify(t))
}

export interface RevocationDeps {
  /**
   * Close everything holding a live connection, and wait for it.
   *
   * Called BEFORE the wipe, and the wipe does not start until it resolves.
   * Deleting the vault and the server list out from under a running SSH
   * session does not make the session stop -- it makes it carry on against
   * files that are gone, which is how a "delete everything" ends with a shell
   * still open on a production host and a credential proxy still forwarding
   * for it. Closing first is also the only ordering under which the user
   * watching the screen sees their sessions end for a stated reason rather
   * than break for none.
   */
  closeSessions(): Promise<void>
  /** `deleteAllData`, passed in rather than imported so this module can be
   *  tested without an Electron app object and a real userData tree. */
  wipe(): BackupResult
}

/**
 * Wipe this device, and leave the tombstone behind either way.
 *
 * Idempotent: a device that has already finished is not wiped twice, which
 * matters because this runs on every launch for as long as the tombstone is
 * there. A previous attempt that FAILED is retried, because the reason it
 * failed -- a file held open by something that has since exited, most likely
 * -- is usually gone by the next launch.
 */
export async function runRevocationWipe(
  who: Pick<RevocationTombstone, 'accountId' | 'deviceId' | 'at'>,
  deps: RevocationDeps
): Promise<RevocationTombstone> {
  const existing = revocationState()
  if (existing?.stage === 'wiped') return existing

  const base: RevocationTombstone = { ...who, stage: 'wiping' }
  writeTombstone(base)

  await deps.closeSessions()

  const result = deps.wipe()
  const done: RevocationTombstone = result.ok
    ? { ...base, stage: 'wiped' }
    : { ...base, stage: 'failed', error: result.error }
  writeTombstone(done)
  return done
}

/**
 * Forget the revocation, so the machine can be used again.
 *
 * Revocation removes THIS DEVICE from an account. It does not, and must not,
 * end the usefulness of the computer: a laptop handed back at the end of a
 * contract is re-imaged and re-issued, and a device revoked by mistake is the
 * commonest case of all. Without this the feature bricks a machine, and a
 * bricking feature is one people switch off.
 *
 * Nothing is recovered by calling it -- the data is already gone. What it
 * restores is the app's willingness to be set up again, as a NEW device with a
 * new key and a new roster entry, which is what it would be anyway.
 */
export function clearRevocation(): void {
  const t = revocationState()
  if (!t) return
  // Only once the wipe has actually finished. Clearing during `wiping` or
  // after `failed` would stop the blocking while data is still on disk, which
  // is the exact state the tombstone exists to survive.
  if (t.stage !== 'wiped') return
  writeTombstone({ ...t, cleared: true })
}

/**
 * Whether the app should refuse to do anything but explain itself.
 *
 * Separate from `revocationState` because the two questions are different: the
 * tombstone answers "was this device revoked", which stays true forever, and
 * this answers "is that still in the user's way", which they can end. A single
 * function would have had to choose, and whichever it chose would be wrong at
 * one of the two call sites.
 */
export function isRevocationBlocking(): boolean {
  const t = revocationState()
  return t !== null && t.cleared !== true
}
