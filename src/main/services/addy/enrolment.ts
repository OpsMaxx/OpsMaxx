import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { atomicWriteFileSync } from '../atomicWrite'

/**
 * Which relay this machine belongs to, across restarts.
 *
 * THE ENROLMENT HAD NO HOME. The session held it on a class field, so an
 * account created on Monday was gone on Tuesday: the keys stayed in the
 * keychain, nothing remembered which relay they were for, and the app came
 * back looking as though Addy had never been set up. That is most of why
 * nobody could tell whether any of this worked.
 *
 * WHAT IS IN HERE IS AN ADDRESS, NOT A SECRET. The relay, the account id, the
 * epoch and the TLS pin — every one of them is something the relay already
 * knows and something an observer of the connection could see. The key
 * material stays in the OS keychain under the machine-only prefix, where
 * `createAccount` puts it and where `exportSecrets` refuses to carry it.
 *
 * The TOKEN is deliberately absent. It expires, and a stale one on disk is a
 * thing to invalidate rather than a thing to use — so every resume logs in
 * again, which costs one round trip and removes a whole class of "it worked
 * yesterday" failure.
 */

const FILE = (): string => join(app.getPath('userData'), 'opsmaxx-addy.json')

export interface AddyEnrolment {
  /** `https://relay.example`. */
  baseURL: string
  accountId: string
  epoch: number
  /** SHA-256 of the relay's TLS SubjectPublicKeyInfo, hex — the pin the login
   *  signature is bound to. Kept so a change can be noticed rather than
   *  silently accepted. */
  spki: string
  /** Development relays present a self-signed certificate. Carried here so a
   *  resume does not quietly become strict — or quietly stay lax. */
  insecureTLS?: boolean
  /** When this machine joined, for the panel to show. */
  at: string
}

export function saveEnrolment(e: Omit<AddyEnrolment, 'at'> & { at?: string }): void {
  const existing = loadEnrolment()
  atomicWriteFileSync(
    FILE(),
    JSON.stringify(
      {
        ...e,
        // The date this machine FIRST joined, not the date of the last login.
        // Re-stamping on every resume would make a year-old enrolment read as
        // this morning's, which is the same mistake the machine-grant record
        // avoids for the same reason.
        at: existing?.at ?? e.at ?? new Date().toISOString()
      },
      null,
      2
    ),
    0o600
  )
}

/** The enrolment, or null. A file that will not parse is null rather than a
 *  throw: the remedy is the same as having none — set up again — and a crash
 *  at launch is not a remedy at all. */
export function loadEnrolment(): AddyEnrolment | null {
  try {
    const path = FILE()
    if (!existsSync(path)) return null
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const e = parsed as AddyEnrolment
    if (typeof e.baseURL !== 'string' || typeof e.accountId !== 'string') return null
    return e
  } catch {
    return null
  }
}

/** Forgets the enrolment. The KEYS are not this module's to remove — see
 *  `forgetAddySecret` — because a device leaving an account and a device
 *  losing its note of where the account was are different events. */
export function forgetEnrolment(): void {
  rmSync(FILE(), { force: true })
}
