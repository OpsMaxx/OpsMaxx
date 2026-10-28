import { AddyError, type AddySidecar } from './sidecar'
import type { RelayClient } from './relay'
import type { ConflictCopy, ConflictReason } from '../../../shared/addy'

/**
 * Conflict copies, opened so a person can choose between them.
 *
 * THE SERVER CANNOT DO THIS AND THAT IS THE POINT. It holds two sealed blobs,
 * knows which device wrote the loser and when, and cannot read either. Only a
 * device with the epoch key can turn them into something a human can compare,
 * which is why the chooser lives here and not in the portal.
 */

export type { ConflictCopy } from '../../../shared/addy'

export interface ConflictDeps {
  addyd: AddySidecar
  relay: RelayClient
  epoch(): number
  /** The highest counter this device has accepted for a collection — the
   *  rollback floor (`sync.ts`'s `counterFloor`). Passed in rather than
   *  imported because `sync.ts` imports `sealConflict` from here. */
  floor(collection: string): number
}

/**
 * The label a conflict copy is sealed under: `conflict:<name>`, never `<name>`.
 *
 * THE LABEL IS THE AEAD'S ASSOCIATED DATA, so it decides what a ciphertext can
 * be opened as. Sealed under the collection's own name, a conflict copy was a
 * perfectly valid canonical object -- same account, same epoch, same name, and
 * a counter of the winner's plus one, which is exactly the number the
 * resolution is written at. So the relay could hand a copy the user had just
 * rejected back as the resolution, and every device would open it and adopt
 * it. Under its own label it cannot open as `vault`, and nothing sealed as
 * `vault` opens as a conflict copy. The relay still files the copy under the
 * plain name (`POST /v1/obj/vault/conflict`); only the sealing differs.
 *
 * Collection names are not validated by the sidecar or the protocol -- the
 * label is a length-prefixed string in the AAD, which is how `clipboard:<peer>`
 * already works -- so this needs no protocol change and no version bump. An
 * OpsMaxx 0.59.0 client opens these under the plain name, fails the tag, and
 * shows the copy as one that cannot be opened: it can discard it, never adopt.
 */
export function conflictLabel(name: string): string {
  return `conflict:${name}`
}

/**
 * What goes INSIDE a conflict copy's sealed plaintext, around the payload.
 *
 * The relay's `device` and `createdAt` are its own word -- unauthenticated,
 * and the chooser's only basis for a vault, which cannot be shown. So the
 * writer and the time travel sealed, where only a holder of the current epoch
 * key can have put them. That is a member of the account as it stands, not a
 * signature by one particular device: a member can claim another member's
 * name, the relay and a removed device cannot claim anything.
 */
interface ConflictEnvelope {
  v: 1
  device: string
  writtenAt: string
  /** Why it was set aside, when that is not an ordinary race. */
  reason?: ConflictReason
  /** The collection's own bytes, base64, exactly as they were on disk. */
  body: string
}

/** Seals `payload` as a conflict copy of `name`, with who and when inside. */
export async function sealConflict(
  addyd: AddySidecar,
  name: string,
  epoch: number,
  counter: number,
  payload: Buffer,
  writerVersion: string,
  reason?: ConflictReason
): Promise<Buffer> {
  const { devicePub } = await addyd.send<{ devicePub: string }>('whoami')
  const envelope: ConflictEnvelope = {
    v: 1,
    device: devicePub,
    writtenAt: new Date().toISOString(),
    ...(reason ? { reason } : {}),
    body: payload.toString('base64')
  }
  const { sealed } = await addyd.send<{ sealed: string }>('seal', {
    collection: conflictLabel(name),
    epoch,
    schema: 1,
    writerVersion,
    counter,
    payload: Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64')
  })
  return Buffer.from(sealed, 'base64')
}

interface RawConflict {
  id: number
  name: string
  epoch: number
  counter: number
  device: string
  body: string
  createdAt: string
}

