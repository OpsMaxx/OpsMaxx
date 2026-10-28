import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VaultEntry } from '../src/shared/vault'

/**
 * Conflict copies: what they can be opened as, which ones are offered, whose
 * word the chooser shows, and who is told when one is chosen.
 *
 * Four defects, each from the 2026-10-28 review:
 *
 *   - A conflict copy was sealed exactly like the real object -- same label,
 *     counter one past the winner's -- so the relay could serve it AS the real
 *     object, or serve an archived real object as a "conflict".
 *   - Every copy the relay listed was offered, under whatever epoch it named,
 *     opened with the rollback floor at 0: a removed device's copy from before
 *     the re-key was one click from being re-sealed and pushed everywhere.
 *   - The chooser named the writer and the time from the relay's own fields,
 *     which for the vault is the entire basis of the choice.
 *   - "Replace it with the other copy" on the vault wrote the file and told
 *     only the renderer, so the vault module kept serving -- and saving -- the
 *     copy it had unlocked.
 *
 * The sidecar here is a fake that enforces what the real AEAD enforces: a body
 * opens only under the label and epoch it was sealed with, and not below the
 * floor. `sidecar/addyd/crypto_test.go` proves the real one refuses a
 * `conflict:` copy as the real object and the reverse.
 */

const userData = mkdtempSync(join(tmpdir(), 'opsmaxx-addy-conflicts-'))
vi.mock('electron', () => ({
  app: { getPath: () => userData, getVersion: () => '0.0.0-test' },
  safeStorage: {
    isEncryptionAvailable: (): boolean => false,
    encryptString: (): Buffer => Buffer.alloc(0),
    decryptString: (): string => ''
  }
}))
vi.mock('../src/main/services/secrets', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSecret: () => null
}))

const { listConflicts, sealConflict, conflictLabel } = await import(
  '../src/main/services/addy/conflicts'
)
const { syncOnce, forgetSyncState } = await import('../src/main/services/addy/sync')
const { addySession } = await import('../src/main/services/addy/session')
const { vaultCreate, vaultSave, vaultStatus, vaultDestroy, vaultExternalChange } = await import(
  '../src/main/services/vault'
)

afterAll(() => rmSync(userData, { recursive: true, force: true }))

const ME = 'aa'.repeat(32)
const RELAY_SAYS = 'ee'.repeat(32)
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')

function labelledSidecar(): {
  alive: () => boolean
  close: () => Promise<void>
  send: (m: string, p?: unknown) => Promise<unknown>
} {
  return {
    alive: () => true,
    close: async () => undefined,
    send: async (method: string, params?: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>
      if (method === 'whoami') return { devicePub: ME }
      if (method === 'seal') {
        return {
          sealed: b64(
            JSON.stringify({ label: p.collection, epoch: p.epoch, counter: p.counter, payload: p.payload })
          )
        }
      }
      if (method === 'open') {
        const inner = JSON.parse(Buffer.from(p.sealed as string, 'base64').toString('utf8'))
        if (inner.label !== p.collection || inner.epoch !== p.epoch) {
          throw new Error(
            `object: opening ${String(p.collection)}: chacha20poly1305: message authentication failed`
          )
        }
        if (inner.counter < (p.seenCounter as number)) {
          throw new Error(`object: the counter is behind: ${inner.counter} < ${String(p.seenCounter)}`)
        }
        return { payload: inner.payload, counter: inner.counter }
      }
      throw new Error(`unexpected sidecar call ${method}`)
    }
  }
}

/** What the real object or a legacy (0.59.0) conflict copy looks like: sealed
 *  under the collection's own name. */
const sealedAs = (label: string, epoch: number, counter: number, payload: unknown): string =>
  b64(JSON.stringify({ label, epoch, counter, payload: b64(JSON.stringify(payload)) }))

interface Listed {
  id: number
  name: string
  epoch: number
  counter: number
  device: string
  body: string
  createdAt: string
}

function relayListing(
  conflicts: Listed[],
  canonical: Record<string, { body: string; etag: string }> = {}
): unknown {
  return {
    request: async () => ({ ok: true, status: 200, json: async () => ({ conflicts }) }),
    getObject: async (name: string) => {
      const o = canonical[name]
      return o ? { body: Buffer.from(o.body, 'base64'), etag: o.etag } : null
    }
  }
}

