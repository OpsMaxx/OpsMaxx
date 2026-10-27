import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A re-key, and following one, survive a hostile relay and a restart.
 *
 * Four things went wrong here, each found by tracing a real path rather than
 * by any test, because every existing check of rotation is a scan of the
 * source and a scan cannot restart the app:
 *
 *  - the relay could ack the transition append and drop it, and the rotating
 *    device deleted its old keys anyway — leaving every other device on the
 *    key the revoked one holds;
 *  - the rotating device never wrote its new epoch down, so its next launch
 *    looked for the epoch-1 key the re-key had just deleted, and refused;
 *  - a device that followed somebody else's rotation had its record written
 *    back at the OLD epoch, so it followed again on every launch and zeroed
 *    every counter floor each time;
 *  - a chain ending before this device's epoch was read past, not refused.
 *
 * So these drive `rotateEpoch`, `followRotation` (through `refreshRoster`) and
 * `resume` for real, against a sidecar and relay that answer as the test says,
 * with the enrolment on a real disk and the keychain in a map.
 */

const userData = mkdtempSync(join(tmpdir(), 'opsmaxx-addy-rotation-'))
vi.mock('electron', () => ({
  app: { getPath: () => userData, getVersion: () => '0' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => ''
  }
}))

const keychain = new Map<string, string>()
vi.mock('../src/main/services/addy/keys', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../src/main/services/addy/keys')
  return {
    ...actual,
    storeAddySecret: (kind: string, scope: string, value: string) => {
      keychain.set(`${kind}|${scope}`, value)
      return true
    },
    loadAddySecret: (kind: string, scope: string) => keychain.get(`${kind}|${scope}`) ?? null,
    forgetAddySecret: (kind: string, scope: string) => void keychain.delete(`${kind}|${scope}`)
  }
})

const forgotEpoch = vi.fn()
vi.mock('../src/main/services/addy/sync', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../src/main/services/addy/sync')
  return {
    ...actual,
    forgetEpochState: () => {
      forgotEpoch()
      ;(actual.forgetEpochState as () => void)()
    }
  }
})

/** Whatever `attach` constructs answers from here, so `resume` runs its real
 *  login and roster read without a network. */
let relay: Record<string, (...args: unknown[]) => unknown> = {}
vi.mock('../src/main/services/addy/relay', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../src/main/services/addy/relay')
  class FakeRelayClient {
    token = ''
    constructor() {
      return new Proxy(this, { get: (t, k: string) => relay[k] ?? (t as Record<string, unknown>)[k] })
    }
  }
  return { ...actual, RelayClient: FakeRelayClient }
})

const { addySession } = await import('../src/main/services/addy/session')
const { saveEnrolment, loadEnrolment, forgetEnrolment } = await import(
  '../src/main/services/addy/enrolment'
)
const { AddyError } = await import('../src/main/services/addy/sidecar')

const ACCT = 'acct1'
const ME = 'aa'.repeat(32)
const BASE = 'https://r.example'
const s = addySession as unknown as Record<string, unknown>

type Call = { method: string; params: Record<string, unknown> }
type FakeSidecar = {
  calls: Call[]
  alive: () => boolean
  close: () => Promise<void>
  send: (m: string, p?: Record<string, unknown>) => Promise<unknown>
}

/** A sidecar whose verified chain ends at `chainEpoch`, head `headSeq`/`head`. */
function sidecar(opts: {
  chainEpoch: number
  headSeq: number
  head: string
  /** The re-read after appending the transition does not carry it. */
  dropTransition?: boolean
}): FakeSidecar {
  const calls: Call[] = []
  return {
    calls,
    alive: () => true,
    close: async () => undefined,
    send: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      switch (method) {
        case 'load':
          return { accountId: ACCT, devicePub: ME, epochs: Object.keys(params.epochKeys as object) }
        case 'whoami':
          return { devicePub: ME }
        case 'fingerprintSelf':
          return { fingerprint: 'fpA' }
        case 'rotateEpoch':
          return {
            epoch: opts.chainEpoch + 1,
            epochSignPub: 'e2',
            handoffs: { fpA: 'aGFuZG9mZg==' },
            escrow: 'ZXNjcm93',
            escrowSig: 'c2ln',
            secrets: { akSeed: 'AK-NEW' },
            seq: opts.headSeq + 1,
            entry: 'dHJhbnNpdGlvbg==',
            entryHash: 'hT'
          }
        case 'adoptEpoch':
          return { epoch: params.epoch, epochSignPub: 'e2', secrets: { akSeed: `AK${String(params.epoch)}` } }
        case 'verifyRoster':
          // Pinned to the transition this device just appended.
          if (params.pinnedHead === 'hT' && params.pinnedSeq === opts.headSeq + 1) {
            if (opts.dropTransition) {
              throw new AddyError('roster-rewound', 'roster: the chain is shorter than the one this device has seen')
            }
            return roster(opts.chainEpoch + 1, opts.headSeq + 1, 'hT')
          }
          return roster(opts.chainEpoch, opts.headSeq, opts.head)
      }
      throw new Error(`unexpected ${method}`)
    }
  }
}
function roster(epoch: number, headSeq: number, head: string): unknown {
  return {
    devices: [{ pubSign: ME, pubEnc: 'cc', epoch: 1, mnemonicAdded: false }],
    selfListed: true,
    selfRevoked: false,
    head,
    headEntry: 'ZQ==',
    headSeq,
    epoch
  }
}

