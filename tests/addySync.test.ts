import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * What the engine decides, and what it refuses to destroy.
 *
 * ===========================================================================
 * THE FAILURE THIS IS WRITTEN AGAINST
 * ===========================================================================
 *
 * Sync is the one feature in this product that can delete a person's work
 * without an error, a prompt or a symptom. Last-writer-wins is the whole
 * design and it is only acceptable because the loser is KEPT — so the tests
 * that matter are not "does a push happen" but "when two copies disagree, are
 * both still reachable afterwards".
 *
 * Three specific mistakes, each of which passes a naive test suite:
 *
 *   - A fresh install pushes its empty state over an established account. The
 *     machine has no `servers` key at all; pushing `[]` because "the local
 *     value is falsy" wipes the account.
 *   - A device that has never synced this collection overwrites the relay with
 *     its own copy, because pushing is the obvious thing to do when you have
 *     data. It must ADOPT, and keep its own copy as a conflict.
 *   - A conflict is detected and the losing bytes are dropped, because the
 *     code that noticed the 409 had already moved on. Those bytes exist
 *     nowhere else at that moment.
 *
 * The relay and the sidecar are fakes, and deliberately thin: what is under
 * test is the DECISION, and a real AEAD would only prove that Go works.
 */

const userData = mkdtempSync(join(tmpdir(), 'opsmaxx-addy-sync-'))
vi.mock('electron', () => ({
  app: { getPath: () => userData, getVersion: () => '0.0.0-test' }
}))

const { syncOnce, forgetSyncState, SYNC_STATE_FILE } = await import(
  '../src/main/services/addy/sync'
)

// ---------------------------------------------------------------------------
// The fakes
// ---------------------------------------------------------------------------

/**
 * A sidecar that frames rather than encrypts.
 *
 * `seal` wraps the payload with its counter; `open` unwraps it and refuses a
 * counter that goes backwards, which is the one property of the real thing the
 * engine's logic depends on. It is NOT encryption and says so — a fake that
 * pretended to encrypt would invite somebody to test confidentiality here,
 * which this cannot answer.
 */
function fakeSidecar(): { send: (m: string, p?: unknown) => Promise<unknown>; alive: () => boolean } {
  return {
    alive: () => true,
    send: async (method: string, params?: unknown) => {
      const p = params as Record<string, unknown>
      if (method === 'seal') {
        return {
          sealed: Buffer.from(
            JSON.stringify({ counter: p.counter, payload: p.payload }),
            'utf8'
          ).toString('base64')
        }
      }
      if (method === 'open') {
        const inner = JSON.parse(Buffer.from(p.sealed as string, 'base64').toString('utf8'))
        if (inner.counter < (p.seenCounter as number)) {
          throw new Error(`counter went backwards: ${inner.counter} < ${p.seenCounter}`)
        }
        return { payload: inner.payload, counter: inner.counter }
      }
      throw new Error(`unexpected sidecar call ${method}`)
    }
  }
}

interface Stored {
  body: Buffer
  etag: string
  counter: number
}

/** A relay with one account's objects in a Map, and ETags that actually
 *  change — a fake with a constant ETag would make every "did it notice the
 *  remote changed" test vacuous. */
function fakeRelay(): {
  objects: Map<string, Stored>
  conflicts: { name: string; body: Buffer }[]
  getObject: (n: string) => Promise<{ body: Buffer; etag: string } | null>
  putObject: (n: string, e: number, c: number, b: Buffer, ifMatch?: string) => Promise<string>
  keepConflict: (n: string, e: number, c: number, b: Buffer) => Promise<void>
} {
  const objects = new Map<string, Stored>()
  const conflicts: { name: string; body: Buffer }[] = []
  let tag = 0
  return {
    objects,
    conflicts,
    getObject: async (name) => {
      const o = objects.get(name)
      return o ? { body: o.body, etag: o.etag } : null
    },
    putObject: async (name, _epoch, counter, body, ifMatch) => {
      const existing = objects.get(name)
      if (ifMatch !== undefined && existing && existing.etag !== ifMatch) {
        const err = new Error(`${name} was written by another device first`)
        ;(err as { code?: string }).code = 'internal'
        throw err
      }
      const etag = `etag-${++tag}`
      objects.set(name, { body, etag, counter })
      return etag
    },
    keepConflict: async (name, _e, _c, body) => {
      conflicts.push({ name, body })
    }
  }
}

