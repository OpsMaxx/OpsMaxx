import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Getting onto a relay.
 *
 * The order is what these are about: an account is registered BEFORE its keys
 * are stored, because a machine holding keys for an account the relay rejected
 * looks attached and can do nothing -- and its owner has a recovery phrase for
 * an account that does not exist.
 */

const stored: { kind: string; scope: string }[] = []
const sent: Record<string, unknown>[] = []

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/addy-test' }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../src/main/services/vault', () => ({ vaultEntriesForResolve: () => [], vaultStatus: () => ({ unlocked: true, stage: 'open' }) }))
vi.mock('../src/main/services/addy/keys', () => ({
  storeAddySecret: (kind: string, scope: string) => {
    stored.push({ kind, scope })
    return true
  }
}))
vi.mock('../src/main/services/addy/sidecar', async (orig) => {
  const real = await orig<typeof import('../src/main/services/addy/sidecar')>()
  return {
    ...real,
    openAddyd: async () => ({
      alive: () => true,
      close: async () => {},
      send: async (method: string, params?: unknown) => {
        sent.push({ method, params })
        if (method === 'createAccount') {
          return {
            accountId: 'a'.repeat(32),
            mnemonic: 'one two three four five six seven eight nine ten eleven twelve',
            rootSignPub: 'b'.repeat(64),
            secrets: { deviceSignSeed: 'c2Vlza', deviceEncKey: 'ZW5j', akSeed: 'YWs=' },
            genesis: 'Z2Vu',
            escrow: 'ZXNj',
            epoch: 1
          }
        }
        return {}
      }
    })
  }
})

const { addySession } = await import('../src/main/services/addy/session')

beforeEach(() => {
  stored.length = 0
  sent.length = 0
  vi.unstubAllGlobals()
})

function relayAnswers(status: number, body = '{}'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: status < 400, status, text: async () => body, json: async () => JSON.parse(body) }))
  )
}

describe('creating an account', () => {
  it('registers first, then stores the keys', async () => {
    relayAnswers(201)
    const result = await addySession.createAccount('https://relay.example', 'an-invite', 'laptop')

    expect(result.mnemonic.split(' ')).toHaveLength(12)
    expect(stored.length).toBeGreaterThan(0)
    // The device key, the device's encryption key and the account key. All
    // under the machine-only prefix, so none of them can ride in a backup.
    expect(stored.map((s) => s.kind).sort()).toEqual(['account', 'device', 'device'])
  })

  it('stores NOTHING when the relay refuses', async () => {
    relayAnswers(403, '{"error":"invite spent"}')
    await expect(
      addySession.createAccount('https://relay.example', 'used-already', 'laptop')
    ).rejects.toThrow(/invite/)
    // A machine holding keys for an account that does not exist looks attached
    // and can do nothing, and its owner has a phrase for nothing.
    expect(stored).toEqual([])
  })

  it('says a spent invite is a spent invite', async () => {
    relayAnswers(403)
    await expect(
      addySession.createAccount('https://relay.example', 'x', 'laptop')
    ).rejects.toThrow(/has been used, has expired, or is not one this relay issued/)
  })

  it('refuses a relay that is not https, rather than upgrading it', async () => {
    relayAnswers(201)
    // Silently rewriting what somebody typed is how they end up trusting an
    // address they did not choose.
    await expect(
      addySession.createAccount('http://relay.example', 'x', 'laptop')
    ).rejects.toThrow(/https/)
    expect(sent).toEqual([])
  })

  it('reports an unreachable relay as unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND') }))
    await expect(
      addySession.createAccount('https://nope.example', 'x', 'laptop')
    ).rejects.toThrow(/could not reach/)
    expect(stored).toEqual([])
  })
})
