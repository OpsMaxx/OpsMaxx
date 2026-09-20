import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The roster says this device is gone, so this device deletes itself.
 *
 * ===========================================================================
 * WHY THIS IS NOT COVERED BY `addyRevokeWipe.test.ts`
 * ===========================================================================
 *
 * That file tests `runRevocationWipe` directly and it is a good test. It is
 * also why nobody noticed the function had no callers: the suite exercised the
 * wipe, so the wipe looked shipped, while the only thing that could START it —
 * reading `selfListed` off a verified chain — was computed and discarded.
 *
 * So this tests the TRIGGER, from the roster read down, because that is the
 * half that was missing and the half no unit test could see.
 */

const userData = mkdtempSync(join(tmpdir(), 'opsmaxx-addy-revtrig-'))
vi.mock('electron', () => ({
  app: { getPath: () => userData, getVersion: () => '0' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => ''
  }
}))

const wiped = vi.fn(() => ({ ok: true as const }))
vi.mock('../src/main/services/backup', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../src/main/services/backup')
  return { ...actual, deleteAllData: () => wiped() }
})

const { addySession } = await import('../src/main/services/addy/session')
const { revocationState, clearRevocation, REVOCATION_FILE } = await import(
  '../src/main/services/addy/revoke'
)

const ME = 'aa'.repeat(32)
const OTHER = 'bb'.repeat(32)

/** A sidecar whose `verifyRoster` answers whatever this test wants. */
function sidecarSaying(selfListed: boolean, devices: string[]): unknown {
  return {
    alive: () => true,
    close: async () => undefined,
    send: async (method: string) => {
      if (method === 'whoami') return { devicePub: ME, deviceEnc: 'cc'.repeat(32) }
      if (method === 'verifyRoster') {
        return {
          devices: devices.map((d) => ({ pubSign: d, pubEnc: 'dd', epoch: 1, mnemonicAdded: false })),
          selfListed,
          head: 'aa',
          headEntry: 'YQ==',
          headSeq: 1,
          epoch: 1
        }
      }
      throw new Error(`unexpected ${method}`)
    }
  }
}

/** Reach into the session, because `refreshRoster` is the unit under test and
 *  standing up a relay and a sidecar to reach it would test neither. */
function attachFake(selfListed: boolean, devices: string[]): void {
  const s = addySession as unknown as Record<string, unknown>
  s.addyd = sidecarSaying(selfListed, devices)
  s.relay = { roster: async () => 'Y2hhaW4=', token: 't' }
  s.account = { baseURL: 'https://r.example', token: 't', accountId: 'acct1', epoch: 1 }
  s.wiping = false
}

beforeEach(() => {
  wiped.mockClear()
  rmSync(join(userData, REVOCATION_FILE), { force: true })
  clearRevocation()
  rmSync(join(userData, REVOCATION_FILE), { force: true })
})
afterAll(() => rmSync(userData, { recursive: true, force: true }))

describe('when the chain still lists this device', () => {
  it('nothing is deleted', async () => {
    attachFake(true, [ME, OTHER])
    const roster = await addySession.refreshRoster()
    expect(roster.stillListed).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(wiped).not.toHaveBeenCalled()
    expect(revocationState()).toBeNull()
  })
})

describe('when the chain no longer lists it', () => {
  it('wipes, and leaves a tombstone that survives for the next launch', async () => {
    writeFileSync(join(userData, 'opsmaxx-data.json'), '{"servers":[{"id":"s1"}]}')
    attachFake(false, [OTHER])

    const roster = await addySession.refreshRoster()
    expect(roster.stillListed).toBe(false)

    await new Promise((r) => setTimeout(r, 30))

    expect(wiped, 'the roster said this device is gone and nothing was deleted').toHaveBeenCalled()
    const tombstone = revocationState()
    expect(tombstone).not.toBeNull()
    expect(tombstone!.stage).toBe('wiped')
    expect(tombstone!.deviceId).toBe(ME)
    // The tombstone is what puts the blocking screen up on the next launch,
    // so it must outlive the wipe rather than being deleted by it.
    expect(existsSync(join(userData, REVOCATION_FILE))).toBe(true)
  })

  it('does not start a second wipe while one is running', async () => {
    attachFake(false, [OTHER])
    await Promise.all([addySession.refreshRoster(), addySession.refreshRoster()])
    await new Promise((r) => setTimeout(r, 30))
    expect(wiped).toHaveBeenCalledTimes(1)
  })
})
