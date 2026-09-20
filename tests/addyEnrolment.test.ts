import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The enrolment that had no home.
 *
 * `AddySession` held which relay this machine belonged to on a class field, so
 * an account created on Monday was gone on Tuesday: the keys stayed in the
 * keychain, nothing remembered which relay they were for, and the app came
 * back looking as though Addy had never been set up. Combined with
 * `attach()` having zero callers, that meant the only attached session in the
 * product's history was the one inside the process that created the account.
 *
 * What is pinned here is the contract that makes a resume possible at all —
 * and, as firmly, what must NOT be in the file.
 */

const userData = mkdtempSync(join(tmpdir(), 'opsmaxx-addy-enrol-'))
vi.mock('electron', () => ({ app: { getPath: () => userData } }))

const { saveEnrolment, loadEnrolment, forgetEnrolment } = await import(
  '../src/main/services/addy/enrolment'
)

const FILE = join(userData, 'opsmaxx-addy.json')
const read = (): string => (existsSync(FILE) ? require('node:fs').readFileSync(FILE, 'utf8') : '')

beforeEach(() => rmSync(FILE, { force: true }))
afterAll(() => rmSync(userData, { recursive: true, force: true }))

const ENROLMENT = {
  baseURL: 'https://relay.example',
  accountId: 'aad42aad5b51c8d31d31b3f529a312e2',
  epoch: 1,
  spki: '54177fc27d256b3dabcdef',
  insecureTLS: false
}

describe('remembering which relay this machine joined', () => {
  it('survives a restart', () => {
    saveEnrolment(ENROLMENT)
    expect(loadEnrolment()).toMatchObject({
      baseURL: 'https://relay.example',
      accountId: ENROLMENT.accountId,
      epoch: 1
    })
  })

  it('holds an address and NEVER key material', () => {
    saveEnrolment(ENROLMENT)
    const raw = read()
    // Everything in here is something the relay already knows and an observer
    // of the connection could see. The keys live in the OS keychain under the
    // machine-only prefix, where exportSecrets refuses to carry them.
    for (const forbidden of ['seed', 'privateKey', 'mnemonic', 'akSeed', 'deviceSignSeed']) {
      expect(raw.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
  })

  it('does not write the token', () => {
    // A token expires, so one on disk is a thing to invalidate rather than a
    // thing to use. Every resume logs in again — one round trip, and a whole
    // class of "it worked yesterday" removed.
    saveEnrolment({ ...ENROLMENT })
    expect(JSON.parse(read())).not.toHaveProperty('token')
  })

  it('keeps the date this machine FIRST joined', () => {
    saveEnrolment({ ...ENROLMENT, at: '2020-01-01T00:00:00.000Z' })
    // A resume re-records the enrolment. Re-stamping would make a years-old
    // enrolment read as this morning's — the same mistake the machine-grant
    // record avoids, for the same reason.
    saveEnrolment({ ...ENROLMENT, spki: 'rotated' })
    const after = loadEnrolment()
    expect(after?.at).toBe('2020-01-01T00:00:00.000Z')
    expect(after?.spki).toBe('rotated')
  })

  it('reads a damaged file as "not enrolled" rather than throwing', () => {
    // This is read at launch. A crash here is a window that never opens, and
    // the remedy for a damaged note is the same as for no note: set up again.
    writeFileSync(FILE, '{ truncated')
    expect(loadEnrolment()).toBeNull()
    writeFileSync(FILE, '{"baseURL":42}')
    expect(loadEnrolment()).toBeNull()
  })

  it('forgets the note without claiming to have removed the keys', () => {
    saveEnrolment(ENROLMENT)
    forgetEnrolment()
    expect(loadEnrolment()).toBeNull()
    // A device leaving an account and a device losing its note of where the
    // account was are different events; this module only does the second.
    expect(existsSync(FILE)).toBe(false)
  })
})
