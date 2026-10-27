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

const { syncOnce, forgetSyncState, forgetEpochState, SYNC_STATE_FILE } = await import(
  '../src/main/services/addy/sync'
)
const { holdSyncedKeys, rendererReloaded } = await import('../src/main/services/addy/collections')
const { saveData } = await import('../src/main/services/store')
const { AddyError } = await import('../src/main/services/addy/sidecar')

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
      // A conflict copy carries its writer inside the seal; see conflicts.ts.
      if (method === 'whoami') return { devicePub: 'aa'.repeat(32) }
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
        // What RelayClient.putObject throws on a 409: its own code, which the
        // engine asks for instead of matching the message.
        throw new AddyError('conflict', `${name} was written by another device first`)
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
/** What the relay holds for one collection, unwrapped from the fake seal. */
function relayPayload(relay: ReturnType<typeof fakeRelay>, name: string): any {
  const o = relay.objects.get(name)
  if (!o) return undefined
  const inner = JSON.parse(o.body.toString('utf8'))
  return JSON.parse(Buffer.from(inner.payload, 'base64').toString('utf8'))
}

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
  // The file itself, not forgetSyncState(): a forget keeps the rollback
  // floors on purpose, and each test is a fresh device.
  rmSync(join(userData, SYNC_STATE_FILE), { force: true })
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
    // One record, two different contents: the one thing a first-contact
    // union will not decide.
    writeBlob({ servers: [{ id: 's1', name: 'edited-here' }] })
    const relay = fakeRelay()
    seeded(relay, 'servers', [{ id: 's1', name: 'edited-there' }])

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
  it('unions the two lists by id: a joining machine keeps its own servers and gains the account\'s', async () => {
    writeBlob({ servers: [{ id: 'local-only' }] })
    const relay = fakeRelay()
    seeded(relay, 'servers', [{ id: 'from-the-account' }])

    const r = await syncOnce(deps(relay))

    expect(r.outcomes.servers).toBe('merged')
    expect(readBlob().servers).toEqual([
      { id: 'local-only', status: 'offline' },
      { id: 'from-the-account', status: 'offline' }
    ])
    // On the relay too, so every other device gets this machine's servers.
    expect(relayPayload(relay, 'servers').map((x: { id: string }) => x.id)).toEqual([
      'local-only',
      'from-the-account'
    ])
    expect(relay.conflicts).toEqual([])
    // And the next pass agrees with it rather than merging again.
    expect((await syncOnce(deps(relay))).outcomes.servers).toBe('unchanged')
  })

  it('keeps both copies when one id holds different records on each side', async () => {
    writeBlob({ servers: [{ id: 's1', name: 'here' }, { id: 'local-only' }] })
    const relay = fakeRelay()
    seeded(relay, 'servers', [{ id: 's1', name: 'there' }])

    const r = await syncOnce(deps(relay))

    expect(r.outcomes.servers).toBe('conflicted')
    // The account wins, because it is the copy the rest of the devices agree
    // on — one story rather than two.
    expect(readBlob().servers).toEqual([{ id: 's1', name: 'there', status: 'offline' }])
    // And nothing was destroyed. These bytes existed nowhere else.
    expect(relay.conflicts.map((c) => c.name)).toContain('servers')
  })

  it('keeps both copies of a collection that is not a list of records', async () => {
    writeBlob({ apiWorkspace: { activeTab: 'here' } })
    const relay = fakeRelay()
    seeded(relay, 'apiWorkspace', { activeTab: 'there' })

    const r = await syncOnce(deps(relay))

    expect(r.outcomes.apiWorkspace).toBe('conflicted')
    expect(relay.conflicts.map((c) => c.name)).toContain('apiWorkspace')
  })

  it('keeps both copies when another device writes between the read and the union', async () => {
    writeBlob({ servers: [{ id: 'local-only' }] })
    const relay = fakeRelay()
    seeded(relay, 'servers', [{ id: 'from-the-account' }])
    const racing = {
      ...relay,
      putObject: async (n: string, e: number, c: number, b: Buffer, ifMatch?: string) => {
        if (n === 'servers' && ifMatch !== undefined) {
          seeded(relay, 'servers', [{ id: 'later' }], 2)
          relay.objects.get('servers')!.etag = 'written-meanwhile'
        }
        return relay.putObject(n, e, c, b, ifMatch)
      }
    }

    const r = await syncOnce(deps(racing as never))

    expect(r.outcomes.servers).toBe('conflicted')
    expect(readBlob().servers).toEqual([{ id: 'later', status: 'offline' }])
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

  it('merges when both changed and the changes do not overlap', async () => {
    // This used to be a conflict copy and a chooser, and the answer a person
    // gave was always the same one: "these differ in one entry and I want
    // both". Adding a server on the laptop while adding a different one on the
    // phone is not an ambiguity, and it should not cost anybody a decision.
    const relay = await settled()
    writeBlob({ servers: [{ id: 's1' }, { id: 'added-here' }] })
    seeded(relay, 'servers', [{ id: 's1' }, { id: 'added-there' }], 2)

    const r = await syncOnce(deps(relay))

    expect(r.outcomes.servers).toBe('merged')
    expect(r.conflicts).toEqual([])
    expect(relay.conflicts).toEqual([])
    expect(readBlob().servers).toEqual([
      { id: 's1', status: 'offline' },
      { id: 'added-here', status: 'offline' },
      { id: 'added-there', status: 'offline' }
    ])
  })

  it('still keeps both, and asks, when the two changes DO overlap', async () => {
    // The merge decides nothing ambiguous. One record renamed two ways is a
    // question for a person, and the old machinery is what answers it —
    // nothing is destroyed on either path.
    const relay = await settled()
    writeBlob({ servers: [{ id: 's1', name: 'mine' }] })
    seeded(relay, 'servers', [{ id: 's1', name: 'theirs' }], 2)

    const r = await syncOnce(deps(relay))

    expect(r.outcomes.servers).toBe('conflicted')
    expect(r.conflicts).toContain('servers')
    const kept = relay.conflicts.find((c) => c.name === 'servers')
    expect(kept).toBeTruthy()
    const inner = JSON.parse(kept!.body.toString('utf8'))
    // Inside the conflict envelope (writer, time, body) — see conflicts.ts.
    const envelope = JSON.parse(Buffer.from(inner.payload, 'base64').toString('utf8'))
    expect(JSON.parse(Buffer.from(envelope.body, 'base64').toString('utf8'))).toEqual([
      { id: 's1', name: 'mine' }
    ])
  })

  it('honours a delete from the other device rather than resurrecting it', async () => {
    // The reason the merge needs an ancestor. Without one, "absent there,
    // present here" cannot be told from "added here", and every delete would
    // come back on the next pass.
    // Settled on BOTH records, so s2 is in the ancestor. That is what makes
    // its absence on the other side a delete rather than an add here — the
    // distinction the whole three-way merge turns on.
    writeBlob({ servers: [{ id: 's1' }, { id: 's2' }] })
    const relay = fakeRelay()
    await syncOnce(deps(relay))

    writeBlob({ servers: [{ id: 's1' }, { id: 's2' }, { id: 'added-here' }] })
    seeded(relay, 'servers', [{ id: 's1' }], 2)

    const r = await syncOnce(deps(relay))

    expect(r.outcomes.servers).toBe('merged')
    expect(readBlob().servers).toEqual([
      { id: 's1', status: 'offline' },
      { id: 'added-here', status: 'offline' }
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
        throw new AddyError('conflict', 'servers was written by another device first')
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

    // An OVERLAPPING change, so this is still a conflict rather than a merge:
    // the same record renamed two ways is the case the chooser exists for, and
    // it is the case this test is about.
    writeBlob({ servers: [{ id: 's1', name: 'mine' }] })
    seeded(relay, 'servers', [{ id: 's1', name: 'theirs' }], 2)

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

    // Not a silent pull: the local estate survives, merged into the new
    // account's as a machine that joins it with its own servers does.
    expect(r.outcomes.servers).toBe('merged')
    expect((readBlob().servers as { id: string }[]).map((x) => x.id)).toEqual(['mine', 'theirs'])
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

    // With no memory of an agreement, a difference is never an overwrite in
    // either direction, and never a silent union either: this device has
    // agreed before, so an empty ancestor would bring back records deleted
    // elsewhere. Both copies are kept for a person. That is what makes
    // "resync everything" safe to offer at all.
    expect(r.outcomes.servers).toBe('conflicted')
    expect(relay.conflicts.map((c) => c.name)).toContain('servers')
  })

  it('keeps the rollback floor through a resync, so the relay cannot hand back an older copy', async () => {
    writeBlob({ servers: [] })
    const relay = fakeRelay()
    seeded(relay, 'servers', [{ id: 'current' }], 7)
    await syncOnce(deps(relay))
    expect(readBlob().servers).toEqual([{ id: 'current', status: 'offline' }])

    forgetSyncState()
    // The relay now serves an archived copy, genuinely sealed, at counter 3.
    seeded(relay, 'servers', [{ id: 'archived' }], 3)

    const r = await syncOnce(deps(relay))

    expect(r.outcomes.servers).toBe('failed')
    expect(readBlob().servers).toEqual([{ id: 'current', status: 'offline' }])
  })

  it('names a refused older copy plainly, and leaving clears the floor so pairing again works', async () => {
    writeBlob({ servers: [] })
    const relay = fakeRelay()
    seeded(relay, 'servers', [{ id: 'current' }], 7)
    await syncOnce(deps(relay))
    forgetSyncState()
    seeded(relay, 'servers', [{ id: 'restored' }], 3)

    const refused = await syncOnce(deps(relay))
    expect(refused.error?.code).toBe('rolled-back')
    expect(refused.error?.message).toMatch(/leave the account on this device and pair it again/)

    // Leaving: the floors go with the agreement, and the restored relay's copy
    // is adopted on the next join.
    forgetSyncState(undefined, { floors: 'clear' })
    expect((await syncOnce(deps(relay))).outcomes.servers).not.toBe('failed')
  })

  it('keeps the floor through a re-key, so the relay cannot serve an older copy after it', async () => {
    writeBlob({ servers: [] })
    const relay = fakeRelay()
    seeded(relay, 'servers', [{ id: 'current' }], 7)
    await syncOnce(deps(relay))

    forgetEpochState()
    seeded(relay, 'servers', [{ id: 'archived' }], 3)

    expect((await syncOnce(deps(relay))).outcomes.servers).toBe('failed')
    expect(readBlob().servers).toEqual([{ id: 'current', status: 'offline' }])
  })

  it('writes a new object above the floor after a resync, so it does not lock itself out', async () => {
    writeBlob({ servers: [] })
    const relay = fakeRelay()
    seeded(relay, 'servers', [{ id: 'current' }], 7)
    await syncOnce(deps(relay))

    forgetSyncState()
    // The relay lost the object (a restore, a move, or on purpose).
    relay.objects.delete('servers')
    writeBlob({ servers: [{ id: 'current' }, { id: 'new' }] })

    expect((await syncOnce(deps(relay))).outcomes.servers).toBe('pushed')
    expect(relay.objects.get('servers')!.counter).toBeGreaterThan(7)
    // And this device can read back what it wrote.
    expect((await syncOnce(deps(relay))).outcomes.servers).not.toBe('failed')
  })

  it('keeps the floor from a state file written before floors existed', async () => {
    writeBlob({ servers: [] })
    const relay = fakeRelay()
    seeded(relay, 'servers', [{ id: 'current' }], 7)
    await syncOnce(deps(relay))
    // A 0.59.0 state file: counters in the entries, no floors.
    const path = join(userData, SYNC_STATE_FILE)
    const old = JSON.parse(readFileSync(path, 'utf8'))
    delete old.floors
    writeFileSync(path, JSON.stringify(old))

    forgetEpochState()
    seeded(relay, 'servers', [{ id: 'archived' }], 3)

    expect((await syncOnce(deps(relay))).outcomes.servers).toBe('failed')
  })

  it('keeps this device\'s copy when a pull would remove most of a list', async () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id }))
    writeBlob({ servers: six })
    const relay = fakeRelay()
    await syncOnce(deps(relay))
    // Another device empties the list.
    const stored = relay.objects.get('servers')!
    seeded(relay, 'servers', [{ id: 'a' }], stored.counter + 1)

    const r = await syncOnce(deps(relay))

    expect(r.outcomes.servers).toBe('pulled')
    expect(relay.conflicts.map((c) => c.name)).toContain('servers')
  })

  it('lets a single delete through without a copy', async () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id }))
    writeBlob({ servers: six })
    const relay = fakeRelay()
    await syncOnce(deps(relay))
    const stored = relay.objects.get('servers')!
    seeded(relay, 'servers', six.slice(1), stored.counter + 1)

    await syncOnce(deps(relay))

    expect(relay.conflicts).toEqual([])
  })
})

