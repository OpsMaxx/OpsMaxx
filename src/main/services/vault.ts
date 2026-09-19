import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { atomicWriteFileSync } from './atomicWrite'
import { randomBytes, scrypt, createCipheriv, createDecipheriv } from 'node:crypto'
import type { VaultEntry, VaultListResult, VaultResult, VaultStage, VaultStatus } from '../../shared/vault'
import { VAULT_LOCKED, VAULT_MIN_PASSWORD } from '../../shared/vault'

// The floor is imported, not restated. Main is the real enforcement boundary —
// the renderer's own check only covers the UI, and any other caller of the
// vault IPC reaches these functions directly — so a second literal here would
// be the one that silently decides how weak a master password may be. It was
// 8 while the shared constant said 12, which is exactly the drift that comment
// warns about.
//
// Only creating and changing a password are checked. Unlocking deliberately is
// not: a vault sealed under an older, lower floor must keep opening, and a
// length check on that path would lock its owner out of their own secrets.

// The vault is encrypted with AES-256-GCM under a key derived from the user's
// master password via scrypt. The password is never stored — a wrong password
// simply fails the GCM authentication tag on decrypt.
//
// The KEY exists only in main-process memory while the vault is unlocked. The
// decrypted ENTRIES do not: vault:list ships them to the renderer, where they
// live in the Zustand store for as long as the vault is open. That is a
// deliberate consequence of showing them in a UI, but it means renderer-side
// script injection reaches vault plaintext, and the threat model has to say so
// rather than claim main-process confinement it does not have.

const FILE = join(app.getPath('userData'), 'opsmaxx-vault.json')

// 128 * N * r = 32 MiB of work per derivation; maxmem must exceed that.
//
// p=3 rather than 1: OWASP's password-storage guidance lists N=2^15 as adequate
// only at p=3, so the previous p=1 was running at about a third of the intended
// work factor. That matters more for an attacker holding a copy of the vault
// file than any of the unlock UI does.
const KDF = { N: 32768, r: 8, p: 3, keylen: 32, maxmem: 96 * 1024 * 1024 }

// What vaults written before the parameters were raised used. A file records
// the parameters it was written with, so an existing vault still opens; it is
// re-encrypted at the current settings the next time it is saved.
const LEGACY_KDF = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 96 * 1024 * 1024 }

interface KdfParams {
  N: number
  r: number
  p: number
}

interface VaultFile {
  version: 1
  salt: string
  iv: string
  tag: string
  data: string
  // Absent on files written before this existed, which means LEGACY_KDF.
  kdf?: KdfParams
}

let key: Buffer | null = null
let salt: Buffer | null = null
let cache: VaultEntry[] | null = null

/**
 * Which of the three stages the vault is in. See VaultStage in shared/vault.ts.
 *
 * THE ASYMMETRY BELOW IS THE WHOLE SECURITY ARGUMENT, so it is written out
 * rather than left to be inferred from the assignments:
 *
 *   main keeps plaintext in every stage but `locked`.
 *   the renderer keeps it only in `open`.
 *
 * That is what lets a sweep resolve a credential at 3am while the entry list
 * is not sitting decrypted in a window somebody walked away from. Anything
 * that reverses the reading — a viewing path that checks `key !== null`, a
 * resolve path that demands `stage === 'open'` — breaks one half or the other,
 * so the two read paths below are deliberately separate functions rather than
 * one function with a flag.
 */
let stage: VaultStage = 'locked'

function derive(password: string, s: Buffer, params: KdfParams = KDF): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, s, KDF.keylen, { N: params.N, r: params.r, p: params.p, maxmem: KDF.maxmem }, (err, dk) =>
      err ? reject(err) : resolve(dk as Buffer)
    )
  })
}

function kdfOf(file: VaultFile): KdfParams {
  return file.kdf ?? LEGACY_KDF
}

function isCurrentKdf(params: KdfParams): boolean {
  return params.N === KDF.N && params.r === KDF.r && params.p === KDF.p
}

function readFile(): VaultFile | null {
  try {
    if (!existsSync(FILE)) return null
    return JSON.parse(readFileSync(FILE, 'utf8')) as VaultFile
  } catch {
    return null
  }
}

// Write through a temp file so a crash mid-write cannot truncate the vault.
function writeEncrypted(entries: VaultEntry[], k: Buffer, s: Buffer): void {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', k, iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(entries), 'utf8'), cipher.final()])
  const file: VaultFile = {
    version: 1,
    salt: s.toString('base64'),
    kdf: { N: KDF.N, r: KDF.r, p: KDF.p },
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  }
  atomicWriteFileSync(FILE, JSON.stringify(file))
}

function decrypt(file: VaultFile, k: Buffer): VaultEntry[] {
  const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(file.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(file.tag, 'base64'))
  const out = Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()])
  return JSON.parse(out.toString('utf8')) as VaultEntry[]
}

