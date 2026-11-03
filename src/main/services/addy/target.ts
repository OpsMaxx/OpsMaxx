import { MIN_PASSPHRASE, type BackupGeneration } from '../../../shared/backup'
import { sha256, type BackupTarget } from '../backupTargets'
import { AddyError, type AddySidecar } from './sidecar'
import type { RelayClient } from './relay'

/**
 * A backup destination that writes to an addy relay.
 *
 * SHIPPED ONLY BEHIND ITS FOUR PRECONDITIONS, all four of which are now met
 * and each of which is checked here rather than assumed:
 *
 *   1. `put` seals the bundle A SECOND TIME under K_profile_n, so the relay
 *      holds ciphertext it cannot read even if the passphrase leaks.
 *   2. The bundle's own KDF is scrypt p=3, matching the vault.
 *   3. `MIN_PASSPHRASE` is 12.
 *   4. RK and AK_n are excluded from `exportSecrets()`, so the bundle cannot
 *      carry the keys that open it.
 *
 * The first is the one this file implements; the other three are checked by
 * `assertPreconditions` below, at construction, because a target that shipped
 * without them would be one that writes singly-sealed credentials to a server
 * -- which is exactly what addy's design says never happens.
 */

/** The collection generations live in.
 *
 *  Named rather than derived from the destination id: a user who recreates a
 *  destination pointing at the same relay should find their generations, and
 *  an id regenerated on a restore would orphan every one of them. */
export const BACKUP_COLLECTION = 'backupGenerations'

/** What the client knows about what it has written.
 *
 *  THE AUTHORITATIVE LIST IS THIS, SEALED AS T0 -- not the relay's. The relay
 *  can enumerate object names, so asking it "what generations exist" is asking
 *  a party that cannot read them and could omit one. `list()` reconciles
 *  against this and treats the relay as a cache. */
interface GenerationIndex {
  generations: { name: string; size: number; modified: number; sha256: string }[]
}

export interface AddyTargetDeps {
  addyd: AddySidecar
  relay: RelayClient
  /** The epoch to seal under. Read fresh per call: a rotation between two
   *  writes must not leave the second sealed under a key the account has
   *  moved off. */
  epoch(): number
  /** The passphrase the bundle was built with, so the precondition check can
   *  see it is long enough. Never stored here. */
  passphraseLength(): number
}

/** Refuses to build the target when a precondition is not met.
 *
 *  Loudly, at construction, rather than at the first write. A destination that
 *  accepts configuration and then fails every scheduled run is one somebody
 *  discovers when they need a restore. */
function assertPreconditions(deps: AddyTargetDeps): void {
  if (MIN_PASSPHRASE < 12) {
    throw new AddyError('config-invalid', {
      key: 'main.addy.target.floorTooLow',
      vars: { min: MIN_PASSPHRASE }
    })
  }
  const length = deps.passphraseLength()
  if (length > 0 && length < MIN_PASSPHRASE) {
    throw new AddyError('config-invalid', {
      key: 'main.addy.target.passphraseTooShort',
      vars: { length, min: MIN_PASSPHRASE }
    })
  }
}

/**
 * Builds the target.
 *
 * Counters are per-object and monotonic, and this target keeps them in the
 * index rather than deriving them from a timestamp: two devices writing in the
 * same second would otherwise produce the same counter, and the relay's
 * rollback check would reject the second as a replay.
 */