/**
 * Lists what is waiting for a choice, with BOTH copies opened.
 *
 * Both, not just the loser. A chooser that showed only the copy that lost
 * would be asking somebody to decide against something they cannot see -- and
 * the commonest right answer is not "keep one" but "these differ in one entry
 * and I want both", which needs the pair on screen.
 */
export async function listConflicts(deps: ConflictDeps): Promise<ConflictCopy[]> {
  const resp = await deps.relay.request('GET', '/v1/conflicts')
  if (!resp.ok) {
    throw new AddyError('internal', `listing conflicts: ${resp.status} ${resp.statusText}`)
  }
  const { conflicts } = (await resp.json()) as { conflicts: RawConflict[] }

  const epoch = deps.epoch()
  const out: ConflictCopy[] = []
  for (const raw of conflicts) {
    // THE CURRENT EPOCH ONLY. A copy sealed under an older key was written
    // before the last re-key, and a re-key is what removing a device does: so
    // it may be the removed device's, posted while it was still a member, or
    // something the relay kept from then. Offering it put one click between a
    // device the user threw out and every device they kept -- "Replace"
    // re-seals it under the current key and syncs it everywhere. The relay
    // deletes these when the epoch advances; a 0.1.0 relay does not, so they
    // are filtered here as well, and not counted.
    if (raw.epoch !== epoch) continue
    const copy: ConflictCopy = {
      id: raw.id,
      collection: raw.name,
      device: raw.device,
      createdAt: raw.createdAt,
      reportedByRelay: true
    }
    try {
      try {
        const env = await openConflict(deps, raw.name, epoch, raw.body)
        copy.losing = JSON.parse(Buffer.from(env.body, 'base64').toString('utf8'))
        copy.device = env.device
        copy.createdAt = env.writtenAt
        copy.reportedByRelay = false
        if (env.reason) copy.reason = env.reason
      } catch (err) {
        if (!(err instanceof NotAConflictCopy)) throw err
        // A LEGACY COPY, kept by OpsMaxx 0.59.0 under the collection's own
        // label -- which makes it indistinguishable from any archived copy of
        // the real object. So it is opened at this device's floor, not 0: the
        // relay could otherwise list last month's vault as a "conflict" and
        // one click would reinstate it. A genuine legacy copy older than the
        // floor is refused and shown as one that cannot be opened, which is
        // the safe failure. Who and when stay the relay's, and say so.
        copy.losing = await openBlob(deps, raw.name, epoch, raw.body, deps.floor(raw.name))
      }
    } catch (err) {
      // Offered with the reason rather than dropped. A conflict that vanishes
      // from the list is a decision nobody gets to make, and the data is still
      // on the relay costing quota.
      copy.problem = err instanceof Error ? err.message : String(err)
    }
    try {
      const stored = await deps.relay.getObject(raw.name, epoch)
      if (stored) {
        // At the floor too. What is shown here as "in use now" is what the
        // user keeps, or concatenates into "keep both" -- an archived copy
        // served in its place would be written back as the resolution.
        copy.winning = await openBlob(
          deps,
          raw.name,
          epoch,
          stored.body.toString('base64'),
          deps.floor(raw.name)
        )
      }
    } catch {
      // The winner being unreadable is worth showing the loser for anyway:
      // that combination is precisely when somebody needs the copy that lost.
    }
    out.push(copy)
  }
  return out
}

async function openBlob(
  deps: ConflictDeps,
  collection: string,
  epoch: number,
  sealed: string,
  seenCounter: number
): Promise<unknown> {
  const { payload } = await deps.addyd.send<{ payload: string }>('open', {
    collection,
    epoch,
    sealed,
    knownSchema: 1,
    seenCounter
  })
  return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
}

/** The sealed body did not open under the conflict label: a legacy copy, or
 *  not a conflict copy at all. Distinct so the caller can try the legacy
 *  reading without swallowing a malformed envelope. */
class NotAConflictCopy extends Error {}

