import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * What `status()` says, and — the part that matters — what it refuses to say.
 *
 * The Sync & devices panel is built on one rule, stated at the top of
 * `addyStatus.ts`: a figure nobody measured must not render as though it had
 * been. That rule is only worth anything if the answering side keeps it, and
 * it is broken by the most natural code anyone would write — `devices: []`
 * when there is no roster, `lastSeen: Date.now()` because a timestamp field
 * wants filling, `running: true` because the session is attached.
 *
 * Each of those is a green dashboard over nothing. So this checks the
 * absences, one per test, because a test that only asserts the happy snapshot
 * passes just as well over all three.
 */

const userData = mkdtempSync(join(tmpdir(), 'opsmaxx-addy-status-'))
vi.mock('electron', () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => ''
  }
}))

const { addySession } = await import('../src/main/services/addy/session')
const { saveEnrolment, forgetEnrolment } = await import('../src/main/services/addy/enrolment')

const ENROLMENT = {
  baseURL: 'https://relay.example',
  accountId: 'aad42aad5b51c8d31d31b3f529a312e2',
  epoch: 1,
  rootSignPub: 'a'.repeat(64),
  epoch1SignPub: 'b'.repeat(64),
  spki: '54177fc27d256b3d'
}

/** The private cache `refreshRoster` fills. Reached into rather than faked
 *  through a relay, because what is under test is the SNAPSHOT, and standing
 *  up a sidecar and an HTTP server to populate one field would test neither. */
function pretendRosterRead(devices: unknown[], self: string): void {
  ;(addySession as unknown as { lastRoster: unknown }).lastRoster = {
    devices,
    stillListed: true,
    self
  }
}

function forgetRoster(): void {
  ;(addySession as unknown as { lastRoster: unknown }).lastRoster = null
}

beforeEach(() => {
  forgetEnrolment()
  forgetRoster()
})
afterAll(() => rmSync(userData, { recursive: true, force: true }))

describe('a machine that has never set addy up', () => {
  it('is not enrolled, and says so without an account id', async () => {
    const s = await addySession.status()
    expect(s.enrolled).toBe(false)
    expect(s.accountId).toBeUndefined()
    expect(s.relayURL).toBeUndefined()
  })

  it('OMITS the device list rather than sending an empty one', async () => {
    // The distinction the whole panel rests on: `[]` reads as "your account
    // has no devices in it", which is both alarming and impossible. Absent
    // reads as "I have not been told", which is the truth.
    const s = await addySession.status()
    expect(s).not.toHaveProperty('devices')
    expect(s.devices).toBeUndefined()
  })
})

describe('a machine that is enrolled but has not reached the relay yet', () => {
  it('is enrolled on the strength of the note on disk', async () => {
    // A laptop on a plane is enrolled. Reporting otherwise would offer it the
    // "create an account" flow, which is the one thing it must not take.
    saveEnrolment(ENROLMENT)
    const s = await addySession.status()
    expect(s.enrolled).toBe(true)
    expect(s.accountId).toBe(ENROLMENT.accountId)
    expect(s.relayURL).toBe(ENROLMENT.baseURL)
  })

  it('does not claim a connection it does not have', async () => {
    saveEnrolment(ENROLMENT)
    const s = await addySession.status()
    expect(s.sync.connected).toBe(false)
  })

  it('still omits the roster', async () => {
    saveEnrolment(ENROLMENT)
    const s = await addySession.status()
    expect(s.devices).toBeUndefined()
  })
})

describe('once a roster has been verified', () => {
  const ME = 'aa'.repeat(32)
  const OTHER = 'bb'.repeat(32)

  beforeEach(() => {
    saveEnrolment(ENROLMENT)
    pretendRosterRead(
      [
        { pubSign: ME, pubEnc: 'cc', epoch: 1, mnemonicAdded: true, label: 'laptop' },
        { pubSign: OTHER, pubEnc: 'dd', epoch: 1, mnemonicAdded: false, label: 'desktop' }
      ],
      ME
    )
  })

  it('reports both devices and marks exactly one as this machine', async () => {
    const s = await addySession.status()
    expect(s.devices).toHaveLength(2)
    expect(s.devices!.filter((d) => d.self)).toHaveLength(1)
    expect(s.devices!.find((d) => d.self)!.id).toBe(ME)
  })

  it('uses the pseudonym the sidecar opened, not the key', async () => {
    const s = await addySession.status()
    expect(s.devices!.map((d) => d.label)).toEqual(['laptop', 'desktop'])
  })

  it('falls back to the key when the label could not be opened', async () => {
    // Which is the ordinary state for a device added in an epoch this one does
    // not hold — not an error, and not a reason to invent "Device 2".
    pretendRosterRead([{ pubSign: OTHER, pubEnc: 'dd', epoch: 2, mnemonicAdded: false }], ME)
    const s = await addySession.status()
    expect(s.devices![0].label).toContain(OTHER.slice(0, 8))
  })

  it('leaves lastSeen and addedAt null rather than filling them in', async () => {
    // The relay reports neither. A `Date.now()` here paints every device as
    // seen just now, which is the single most misleading thing this screen
    // could say.
    const s = await addySession.status()
    for (const d of s.devices!) {
      expect(d.lastSeen).toBeNull()
      expect(d.addedAt).toBeNull()
    }
  })

  it('does not claim a sync engine is running', async () => {
    // There is none in this build. Every other figure on the panel is read
    // through this flag, so a `true` here turns "last sync: never" from "not
    // started" into "badly behind".
    const s = await addySession.status()
    expect(s.sync.running).toBe(false)
    expect(s.sync.lastSyncAt).toBeNull()
  })
})
