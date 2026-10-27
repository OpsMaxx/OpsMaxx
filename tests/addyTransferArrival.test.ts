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

const BB = 'bb'.repeat(32)

/**
 * A sidecar that frames rather than encrypts — see addySync.test.ts — but
 * keeps the two rules of `openMail` this file depends on: the signer must be
 * one of the `senders` the caller passed (its verified roster), and the same
 * mail opens once. The cryptography behind them is tested in Go
 * (sidecar/addyd/mail_test.go); what is tested here is that the parent hands
 * over the roster and never the relay's `fromDevice`.
 */
const opened = new Set<string>()
const addyd = {
  alive: () => true,
  send: async (method: string, params?: unknown) => {
    const p = params as Record<string, unknown>
    if (method === 'openMail') {
      const frame = JSON.parse(Buffer.from(p.sealed as string, 'base64').toString('utf8'))
      const signer = frame.signer ?? BB
      if (!(p.senders as string[]).includes(signer)) throw new Error('not on this account')
      if (opened.has(p.sealed as string)) throw new Error('already delivered once')
      opened.add(p.sealed as string)
      return { from: signer, sentAt: frame.sentAt ?? 1, payload: p.sealed }
    }
    if (method === 'openBlob') return { payload: p.sealed }
    throw new Error(`unexpected ${method}`)
  }
}

/** One notice in the mailbox, and the object it points at. */
function relayWith(
  notice: Record<string, unknown>,
  bytes: Buffer | null,
  opts: { fromDevice?: string; acked?: number[][] } = {}
): { getObject: () => Promise<unknown>; [k: string]: unknown } {
  const sealedNotice = Buffer.from(JSON.stringify({ key: 'a2V5', ...notice }), 'utf8').toString('base64')
  const relay = {
    request: async (_m: string, path: string, body?: { ids: number[] }) => {
      if (path === '/v1/mail') {
        return {
          ok: true,
          json: async () => ({
            messages: [{ id: 1, fromDevice: opts.fromDevice ?? BB, kind: 'transfer', sealed: sealedNotice }]
          })
        }
      }
      if (path === '/v1/mail/ack' && body) opts.acked?.push(body.ids)
      return { ok: true, json: async () => ({}) }
    },
    // The bytes themselves: `collectFiles` base64s this for the sidecar and
    // the fake sidecar hands it straight back, so a round trip returns these.
    getObject: async (): Promise<unknown> => (bytes ? { body: bytes, etag: 'e1' } : null),
    deleteObject: async () => undefined
  }
  return relay
}

const deps = (relay: unknown, peers = [BB]): Parameters<typeof collectFiles>[0] => ({
  addyd: addyd as never,
  relay: relay as never,
  epoch: () => 1,
  peers: () => peers,
  peerEnc: () => 'ee'.repeat(32)
})

const sha = async (b: Buffer): Promise<string> =>
  (await import('node:crypto')).createHash('sha256').update(b).digest('hex')

beforeEach(() => {
  rmSync(join(userData, TRANSFER_DIR), { recursive: true, force: true })
  opened.clear()
})
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

describe('who a file came from', () => {
  it('is ignored when the sender is not on the roster any more', async () => {
    // A removed device keeps a working key. Without the roster check such a
    // device goes on delivering files to every machine on the account, and
    // "one of your own devices" is exactly the belief this feature asks the
    // user to act on.
    const bytes = Buffer.from('x', 'utf8')
    const relay = relayWith(
      { id: 'abcd1234abcd1234', name: 'f.txt', size: 1, sha256: await sha(bytes), sentAt: 1 },
      bytes
    )
    const noPeers = { ...deps(relay), peers: () => [] }

    expect(await collectFiles(noPeers)).toEqual([])
  })

  it('and accepted when they are', async () => {
    // The other half, or the filter would be indistinguishable from a feature
    // that never delivers.
    const bytes = Buffer.from('x', 'utf8')
    const relay = relayWith(
      { id: 'abcd1234abcd5678', name: 'f.txt', size: 1, sha256: await sha(bytes), sentAt: 1 },
      bytes
    )
    expect(await collectFiles(deps(relay))).toHaveLength(1)
  })

  it('is the signer, never the relay label, and a removed signer is refused under a member\'s name', async () => {
    // The relay's `fromDevice` was the whole sender check. It can name any
    // current member, so a removed device's notice labelled as the desktop's
    // was delivered as the desktop's.
    const CC = 'cc'.repeat(32)
    const DD = 'dd'.repeat(32)
    const bytes = Buffer.from('x', 'utf8')
    const notice = { id: 'abcd1234abcd9999', name: 'f.txt', size: 1, sha256: await sha(bytes), sentAt: 1 }

    const forged = relayWith({ ...notice, signer: CC }, bytes, { fromDevice: BB })
    expect(await collectFiles(deps(forged, [BB, DD]))).toEqual([])

    const relabelled = relayWith({ ...notice, signer: BB }, bytes, { fromDevice: DD })
    const arrived = await collectFiles(deps(relabelled, [BB, DD]))
    expect(arrived).toHaveLength(1)
    expect(arrived[0].from).toBe(BB)
  })
})

describe('a notice whose bytes are not there yet', () => {
  it('is retried without being opened twice', async () => {
    // Opening spends the notice's nonce, so the sidecar refuses the same mail
    // twice. The retry a missing object gets has to reuse the first opening,
    // or the transfer is dropped as a replay on the pass that would have
    // delivered it.
    const bytes = Buffer.from('late', 'utf8')
    const notice = { id: 'abcd1234abcd7777', name: 'f.txt', size: 4, sha256: await sha(bytes), sentAt: 1 }
    const acked: number[][] = []
    const relay = relayWith(notice, null, { acked })
    expect(await collectFiles(deps(relay))).toEqual([])
    expect(acked).toEqual([])

    relay.getObject = async () => ({ body: bytes, etag: 'e1' })
    const arrived = await collectFiles(deps(relay))
    expect(arrived).toHaveLength(1)
    expect(readFileSync(arrived[0].path, 'utf8')).toBe('late')
  })
})

describe('a notice from OpsMaxx 0.59.0', () => {
  it('is refused, acknowledged, and says to update the sender', async () => {
    // The old notice is a collection object under the epoch key: it says
    // nothing about which device wrote it, so it cannot be accepted.
    const legacy = Buffer.concat([Buffer.from('addy-obj-v1\0', 'latin1'), Buffer.alloc(64)]).toString('base64')
    const acked: number[][] = []
    const relay = {
      request: async (_m: string, path: string, body?: { ids: number[] }) => {
        if (path === '/v1/mail/ack' && body) acked.push(body.ids)
        return {
          ok: true,
          json: async () => ({ messages: [{ id: 7, fromDevice: BB, kind: 'transfer', sealed: legacy }] })
        }
      },
      getObject: async () => null,
      deleteObject: async () => undefined
    }
    await expect(collectFiles(deps(relay))).rejects.toThrow(/Update OpsMaxx on the sending device/)
    expect(acked).toEqual([[7]])
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
