import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { readFileSync, existsSync, copyFileSync } from 'node:fs'
import { atomicWriteFileSync } from './atomicWrite'
import { secretsAvailable } from './secretsBackend'

// Workspaces, folders, servers, databases, tunnels, VPNs, CI connections.
// Credentials are NOT here — those are secrets.ts and the vault — but the
// estate is, and an estate is the reconnaissance half of an attack: which
// hosts exist, which accounts, which ports, how they are grouped.
//
// This file used to be plaintext, which made the confidentiality boundary
// inconsistent in the one direction that is hard to defend. The same bytes are
// sealed under the epoch key when addy carries them to a relay, and under
// AES-256-GCM inside a backup bundle. Only on the local disk — where they spend
// all of their time — were they in the clear, readable by anything running as
// the user: malware with no keychain entitlement, a cloud-backed Documents
// folder, a Time Machine snapshot, a support bundle, a borrowed laptop.
//
// So the blob is sealed with the OS secure store, the same mechanism
// secrets.ts uses, and NOT with the vault's master password. That choice is
// load-bearing for the workflow: the server list has to render while the vault
// is locked, because seeing your servers is how you decide to unlock. A
// password-derived key here would invert that and make the app unusable until
// you had already committed to using it.
const FILE = join(app.getPath('userData'), 'opsmaxx-data.json')
const BAK = `${FILE}.bak`

/** The on-disk shape once sealed. Still JSON, so anything that parses this
 *  file without understanding it gets an object rather than a syntax error —
 *  and gets something obviously not a server list, rather than half of one. */
interface SealedFile {
  v: 1
  enc: string
}

function isSealed(parsed: unknown): parsed is SealedFile {
  return !!parsed && typeof parsed === 'object' && typeof (parsed as SealedFile).enc === 'string'
}

/**
 * Why the last write went to disk unsealed, or null if it did not.
 *
 * secrets.ts REFUSES to persist when the OS keychain is unavailable, and that
 * is right for a credential: not saving one costs the user a retype. It is the
 * wrong trade here, because this file is the application's entire state and an
 * install that cannot save it cannot be used at all — so a machine with no
 * keyring would be bricked by a hardening that is supposed to protect it.
 *
 * Plaintext is therefore still written in that case, exactly as it always was,
 * and the fact is recorded instead of being swallowed. The rule this keeps is
 * not "never plaintext", which was never true of this file; it is that nobody
 * gets plaintext while believing otherwise.
 */
let unsealedReason: string | null = null

/**
 * Whether the estate is sealed on disk, and why not if it is not.
 *
 * `sealed` is read from the FILE rather than from the flag, because the flag
 * only knows about writes this process has made: a machine that opened the app
 * and saved nothing would otherwise report the state of a write that never
 * happened. `reason` is the flag, because "why" is only knowable at the moment
 * of the attempt.
 *
 * The boolean goes into the diagnostics payload. A bug report saying the
 * server list is readable on disk is the difference between a keyring that is
 * missing and one that is merely asleep, and the answer is not otherwise
 * visible from outside.
 */
export function dataAtRest(): { sealed: boolean; reason: string | null } {
  let sealed = true
  try {
    if (existsSync(FILE)) sealed = isSealed(JSON.parse(readFileSync(FILE, 'utf8')))
  } catch {
    // Unreadable is a different problem, reported by `loadData` returning null
    // with `dataFileExists` true. It is not a claim that the estate is lying
    // around in the clear, so it must not be reported as one.
    sealed = true
  }
  return { sealed, reason: unsealedReason }
}

/**
 * Whether the blob exists at all, as distinct from whether it can be read.
 *
 * `loadData` returns null for both, which is right for the renderer — it
 * starts clean either way — and wrong for anything that would WRITE based on
 * the answer. Sync did: a corrupt file read as "this machine has nothing", so
 * every collection was adopted from the relay and the file was rebuilt from an
 * empty object, destroying `settings`, `tabs` and every other key that has no
 * relay copy.
 *
 * Sealing adds a THIRD state to the two this already had — present, parseable,
 * and not decryptable by this machine's key — and it has to land on the same
 * side as corrupt. A restored copy of somebody else's folder, or this folder
 * after a keychain reset, is emphatically not "this machine has nothing".
 * Because `loadData` answers null for it and the file is still there, it
 * already does.
 */
export function dataFileExists(): boolean {
  // The PRIMARY only. `loadData` falls back to the backup when the primary
  // fails to parse, so a null answer with the primary present means both were
  // unreadable — which is the state worth refusing to write over. Counting a
  // leftover backup here would make a machine that has simply never saved
  // look corrupt, and that machine is the ordinary fresh install.
  return existsSync(FILE)
}

/** One file, decoded through whichever of the two shapes it is in. Throws so
 *  the caller can decide whether to try the backup. */