// ---------------------------------------------------------------------------

describe('a collection whose source rewrites what it is given', () => {
  // Every server on every device went grey and stayed grey.
  //
  // `serversSource` transforms on write: an arriving server lands `offline`,
  // because a connection belongs to the machine holding it and one device's
  // sockets must not draw as green lights on another's. That part is right.
  //
  // What was wrong is what the engine recorded afterwards. It wrote the
  // relay's bytes to the source and stored the hash of THOSE bytes as "what
  // this device now has" — while the source had put something else on disk.
  // The next pass compared the disk against that hash, found a local edit
  // nobody had made, and pushed the transformed copy back as the account's
  // winner. The other device pulled its own servers back as offline,
  // transformed them again, and pushed again: one clobber per sync interval,
  // for ever, with reconnecting each server by hand as the only cure.

  it('settles instead of pushing the rewrite back at the account', async () => {
    const relay = fakeRelay()
    seeded(relay, 'servers', [{ id: 's1', name: 'TestServer', status: 'online' }])

    expect((await syncOnce(deps(relay))).outcomes.servers).toBe('adopted')
    // The transform still happens. A socket on another machine is not a socket
    // on this one, and that was never the bug.
    expect(readBlob().servers).toEqual([{ id: 's1', name: 'TestServer', status: 'offline' }])

    // THE ASSERTION THAT MATTERS. Nothing changed on either side, so a second
    // pass must have nothing to do.
    const before = relay.objects.get('servers')!.etag
    expect((await syncOnce(deps(relay))).outcomes.servers).toBe('unchanged')
    expect(relay.objects.get('servers')!.etag, 'pushed its own rewrite back').toBe(before)
  })

  it('leaves the other device\'s copy alone, pass after pass', async () => {
    const relay = fakeRelay()
    seeded(relay, 'servers', [{ id: 's1', name: 'TestServer', status: 'online' }])
    await syncOnce(deps(relay))

    for (let i = 0; i < 4; i++) {
      expect((await syncOnce(deps(relay))).outcomes.servers, `pass ${i + 2}`).toBe('unchanged')
    }

    // What the relay holds is still what the device that owns that socket
    // said, not this device's rewrite of it.
    const stored = JSON.parse(relay.objects.get('servers')!.body.toString('utf8')) as {
      payload: string
    }
    expect(JSON.parse(Buffer.from(stored.payload, 'base64').toString('utf8'))).toEqual([
      { id: 's1', name: 'TestServer', status: 'online' }
    ])
  })

  it('still notices a real local edit', async () => {
    // The fix must not buy quiet by going blind. A genuine change here is
    // still a push.
    const relay = fakeRelay()
    seeded(relay, 'servers', [{ id: 's1', name: 'TestServer', status: 'online' }])
    await syncOnce(deps(relay))
    expect((await syncOnce(deps(relay))).outcomes.servers).toBe('unchanged')

    writeBlob({ ...readBlob(), servers: [{ id: 's1', name: 'Renamed Here', status: 'offline' }] })
    expect((await syncOnce(deps(relay))).outcomes.servers).toBe('pushed')
  })
})

