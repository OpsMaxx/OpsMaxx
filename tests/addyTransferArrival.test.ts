import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * What happens when a file arrives from another machine.
 *
 * ===========================================================================
 * THE BUG THIS EXISTS FOR
 * ===========================================================================
 *
 * The arriving notice is JSON, decrypted, written by another device. Its
 * FILENAME was sanitised; its transfer ID was not — and the id is what builds
 * the directory, through `mkdirSync(..., { recursive: true })`. So an id of
 * `../../../../.ssh` with a name of `authorized_keys` wrote an SSH public key
 * into the user's home directory at mode 0600, which is exactly the mode sshd
 * insists on. No prompt: `collectFiles` runs on the sync timer.
 *
 * A device holding the epoch key is not a reason to trust what it sends. It is
 * the reason to check: a revoked device that has not been re-keyed still holds
 * that key, and an arriving file is the one artefact this feature asks the
 * user to make a trust judgement about.
 *
 * So these are tests against the CALL, not against the source text — the
 * earlier assertion was a regex over this file and it matched the vulnerable
 * line quite happily.
 */

const userData = mkdtempSync(join(tmpdir(), 'opsmaxx-addy-arrive-'))
vi.mock('electron', () => ({ app: { getPath: () => userData } }))

const { collectFiles, TRANSFER_DIR, sweepQuarantine, QUARANTINE_MS } = await import(
  '../src/main/services/addy/transfer'
)

/** A sidecar that frames rather than encrypts — see addySync.test.ts. */
const addyd = {
  alive: () => true,
  send: async (method: string, params?: unknown) => {
    const p = params as Record<string, unknown>
    if (method === 'whoami') return { devicePub: 'aa'.repeat(32) }
    if (method === 'open') return { payload: p.sealed }
    throw new Error(`unexpected ${method}`)
  }
}

/** One notice in the mailbox, and the object it points at. */
function relayWith(notice: unknown, bytes: Buffer): unknown {
  const sealedNotice = Buffer.from(JSON.stringify(notice), 'utf8').toString('base64')
  return {
    request: async (_m: string, path: string) => {
      if (path === '/v1/mail') {
        return {
          ok: true,
          json: async () => ({
            messages: [{ id: 1, fromDevice: 'bb'.repeat(32), kind: 'transfer', sealed: sealedNotice }]
          })
        }
      }
      return { ok: true, json: async () => ({}) }
    },
    // The bytes themselves: `collectFiles` base64s this for the sidecar and
    // the fake sidecar hands it straight back, so a round trip returns these.
    getObject: async () => ({ body: bytes, etag: 'e1' })
  }
}

const deps = (relay: unknown): Parameters<typeof collectFiles>[0] => ({
  addyd: addyd as never,
  relay: relay as never,
  epoch: () => 1,
  peers: () => ['bb'.repeat(32)]
})

const sha = async (b: Buffer): Promise<string> =>
  (await import('node:crypto')).createHash('sha256').update(b).digest('hex')

beforeEach(() => rmSync(join(userData, TRANSFER_DIR), { recursive: true, force: true }))
afterAll(() => rmSync(userData, { recursive: true, force: true }))

describe('a transfer id that tries to escape the quarantine', () => {
  const escapes = [
    '../../../../.ssh',
    '..',
    'a/../../b',
    '/etc',
    '..\\..\\Windows',
    'nothex!'
  ]

  for (const id of escapes) {
    it(`refuses ${JSON.stringify(id)} and writes nothing`, async () => {
      const bytes = Buffer.from('ssh-ed25519 AAAA... attacker\n', 'utf8')
      const relay = relayWith(
        { id, name: 'authorized_keys', size: bytes.length, sha256: await sha(bytes), sentAt: 1 },
        bytes
      )

      const arrived = await collectFiles(deps(relay))

      expect(arrived, `${id} was accepted`).toEqual([])
      // And nothing landed anywhere: the quarantine is the only place this
      // code may write, so if it wrote at all it wrote outside.
      const quarantine = join(userData, TRANSFER_DIR)
      const stray = existsSync(quarantine)
        ? (await import('node:fs')).readdirSync(quarantine)
        : []
      expect(stray).toEqual([])
      expect(existsSync(resolve(userData, '../.ssh'))).toBe(false)
    })
  }

  it('accepts an ordinary hex id and puts the file under it', async () => {
    // The other half: a test that only refuses would pass on a build that
    // refused everything, which would be a transfer feature that never works.
    const bytes = Buffer.from('the runbook\n', 'utf8')
    const id = 'deadbeefcafe0001'
    const relay = relayWith(
      { id, name: 'runbook.sh', size: bytes.length, sha256: await sha(bytes), sentAt: 1 },
      bytes
    )

    const arrived = await collectFiles(deps(relay))

    expect(arrived).toHaveLength(1)
    expect(arrived[0].name).toBe('runbook.sh')
    expect(readFileSync(arrived[0].path, 'utf8')).toBe('the runbook\n')
    expect(arrived[0].path.startsWith(join(userData, TRANSFER_DIR, id))).toBe(true)
  })

  it('refuses a file whose bytes do not match the digest it was promised', async () => {
    // The AEAD proves nobody without the key altered them; the digest proves
    // they are all of them. A truncated fetch must not be written as though it
    // were the file.
    const bytes = Buffer.from('half of it', 'utf8')
    const relay = relayWith(
      { id: 'aaaa1111bbbb2222', name: 'x.txt', size: 999, sha256: 'ff'.repeat(32), sentAt: 1 },
      bytes
    )
    expect(await collectFiles(deps(relay))).toEqual([])
  })

  it('still puts a filename with a path in it inside the transfer folder', async () => {
    const bytes = Buffer.from('x', 'utf8')
    const id = 'cccc3333dddd4444'
    const relay = relayWith(
      { id, name: '../../.bashrc', size: 1, sha256: await sha(bytes), sentAt: 1 },
      bytes
    )
    const arrived = await collectFiles(deps(relay))
    expect(arrived).toHaveLength(1)
    expect(arrived[0].path.startsWith(join(userData, TRANSFER_DIR, id))).toBe(true)
    expect(arrived[0].name).not.toContain('..')
  })
})

describe('the sweep', () => {
  it('leaves a fresh transfer alone and takes an old one', async () => {
    const bytes = Buffer.from('x', 'utf8')
    const relay = relayWith(
      { id: 'eeee5555ffff6666', name: 'f.txt', size: 1, sha256: await sha(bytes), sentAt: 1 },
      bytes
    )
    const arrived = await collectFiles(deps(relay))
    expect(arrived).toHaveLength(1)

    expect(sweepQuarantine(Date.now())).toBe(0)
    expect(existsSync(arrived[0].path)).toBe(true)

    expect(sweepQuarantine(Date.now() + QUARANTINE_MS + 1)).toBe(1)
    expect(existsSync(arrived[0].path)).toBe(false)
  })
})
