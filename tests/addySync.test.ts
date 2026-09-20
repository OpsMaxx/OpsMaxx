import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
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
  app: { getPath: () => userData, getVersion: () => '0.0.0-test' },
  // store.ts seals opsmaxx-data.json with the OS secure store, and these tests
  // drive it through blobKey. Identity "encryption", like tests/mocks/electron.ts:
  // what is under test here is the sync engine, not the sealing.
  safeStorage: {
    isEncryptionAvailable: (): boolean => true,
    encryptString: (v: string): Buffer => Buffer.from(v, 'utf8'),
    decryptString: (b: Buffer): string => b.toString('utf8')
  }
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
    applied,
    // Entries agreed with another account are discarded rather than trusted;
    // every test in this file is the same account unless it says otherwise.
    accountId: () => 'acct-under-test'
  }
}

// ---------------------------------------------------------------------------

const DATA = join(userData, 'opsmaxx-data.json')
// Through the same envelope store.ts writes. A helper that read the file raw
// would report the sealed wrapper rather than the estate, and one that wrote
// raw would hand the engine a legacy-shaped file in every test — so the path
// under test here would be the migration, which is not what any of these are
// about.
const writeBlob = (o: unknown): void =>
  writeFileSync(DATA, JSON.stringify({ v: 1, enc: Buffer.from(JSON.stringify(o), 'utf8').toString('base64') }))