describe('a lost write is recognised by its code, not its wording', () => {
  // The engine used to regex the message for "written by another device", so
  // rewording the sentence in relay.ts would have turned every create race
  // into a failed collection. The refusal now carries `conflict`.
  it('routes a conflict-coded refusal into the conflict path whatever it says', async () => {
    writeBlob({ servers: [{ id: 'mine' }] })
    const relay = fakeRelay()
    let raced = false
    const racing = {
      ...relay,
      putObject: async (name: string, e: number, c: number, b: Buffer, ifMatch?: string) => {
        if (name === 'servers' && !raced) {
          // Another device created it between this pass's GET and its PUT.
          raced = true
          seeded(relay, 'servers', [{ id: 'theirs' }])
          throw new AddyError('conflict', 'the relay answered 409')
        }
        return relay.putObject(name, e, c, b, ifMatch)
      }
    }
    const r = await syncOnce(deps(racing as never))
    expect(raced, 'the race was never staged').toBe(true)
    expect(r.outcomes.servers).not.toBe('failed')
  })
})

describe('the renderer is told as each copy lands', () => {
  it('before the pass moves on to the next collection', async () => {
    // Told once at the end of the pass, the renderer had fifteen more relay
    // round trips in which its next save wrote the pre-sync copy back.
    const relay = fakeRelay()
    seeded(relay, 'databases', [{ id: 'd1' }])
    seeded(relay, 'servers', [{ id: 's1' }])
    let toldBeforeServers = false
    const watching = {
      ...relay,
      getObject: async (name: string) => {
        if (name === 'servers') toldBeforeServers = applied.mock.calls.some((c) => c[0].includes('databases'))
        return relay.getObject(name)
      }
    }
    await syncOnce(deps(watching as never))
    expect(toldBeforeServers).toBe(true)
  })

  it('a save the renderer queued before it reloaded cannot push the old copy', async () => {
    writeBlob({ servers: [{ id: 's1' }], theme: 'dark' })
    const relay = fakeRelay()
    await syncOnce(deps(relay))
    // Another device adds a server, and this one pulls it.
    seeded(relay, 'servers', [{ id: 's1' }, { id: 's2' }], 2)
    expect((await syncOnce(deps(relay))).outcomes.servers).toBe('pulled')

    // The renderer's debounced save fires before its reload: the pre-sync
    // servers, plus a change of its own that has nothing to do with them.
    // This is what main's `data:save` does with it.
    saveData(holdSyncedKeys({ servers: [{ id: 's1' }], theme: 'light' }))
    expect((readBlob().servers as unknown[]).length).toBe(2)
    expect(readBlob().theme).toBe('light')

    const r = await syncOnce(deps(relay))
    expect(r.outcomes.servers).toBe('unchanged')

    // Once it has read the file back, what it saves is its own again.
    rendererReloaded()
    saveData(holdSyncedKeys({ servers: [{ id: 's1' }], theme: 'light' }))
    expect((readBlob().servers as unknown[]).length).toBe(1)
  })
})