const applied = vi.fn()
function deps(relay: ReturnType<typeof fakeRelay>): Parameters<typeof syncOnce>[0] {
  return {
    addyd: fakeSidecar() as never,
    relay: relay as never,
    epoch: () => 1,
    applied
  }
}

// ---------------------------------------------------------------------------

const DATA = join(userData, 'opsmaxx-data.json')
const writeBlob = (o: unknown): void => writeFileSync(DATA, JSON.stringify(o))
const readBlob = (): Record<string, unknown> => JSON.parse(readFileSync(DATA, 'utf8'))

/** What the relay would be holding if another device had pushed this. */
function seeded(relay: ReturnType<typeof fakeRelay>, name: string, value: unknown, counter = 1): void {
  relay.objects.set(name, {
    body: Buffer.from(
      JSON.stringify({
        counter,
        payload: Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
      }),
      'utf8'
    ),
    etag: `seed-${name}`,
    counter
  })
}

beforeEach(() => {
  applied.mockClear()
  forgetSyncState()
  rmSync(DATA, { force: true })
})
afterAll(() => rmSync(userData, { recursive: true, force: true }))

describe('a machine with nothing', () => {
  it('takes the account rather than pushing its own emptiness over it', async () => {
    const relay = fakeRelay()
    seeded(relay, 'servers', [{ id: 's1', name: 'web-01' }])

    const r = await syncOnce(deps(relay))

    expect(r.outcomes.servers).toBe('adopted')
    expect(readBlob().servers).toEqual([{ id: 's1', name: 'web-01' }])
  })

  it('pushes nothing at all when it has nothing', async () => {
    // The mistake: `local ?? Buffer.from('[]')`. A fresh install would then
    // overwrite an established account with sixteen empty collections, which
    // is the single worst thing this engine could do.
    const relay = fakeRelay()
    const r = await syncOnce(deps(relay))
    expect(relay.objects.size).toBe(0)
    expect(r.outcomes.servers).toBe('unchanged')
    expect(r.carried).toBe(0)
  })

  it('tells the renderer which collections landed, so they are not overwritten', async () => {
    // Eleven collections live in the blob the renderer holds in memory and
    // writes in full on every change. Without this call the next keystroke in
    // that window undoes the sync.
    const relay = fakeRelay()
    seeded(relay, 'servers', [{ id: 's1' }])
    await syncOnce(deps(relay))
    expect(applied).toHaveBeenCalledWith(['servers'])
  })

  it('does not announce a pass in which nothing landed', async () => {
    await syncOnce(deps(fakeRelay()))
    expect(applied).not.toHaveBeenCalled()
  })
})

describe('a machine with data and an empty account', () => {
  it('pushes, and an empty list is data', async () => {
    // Deleting your last server is an edit somebody made. Treating `[]` as
    // "nothing to send" would make that edit unsyncable for ever.
    writeBlob({ servers: [] })
    const relay = fakeRelay()

    const r = await syncOnce(deps(relay))

    expect(r.outcomes.servers).toBe('pushed')
    expect(relay.objects.has('servers')).toBe(true)
  })
})

describe('both sides have a copy and this device has never synced', () => {
  it('adopts the account and keeps its own copy rather than choosing for the user', async () => {
    writeBlob({ servers: [{ id: 'local-only' }] })
    const relay = fakeRelay()
    seeded(relay, 'servers', [{ id: 'from-the-account' }])

    const r = await syncOnce(deps(relay))

    expect(r.outcomes.servers).toBe('conflicted')
    // The account wins, because it is the copy the rest of the devices agree
    // on — one story rather than two.
    expect(readBlob().servers).toEqual([{ id: 'from-the-account' }])
    // And nothing was destroyed. These bytes existed nowhere else.
    expect(relay.conflicts.map((c) => c.name)).toContain('servers')
  })

  it('records agreement without a conflict when the two copies are identical', async () => {
    const same = [{ id: 's1', name: 'web-01' }]
    writeBlob({ servers: same })
    const relay = fakeRelay()
    seeded(relay, 'servers', same)

    const r = await syncOnce(deps(relay))

    expect(r.outcomes.servers).toBe('unchanged')
    expect(relay.conflicts).toEqual([])
  })
})

