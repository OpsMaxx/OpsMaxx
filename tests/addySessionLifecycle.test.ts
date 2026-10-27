import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Sync coming back after something took it down, and a device appearing that
 * nobody here added.
 *
 * Both were silent. Closing the lid locked the vault, the lock detached the
 * session, and nothing ever attached it again — no banner, and Resume said
 * "not signed in yet". A sidecar that crashed did the same. And a device added
 * to the account with the recovery phrase was one more row in a list nobody
 * was looking at: the flag was computed in the sidecar and dropped.
 */

const userData = mkdtempSync(join(tmpdir(), 'opsmaxx-addy-lifecycle-'))
vi.mock('electron', () => ({
  app: { getPath: () => userData, getVersion: () => '0' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => ''
  }
}))

// Leaving deletes keychain entries; none of that is under test here.
vi.mock('../src/main/services/addy/keys', () => ({
  forgetAddySecret: () => undefined,
  storeAddySecret: () => true,
  loadAddySecret: () => null
}))

/** Every sidecar the session opens, with the exit hook it registered. */
const opened: { onExit?: (reason: string) => void; closed: boolean }[] = []
vi.mock('../src/main/services/addy/sidecar', async (orig) => {
  const real = await orig<typeof import('../src/main/services/addy/sidecar')>()
  return {
    ...real,
    openAddyd: async (_role: string, _log: unknown, onExit?: (reason: string) => void) => {
      const rec = { onExit, closed: false }
      opened.push(rec)
      return {
        alive: () => !rec.closed,
        close: async () => {
          rec.closed = true
        },
        send: async () => ({})
      }
    }
  }
})

const { addySession } = await import('../src/main/services/addy/session')
const { saveEnrolment, forgetEnrolment, loadEnrolment } = await import('../src/main/services/addy/enrolment')

const ACCOUNT = 'aad42aad5b51c8d31d31b3f529a312e2'
const ENROLMENT = {
  baseURL: 'https://relay.example',
  accountId: ACCOUNT,
  epoch: 1,
  rootSignPub: 'a'.repeat(64),
  epoch1SignPub: 'b'.repeat(64),
  spki: '54177fc27d256b3d'
}
const s = addySession as unknown as Record<string, unknown> & {
  reconnect: () => Promise<{ ok: boolean }>
}
const realReconnect = s.reconnect
let reconnects = 0

function attached(): void {
  s.account = { baseURL: ENROLMENT.baseURL, token: 't', accountId: ACCOUNT, epoch: 1 }
  s.relay = { token: 't' }
}

beforeEach(async () => {
  s.reconnect = realReconnect
  await addySession.detach()
  s.lastProblem = null
  s.lockedOut = false
  s.paused = false
  s.crashes = []
  s.reattachDelays = [0]
  opened.length = 0
  reconnects = 0
  forgetEnrolment()
  saveEnrolment(ENROLMENT)
  // Stands in for the whole resume path, which needs a relay: what is under
  // test is WHETHER sync is brought back, not how a login works.
  s.reconnect = async () => {
    reconnects++
    attached()
    s.lastProblem = null
    return { ok: true }
  }
})
afterAll(() => rmSync(userData, { recursive: true, force: true }))

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

describe('the vault locking', () => {
  it('says why sync stopped, and the unlock brings it back', async () => {
    attached()
    await addySession.detachForVaultLock()
    expect(addySession.attached).toBe(false)
    expect((await addySession.status()).problem).toMatch(/paused while the vault is locked/)

    addySession.resumeAfterVaultLock()
    await tick()
    expect(reconnects).toBe(1)
    expect((await addySession.status()).problem).toBeUndefined()
  })

  it('a second unlock, or one with no lock behind it, attaches nothing', async () => {
    addySession.resumeAfterVaultLock()
    await tick()
    expect(reconnects).toBe(0)
  })

  it('says nothing on a machine that never set sync up', async () => {
    forgetEnrolment()
    await addySession.detachForVaultLock()
    expect((await addySession.status()).problem).toBeUndefined()
    addySession.resumeAfterVaultLock()
    await tick()
    expect(reconnects).toBe(0)
  })

  it('pause and leave stay quiet', async () => {
    attached()
    addySession.pauseSync()
    expect((await addySession.status()).problem).toBeUndefined()
    await addySession.leaveAccount()
    expect((await addySession.status()).problem).toBeUndefined()
  })

  it('a lock while a re-attach is backing off stops it', async () => {
    s.reattachDelays = [0, 30]
    let first = true
    s.reconnect = async () => {
      reconnects++
      if (first) {
        first = false
        return { ok: false }
      }
      attached()
      return { ok: true }
    }
    attached()
    await addySession.detachForVaultLock()
    addySession.resumeAfterVaultLock()
    await tick()
    await addySession.detachForVaultLock()
    await new Promise((r) => setTimeout(r, 60))
    expect(reconnects).toBe(1)
    expect(addySession.attached).toBe(false)
  })
})