const readBlob = (): Record<string, unknown> => {
  const parsed = JSON.parse(readFileSync(DATA, 'utf8'))
  return typeof parsed?.enc === 'string'
    ? JSON.parse(Buffer.from(parsed.enc, 'base64').toString('utf8'))
    : parsed
}

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
    // `status: 'offline'` on every assertion below is the servers source, not
    // the engine: a connection belongs to the machine that holds it, so an
    // arriving server lands disconnected. See collections.ts's serversSource.

    const r = await syncOnce(deps(relay))

    expect(r.outcomes.servers).toBe('adopted')
    expect(readBlob().servers).toEqual([{ id: 's1', name: 'web-01', status: 'offline' }])
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

  it('tells the renderer about a CONFLICT too, which is also a write', async () => {
    // The omission was deterministic loss, not a race. A conflict writes the
    // remote copy to disk; a renderer that is not told keeps the losing copy
    // in memory and rewrites it over the file on its next save — which fires
    // on a theme change or an opened tab — and the next pass pushes that
    // revert as the account's winner.
    writeBlob({ servers: [{ id: 's1' }, { id: 'added-here' }] })
    const relay = fakeRelay()
    seeded(relay, 'servers', [{ id: 's1' }, { id: 'added-there' }])

    const r = await syncOnce(deps(relay))

    expect(r.outcomes.servers).toBe('conflicted')
    expect(applied).toHaveBeenCalledWith(['servers'])
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
  it('pushes what it has', async () => {
    writeBlob({ servers: [{ id: 's1' }] })
    const relay = fakeRelay()

    const r = await syncOnce(deps(relay))

    expect(r.outcomes.servers).toBe('pushed')
    expect(relay.objects.has('servers')).toBe(true)
  })

  it('does NOT push an empty list it has never agreed about', async () => {
    // The renderer writes all eleven of its keys on its first save, so from a
    // fresh install's first second the blob holds `servers: []` and the rest.
    // Pushed, that emptiness becomes the account's value for any collection
    // the account has not carried yet — and the device that DOES have the data
    // then adopts the empty object and demotes its real contents to a conflict
    // copy. The user opens the machine they work on and their HTTP workspace
    // is gone, recoverable only through a chooser they have to know to open.
    writeBlob({ servers: [], apiWorkspace: {} })
    const relay = fakeRelay()

    const r = await syncOnce(deps(relay))

    expect(r.outcomes.servers).toBe('unchanged')
    expect(r.outcomes.apiWorkspace).toBe('unchanged')
    expect(relay.objects.size).toBe(0)
  })

  it('DOES push an empty list once it has agreed about that collection', async () => {
    // Deleting your last server is an edit somebody made, and it has to reach
    // the other machines. The ambiguity exists exactly once — a device that
    // has agreed with the account can tell "I am new" from "I emptied this",
    // because the difference is recorded.
    writeBlob({ servers: [{ id: 's1' }] })
    const relay = fakeRelay()
    await syncOnce(deps(relay))

    writeBlob({ servers: [] })
    const r = await syncOnce(deps(relay))

    expect(r.outcomes.servers).toBe('pushed')
  })

  it('adopts without a conflict copy when its own copy is empty', async () => {
    // A new device paired to an established account would otherwise be handed
    // one conflict — "your empty list" against "your estate" — per populated
    // collection, before the chooser means anything.
    writeBlob({ servers: [] })
    const relay = fakeRelay()
    seeded(relay, 'servers', [{ id: 'the-account' }])

    const r = await syncOnce(deps(relay))

    expect(r.outcomes.servers).toBe('adopted')
    expect(relay.conflicts).toEqual([])
    expect(readBlob().servers).toEqual([{ id: 'the-account', status: 'offline' }])
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
    expect(readBlob().servers).toEqual([{ id: 'from-the-account', status: 'offline' }])
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
    expect(readBlob().servers).toEqual([
      { id: 's1', status: 'offline' },
      { id: 'from-elsewhere', status: 'offline' }
    ])
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

describe('the local data file', () => {
  it('a corrupt blob is refused, not treated as an empty machine', async () => {
    // `loadData` answers null for "no file" AND for "file and backup both
    // corrupt". Conflated, the second read as "this machine has nothing": all
    // eleven blob collections adopted from the relay, and the file rebuilt
    // from `{}` — destroying `settings`, `tabs`, `activeWorkspaceId` and every
    // other key with no relay copy, including the module state and the
    // local-terminal kill switch. `saveData` copies the corrupt file onto the
    // backup on its way past, so the one good copy went too.
    // The backup too: `loadData` falls back to it, so a stale one from an
    // earlier test would make this corrupt file readable after all.
    rmSync(`${DATA}.bak`, { force: true })
    writeFileSync(DATA, '{"servers":[{"id":"s1"}],"settings":{"theme":"light"')
    const relay = fakeRelay()
    seeded(relay, 'servers', [{ id: 'from-the-account' }])

    const r = await syncOnce(deps(relay))

    expect(r.outcomes.servers).toBe('failed')
    // And nothing was written over it.
    expect(readFileSync(DATA, 'utf8')).toContain('"theme":"light"')
  })

  it('a write that does not land is reported, not recorded as agreement', async () => {
    // `saveData` swallows every failure into a console line. The engine then
    // recorded agreement for a pull that never reached disk — and the NEXT
    // pass saw a local edit with no remote one and pushed the stale copy over
    // the account. Another device's work deleted everywhere because a disk was
    // full, with a console line nobody reads as the only trace.
    writeBlob({ servers: [{ id: 's1' }] })
    const relay = fakeRelay()
    await syncOnce(deps(relay))

    seeded(relay, 'servers', [{ id: 'from-elsewhere' }], 2)
    // Make the write fail in a way `saveData` swallows: a directory it cannot
    // create its temp file in. The rename never happens and the old contents
    // stay, which is exactly the shape of a full disk.
    chmodSync(userData, 0o500)
    try {
      const r = await syncOnce(deps(relay))
      expect(r.outcomes.servers).toBe('failed')
      // And the old contents are still there: nothing half-wrote. Read through
      // readBlob rather than grepping the file for `"s1"` — the estate is
      // sealed on disk now, so that substring is absent whether the write
      // landed or not, and the assertion would pass for the wrong reason.
      expect(readBlob().servers).toEqual([{ id: 's1' }])
    } finally {
      chmodSync(userData, 0o700)
    }
  })
})

describe('a relay that serves an old copy back', () => {
  it('is refused rather than adopted, and the floor is not lowered', async () => {
    // The relay can answer 409 unconditionally, which sends every conditional
    // write down the conflict path — and that path RE-READS the object. Opened
    // with no floor the sidecar cannot refuse an archived copy: it is genuine
    // ciphertext the account once wrote, so the tag and the AAD verify. The
    // old copy would overwrite the user's edit on disk, the edit would be
    // demoted to a conflict copy, and the device's floor would drop to the old
    // number — after which its own next push is refused by every other device
    // as a rollback.
    writeBlob({ servers: [{ id: 's1' }] })
    const relay = fakeRelay()
    seeded(relay, 'servers', [{ id: 's1' }], 50)
    await syncOnce(deps(relay))

    // The user edits; the relay refuses the write and then serves an archive.
    writeBlob({ servers: [{ id: 's1' }, { id: 'added-here' }] })
    const hostile = {
      ...relay,
      putObject: async () => {
        throw Object.assign(new Error('servers was written by another device first'), {
          code: 'internal'
        })
      },
      getObject: async (name: string) => {
        if (name !== 'servers') return relay.getObject(name)
        // Counter 3 against a device that has seen 50.
        return {
          body: Buffer.from(
            JSON.stringify({
              counter: 3,
              payload: Buffer.from(JSON.stringify([{ id: 'ancient' }]), 'utf8').toString('base64')
            }),
            'utf8'
          ),
          etag: 'replay'
        }
      }
    }

    const r = await syncOnce(deps(hostile as never))

    expect(r.outcomes.servers).toBe('failed')
    // The user's edit is still on disk. Adopting the archive would have
    // reinstated a removed SSH host key, or a deleted server.
    expect(readBlob().servers).toEqual([{ id: 's1' }, { id: 'added-here' }])
  })
})

describe('a conflict that is not one', () => {
  it('does not publish a copy when both sides hold the same bytes', async () => {
    // Reached when a pass is interrupted: collections land on disk, the state
    // entry does not, and the next pass sees a local change AND a remote
    // change over two payloads that are identical. Asking somebody to choose
    // between a thing and itself is the fastest way to teach them the chooser
    // is noise — and the chooser is the only thing that makes
    // last-writer-wins acceptable.
    writeBlob({ servers: [{ id: 's1' }] })
    const relay = fakeRelay()
    await syncOnce(deps(relay))

    // Both sides move to the SAME new value, independently — which is what
    // two devices agreeing looks like from here.
    const agreed = [{ id: 's1' }, { id: 's2' }]
    writeBlob({ servers: agreed })
    seeded(relay, 'servers', agreed, 2)

    const r = await syncOnce(deps(relay))

    expect(r.outcomes.servers).toBe('unchanged')
    expect(relay.conflicts).toEqual([])
  })

  it('does not republish the same conflict every pass when the write fails', async () => {
    // The loser is preserved BEFORE anything is overwritten, which is the
    // right order — so a write that then fails leaves no state entry, and the
    // next pass sees the identical situation. Twelve copies an hour until the
    // relay starts answering 507, after which the loser genuinely is
    // discarded.
    writeBlob({ servers: [{ id: 's1' }] })
    const relay = fakeRelay()
    await syncOnce(deps(relay))

    writeBlob({ servers: [{ id: 's1' }, { id: 'here' }] })
    seeded(relay, 'servers', [{ id: 's1' }, { id: 'there' }], 2)

    // A source whose write always fails, as a full disk does.
    const broken = {
      ...deps(relay),
      relay: relay as never
    }
    const { SOURCES } = await import('../src/main/services/addy/collections')
    const real = SOURCES.servers!
    SOURCES.servers = {
      read: () => real.read(),
      write: () => {
        throw new Error('the disk is full')
      },
      inRendererStore: true
    }
    try {
      await syncOnce(broken)
      expect(relay.conflicts.length).toBe(1)
      await syncOnce(broken)
      expect(relay.conflicts.length, 'a second copy of the same conflict').toBe(1)
    } finally {
      SOURCES.servers = real
    }
  })
})

describe('a state agreed with a different account', () => {
  it('is discarded rather than trusted', async () => {
    // The whole safety of a device's first sync is the `!known` branch: adopt
    // the account, keep the local copy as a conflict. A stale entry from a
    // previous account — whose `localHash` still matches an untouched local
    // file — makes `localChanged` false, so the pass takes the `pulled` branch
    // instead and the account's copy overwrites the local estate with nothing
    // kept. Reached by unpairing and joining a different account with the
    // local files untouched in between.
    writeBlob({ servers: [{ id: 'mine' }] })
    const relay = fakeRelay()
    await syncOnce(deps(relay))

    // Same machine, same untouched files, a different account's relay.
    const other = fakeRelay()
    seeded(other, 'servers', [{ id: 'theirs' }])
    const elsewhere = { ...deps(other), accountId: () => 'a-different-account' }

    const r = await syncOnce(elsewhere)

    // A conflict, not a silent pull: the local estate survives on the relay
    // as a copy the user can choose.
    expect(r.outcomes.servers).toBe('conflicted')
    expect(other.conflicts.map((c) => c.name)).toContain('servers')
  })
})

describe('a state cleared while a pass is running', () => {
  it('is not put back by that pass', async () => {
    // `syncOnce` loads the state at the start and writes the whole thing back
    // at the end, so a rotation, a catch-up or the user's own resync that
    // cleared it mid-pass was silently resurrected seconds later. The
    // resurrection is what turned a recoverable conflict into silent loss:
    // with the forget standing, the next pass hits the `!known` branch and
    // keeps both copies; with it undone, it takes the `pulled` branch and
    // overwrites the local one.
    writeBlob({ servers: [{ id: 's1' }] })
    const relay = fakeRelay()
    await syncOnce(deps(relay))
    expect(existsSync(join(userData, SYNC_STATE_FILE))).toBe(true)

    // A pass that is slow enough for something else to happen during it.
    const slow = {
      ...relay,
      getObject: async (name: string) => {
        if (name === 'servers') forgetSyncState()
        return relay.getObject(name)
      }
    }
    await syncOnce(deps(slow as never))

    // The state file is the empty one the forget wrote, not the map the pass
    // was holding.
    const saved = JSON.parse(readFileSync(join(userData, SYNC_STATE_FILE), 'utf8'))
    expect(Object.keys(saved.collections)).toEqual([])
  })
})

describe('a sync-state write that fails', () => {
  it('does not discard the pass, and still tells the renderer', async () => {
    // `saveState` throws by design and sat outside every try, so its failure
    // escaped `syncOnce`: `applied()` never ran, the renderer was never told
    // about a single inbound write, and its next save reverted all of them.
    // The pass after that pushed the reverts as the account's winners. A
    // bookkeeping-file failure became account-wide data loss.
    // Nothing on either side, so no collection fails and the state write is
    // the only thing that can: that isolates the containment being tested.
    const relay = fakeRelay()
    chmodSync(userData, 0o500)
    try {
      const r = await syncOnce(deps(relay))
      // A result came back at all — before, the exception escaped the pass.
      expect(r.outcomes.servers).toBe('unchanged')
      expect(r.error?.collection).toBe('sync state')
    } finally {
      chmodSync(userData, 0o700)
    }
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
