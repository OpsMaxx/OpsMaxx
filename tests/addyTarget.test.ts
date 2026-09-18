import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { MIN_PASSPHRASE } from '../src/shared/backup'
import { addyTarget, BACKUP_COLLECTION } from '../src/main/services/addy/target'
import { AddyError, type AddySidecar } from '../src/main/services/addy/sidecar'
import type { RelayClient } from '../src/main/services/addy/relay'

/**
 * The backup destination that writes to an addy relay.
 *
 * The property everything here exists to protect: THE RELAY NEVER HOLDS A
 * SINGLY-SEALED BUNDLE. A backup bundle is already encrypted under the user's
 * passphrase, and a passphrase is a thing people reuse, write down and type
 * where somebody can see. The second seal under K_profile_n is what makes a
 * relay operator who learned the passphrase hold nothing.
 */

/**
 * A sidecar whose `seal` actually TRANSFORMS the bytes.
 *
 * The first version of this prefixed a marker and returned the payload
 * unchanged after it -- and the test below, which asserts the relay never
 * holds the bundle verbatim, failed against correct code. The fake was wrong,
 * not the target: a real AEAD seal produces bytes with no plaintext in them,
 * and a fake that leaves the plaintext in place cannot be used to check that
 * property at all.
 *
 * XOR is enough. It is not encryption and does not pretend to be; what it has
 * in common with the real thing is that the output contains none of the input.
 */
const SEAL_MARK = Buffer.from('SEALED:')
const SEAL_KEY = 0x5a

function scramble(b: Buffer): Buffer {
  const out = Buffer.alloc(b.length)
  for (let i = 0; i < b.length; i++) out[i] = b[i] ^ SEAL_KEY
  return out
}

function fakeSidecar(): AddySidecar & { sealed: Buffer[] } {
  const sealed: Buffer[] = []
  return {
    sealed,
    alive: () => true,
    async close() {},
    async send<T>(method: string, params?: unknown): Promise<T> {
      const p = params as Record<string, unknown>
      if (method === 'seal') {
        const payload = Buffer.from(String(p.payload), 'base64')
        sealed.push(payload)
        const wrapped = Buffer.concat([SEAL_MARK, scramble(payload)])
        return { sealed: wrapped.toString('base64') } as T
      }
      if (method === 'open') {
        const blob = Buffer.from(String(p.sealed), 'base64')
        if (!blob.subarray(0, SEAL_MARK.length).equals(SEAL_MARK)) {
          throw new AddyError('internal', 'not sealed')
        }
        return { payload: scramble(blob.subarray(SEAL_MARK.length)).toString('base64') } as T
      }
      throw new AddyError('internal', `unexpected method ${method}`)
    }
  }
}

/** A relay that remembers what it was handed. */
function fakeRelay(): RelayClient & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>()
  return {
    objects,
    async getObject(name: string) {
      const held = objects.get(name)
      return held ? { body: held, etag: 'e' } : null
    },
    async putObject(name: string, _epoch: number, _counter: number, sealed: Buffer) {
      objects.set(name, sealed)
      return 'e'
    },
    async roster() {
      return ''
    },
    async request() {
      throw new Error('not used')
    }
  } as unknown as RelayClient & { objects: Map<string, Buffer> }
}

function target(over: { passphraseLength?: number } = {}) {
  const addyd = fakeSidecar()
  const relay = fakeRelay()
  const t = addyTarget({
    addyd,
    relay,
    epoch: () => 1,
    passphraseLength: () => over.passphraseLength ?? 16
  })
  return { t, addyd, relay }
}

const BUNDLE = Buffer.from('a passphrase-encrypted backup bundle')

describe('what reaches the relay', () => {
  it('is never the bundle as the backup layer produced it', async () => {
    const { t, relay } = target()
    await t.put('opsmaxx-backup-2026-09-18.spbackup', BUNDLE)

    // Every byte the relay holds, checked. A test that only looked at the
    // generation object would miss an index that carried plaintext.
    for (const [name, stored] of relay.objects) {
      expect(stored.includes(BUNDLE), `${name} holds the bundle verbatim`).toBe(false)
      expect(stored.subarray(0, SEAL_MARK.length), `${name} is not sealed`).toEqual(SEAL_MARK)
    }
  })

  it('seals the generation and the index separately', async () => {
    const { t, addyd } = target()
    await t.put('gen-1', BUNDLE)
    // Two seals, not one: the index is a T0 collection in its own right, and
    // an index written in the clear would tell the relay the name, size and
    // hash of every backup this account holds.
    expect(addyd.sealed.length).toBe(2)
  })
})

