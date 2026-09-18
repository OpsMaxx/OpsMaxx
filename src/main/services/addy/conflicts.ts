import { AddyError, type AddySidecar } from './sidecar'
import type { RelayClient } from './relay'
import type { ConflictCopy } from '../../../shared/addy'

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

  const out: ConflictCopy[] = []
  for (const raw of conflicts) {
    const copy: ConflictCopy = {
      id: raw.id,
      collection: raw.name,
      device: raw.device,
      createdAt: raw.createdAt
    }
    try {
      copy.losing = await openBlob(deps, raw.name, raw.epoch, raw.body)
    } catch (err) {
      // Offered with the reason rather than dropped. A conflict that vanishes
      // from the list is a decision nobody gets to make, and the data is still
      // on the relay costing quota.
      copy.problem = err instanceof Error ? err.message : String(err)
    }
    try {
      const stored = await deps.relay.getObject(raw.name, deps.epoch())
      if (stored) {
        copy.winning = await openBlob(deps, raw.name, deps.epoch(), stored.body.toString('base64'))
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
  sealed: string
): Promise<unknown> {
  const { payload } = await deps.addyd.send<{ payload: string }>('open', {
    collection,
    epoch,
    sealed,
    knownSchema: 1,
    // Zero, deliberately: this is a copy being INSPECTED, not applied. The
    // rollback check exists to stop an old document overwriting a newer one,
    // and a conflict copy is old by definition -- enforcing it here would make
    // every conflict unopenable, which is the opposite of the point.
    seenCounter: 0
  })
  return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
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
  counter: number
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
  await deps.relay.putObject(collection, deps.epoch(), counter, Buffer.from(sealed, 'base64'))

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
