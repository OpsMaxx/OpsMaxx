import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Recovery writes nothing until the person has compared the words.
 *
 * It used to run from the phrase straight through the keychain, the roster
 * append and sync, and then show a device count. The rollback probe only
 * fires when the relay serves the next epoch's escrow, so a relay that serves
 * epoch 1's escrow, a chain cut back to genesis and a 404 for epoch 2 walked
 * past it — and the recovering machine joined on the key every removed device
 * still holds, before the person saw anything. The fakes here are that relay.
 */

const userData = mkdtempSync(join(tmpdir(), 'opsmaxx-addy-recovery-'))
vi.mock('electron', () => ({
  app: { getPath: () => userData, getVersion: () => '0' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => ''
  }
}))

const stored: string[] = []
const forgotten: string[] = []
vi.mock('../src/main/services/addy/keys', () => ({
  storeAddySecret: (kind: string, scope: string) => {
    stored.push(`${kind}/${scope}`)
    return true
  },
  forgetAddySecret: (kind: string, scope: string) => void forgotten.push(`${kind}/${scope}`),
  loadAddySecret: () => null
}))

const ACCOUNT = 'aad42aad5b51c8d31d31b3f529a312e2'
/** Stands in for protocol.Fingerprint: a pure function of the head. */
const wordsFor = (head: string): string[] => ['w', 'x', 'y', 'z', 'v'].map((w) => `${w}-${head}`)

const sent: string[] = []
const sidecars: { closed: boolean }[] = []
let probeSealed = false
function fakeSidecar(): unknown {
  const rec = { closed: false }
  sidecars.push(rec)
  return {
    alive: () => !rec.closed,
    close: async () => {
      rec.closed = true
    },
    send: async (method: string, params?: Record<string, unknown>) => {
      sent.push(method)
      switch (method) {
        case 'recoverIdentity':
          return {
            accountId: ACCOUNT,
            rootSignPub: 'a'.repeat(64),
            devicePub: 'c'.repeat(64),
            secrets: { deviceSignSeed: 'SEED', deviceEncKey: 'ENC' }
          }
        case 'recoverOpen':
          // Epoch 1's escrow and the genesis-only chain: everything verifies.
          return {
            accountId: ACCOUNT,
            epoch: 1,
            rootSignPub: 'a'.repeat(64),
            epoch1SignPub: 'b'.repeat(64),
            devices: 1,
            seq: 1,
            entry: 'ENTRY',
            head: 'genesis',
            headTS: Date.UTC(2026, 8, 1),
            secrets: { akSeed: 'AK1' }
          }
        case 'recoverProbe':
          return { sealed: probeSealed }
        case 'verifyRoster':
          return { devices: [{ pubSign: 'd'.repeat(64), label: 'old laptop', mnemonicAdded: false }] }
        case 'fingerprint':
          return { words: wordsFor(String(params?.head)) }
        default:
          return {}
      }
    }
  }
}
vi.mock('../src/main/services/addy/sidecar', async (orig) => ({
  ...(await orig<typeof import('../src/main/services/addy/sidecar')>()),
  openAddyd: async () => fakeSidecar()
}))

const appended: [number, string][] = []
let appendFails = false
/** Whether the relay serves the escrow one epoch past the chain's end. */
let servesNextEscrow = false
vi.mock('../src/main/services/addy/relay', async (orig) => ({
  ...(await orig<typeof import('../src/main/services/addy/relay')>()),
  RelayClient: class {
    token = ''
    async login(): Promise<{ token: string; spki: string }> {
      this.token = 't'
      return { token: 't', spki: 's' }
    }
    // 404 for everything past epoch 1, unless told otherwise: the escrow that
    // would trip the probe is simply not served.
    async getObject(name: string, epoch: number): Promise<{ body: Buffer; etag: string } | null> {
      return name === 'escrow' && (epoch === 1 || servesNextEscrow) ? { body: Buffer.from('escrow'), etag: '1' } : null
    }
    async roster(): Promise<string> {
      return 'Z2VuZXNpcw=='
    }
    async appendRoster(seq: number, entry: string): Promise<void> {
      if (appendFails) throw new Error('relay went away')
      appended.push([seq, entry])
    }
  }
}))