describe('a conflict copy kept by sync', () => {
  const HOSTS = join(userData, 'opsmaxx-known-hosts.json')
  beforeEach(() => {
    forgetSyncState()
    rmSync(HOSTS, { force: true })
  })

  function relay(): {
    objects: Map<string, { body: Buffer; etag: string }>
    conflicts: { name: string; body: Buffer }[]
    getObject: (n: string) => Promise<{ body: Buffer; etag: string } | null>
    putObject: (n: string, e: number, c: number, b: Buffer) => Promise<string>
    keepConflict: (n: string, e: number, c: number, b: Buffer) => Promise<void>
  } {
    const objects = new Map<string, { body: Buffer; etag: string }>()
    const conflicts: { name: string; body: Buffer }[] = []
    let tag = 0
    return {
      objects,
      conflicts,
      getObject: async (n) => objects.get(n) ?? null,
      putObject: async (n, _e, _c, body) => {
        const etag = `etag-${++tag}`
        objects.set(n, { body, etag })
        return etag
      },
      keepConflict: async (name, _e, _c, body) => {
        conflicts.push({ name, body })
      }
    }
  }
  const deps = (r: ReturnType<typeof relay>): Parameters<typeof syncOnce>[0] => ({
    addyd: labelledSidecar() as never,
    relay: r as never,
    epoch: () => 1,
    applied: () => undefined,
    accountId: () => 'acct'
  })
  const theirs = (): { body: Buffer; etag: string } => ({
    body: Buffer.from(sealedAs('knownHosts', 1, 4, { h1: 'theirs' }), 'base64'),
    etag: 'e0'
  })

  it('is sealed under its own label, with the writer and the time inside', async () => {
    // Known hosts is one object, not a list of records, so two different
    // copies on first contact cannot be unioned and the local one is kept.
    writeFileSync(HOSTS, '{"h1":"mine"}')
    const r = relay()
    r.objects.set('knownHosts', theirs())

    const before = Date.now()
    const result = await syncOnce(deps(r))
    expect(result.outcomes.knownHosts).toBe('conflicted')

    const kept = r.conflicts.find((c) => c.name === 'knownHosts')!
    const inner = JSON.parse(kept.body.toString('utf8'))
    expect(inner.label).toBe('conflict:knownHosts')
    const env = JSON.parse(Buffer.from(inner.payload, 'base64').toString('utf8'))
    expect(env.device).toBe(ME)
    expect(Date.parse(env.writtenAt)).toBeGreaterThanOrEqual(before - 1000)
    expect(JSON.parse(Buffer.from(env.body, 'base64').toString('utf8'))).toEqual({ h1: 'mine' })
  })

  it('cannot be served as the real object', async () => {
    writeFileSync(HOSTS, '{"h1":"mine"}')
    const r = relay()
    r.objects.set('knownHosts', theirs())
    await syncOnce(deps(r))
    const kept = r.conflicts.find((c) => c.name === 'knownHosts')!
    expect(readFileSync(HOSTS, 'utf8')).toBe('{"h1":"theirs"}')

    // THE ATTACK: the relay answers the next read of `knownHosts` with the
    // copy the user set aside. Under the old sealing it opened -- right
    // label, right epoch, a counter one past the winner's -- and was adopted.
    r.objects.set('knownHosts', { body: kept.body, etag: 'e-replayed' })
    const again = await syncOnce(deps(r))
    expect(again.outcomes.knownHosts).toBe('failed')
    expect(readFileSync(HOSTS, 'utf8')).toBe('{"h1":"theirs"}')
  })
})

