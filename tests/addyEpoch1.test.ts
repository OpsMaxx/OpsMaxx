import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The account's epoch-1 signing key reaches the relay, once per relay.
 *
 * With it the relay verifies each roster append's signature before storing
 * it; without it a member can append an entry no client accepts and brick the
 * account for everyone. New accounts send it at registration; existing ones
 * send it after a login.
 */

const userData = mkdtempSync(join(tmpdir(), 'opsmaxx-addy-epoch1-'))
vi.mock('electron', () => ({
  app: { getPath: () => userData, getVersion: () => '0' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => ''
  }
}))

const { addySession } = await import('../src/main/services/addy/session')
const { saveEnrolment, loadEnrolment } = await import('../src/main/services/addy/enrolment')
afterAll(() => rmSync(userData, { recursive: true, force: true }))

const KEY = 'ee'.repeat(32)
function attach(status: number, error = ''): { posted: unknown[] } {
  const posted: unknown[] = []
  saveEnrolment({
    baseURL: 'https://r.example',
    accountId: 'acct1',
    epoch: 1,
    rootSignPub: 'aa',
    epoch1SignPub: KEY,
    spki: ''
  })
  const s = addySession as unknown as Record<string, unknown>
  s.account = { baseURL: 'https://r.example', token: 't', accountId: 'acct1', epoch: 1, epoch1SignPub: KEY }
  s.lastProblem = null
  s.relay = {
    request: async (method: string, path: string, body: unknown) => {
      posted.push({ method, path, body })
      return new Response(status === 204 ? null : JSON.stringify({ error }), { status })
    }
  }
  return { posted }
}
const send = (): Promise<void> =>
  ((addySession as unknown as { sendEpoch1: () => Promise<void> }).sendEpoch1).call(addySession)

describe('handing the relay the epoch-1 key', () => {
  it('sends it once, and remembers which relay has it', async () => {
    const { posted } = attach(204)
    await send()
    await send()
    expect(posted).toEqual([
      { method: 'POST', path: '/v1/roster/epoch1', body: { epoch1_sign_pub: KEY } }
    ])
    expect(loadEnrolment()?.epoch1SentTo).toBe('https://r.example')
  })

  it('a relay holding a different key is reported, not trusted, and asked again later', async () => {
    attach(409, 'store: a different epoch 1 key is already stored')
    await send()
    const problem = (addySession as unknown as { lastProblem: string | null }).lastProblem
    expect(problem).toMatch(/different signing key/)
    expect(loadEnrolment()?.epoch1SentTo).toBeUndefined()
  })

  it('a relay that predates the route is left alone', async () => {
    attach(404)
    await send()
    expect((addySession as unknown as { lastProblem: string | null }).lastProblem).toBeNull()
  })

  it('a new account sends it with the registration', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(join(__dirname, '..', 'src', 'main', 'services', 'addy', 'session.ts'), 'utf8')
    const create = src.slice(src.indexOf('async createAccount('))
    expect(create.slice(0, create.indexOf('\n  }\n'))).toMatch(/epoch1_sign_pub: minted\.epoch1SignPub/)
  })
})