function readOne(path: string): { value: unknown; sealed: boolean } {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isSealed(parsed)) return { value: parsed, sealed: false }
  return {
    value: JSON.parse(safeStorage.decryptString(Buffer.from(parsed.enc, 'base64'))),
    sealed: true
  }
}

let migrated = false

/**
 * Seal a file that was written before this module sealed anything.
 *
 * On read rather than waiting for the next save, because the next save may
 * never come: a user who opens OpsMaxx to look at a server and closes it again
 * has changed nothing, and "your estate is encrypted now, as soon as you edit
 * something" is not a property anyone can rely on.
 *
 * The BACKUP is rewritten too, and that is the point rather than a detail.
 * `saveData` copies the live file to `.bak` before each write, so a migration
 * that sealed only the primary would leave the last plaintext copy of the whole
 * estate sitting next to it indefinitely, under a name that says it is a
 * backup. Sealing the file and leaving its shadow readable is not sealing it.
 */
function migrate(value: unknown): void {
  if (migrated) return
  migrated = true
  try {
    // Inside the try, because `secretsAvailable` can THROW rather than answer
    // and this runs on the read path. An exception escaping here would reach
    // `loadData`'s catch, which treats it as an unreadable primary and goes
    // looking for the backup — so a keychain that is merely not ready yet
    // would present as a corrupt estate.
    if (!secretsAvailable()) return
    const sealed = seal(value)
    atomicWriteFileSync(FILE, sealed)
    // Same bytes rather than a delete: the backup exists so one bad write
    // cannot lose the estate, and that is still true during a migration.
    if (existsSync(BAK)) atomicWriteFileSync(BAK, sealed)
  } catch (err) {
    console.error('[store] could not seal the existing data file:', err)
  }
}

function seal(data: unknown): string {
  const json = JSON.stringify(data)
  try {
    if (secretsAvailable()) {
      const file: SealedFile = { v: 1, enc: safeStorage.encryptString(json).toString('base64') }
      unsealedReason = null
      return JSON.stringify(file)
    }
    unsealedReason =
      'The OS secure store is unavailable on this machine, so your server list is saved unencrypted.'
  } catch (err) {
    // A THROW HERE MEANS THE SAME THING AS `false` ABOVE, AND MUST NOT LOSE
    // THE SAVE. safeStorage can raise rather than answer — before `app.ready`,
    // and on Linux where the backend is resolved lazily; secretsBackend.ts
    // already wraps `getSelectedStorageBackend` for this reason. Letting it
    // escape would send the exception to `saveData`'s catch, which logs to a
    // console nobody reads and returns, and the user's edit would be gone with
    // the app still showing it on screen.
    unsealedReason = `The OS secure store could not be reached (${
      err instanceof Error ? err.message : String(err)
    }), so your server list is saved unencrypted.`
  }
  return json
}

export function loadData(): unknown | null {
  // Before `ready` a sealed file cannot be opened — safeStorage throws "cannot
  // be used before app is ready" — and inside the try below that throw reads
  // exactly like a corrupt primary: it went to the backup, failed there too,
  // and answered null, which every caller takes to mean "this machine has
  // nothing". Anything that saved on that answer would write an empty estate
  // over a perfectly good one. So an early read is refused outright, here,
  // before the fallback can misfile it. `?.` because test doubles of
  // `electron` may not carry isReady; they stand for a ready app.
  if (app.isReady?.() === false) {
    throw new Error('loadData() called before app is ready; the data file cannot be unsealed yet')
  }
  try {
    if (existsSync(FILE)) {
      const { value, sealed } = readOne(FILE)
      if (!sealed) migrate(value)
      return value
    }
  } catch (err) {
    console.error('[store] primary data file unreadable, trying backup:', err)
    // A corrupt primary is exactly what the backup copy exists for. Losing
    // every server because of one bad write is not acceptable.
    try {
      if (existsSync(BAK)) return readOne(BAK).value
    } catch (bakErr) {
      console.error('[store] backup unreadable too:', bakErr)
    }
  }
  return null
}

// Written temp-then-rename, like the vault and the workspace locks. Writing
// straight over the live file meant a crash, a power loss or a full disk mid
// write could truncate it — losing every server, database and folder.
export function saveData(data: unknown): void {
  try {
    const json = seal(data)
    // Never leave the previous good copy behind on a partial write.
    if (existsSync(FILE)) {
      try {
        copyFileSync(FILE, BAK)
      } catch {
        /* a missing backup must not stop the save */
      }
    }
    atomicWriteFileSync(FILE, json)
  } catch (err) {
    console.error('[store] save failed:', err)
  }
}

/**
 * Forget the migration latch. Tests only.
 *
 * `migrated` is a module singleton and the suite reuses one process, so a test
 * that writes a legacy file after another test has already migrated one would
 * silently exercise nothing.
 */
export function resetStoreMigrationForTests(): void {
  migrated = false
  unsealedReason = null
}