const { addySession } = await import('../src/main/services/addy/session')
const { loadEnrolment, forgetEnrolment } = await import('../src/main/services/addy/enrolment')
const s = addySession as unknown as Record<string, unknown>

const recover = (): ReturnType<typeof addySession.recoverFromPhrase> =>
  addySession.recoverFromPhrase('https://relay.example', 'twelve words', 'new laptop')

beforeEach(async () => {
  await addySession.detach()
  forgetEnrolment()
  stored.length = 0
  forgotten.length = 0
  sent.length = 0
  sidecars.length = 0
  appended.length = 0
  probeSealed = false
  appendFails = false
  servesNextEscrow = false
  // The login-and-enrol tail is the ordinary attach path, tested elsewhere.
  s.loginAndRecord = async () => undefined
  s.refreshRoster = async () => ({ devices: [{}, {}], stillListed: true })
})
afterAll(() => rmSync(userData, { recursive: true, force: true }))

describe('recovering onto a chain cut at genesis', () => {
  it('shows the review and has appended, stored and started nothing', async () => {
    const review = await recover()

    expect(review).toEqual({
      accountId: ACCOUNT,
      fingerprint: wordsFor('genesis'),
      epoch: 1,
      devices: [{ label: 'old laptop', addedWithPhrase: false }],
      lastEntryAt: Date.UTC(2026, 8, 1)
    })
    expect(appended).toEqual([])
    expect(stored).toEqual([])
    expect(loadEnrolment()).toBeNull()
    expect(addySession.attached).toBe(false)
    expect((await addySession.status()).enrolled).toBe(false)
    // RK is gone before anybody starts reading the screen.
    expect(sent).toContain('recoverForget')
  })

  it('writes the keys, then the entry, only on confirm', async () => {
    await recover()
    const done = await addySession.confirmRecovery()
    expect(stored).toEqual([`device/${ACCOUNT}:device`, `device/${ACCOUNT}:device-enc`, `account/${ACCOUNT}:account`])
    expect(appended).toEqual([[1, 'ENTRY']])
    expect(done).toEqual({ accountId: ACCOUNT, devices: 2 })
    expect(addySession.attached).toBe(true)
  })

  it('cancel at review leaves no trace', async () => {
    await recover()
    await addySession.cancelRecovery()
    expect(sidecars.every((c) => c.closed)).toBe(true)
    expect(stored).toEqual([])
    expect(appended).toEqual([])
    expect(loadEnrolment()).toBeNull()
    await expect(addySession.confirmRecovery()).rejects.toThrow(/no recovery waiting/)
  })

  it('an append that fails takes the stored keys back out', async () => {
    await recover()
    appendFails = true
    await expect(addySession.confirmRecovery()).rejects.toThrow(/relay went away/)
    expect(forgotten).toEqual(stored)
    expect(sidecars.every((c) => c.closed)).toBe(true)
    expect(addySession.attached).toBe(false)
  })

  it('still refuses outright when the relay holds a next-epoch escrow the account sealed', async () => {
    servesNextEscrow = true
    probeSealed = true
    await expect(recover()).rejects.toThrow(/rolled-back account/)
    expect(stored).toEqual([])
    expect(appended).toEqual([])
    expect(sidecars.every((c) => c.closed)).toBe(true)
    await expect(addySession.confirmRecovery()).rejects.toThrow(/no recovery waiting/)
  })
})

describe('the fingerprint an existing device shows', () => {
  it('is the recovering screen’s words for the same head, and different words for another', async () => {
    const review = await recover()
    await addySession.cancelRecovery()

    const existing = (head: string): Promise<string[] | undefined> => {
      s.addyd = fakeSidecar()
      s.lastRoster = { devices: [], stillListed: true, head }
      return addySession.status().then((st) => st.fingerprint)
    }
    expect(await existing('genesis')).toEqual(review.fingerprint)
    expect(await existing('genesis+removal')).not.toEqual(review.fingerprint)
  })
})
