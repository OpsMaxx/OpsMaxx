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
  /**
   * The two public keys a roster is verified against.
   *
   * FROM THE CLIENT, NEVER FROM THE SERVER. The sidecar's own comment calls
   * that "the single most important sentence in this file": a chain verified
   * against a key the relay supplied is not verified at all. They are recorded
   * at mint time because that is the only moment they are known from a source
   * that is not the relay, and without them this device can never check its
   * own roster again.
   */
  rootSignPub: string
  epoch1SignPub: string
  /** SHA-256 of the relay's TLS SubjectPublicKeyInfo, hex — the pin the login
   *  signature is bound to. Kept so a change can be noticed rather than
   *  silently accepted. */
  spki: string
  /** Development relays present a self-signed certificate. Carried here so a
   *  resume does not quietly become strict — or quietly stay lax. */
  insecureTLS?: boolean
  /**
   * The furthest point in the roster this device has verified: the sequence
   * number and the hash of the entry at it.
   *
   * THE ANTI-ROLLBACK ANCHOR, and it has to be on disk or it is nothing. The
   * verifier raises "rewound" and "forked" only when it is given a pin, and
   * nothing gave it one — so a relay could simply withhold the newest entries
   * and every device would verify a shorter chain quite happily. Withhold the
   * one that revoked a device and that device is back in everybody's peer
   * list, receiving clipboards and accepting files.
   *
   * Absent on an enrolment written before this existed, and on the first
   * verification of a fresh one. That is the only honest starting state: a
   * device with no history cannot detect a rollback, which is why it records
   * one at the first opportunity.
   */
  pinSeq?: number
  pinHead?: string
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
  return readEnrolment().enrolment
}

/**
 * The enrolment, AND whether the answer is "there is none" or "it is there and
 * this process cannot read it".
 *
 * THOSE TWO ARE NOT THE SAME STATE AND THE PRODUCT TREATED THEM AS ONE. A file
 * present but unreadable — the wrong ACL after an installer ran elevated, a
 * truncated write, a disk error — returned the same `null` as a machine that
 * has never synced. The app then offered to set up an account this device
 * already has, and `leaveAccount` reported there was nothing to leave while a
 * live session was still running.
 *
 * `loadEnrolment` keeps the plain answer, because most callers genuinely only
 * need "do I have one". Anything that TELLS THE USER something should use this
 * one, so the sentence can be "this machine is enrolled and the record cannot
 * be read" rather than "set up addy".
 */
export function readEnrolment(): { enrolment: AddyEnrolment | null; unreadable?: string } {
  const path = FILE()
  try {
    if (!existsSync(path)) return { enrolment: null }
  } catch (err) {
    // Even the existence check can throw, on a path this process may not
    // traverse. Reported, not swallowed into "no account".
    return { enrolment: null, unreadable: `${path} cannot be reached: ${String(err)}` }
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object') {
      return { enrolment: null, unreadable: `${path} is not an enrolment record.` }
    }
    const e = parsed as AddyEnrolment
    if (typeof e.baseURL !== 'string' || typeof e.accountId !== 'string') {
      return { enrolment: null, unreadable: `${path} is missing the relay or the account id.` }
    }
    return { enrolment: e }
  } catch (err) {
    return {
      enrolment: null,
      unreadable:
        `${path} exists but cannot be read: ${err instanceof Error ? err.message : String(err)}. ` +
        `This machine may still be enrolled — do not set up a new account until this is resolved, ` +
        `or you will end up with two sets of devices that cannot see each other.`
    }
  }
}

/** Forgets the enrolment. The KEYS are not this module's to remove — see
 *  `forgetAddySecret` — because a device leaving an account and a device
 *  losing its note of where the account was are different events. */
export function forgetEnrolment(): void {
  rmSync(FILE(), { force: true })
}