describe('once the two sides agree', () => {
  /** Get both sides to a known, agreed state. */
  async function settled(): Promise<ReturnType<typeof fakeRelay>> {
    writeBlob({ servers: [{ id: 's1' }] })
    const relay = fakeRelay()
    await syncOnce(deps(relay))
    return relay
  }

  it('does nothing at all on a second pass', async () => {
    const relay = await settled()
    const r = await syncOnce(deps(relay))
    expect(r.outcomes.servers).toBe('unchanged')
    expect(r.carried).toBe(0)
  })

  it('pushes a local edit', async () => {
    const relay = await settled()
    writeBlob({ servers: [{ id: 's1' }, { id: 's2' }] })

    const r = await syncOnce(deps(relay))

    expect(r.outcomes.servers).toBe('pushed')
  })

  it('pulls a remote edit', async () => {
    const relay = await settled()
    seeded(relay, 'servers', [{ id: 's1' }, { id: 'from-elsewhere' }], 2)

    const r = await syncOnce(deps(relay))

    expect(r.outcomes.servers).toBe('pulled')
    expect(readBlob().servers).toEqual([{ id: 's1' }, { id: 'from-elsewhere' }])
  })

  it('keeps both when both changed', async () => {
    const relay = await settled()
    writeBlob({ servers: [{ id: 's1' }, { id: 'added-here' }] })
    seeded(relay, 'servers', [{ id: 's1' }, { id: 'added-there' }], 2)

    const r = await syncOnce(deps(relay))

    expect(r.outcomes.servers).toBe('conflicted')
    expect(r.conflicts).toContain('servers')
    // The local edit survives, sealed, on the relay. Without this the person
    // who added a server on their laptop loses it with no error.
    const kept = relay.conflicts.find((c) => c.name === 'servers')
    expect(kept).toBeTruthy()
    const inner = JSON.parse(kept!.body.toString('utf8'))
    expect(JSON.parse(Buffer.from(inner.payload, 'base64').toString('utf8'))).toEqual([
      { id: 's1' },
      { id: 'added-here' }
    ])
  })
})

describe('when something goes wrong', () => {
  it('carries the other fifteen collections past one failure', async () => {
    writeBlob({ servers: [{ id: 's1' }], databases: [{ id: 'db1' }] })
    const relay = fakeRelay()
    const broken = {
      ...relay,
      putObject: async (name: string, ...rest: unknown[]) => {
        if (name === 'servers') throw new Error('the relay hated it')
        return relay.putObject(name, ...(rest as [number, number, Buffer, string?]))
      }
    }

    const r = await syncOnce(deps(broken as never))

    expect(r.outcomes.servers).toBe('failed')
    expect(r.error?.collection).toBe('servers')
    // The point: one bad collection is not a dead sync.
    expect(r.outcomes.databases).toBe('pushed')
  })

  it('reports the collections it has no source for rather than passing over them', async () => {
    // `manifest` and `deviceNames` are declared PENDING with a reason. A
    // silent skip would make them indistinguishable from a wiring bug.
    const r = await syncOnce(deps(fakeRelay()))
    expect(r.outcomes.manifest).toBe('skipped')
    expect(r.outcomes.deviceNames).toBe('skipped')
  })

  it('starts from nothing again after a resync, without destroying either copy', async () => {
    writeBlob({ servers: [{ id: 's1' }] })
    const relay = fakeRelay()
    await syncOnce(deps(relay))

    forgetSyncState()
    expect(existsSync(join(userData, SYNC_STATE_FILE))).toBe(true)
    writeBlob({ servers: [{ id: 's1' }, { id: 'local-since' }] })

    const r = await syncOnce(deps(relay))

    // With no memory of an agreement, a difference is a question for the user
    // rather than an overwrite in either direction. That is what makes
    // "resync everything" safe to offer at all.
    expect(r.outcomes.servers).toBe('conflicted')
    expect(relay.conflicts.length).toBeGreaterThan(0)
  })
})