describe('a re-key does not revert an edit that was not pushed yet', () => {
  it('the offline device pushes its edit after following the rotation', async () => {
    // A laptop edits offline; meanwhile another device re-keys, which
    // re-seals every object (new ETags, same contents). The rotation used to
    // forget ALL state, so the laptop's next pass took the first-contact
    // branch: its edit became a conflict copy and the account's older copy
    // went back on its screen — for every collection it had touched.
    const hosts = join(userData, 'opsmaxx-known-hosts.json')
    writeBlob({ servers: [{ id: 's1' }] })
    writeFileSync(hosts, '{"h1":"fp1"}')
    const relay = fakeRelay()
    await syncOnce(deps(relay))

    writeBlob({ servers: [{ id: 's1' }, { id: 'edited-offline' }] })
    writeFileSync(hosts, '{"h1":"fp1","h2":"fp2"}')
    for (const [name, o] of relay.objects) relay.objects.set(name, { ...o, etag: `resealed-${name}` })
    forgetEpochState()

    const r = await syncOnce(deps(relay))

    // Both kinds: a list of records, and a whole file the merge cannot open.
    expect(r.outcomes.servers).toBe('pushed')
    expect(r.outcomes.knownHosts).toBe('pushed')
    expect(relay.conflicts).toEqual([])
    expect(readBlob().servers).toEqual([{ id: 's1' }, { id: 'edited-offline' }])
    expect(readFileSync(hosts, 'utf8')).toBe('{"h1":"fp1","h2":"fp2"}')
    rmSync(hosts, { force: true })
  })
})