const puts: string[] = []
const appended: number[] = []
function fakeRelay(): void {
  relay = {
    roster: async () => 'Y2hhaW4=',
    getObject: async (name: unknown) =>
      String(name).startsWith('handoff') ? { body: Buffer.from('h'), etag: 'e' } : null,
    putObject: async (name: unknown) => void puts.push(String(name)),
    appendRoster: async (seq: unknown) => void appended.push(Number(seq)),
    login: async () => ({ token: 't', spki: 'spki' }),
    request: async () => ({ ok: true, status: 200 })
  }
}

function enrol(epoch: number, pinSeq: number, pinHead: string): void {
  saveEnrolment({
    baseURL: BASE,
    accountId: ACCT,
    epoch,
    rootSignPub: 'r'.repeat(64),
    epoch1SignPub: 'e'.repeat(64),
    spki: 'spki',
    pinSeq,
    pinHead,
    seenDevices: [ME]
  })
}

function attachFake(epoch: number, side: FakeSidecar): void {
  fakeRelay()
  s.addyd = side
  s.relay = relay
  s.account = {
    baseURL: BASE,
    token: 't',
    accountId: ACCT,
    epoch,
    rootSignPub: 'r'.repeat(64),
    epoch1SignPub: 'e'.repeat(64)
  }
  // Nothing here is about the engine, and a real pass would reach for relay
  // calls these fakes do not provide.
  s.paused = true
  s.syncNow = async () => null
}

beforeEach(() => {
  keychain.clear()
  forgotEpoch.mockClear()
  puts.length = 0
  appended.length = 0
  forgetEnrolment()
  keychain.set(`device|${ACCT}:device`, 'DEV')
  keychain.set(`device|${ACCT}:device-enc`, 'DEVENC')
  keychain.set(`account|${ACCT}:account`, 'AK1')
})
afterAll(() => rmSync(userData, { recursive: true, force: true }))