describe('listing conflict copies', () => {
  const NOW = 2
  const deps = (relay: unknown, floor = 0): Parameters<typeof listConflicts>[0] => ({
    addyd: labelledSidecar() as never,
    relay: relay as never,
    epoch: () => NOW,
    floor: () => floor
  })
  const current = async (payload: unknown, counter = 6): Promise<string> =>
    (
      await sealConflict(
        labelledSidecar() as never,
        'servers',
        NOW,
        counter,
        Buffer.from(JSON.stringify(payload)),
        'test'
      )
    ).toString('base64')
  const winner = { servers: { body: sealedAs('servers', NOW, 5, [{ id: 'won' }]), etag: 'w' } }
  const listed = (over: Partial<Listed> & { body: string }): Listed => ({
    id: 1,
    name: 'servers',
    epoch: NOW,
    counter: 6,
    device: RELAY_SAYS,
    createdAt: '2001-01-01T00:00:00Z',
    ...over
  })

  it('shows who wrote it and when from inside the sealed copy, not the relay', async () => {
    const list = await listConflicts(
      deps(relayListing([listed({ body: await current([{ id: 'lost' }]) })], winner))
    )
    expect(list).toHaveLength(1)
    expect(list[0].losing).toEqual([{ id: 'lost' }])
    expect(list[0].winning).toEqual([{ id: 'won' }])
    expect(list[0].device).toBe(ME)
    expect(list[0].createdAt).not.toBe('2001-01-01T00:00:00Z')
    expect(list[0].reportedByRelay).toBe(false)
  })

  it('does not offer a copy from an older epoch at all', async () => {
    // Sealed under the epoch before the last re-key: possibly the removed
    // device's own. Not opened, not counted, not one click from the account.
    const old = sealedAs(conflictLabel('servers'), NOW - 1, 3, {
      v: 1,
      device: ME,
      writtenAt: new Date().toISOString(),
      body: b64('[{"id":"planted"}]')
    })
    const list = await listConflicts(
      deps(relayListing([listed({ id: 9, epoch: NOW - 1, counter: 3, body: old })], winner))
    )
    expect(list).toEqual([])
  })

  it('opens a legacy copy at the floor, and marks who and when as the relay’s word', async () => {
    // Kept by 0.59.0: sealed like the real object. At or above the floor it
    // is offered, with the relay's device and time flagged as unchecked.
    const legacy = sealedAs('servers', NOW, 6, [{ id: 'old-client' }])
    const list = await listConflicts(
      deps(
        relayListing([listed({ id: 2, body: legacy, createdAt: '2026-10-01T00:00:00Z' })], winner),
        5
      )
    )
    expect(list[0].losing).toEqual([{ id: 'old-client' }])
    expect(list[0].device).toBe(RELAY_SAYS)
    expect(list[0].createdAt).toBe('2026-10-01T00:00:00Z')
    expect(list[0].reportedByRelay).toBe(true)
  })

  it('refuses an archived real object the relay lists as a "conflict"', async () => {
    // Indistinguishable from a legacy copy -- which is why legacy copies are
    // opened at the floor. Below it, nothing can be chosen.
    const archived = sealedAs('servers', NOW, 2, [{ id: 'last-month' }])
    const list = await listConflicts(
      deps(relayListing([listed({ id: 3, counter: 2, body: archived })], winner), 5)
    )
    expect(list[0].losing).toBeUndefined()
    expect(list[0].problem).toMatch(/behind/)
  })

  it('will not show an archived winner as the version in use', async () => {
    const list = await listConflicts(
      deps(
        relayListing([listed({ id: 4, counter: 9, body: await current([{ id: 'x' }], 9) })], {
          servers: { body: sealedAs('servers', NOW, 2, [{ id: 'archived' }]), etag: 'a' }
        }),
        8
      )
    )
    expect(list[0].losing).toEqual([{ id: 'x' }])
    expect(list[0].winning).toBeUndefined()
  })

  it('does not read a conflict copy served as the winner', async () => {
    const asConflict = await current([{ id: 'c' }])
    const list = await listConflicts(
      deps(
        relayListing([listed({ id: 5, body: asConflict })], {
          servers: { body: asConflict, etag: 'swapped' }
        })
      )
    )
    expect(list[0].losing).toEqual([{ id: 'c' }])
    expect(list[0].winning).toBeUndefined()
  })
})

describe('resolving a vault conflict', () => {
  const FILE = join(userData, 'opsmaxx-vault.json')
  const entry = (id: string): VaultEntry => ({
    id,
    name: id,
    kind: 'login',
    url: '',
    username: 'root',
    password: `${id}-secret`,
    notes: '',
    tags: [],
    fields: [],
    createdAt: '',
    updatedAt: ''
  })

  it('tells the vault module, so it relocks rather than saving its old copy back', async () => {
    // The other copy: another device's vault, its own password and salt.
    rmSync(FILE, { force: true })
    vaultDestroy()
    await vaultCreate('the-other-master-1234')
    vaultSave([entry('theirs')])
    const theirs = JSON.parse(readFileSync(FILE, 'utf8'))
    vaultDestroy()
    rmSync(FILE, { force: true })

    // This machine's vault, open.
    await vaultCreate('this-machines-master-5678')
    vaultSave([entry('mine')])
    expect(vaultStatus().unlocked).toBe(true)

    // As index.ts wires it.
    const told: string[][] = []
    addySession.onApplied((collections) => {
      told.push(collections)
      if (collections.includes('vault')) vaultExternalChange()
    })
    const s = addySession as unknown as Record<string, unknown>
    s.addyd = labelledSidecar()
    s.account = { baseURL: 'https://r.example', token: 't', accountId: 'acct', epoch: 1 }
    s.relay = {
      getObject: async () => ({
        body: Buffer.from(sealedAs('vault', 1, 3, { mine: true }), 'base64'),
        etag: 'v3'
      }),
      putObject: async () => 'v4',
      request: async () => ({ ok: true, status: 204 })
    }

    await addySession.resolveConflict(7, 'vault', theirs)

    expect(told).toContainEqual(['vault'])
    expect(vaultStatus().unlocked).toBe(false)
    // THE DATA-LOSS PATH: a save from the copy it had unlocked would have
    // sealed `mine` back over the chosen file.
    expect(vaultSave([entry('mine')]).ok).toBe(false)
    expect(JSON.parse(readFileSync(FILE, 'utf8'))).toEqual(theirs)
  })

  it('is what index.ts does with a vault the session says changed', () => {
    const MAIN = readFileSync(join(__dirname, '..', 'src/main/index.ts'), 'utf8')
    const handler = MAIN.slice(MAIN.indexOf('addySession.onApplied('))
    expect(handler.slice(0, 4000)).toMatch(/includes\('vault'\)\)\s*\{\s*const \{ relocked \} = vaultExternalChange\(\)/)
  })
})