describe('the sidecar dying on its own', () => {
  async function liveSidecar(): Promise<(reason: string) => void> {
    const crypto = await (s.openCrypto as () => Promise<unknown>).call(addySession)
    s.addyd = crypto
    attached()
    return opened[opened.length - 1].onExit!
  }

  it('is reported and repaired', async () => {
    const exit = await liveSidecar()
    exit('signal SIGKILL')
    await tick()
    expect(reconnects).toBe(1)
  })

  it('is reported, and not respawned for ever', async () => {
    for (let i = 0; i < 3; i++) {
      ;(await liveSidecar())('code 2')
      await tick()
    }
    expect(reconnects).toBe(3)
    ;(await liveSidecar())('code 2')
    await tick()
    expect(reconnects).toBe(3)
    expect((await addySession.status()).problem).toMatch(/keeps stopping/)
  })
})

describe('a device this machine did not add', () => {
  const ME = 'aa'.repeat(32)
  const B = 'bb'.repeat(32)
  const C = 'cc'.repeat(32)
  let alerts: { id: string; label: string; addedWithPhrase: boolean }[] = []
  addySession.onDeviceAdded((d) => alerts.push(d))

  function rosterOf(devices: { pubSign: string; mnemonicAdded?: boolean; label?: string }[]): void {
    attached()
    s.relay = { token: 't', roster: async () => 'Y2hhaW4=' }
    s.addyd = {
      alive: () => true,
      close: async () => undefined,
      send: async (method: string) => {
        if (method === 'whoami') return { devicePub: ME }
        if (method === 'verifyRoster') {
          return {
            devices: devices.map((d) => ({ pubEnc: 'dd', epoch: 1, mnemonicAdded: false, ...d })),
            selfListed: true,
            selfRevoked: false,
            head: 'aa',
            headEntry: 'YQ==',
            headSeq: devices.length,
            epoch: 1
          }
        }
        throw new Error(`unexpected ${method}`)
      }
    }
  }

  beforeEach(() => {
    alerts = []
  })

  it('the first roster is a baseline, not news', async () => {
    rosterOf([{ pubSign: ME }, { pubSign: B }])
    await addySession.refreshRoster()
    expect(alerts).toEqual([])
    expect(loadEnrolment()?.seenDevices).toEqual([ME, B])
  })

  it('a device added with the phrase raises the alert, naming it — once', async () => {
    rosterOf([{ pubSign: ME }, { pubSign: B }])
    await addySession.refreshRoster()
    rosterOf([{ pubSign: ME }, { pubSign: B }, { pubSign: C, mnemonicAdded: true, label: 'kitchen pc' }])
    await addySession.refreshRoster()
    expect(alerts).toEqual([{ id: C, label: 'kitchen pc', addedWithPhrase: true }])
    await addySession.refreshRoster()
    expect(alerts).toHaveLength(1)
  })

  it('a device added while this machine was off alerts on the next launch', async () => {
    rosterOf([{ pubSign: ME }])
    await addySession.refreshRoster()
    // A relaunch: nothing in memory, the baseline only on disk.
    await addySession.detach()
    rosterOf([{ pubSign: ME }, { pubSign: B }])
    await addySession.refreshRoster()
    expect(alerts.map((a) => a.id)).toEqual([B])
    expect(alerts[0].addedWithPhrase).toBe(false)
  })

  it('a device this machine paired is not reported back to it', async () => {
    rosterOf([{ pubSign: ME }])
    await addySession.refreshRoster()
    // What completePairing records the moment its append lands.
    saveEnrolment({ ...loadEnrolment()!, seenDevices: [ME, B] })
    // And a login that rebuilds the record field by field does not drop it.
    const { seenDevices: _dropped, ...rest } = loadEnrolment()!
    saveEnrolment(rest)
    rosterOf([{ pubSign: ME }, { pubSign: B }])
    await addySession.refreshRoster()
    expect(alerts).toEqual([])
  })

  it('completePairing records the device before anything can read the roster', () => {
    const SESSION = readFileSync(resolve(__dirname, '..', 'src/main/services/addy/session.ts'), 'utf8')
    const fn = SESSION.slice(SESSION.indexOf('async completePairing('))
    const append = fn.indexOf('await relay.appendRoster(')
    const record = fn.indexOf('seenDevices: [...seen.seenDevices, peerPubSign]')
    const reread = fn.indexOf('await this.refreshRoster()', append)
    expect(record).toBeGreaterThan(append)
    expect(record).toBeLessThan(reread)
  })
})

describe('main is wired to all of it', () => {
  const MAIN = readFileSync(resolve(__dirname, '..', 'src/main/index.ts'), 'utf8')

  it('the vault lock detaches with a reason, and unlocking and waking bring sync back', () => {
    const lock = MAIN.slice(MAIN.indexOf('const lockVaultFully'))
    expect(lock.slice(0, lock.indexOf('\n}\n'))).toMatch(/addySession\.detachForVaultLock\(\)/)
    const unlock = MAIN.slice(MAIN.indexOf('const resumeChecksAfterUnlock'))
    expect(unlock.slice(0, unlock.indexOf('\n}\n'))).toMatch(/addySession\.resumeAfterVaultLock\(\)/)
    // On wake only when no lock is in force: with a vault, the unlock does it.
    expect(MAIN).toMatch(/if \(!vault\.exists \|\| vault\.unlocked\) addySession\.resumeAfterVaultLock\(\)/)
  })

  it('a new device raises an OS notification', () => {
    const hook = MAIN.slice(MAIN.indexOf('addySession.onDeviceAdded('))
    expect(hook.slice(0, 1500)).toMatch(/new Notification\(/)
    expect(hook.slice(0, 1500)).toMatch(/recovery phrase/)
  })
})