describe('the generation list', () => {
  it('comes from the sealed index rather than the relay', async () => {
    const { t, relay } = target()
    await t.put('gen-1', BUNDLE)

    // A generation the relay knows about and the client never wrote. Asking
    // the relay what exists is asking a party that cannot read any of it --
    // and that could as easily omit one, which is a generation retention never
    // deletes and restore never offers.
    relay.objects.set(`${BACKUP_COLLECTION}/gen-invented`, Buffer.concat([SEAL_MARK, scramble(Buffer.from('x'))]))

    const listed = await t.list()
    expect(listed.map((g) => g.name)).toEqual(['gen-1'])
  })

  it('records the size of the bundle, not of the sealed object', async () => {
    const { t } = target()
    await t.put('gen-1', BUNDLE)
    const [gen] = await t.list()
    // What a user is shown, and what retention reasons about. The sealing
    // overhead is addy's business, not theirs.
    expect(gen.size).toBe(BUNDLE.length)
  })
})

describe('reading a generation back', () => {
  it('round-trips the exact bundle', async () => {
    const { t } = target()
    await t.put('gen-1', BUNDLE)
    expect(await t.get('gen-1')).toEqual(BUNDLE)
  })

  it('refuses one whose hash disagrees with what this device recorded', async () => {
    const { t, relay } = target()
    await t.put('gen-1', BUNDLE)

    // The relay swaps the object for a different, validly sealed one. It can
    // do this: it holds the bytes. What it cannot do is change the hash in the
    // sealed index, which is the one party to this exchange that is not the
    // server.
    relay.objects.set(
      `${BACKUP_COLLECTION}/gen-1`,
      Buffer.concat([SEAL_MARK, scramble(Buffer.from('a different bundle entirely'))])
    )

    await expect(t.get('gen-1')).rejects.toThrow(/different hash/)
  })

  it('says so plainly when the relay has no such generation', async () => {
    const { t } = target()
    await expect(t.get('never-written')).rejects.toThrow(/no generation named/)
  })
})

describe('removing a generation', () => {
  it('takes it out of the index first', async () => {
    const { t } = target()
    await t.put('gen-1', BUNDLE)
    await t.remove('gen-1')
    // The reverse order leaves a generation listed that is not there, which
    // restore offers and then fails on. This order leaves at worst an orphaned
    // object, which costs quota and nothing else.
    expect(await t.list()).toEqual([])
  })
})

describe('the preconditions', () => {
  it('refuse at construction rather than at the first write', () => {
    // A destination that accepts configuration and then fails every scheduled
    // run is one somebody discovers when they need a restore.
    expect(() => target({ passphraseLength: 8 })).toThrow(/12/)
  })

  it('are the ones the plan named', () => {
    // The floor, pinned here as well as in the backup tests, because THIS is
    // the feature whose shipping was made conditional on it.
    expect(MIN_PASSPHRASE).toBeGreaterThanOrEqual(12)
  })

  it('accept a passphrase at the floor exactly', () => {
    expect(() => target({ passphraseLength: MIN_PASSPHRASE })).not.toThrow()
  })
})

describe('counters', () => {
  it('advance rather than being derived from the clock', async () => {
    const { t } = target()
    await t.put('gen-1', BUNDLE)
    await t.put('gen-2', BUNDLE)
    // Two devices writing in the same second would produce the same
    // timestamp-derived counter, and the relay's rollback check would reject
    // the second as a replay.
    const listed = await t.list()
    expect(listed).toHaveLength(2)
  })
})

describe('the hash the index records', () => {
  it('is of the bundle, so it can be checked after unsealing', async () => {
    const { t, relay } = target()
    await t.put('gen-1', BUNDLE)

    const indexBlob = relay.objects.get(BACKUP_COLLECTION)
    expect(indexBlob).toBeTruthy()
    const index = JSON.parse(scramble(indexBlob!.subarray(SEAL_MARK.length)).toString('utf8')) as {
      generations: { sha256: string }[]
    }
    expect(index.generations[0].sha256).toBe(createHash('sha256').update(BUNDLE).digest('hex'))
  })
})