async function openConflict(
  deps: ConflictDeps,
  name: string,
  epoch: number,
  sealed: string
): Promise<ConflictEnvelope> {
  let payload: string
  try {
    ;({ payload } = await deps.addyd.send<{ payload: string }>('open', {
      collection: conflictLabel(name),
      epoch,
      sealed,
      knownSchema: 1,
      // Zero, and only here. The rollback floor guards a collection's own
      // counter sequence, and this copy cannot be served as part of it -- the
      // label sees to that. A floor would only make a copy unopenable once the
      // collection had moved on twice, which for a busy server list is hours.
      // What a replayed old copy CAN do is be offered again, and its sealed
      // date says when it was really written.
      seenCounter: 0
    }))
  } catch (err) {
    throw new NotAConflictCopy(err instanceof Error ? err.message : String(err))
  }
  const env = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as Partial<ConflictEnvelope>
  if (
    env.v !== 1 ||
    typeof env.device !== 'string' ||
    typeof env.writtenAt !== 'string' ||
    typeof env.body !== 'string'
  ) {
    throw new AddyError('internal', 'the conflict copy opened but its contents are not in a shape this version reads')
  }
  return env as ConflictEnvelope
}

/**
 * Resolves a conflict by writing the chosen contents and dropping the copy.
 *
 * ONE OPERATION, in this order: write first, then drop. The reverse loses the
 * losing copy if the write fails, which is the one outcome the whole mechanism
 * exists to prevent -- and it fails exactly when the relay is unreachable,
 * which is when a user is most likely to be retrying.
 *
 * `chosen` is whatever the user decided, which may be neither copy: merging
 * two server lists by hand produces a third thing, and that is the commonest
 * good answer.
 */
export async function resolveConflict(
  deps: ConflictDeps,
  id: number,
  collection: string,
  chosen: unknown,
  counter: number,
  /**
   * The winner's current ETag, and it is REQUIRED for this to work at all.
   *
   * Without it this sent an unconditional PUT over an object that exists, and
   * the relay refuses exactly that — `ErrObjectExists`, 409, deliberately
   * distinct from a tag mismatch. So choosing a merged copy, which is the
   * commonest right answer when two server lists differ by one entry, failed
   * every time. The user pressed save, the list did not change, and nothing
   * said why.
   *
   * It also does the job a conditional write is for: if another device wrote
   * between the chooser opening and the user deciding, this is refused rather
   * than silently flattening that write.
   */
  ifMatch: string
): Promise<void> {
  const payload = Buffer.from(JSON.stringify(chosen), 'utf8')
  const { sealed } = await deps.addyd.send<{ sealed: string }>('seal', {
    collection,
    epoch: deps.epoch(),
    schema: 1,
    writerVersion: process.env.npm_package_version ?? 'dev',
    counter,
    payload: payload.toString('base64')
  })
  await deps.relay.putObject(
    collection,
    deps.epoch(),
    counter,
    Buffer.from(sealed, 'base64'),
    ifMatch
  )

  const resp = await deps.relay.request('POST', `/v1/conflicts/${id}/resolve`)
  if (!resp.ok && resp.status !== 404) {
    throw new AddyError('internal', `resolving conflict ${id}: ${resp.status} ${resp.statusText}`)
  }
}

/**
 * Drops a conflict copy without writing anything.
 *
 * For the user who looked at both and decided the winner was right. Separate
 * from `resolveConflict` rather than a flag on it, because "write this" and
 * "write nothing" are different operations and a boolean that chose between
 * them would be one somebody passes wrongly.
 */
export async function discardConflict(deps: ConflictDeps, id: number): Promise<void> {
  const resp = await deps.relay.request('POST', `/v1/conflicts/${id}/resolve`)
  if (!resp.ok && resp.status !== 404) {
    throw new AddyError('internal', `discarding conflict ${id}: ${resp.status} ${resp.statusText}`)
  }
}