describe('resolving one conflict', () => {
  it('leaves another collection\'s pending edit alone', async () => {
    writeBlob({ servers: [{ id: 's1' }], databases: [{ id: 'd1' }] })
    const relay = fakeRelay()
    await syncOnce(deps(relay))
    // An edit to databases this device has not pushed yet.
    writeBlob({ ...readBlob(), databases: [{ id: 'd1' }, { id: 'd2-pending' }] })

    // `servers` is resolved, as session.resolveConflict does it: the choice
    // on the relay and on disk, and that collection's agreement forgotten.
    const chosen = [{ id: 's1' }, { id: 'chosen' }]
    seeded(relay, 'servers', chosen, 5)
    writeBlob({ ...readBlob(), servers: chosen })
    forgetSyncState(['servers'])

    const r = await syncOnce(deps(relay))

    expect(r.outcomes.databases).toBe('pushed')
    expect(r.outcomes.servers).toBe('unchanged')
    expect(relay.conflicts).toEqual([])
    expect(readBlob().databases).toEqual([{ id: 'd1' }, { id: 'd2-pending' }])
  })

  it('is what session.resolveConflict forgets', () => {
    const SESSION = readFileSync(join(__dirname, '..', 'src/main/services/addy/session.ts'), 'utf8')
    const fn = SESSION.slice(SESSION.indexOf('async resolveConflict('))
    expect(fn.slice(0, fn.indexOf('\n  }\n'))).toMatch(/forgetSyncState\(\[collection\]\)/)
  })
})