export function addyTarget(deps: AddyTargetDeps): BackupTarget {
  assertPreconditions(deps)

  let index: GenerationIndex | null = null
  /** What the relay said the index was when this target last read or wrote
   *  it. Sent as If-Match on the next write: the relay's PUT is CREATE ONLY
   *  without one, so an index written unconditionally lands once and then
   *  every later backup is refused as "written by another device first". */
  let indexEtag = ''
  let indexCounter = 0

  const objectName = (generation: string): string => `${BACKUP_COLLECTION}/${generation}`

  /** Seals through the sidecar. The bundle bytes cross the pipe; the key does
   *  not cross it in either direction. */
  const seal = async (collection: string, counter: number, payload: Buffer): Promise<Buffer> => {
    const { sealed } = await deps.addyd.send<{ sealed: string }>('seal', {
      collection,
      epoch: deps.epoch(),
      schema: 1,
      writerVersion: process.env.npm_package_version ?? 'dev',
      counter,
      payload: payload.toString('base64')
    })
    return Buffer.from(sealed, 'base64')
  }

  const open = async (
    collection: string,
    sealed: Buffer,
    seenCounter: number
  ): Promise<{ payload: Buffer; counter: number }> => {
    const result = await deps.addyd.send<{ payload: string; counter?: number }>('open', {
      collection,
      epoch: deps.epoch(),
      sealed: sealed.toString('base64'),
      knownSchema: 1,
      seenCounter
    })
    return { payload: Buffer.from(result.payload, 'base64'), counter: result.counter ?? 0 }
  }

  const loadIndex = async (): Promise<GenerationIndex> => {
    if (index) return index
    const stored = await deps.relay.getObject(BACKUP_COLLECTION, deps.epoch())
    if (!stored) {
      index = { generations: [] }
      indexEtag = ''
      return index
    }
    const opened = await open(BACKUP_COLLECTION, stored.body, 0)
    index = JSON.parse(opened.payload.toString('utf8')) as GenerationIndex
    indexEtag = stored.etag
    // Never backwards: a counter this device already wrote stays the floor
    // even if the copy just read carries a lower one.
    indexCounter = Math.max(indexCounter, opened.counter)
    return index
  }

  const isConflict = (err: unknown): boolean => err instanceof AddyError && err.code === 'conflict'

  /** Writes the index as `change` applied to the CURRENT one.
   *
   *  A change rather than a finished index, so that when the conditional write
   *  loses -- another device backed up in between, or this target's cached
   *  copy is older than the relay's -- it is re-read and the same change is
   *  applied again on top. Failing instead would fail every backup after the
   *  first one somebody else wrote, forever. */
  const updateIndex = async (change: (current: GenerationIndex) => GenerationIndex): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      const next = change(await loadIndex())
      const counter = indexCounter + 1
      const sealed = await seal(BACKUP_COLLECTION, counter, Buffer.from(JSON.stringify(next), 'utf8'))
      try {
        indexEtag = await deps.relay.putObject(BACKUP_COLLECTION, deps.epoch(), counter, sealed, indexEtag || undefined)
        indexCounter = counter
        index = next
        return
      } catch (err) {
        // ponytail: three tries, then the 409 surfaces; a device losing three
        // races in a row is a loop worth hearing about rather than hiding.
        if (!isConflict(err) || attempt >= 2) throw err
        indexCounter = counter
        index = null
      }
    }
  }

  /** Writes a generation object, replacing one of the same name if a run that
   *  failed after this step left it there. */
  const putGeneration = async (name: string, counter: number, data: Buffer): Promise<void> => {
    const sealed = await seal(objectName(name), counter, data)
    try {
      await deps.relay.putObject(objectName(name), deps.epoch(), counter, sealed)
    } catch (err) {
      if (!isConflict(err)) throw err
      const existing = await deps.relay.getObject(objectName(name), deps.epoch())
      await deps.relay.putObject(objectName(name), deps.epoch(), counter, sealed, existing?.etag)
    }
  }

  return {
    async put(name, data) {
      // THE SECOND SEAL. `data` is already a passphrase-encrypted bundle; this
      // wraps it again under K_profile_n, which the relay does not have and
      // cannot derive. Without it a relay operator who learned the passphrase
      // -- from a note, a reused password, a shoulder -- would hold everything
      // the bundle carries.
      const current = await loadIndex()
      await putGeneration(name, current.generations.length + 1, data)

      const entry = { name, size: data.length, modified: Date.now(), sha256: sha256(data) }
      await updateIndex((latest) => ({
        generations: [...latest.generations.filter((g) => g.name !== name), entry]
      }))
    },

    async get(name) {
      const stored = await deps.relay.getObject(objectName(name), deps.epoch())
      if (!stored) {
        throw new AddyError('internal', { key: 'main.addy.target.noGeneration', vars: { name } })
      }
      const bundle = (await open(objectName(name), stored.body, 0)).payload

      // Checked against what the client recorded when it wrote, not against
      // anything the relay said. The whole point of the sealed index is that
      // it is the one party in this exchange that is not the server.
      const known = (await loadIndex()).generations.find((g) => g.name === name)
      if (known && sha256(bundle) !== known.sha256) {
        throw new AddyError('internal', { key: 'main.addy.target.hashMismatch', vars: { name } })
      }
      return bundle
    },

    async list(): Promise<BackupGeneration[]> {
      // From the sealed index, never from the relay's enumeration. A relay can
      // list object names, so asking it what exists is asking a party that
      // cannot read any of them and could omit one -- and an omitted
      // generation is one retention never deletes and restore never offers.
      const current = await loadIndex()
      return current.generations.map((g) => ({ name: g.name, size: g.size, modified: g.modified }))
    },

    async remove(name) {
      // The index first, then the object. The reverse order leaves a
      // generation listed that is not there, which restore offers and then
      // fails on; this order leaves at worst an orphaned object, which costs
      // quota and nothing else.
      await updateIndex((latest) => ({ generations: latest.generations.filter((g) => g.name !== name) }))
      // Deleted rather than overwritten with an empty tombstone: the relay's
      // PUT is create-only without an If-Match, so the tombstone was refused
      // every time and every pruned generation stayed on the relay as quota.
      await deps.relay.deleteObject(objectName(name), deps.epoch()).catch(() => {
        // A delete that does not land is not worth failing the removal over:
        // the index is authoritative and no longer lists it.
      })
    },

    async close() {
      /* the sidecar and the relay client outlive one target */
    }
  }
}