export function vaultStatus(): VaultStatus {
  return { exists: existsSync(FILE), unlocked: key !== null, stage, entryCount: cache?.length ?? 0 }
}

export async function vaultCreate(password: string): Promise<VaultResult> {
  if (existsSync(FILE)) return { ok: false, error: 'A vault already exists on this machine.' }
  if (password.length < VAULT_MIN_PASSWORD)
    return { ok: false, error: `Master password must be at least ${VAULT_MIN_PASSWORD} characters.` }
  try {
    const s = randomBytes(16)
    const k = await derive(password, s)
    writeEncrypted([], k, s)
    key = k
    salt = s
    cache = []
    stage = 'open'
    touchVaultActivity()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function vaultUnlock(password: string): Promise<VaultResult> {
  const file = readFile()
  if (!file) return { ok: false, error: 'No vault has been created yet.' }
  // Captured before anything can change it. See the catch at the end.
  const wasOpen = key !== null
  try {
    const s = Buffer.from(file.salt, 'base64')
    const stored = kdfOf(file)
    const k = await derive(password, s, stored)
    cache = decrypt(file, k) // throws if the password is wrong

    // Upgrade a vault written at the old work factor, now that the password is
    // in hand and known correct — the only moment it can be re-derived. Silent
    // because the user has nothing to decide, and best-effort because failing
    // to upgrade is not a reason to refuse an unlock that already succeeded.
    if (!isCurrentKdf(stored)) {
      try {
        const upgraded = await derive(password, s, KDF)
        writeEncrypted(cache, upgraded, s)
        key = upgraded
        salt = s
        stage = 'open'
        touchVaultActivity()
        return { ok: true }
      } catch {
        /* keep the vault open on the parameters it already had */
      }
    }

    key = k
    salt = s
    stage = 'open'
    touchVaultActivity()
    return { ok: true }
  } catch {
    // A FAILED ATTEMPT MUST NOT LOCK A VAULT THAT WAS ALREADY OPEN.
    //
    // This used to zero the key, the salt and the cache unconditionally, so a
    // mistyped password did not merely fail — it tore down a vault that was
    // working and serving every background reader in the process. The stage
    // that makes it reachable is `secured`: the vault IS unlocked, the
    // renderer holds no plaintext, and a surface that wants some asks for the
    // password again. One typo there stopped the fleet sampler, the backups,
    // CI polling and VPN autostart together, and the only way back was typing
    // the password correctly — which the user had no reason to think was
    // suddenly required, because it had all been working a moment earlier.
    //
    // Nothing is reset on the way in either: `decrypt` assigns to `cache` only
    // on success and every other assignment is after it, so an attempt that
    // fails now leaves the vault exactly as it found it.
    if (!wasOpen) {
      key = null
      salt = null
      cache = null
      stage = 'locked'
    }
    return { ok: false, error: 'Incorrect master password.' }
  }
}

// The derived key, for biometric unlock to hold on the user's behalf. Only
// ever readable while the vault is already unlocked — this cannot be used to
// obtain a key the caller did not already have — and never leaves the main
// process. Returned as a copy so a caller cannot zero the live key.
export function vaultExportKey(): { key: Buffer; salt: Buffer } | null {
  if (!key || !salt) return null
  return { key: Buffer.from(key), salt: Buffer.from(salt) }
}

// Unlock with a previously derived key instead of a password. The GCM tag is
// still what decides: a key that does not decrypt the file fails exactly as a
// wrong password does, so a corrupted or stale stored key cannot half-open a
// vault.
export function vaultUnlockWithKey(k: Buffer, s: Buffer): VaultResult {
  const file = readFile()
  if (!file) return { ok: false, error: 'No vault exists yet.' }
  try {
    const entries = decrypt(file, k)
    key = Buffer.from(k)
    salt = Buffer.from(s)
    cache = entries
    stage = 'open'
    touchVaultActivity()
    return { ok: true }
  } catch {
    return { ok: false, error: 'The stored key no longer opens this vault.' }
  }
}

// Idle auto-secure.
//
// A vault that never shuts itself makes every other protection here optional:
// the decrypted entries sit in the renderer for as long as the app is open,
// which on a workstation is days.
//
// The timer moves the vault to `secured`, NOT to `locked`, and the difference
// is the whole point. Locking outright stopped monitoring, CI polling,
// scheduled backups and every reconnect along with hiding the entries, so a
// monitoring tool stopped monitoring because nobody had clicked anything for a
// quarter of an hour. Securing removes the exposure a timer can actually remove
// — the renderer's plaintext copy — and leaves the key where unattended work
// can still reach it. shared/vault.ts VaultStage states what that gives up.
//
// The timer measures A PERSON. It is reset by `vaultList`, which is the IPC
// read, and deliberately NOT by `vaultEntriesForResolve`, which is the
// background one — see the comment on that function.
let idleTimer: ReturnType<typeof setTimeout> | null = null
let idleMinutes = 15
let onAutoSecure: (() => void) | null = null

export function setVaultAutoLock(minutes: number, onSecure?: () => void): void {
  idleMinutes = minutes
  if (onSecure) onAutoSecure = onSecure
  touchVaultActivity()
}

export function touchVaultActivity(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  // 0 disables it, for anyone who would rather decide for themselves.
  // Only armed while the vault is actually open: a timer counting down against
  // a vault that is already secured has nothing left to take away, and one
  // armed against no key at all was what `vaultList` used to do by touching
  // before it checked.
  if (idleMinutes <= 0 || stage !== 'open') return
  idleTimer = setTimeout(() => {
    vaultSecure()
    onAutoSecure?.()
  }, idleMinutes * 60_000)
}

/**
 * Stage 1: take the vault off the screen without taking it away from the app.
 *
 * Keeps `key`, `salt` AND `cache` — resolution has to come from somewhere and
 * `cache` is it. What must be dropped is the RENDERER's copy, which is not
 * this module's to drop: main sends `vault:secured` and the renderer's store
 * clears itself. If that message is ever lost, this stage protects nothing,
 * which is why the renderer subscribes once at app level rather than from
 * whichever view happens to be mounted.
 */
export function vaultSecure(): VaultResult {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  if (key) stage = 'secured'
  return { ok: true }
}

export function vaultLock(): VaultResult {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  key?.fill(0)
  key = null
  salt = null
  cache = null
  stage = 'locked'
  return { ok: true }
}

/**
 * The human read, over IPC. Refuses unless the vault is fully open.
 *
 * The guard comes BEFORE the touch. It used to come after, which armed an idle
 * timer on a call that had just been refused.
 *
 * The refusal carries VAULT_LOCKED so the renderer offers an unlock rather than
 * printing a sentence the user has to act on by hand — the invariant
 * tests/vaultLockedOffersUnlock.test.ts enforces.
 */
export function vaultList(): VaultListResult {
  if (stage !== 'open' || !key || !cache) {
    return { ok: false, error: `${VAULT_LOCKED}: the vault is locked.` }
  }
  touchVaultActivity()
  return { ok: true, entries: cache }
}

/**
 * The resolve read. Does NOT touch the idle timer, and works while `secured`.
 *
 * Separate from `vaultList` because the idle timer measures a person and
 * `vaultList` was the read path for both. A monitoring sweep resolving a
 * credential every couple of minutes postponed the human-idle lock for as long
 * as the app ran — so on an estate that sampled, the vault never locked and the
 * protection was not real; on one that did not, because pooled SSH connections
 * get reused without re-resolving, it locked and every background consumer
 * stopped at once. Both halves of that were this one line.
 *
 * Returns null rather than a result object so each caller raises its own
 * VaultLockedError with its own subject — a VPN profile should not have to
 * describe itself as a server.
 *
 * tests/vaultReadPaths.test.ts is what keeps a new background consumer from
 * reaching for `vaultList` instead: a type cannot say "IPC handlers only".
 */
export function vaultEntriesForResolve(): VaultEntry[] | null {
  return key && cache ? cache : null
}

export function vaultSave(entries: VaultEntry[]): VaultResult {
  // A write is always a person, so it needs the vault fully open — and the
  // marker, so the modal that was saving offers the unlock instead of a dead
  // sentence.
  if (stage !== 'open' || !key || !salt) {
    return { ok: false, error: `${VAULT_LOCKED}: the vault is locked.` }
  }
  touchVaultActivity()
  try {
    writeEncrypted(entries, key, salt)
    cache = entries
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function vaultChangePassword(current: string, next: string): Promise<VaultResult> {
  if (next.length < VAULT_MIN_PASSWORD)
    return { ok: false, error: `Master password must be at least ${VAULT_MIN_PASSWORD} characters.` }
  const file = readFile()
  if (!file) return { ok: false, error: 'No vault has been created yet.' }
  try {
    const entries = decrypt(file, await derive(current, Buffer.from(file.salt, 'base64')))
    const s = randomBytes(16)
    const k = await derive(next, s)
    writeEncrypted(entries, k, s)
    key?.fill(0)
    key = k
    salt = s
    cache = entries
    stage = 'open'
    touchVaultActivity()
    return { ok: true }
  } catch {
    return { ok: false, error: 'Incorrect current password.' }
  }
}

// Destroys the vault file. Only reachable from the UI behind an explicit
// confirmation, for when the master password is lost.
export function vaultDestroy(): VaultResult {
  try {
    vaultLock()
    if (existsSync(FILE)) unlinkSync(FILE)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function vaultDispose(): void {
  vaultLock()
}