describe('a re-key', () => {
  it('is verified against this device’s pin, not unpinned', async () => {
    enrol(1, 3, 'h3')
    const side = sidecar({ chainEpoch: 1, headSeq: 3, head: 'h3' })
    attachFake(1, side)
    await addySession.rotateEpoch('revocation', 'twelve words')
    const prepared = side.calls.find((c) => c.method === 'rotateEpoch')!
    expect(prepared.params).toMatchObject({ havePin: true, pinnedSeq: 3, pinnedHead: 'h3' })
  })

  it('is refused on a device that has no pin yet, and writes nothing', async () => {
    saveEnrolment({
      baseURL: BASE,
      accountId: ACCT,
      epoch: 1,
      rootSignPub: 'r'.repeat(64),
      epoch1SignPub: 'e'.repeat(64),
      spki: 'spki',
      seenDevices: [ME]
    })
    const side = sidecar({ chainEpoch: 1, headSeq: 3, head: 'h3' })
    attachFake(1, side)
    const err = (await addySession.rotateEpoch('revocation', 'twelve words').catch((e: unknown) => e)) as {
      code?: string
    }
    expect(err?.code).toBe('roster-invalid')
    expect(side.calls.some((c) => c.method === 'rotateEpoch')).toBe(false)
    expect(puts).toEqual([])
    expect(appended).toEqual([])
  })

  it('refuses a chain that ends before this device’s epoch, and writes nothing', async () => {
    enrol(2, 3, 'h3')
    keychain.set(`account|${ACCT}:account:2`, 'AK2')
    // The relay serves the chain as it stood at epoch 1; this device is on 2.
    attachFake(2, sidecar({ chainEpoch: 1, headSeq: 3, head: 'h3' }))
    const err = (await addySession.rotateEpoch('revocation', 'twelve words').catch((e: unknown) => e)) as {
      code?: string
    }
    expect(err?.code).toBe('roster-rewound')
    expect(puts).toEqual([])
    expect(appended).toEqual([])
  })

  it('whose transition the relay acked and dropped deletes no key and says so', async () => {
    enrol(1, 3, 'h3')
    attachFake(1, sidecar({ chainEpoch: 1, headSeq: 3, head: 'h3', dropTransition: true }))
    const err = (await addySession.rotateEpoch('revocation', 'twelve words').catch((e: unknown) => e)) as {
      code?: string
      message?: string
    }
    expect(err?.code).toBe('roster-rewound')
    expect(err?.message).toMatch(/no key was deleted/)
    expect(appended, 'the transition was never even sent').toEqual([4])
    // Still on epoch 1, with epoch 1's key: the account as the other devices see it.
    expect(keychain.get(`account|${ACCT}:account`)).toBe('AK1')
    expect(loadEnrolment()?.epoch).toBe(1)
    expect((s.account as { epoch: number }).epoch).toBe(1)
    expect(forgotEpoch).not.toHaveBeenCalled()
  })

  it('survives a restart: the device that re-keyed resumes on the new epoch', async () => {
    enrol(1, 3, 'h3')
    attachFake(1, sidecar({ chainEpoch: 1, headSeq: 3, head: 'h3' }))
    const done = await addySession.rotateEpoch('revocation', 'twelve words')
    expect(done.epoch).toBe(2)
    // The revocation did what it is for: epoch 1's key is gone.
    expect(keychain.has(`account|${ACCT}:account`)).toBe(false)
    expect(loadEnrolment()).toMatchObject({ epoch: 2, pinSeq: 4, pinHead: 'hT' })

    await addySession.detach()
    const relaunched = sidecar({ chainEpoch: 2, headSeq: 4, head: 'hT' })
    s.openCrypto = async () => relaunched
    fakeRelay()
    try {
      const resumed = await addySession.resume()
      expect(resumed.problem).toBeUndefined()
      expect(resumed.resumed).toBe(true)
      // Loaded with the current key alone, and attached at its epoch — which
      // is the epoch every seal from here on is made under.
      const load = relaunched.calls.find((c) => c.method === 'load')!
      expect(load.params.epochKeys).toEqual({ 2: 'AK-NEW' })
      expect((s.account as { epoch: number }).epoch).toBe(2)
      // And the roster read on the way in was pinned to the confirmed transition.
      const read = relaunched.calls.find((c) => c.method === 'verifyRoster')!
      expect(read.params).toMatchObject({ havePin: true, pinnedSeq: 4, pinnedHead: 'hT' })
      expect(relaunched.calls.some((c) => c.method === 'adoptEpoch')).toBe(false)
    } finally {
      delete s.openCrypto
      await addySession.detach()
    }
  })
})

describe('following another device’s rotation', () => {
  it('keeps the pin and the new epoch on disk, so the next launch does not follow again', async () => {
    enrol(1, 3, 'h3')
    const side = sidecar({ chainEpoch: 2, headSeq: 4, head: 'h4' })
    attachFake(1, side)
    await addySession.refreshRoster()
    expect(side.calls.filter((c) => c.method === 'adoptEpoch')).toHaveLength(1)
    expect(side.calls.find((c) => c.method === 'adoptEpoch')!.params).toMatchObject({
      havePin: true,
      pinnedSeq: 3
    })
    expect(forgotEpoch).toHaveBeenCalledTimes(1)
    expect(loadEnrolment()).toMatchObject({ epoch: 2, pinSeq: 4, pinHead: 'h4', seenDevices: [ME] })
    expect(keychain.get(`account|${ACCT}:account:2`)).toBe('AK2')

    // The restart: the session comes back from what is on disk.
    attachFake(loadEnrolment()!.epoch, side)
    await addySession.refreshRoster()
    expect(side.calls.filter((c) => c.method === 'adoptEpoch'), 'followed the same rotation twice').toHaveLength(1)
    expect(forgotEpoch, 'counter floors zeroed again').toHaveBeenCalledTimes(1)
    expect(side.calls.filter((c) => c.method === 'verifyRoster').at(-1)!.params).toMatchObject({
      havePin: true,
      pinnedSeq: 4,
      pinnedHead: 'h4'
    })
  })

  it('a record rebuilt field by field keeps the pin', () => {
    enrol(1, 3, 'h3')
    saveEnrolment({
      baseURL: BASE,
      accountId: ACCT,
      epoch: 2,
      rootSignPub: 'r'.repeat(64),
      epoch1SignPub: 'e'.repeat(64),
      spki: 'spki'
    })
    expect(loadEnrolment()).toMatchObject({ epoch: 2, pinSeq: 3, pinHead: 'h3' })
  })
})

describe('a chain behind this device’s epoch', () => {
  it('is a rollback, not something to read past', async () => {
    enrol(2, 4, 'h4')
    attachFake(2, sidecar({ chainEpoch: 1, headSeq: 4, head: 'h4' }))
    const err = (await addySession.refreshRoster().catch((e: unknown) => e)) as { code?: string }
    expect(err?.code).toBe('roster-rewound')
    expect(loadEnrolment()).toMatchObject({ epoch: 2, pinSeq: 4 })
  })
})
