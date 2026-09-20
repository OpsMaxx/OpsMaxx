import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { WS_MIN_PASSWORD } from '../../shared/workspace'
import { atomicWriteFileSync } from './atomicWrite'

// Per-workspace passwords. Only a scrypt verifier is stored — never the
// password itself, and never anything reversible.
//
// NOTE: this gates access to a workspace in the UI. It does not encrypt the
// workspace's servers/databases on disk; those still live in the normal data
// file. Use the Vault for secrets that must be encrypted at rest.

// The minimum length enforced below is WS_MIN_PASSWORD, in shared/workspace.ts
// — shared rather than declared here because the renderer's form enforces the
// same rule, and the two hand-kept copies of the number were exactly the drift
// the vault's shared constant was introduced to end. The reasoning for the
// value, including why it is not the vault's 12, is in that file.

const FILE = join(app.getPath('userData'), 'opsmaxx-wslocks.json')

// The same parameters as the vault, and for the same reason: OWASP lists
// N=2^15 as adequate only at p=3, so the p=1 this used to run at was about a
// third of the intended work factor.
//
// WHY A VERIFIER THAT GUARDS NOTHING IS WORTH HARDENING. This gates the UI and
// says so above; an attacker holding this file can already read the workspace's
// servers out of opsmaxx-data.json without touching it, so cracking it wins
// them nothing they did not have. The exposure is the PASSWORD, not the
// workspace: people reuse them, and the one protecting a workspace here may be
// the one protecting the vault next door, or an account on one of the hosts
// inside it. A cheap verifier for a low-value door is still a cheap oracle for
// a password that opens expensive ones.
const KDF = { N: 32768, r: 8, p: 3, keylen: 32, maxmem: 96 * 1024 * 1024 }

// What locks written before the parameters were raised used. A lock records
// the parameters it was written with, so an existing one still verifies; it is
// re-derived at the current settings the next time it is entered correctly.
//
// This file recorded NO parameters before now, which is why raising the value
// alone would not have been a hardening but a lockout: every stored verifier
// would have stopped matching the password that produced it, with no way to
// tell that from a wrong password.
const LEGACY_KDF = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 96 * 1024 * 1024 }

interface KdfParams {
  N: number
  r: number
  p: number
}

interface Lock {
  salt: string
  hash: string
  // Absent on locks written before this existed, which means LEGACY_KDF.
  kdf?: KdfParams
}

function kdfOf(lock: Lock): KdfParams {
  return lock.kdf ?? { N: LEGACY_KDF.N, r: LEGACY_KDF.r, p: LEGACY_KDF.p }
}

function isCurrentKdf(k: KdfParams): boolean {
  return k.N === KDF.N && k.r === KDF.r && k.p === KDF.p
}
type LockMap = Record<string, Lock>

function derive(password: string, salt: Buffer, params: KdfParams = KDF): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KDF.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: KDF.maxmem },
      (err, dk) => (err ? reject(err) : resolve(dk as Buffer))
    )
  })
}

function read(): LockMap {
  try {
    if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, 'utf8')) as LockMap
  } catch {
    /* ignore corrupt file */
  }
  return {}
}

function write(map: LockMap): void {
  atomicWriteFileSync(FILE, JSON.stringify(map))
}

export function wsLockIds(): string[] {
  return Object.keys(read())
}

export async function wsLockVerify(id: string, password: string): Promise<boolean> {
  const lock = read()[id]
  if (!lock) return true // no password set — nothing to check
  try {
    const salt = Buffer.from(lock.salt, 'base64')
    const stored = kdfOf(lock)
    const got = await derive(password, salt, stored)
    const want = Buffer.from(lock.hash, 'base64')
    if (!(got.length === want.length && timingSafeEqual(got, want))) return false

    // Upgrade a lock written at the old work factor, now that the password is
    // in hand and known correct — the only moment it can be re-derived. Silent
    // because the user has nothing to decide, and best-effort because failing
    // to upgrade is not a reason to reject a password that was right.
    //
    // Re-read rather than reusing the map above: verifying is slow by design,
    // and a set or a remove for another workspace can land while it runs.
    if (!isCurrentKdf(stored)) {
      try {
        const upgraded = await derive(password, salt, KDF)
        const fresh = read()
        const still = fresh[id]
        // Only if it is the same verifier we just checked. A password changed
        // underneath us has already been written at the current parameters,
        // and overwriting it here would put the OLD password back.
        if (still && still.hash === lock.hash && still.salt === lock.salt) {
          fresh[id] = {
            salt: lock.salt,
            hash: upgraded.toString('base64'),
            kdf: { N: KDF.N, r: KDF.r, p: KDF.p }
          }
          write(fresh)
        }
      } catch {
        /* leave the lock on the parameters it already had */
      }
    }
    return true
  } catch {
    return false
  }
}

export async function wsLockSet(
  id: string,
  password: string,
  current?: string
): Promise<{ ok: boolean; error?: string }> {
  if (password.length < WS_MIN_PASSWORD)
    return {
      ok: false,
      error: `Password must be at least ${WS_MIN_PASSWORD} characters.`
    }
  const map = read()
  if (map[id] && !(await wsLockVerify(id, current ?? ''))) {
    return { ok: false, error: 'Current password is incorrect.' }
  }
  try {
    const salt = randomBytes(16)
    const hash = await derive(password, salt)
    map[id] = {
      salt: salt.toString('base64'),
      hash: hash.toString('base64'),
      kdf: { N: KDF.N, r: KDF.r, p: KDF.p }
    }
    write(map)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function wsLockRemove(
  id: string,
  current: string
): Promise<{ ok: boolean; error?: string }> {
  const map = read()
  if (!map[id]) return { ok: true }
  if (!(await wsLockVerify(id, current))) return { ok: false, error: 'Password is incorrect.' }
  delete map[id]
  write(map)
  return { ok: true }
}

// Called when a workspace is deleted so no orphan verifier is left behind.
export function wsLockDelete(id: string): void {
  const map = read()
  if (!map[id]) return
  delete map[id]
  write(map)
}
