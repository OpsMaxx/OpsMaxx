import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { atomicWriteFileSync } from '../atomicWrite'
import { AddyError, type AddySidecar } from './sidecar'
import type { RelayClient } from './relay'
import { SOURCES, type CollectionSource } from './collections'
import { SYNCED_COLLECTIONS, type SyncedCollection } from '../../../shared/addy'

/**
 * The engine that actually carries data between two machines.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS, IN ONE PARAGRAPH
 * ---------------------------------------------------------------------------
 *
 * One pass over the sixteen collections. For each: read the sealed copy on the
 * relay, read the local one, and decide between them. The decision is
 * last-writer-wins PER COLLECTION, with the loser KEPT as a named conflict
 * copy — the second half is what makes the first half acceptable. A bare LWW
 * would silently destroy one device's work and tell nobody, which for
 * `servers` means a machine somebody added on the laptop is simply gone from
 * the desktop, with no error and no symptom.
 *
 * ---------------------------------------------------------------------------
 * THE THREE THINGS THIS FILE IS CAREFUL ABOUT
 * ---------------------------------------------------------------------------
 *
 * 1. IT NEVER OPENS WHAT IT CARRIES. `seal` and `open` happen in the sidecar;
 *    this module moves base64 and never holds a key. `vault` in particular is
 *    ciphertext going in and ciphertext coming out.
 *
 * 2. ABSENT IS NOT EMPTY. A collection this machine has never had reads as
 *    `null`, and `null` is never pushed. An empty `servers` array IS pushed,
 *    because deleting your last server is a real edit somebody made. Conflating
 *    the two is how a fresh install wipes an established account.
 *
 * 3. THE COUNTER ONLY GOES UP. Every sealed payload carries a monotonic
 *    counter and the sidecar refuses one that goes backwards, so a replayed or
 *    rolled-back copy is an error rather than a silent downgrade. This module's
 *    job is to keep the number it last saw, per collection, and hand it back.
 */

/** What this device remembers about one collection between passes. */
interface CollectionState {
  /** The relay's ETag when this device last agreed with it. */
  etag: string
  /** The highest counter this device has seen in that object. */
  counter: number
  /** SHA-256 of the local bytes as they stood at that moment. How a later pass
   *  tells "this machine edited it" from "this machine has not touched it". */
  localHash: string
  /** Epoch ms of the last agreement. */
  at: number
}

interface SyncState {
  version: 1
  /** Keyed by collection name. Absent means never synced, which is a state. */
  collections: Record<string, CollectionState>
}

/** DEVICE-LOCAL, and it must stay that way.
 *
 *  It records what this particular machine has seen, so syncing it would have
 *  every device adopt every other device's idea of what it had already done.
 *  Classified in `NOT_SYNCED` for exactly that reason. */
export const SYNC_STATE_FILE = 'opsmaxx-addy-sync.json'

const statePath = (): string => join(app.getPath('userData'), SYNC_STATE_FILE)

function loadState(): SyncState {
  try {
    const path = statePath()
    if (!existsSync(path)) return { version: 1, collections: {} }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as SyncState
    if (parsed?.version !== 1 || typeof parsed.collections !== 'object') {
      return { version: 1, collections: {} }
    }
    return parsed
  } catch {
    // A damaged note means this device does not know what it has already
    // agreed to — which is exactly the state a fresh device is in, and that
    // state is handled: it adopts the relay's copy rather than overwriting it.
    return { version: 1, collections: {} }
  }
}

function saveState(state: SyncState): void {
  atomicWriteFileSync(statePath(), JSON.stringify(state))
}

const hash = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

/** What one collection did in one pass, for the panel and for the log. */
export type CollectionOutcome =
  | 'unchanged'
  | 'pushed'
  | 'pulled'
  | 'adopted'
  | 'conflicted'
  | 'skipped'
  | 'failed'

export interface SyncResult {
  at: number
  /** Per collection, what happened. Every wired collection appears. */
  outcomes: Record<string, CollectionOutcome>
  /** How many objects actually moved in either direction. The number the
   *  panel's sparkline is built from. */
  carried: number
  /** Collections that ended in a conflict copy waiting for a choice. */
  conflicts: string[]
  /** First failure, if any. A pass continues past one: a collection that
   *  cannot be carried must not stop the fifteen that can. */
  error?: { collection: string; message: string; code?: string }
}

export interface SyncDeps {
  addyd: AddySidecar
  relay: RelayClient
  epoch(): number
  /** Told which collections changed on disk, so the renderer can reload them
   *  before it writes its own stale copy back over the top. */
  applied(collections: SyncedCollection[]): void
}

/** The schema every object this version writes declares. Bumped when the shape
 *  of what is inside changes, never when this file changes. */
const SCHEMA = 1

function versionString(): string {
  return `opsmaxx/${app.getVersion?.() ?? '0'}`
}

/**
 * One pass over everything.
 *
 * Sequential rather than parallel, and that is a decision: sixteen concurrent
 * conditional writes against one account is how two of them race each other
 * into conflict copies that neither device's user caused.
 */
export async function syncOnce(deps: SyncDeps): Promise<SyncResult> {
  const state = loadState()
  const result: SyncResult = { at: Date.now(), outcomes: {}, carried: 0, conflicts: [] }
  const changed: SyncedCollection[] = []

  for (const name of SYNCED_COLLECTIONS) {
    const source = SOURCES[name]
    if (!source) {
      // Declared in `PENDING` with a reason — see collections.ts. Reported
      // rather than passed over in silence.
      result.outcomes[name] = 'skipped'
      continue
    }
    try {
      const outcome = await syncCollection(deps, name, source, state)
      result.outcomes[name] = outcome
      if (outcome === 'pushed' || outcome === 'pulled' || outcome === 'adopted') result.carried++
      // `conflicted` BELONGS HERE, and leaving it out was deterministic data
      // loss rather than a race.
      //
      // Both conflict paths write the remote copy to disk — that is what
      // "the remote wins and the local is kept" means. Not naming the
      // collection meant the renderer was never told, so it went on holding
      // the losing copy in memory and rewrote it over the file on its next
      // save, which fires on a theme change or an opened tab. The following
      // pass then saw a local edit and no remote one, and PUSHED the reverted
      // copy as the account's winner. The other device's work was gone from
      // every screen, surviving only as a conflict copy nobody had been told
      // to look at, and the panel reported success throughout.
      if (outcome === 'pulled' || outcome === 'adopted' || outcome === 'conflicted') {
        changed.push(name)
      }
      if (outcome === 'conflicted') result.conflicts.push(name)
    } catch (err) {
      result.outcomes[name] = 'failed'
      if (!result.error) {
        result.error = {
          collection: name,
          message: err instanceof Error ? err.message : String(err),
          ...(err instanceof AddyError ? { code: err.code } : {})
        }
      }
    }
  }

  /**
   * THE STATE WRITE MUST NOT TAKE THE PASS WITH IT.
   *
   * `saveState` throws by design — it writes temp-then-rename — and it sat
   * outside every try. So a stale temp file or a full disk made the exception
   * escape `syncOnce` entirely: `applied()` never ran, the renderer was never
   * told about a single inbound write, and its next save reverted all of them.
   * The pass after that saw local edits with no remote ones and pushed the
   * reverts as the account's winners. A failure to write a bookkeeping file
   * became account-wide data loss.
   *
   * Reported as the pass's error instead. The consequence of losing the state
   * is bounded and recoverable: the next pass finds collections on disk it has
   * no record of agreeing to, and treats them as conflicts — which is noisy,
   * and is the safe direction.
   */
  try {
    saveState(state)
  } catch (err) {
    if (!result.error) {
      result.error = {
        collection: 'sync state',
        message: err instanceof Error ? err.message : String(err)
      }
    }
  }

  // AFTER the state write is attempted, and after every collection: the
  // renderer reloads once for the whole pass rather than fifteen times, and it
  // reloads from a file that is already consistent.
  if (changed.length > 0) deps.applied(changed)
  return result
}

async function syncCollection(
  deps: SyncDeps,
  name: SyncedCollection,
  source: CollectionSource,
  state: SyncState
): Promise<CollectionOutcome> {
  const epoch = deps.epoch()
  const known = state.collections[name]
  const local = source.read()
  const remote = await deps.relay.getObject(name, epoch)

  // Nothing here and nothing there. Not an error, and not worth a record.
  if (!local && !remote) return 'unchanged'

  // -- This machine has nothing. Take what the account has. -----------------
  if (!local && remote) {
    const opened = await openObject(deps, name, epoch, remote.body, known?.counter ?? 0)
    source.write(opened.payload)
    state.collections[name] = {
      etag: remote.etag,
      counter: opened.counter,
      localHash: hash(opened.payload),
      at: Date.now()
    }
    return 'adopted'
  }

  // -- The account has nothing. Send what this machine has. ------------------
  if (local && !remote) {
    const counter = (known?.counter ?? 0) + 1
    const etag = await putSealed(deps, name, epoch, counter, local)
    state.collections[name] = { etag, counter, localHash: hash(local), at: Date.now() }
    return 'pushed'
  }

  // -- Both sides have a copy. ----------------------------------------------
  const body = local as Buffer
  const there = remote as { body: Buffer; etag: string }

  // A device that has never synced this collection, with data on both sides.
  // It ADOPTS rather than pushes, and that asymmetry is deliberate: this
  // machine's copy has never been part of the account, so overwriting an
  // account's data with it is the one irreversible mistake available here. The
  // local copy is not lost — it is kept as a conflict copy, so the user is
  // offered the choice rather than having it made for them.
  if (!known) {
    const opened = await openObject(deps, name, epoch, there.body, 0)
    if (!opened.payload.equals(body)) {
      await keepAsConflict(deps, name, epoch, opened.counter + 1, body)
      source.write(opened.payload)
      state.collections[name] = {
        etag: there.etag,
        counter: opened.counter,
        localHash: hash(opened.payload),
        at: Date.now()
      }
      return 'conflicted'
    }
    // Identical. Agree with it and record that, so the next pass is cheap.
    state.collections[name] = {
      etag: there.etag,
      counter: opened.counter,
      localHash: hash(body),
      at: Date.now()
    }
    return 'unchanged'
  }

  const localChanged = hash(body) !== known.localHash
  const remoteChanged = there.etag !== known.etag

  if (!localChanged && !remoteChanged) return 'unchanged'

  if (localChanged && !remoteChanged) {
    const counter = known.counter + 1
    try {
      const etag = await putSealed(deps, name, epoch, counter, body, known.etag)
      state.collections[name] = { etag, counter, localHash: hash(body), at: Date.now() }
      return 'pushed'
    } catch (err) {
      // Somebody wrote between the GET above and this PUT. The conditional
      // write is what caught it; the remedy is the same as the both-changed
      // case below, so fall into it rather than losing the edit.
      if (!(err instanceof AddyError) || !/written by another device/.test(err.message)) throw err
      return conflictWithRemote(deps, name, epoch, source, state, body)
    }
  }

  if (!localChanged && remoteChanged) {
    const opened = await openObject(deps, name, epoch, there.body, known.counter)
    source.write(opened.payload)
    state.collections[name] = {
      etag: there.etag,
      counter: opened.counter,
      localHash: hash(opened.payload),
      at: Date.now()
    }
    return 'pulled'
  }

  // Both. LAST WRITER WINS, and the writer that lost keeps its copy.
  return conflictWithRemote(deps, name, epoch, source, state, body)
}

/**
 * The remote copy wins and the local one is kept.
 *
 * WHICH ONE WINS IS LESS IMPORTANT THAN THAT NEITHER IS DESTROYED. The remote
 * is chosen because it is the copy the rest of the account already agrees on,
 * so picking it is the choice that leaves one story rather than two. The local
 * copy goes to the relay as a conflict copy, sealed, and the chooser in the
 * renderer opens both so a person can decide — which is the commonest right
 * answer anyway: "these differ in one entry and I want both".
 */
async function conflictWithRemote(
  deps: SyncDeps,
  name: SyncedCollection,
  epoch: number,
  source: CollectionSource,
  state: SyncState,
  local: Buffer
): Promise<CollectionOutcome> {
  const fresh = await deps.relay.getObject(name, epoch)
  if (!fresh) {
    // It went away between the two reads. Nothing to conflict with.
    const counter = (state.collections[name]?.counter ?? 0) + 1
    const etag = await putSealed(deps, name, epoch, counter, local)
    state.collections[name] = { etag, counter, localHash: hash(local), at: Date.now() }
    return 'pushed'
  }
  const opened = await openObject(deps, name, epoch, fresh.body, 0)
  await keepAsConflict(deps, name, epoch, opened.counter + 1, local)
  source.write(opened.payload)
  state.collections[name] = {
    etag: fresh.etag,
    counter: opened.counter,
    localHash: hash(opened.payload),
    at: Date.now()
  }
  return 'conflicted'
}

async function putSealed(
  deps: SyncDeps,
  name: SyncedCollection,
  epoch: number,
  counter: number,
  payload: Buffer,
  ifMatch?: string
): Promise<string> {
  const sealed = await deps.addyd.send<{ sealed: string }>('seal', {
    collection: name,
    epoch,
    schema: SCHEMA,
    writerVersion: versionString(),
    counter,
    payload: payload.toString('base64')
  })
  return deps.relay.putObject(name, epoch, counter, Buffer.from(sealed.sealed, 'base64'), ifMatch)
}

async function openObject(
  deps: SyncDeps,
  name: SyncedCollection,
  epoch: number,
  sealed: Buffer,
  seenCounter: number
): Promise<{ payload: Buffer; counter: number }> {
  const opened = await deps.addyd.send<{ payload: string; counter: number }>('open', {
    collection: name,
    epoch,
    sealed: sealed.toString('base64'),
    knownSchema: SCHEMA,
    seenCounter
  })
  return { payload: Buffer.from(opened.payload, 'base64'), counter: opened.counter }
}

/** Hands the losing copy to the relay, still sealed, before anything
 *  overwrites it. The only moment those bytes exist anywhere but here. */
async function keepAsConflict(
  deps: SyncDeps,
  name: SyncedCollection,
  epoch: number,
  counter: number,
  payload: Buffer
): Promise<void> {
  const sealed = await deps.addyd.send<{ sealed: string }>('seal', {
    collection: name,
    epoch,
    schema: SCHEMA,
    writerVersion: versionString(),
    counter,
    payload: payload.toString('base64')
  })
  await deps.relay.keepConflict(name, epoch, counter, Buffer.from(sealed.sealed, 'base64'))
}

/** Forget everything this device has agreed to. For a revocation wipe and for
 *  a deliberate "resync everything". */
export function forgetSyncState(): void {
  saveState({ version: 1, collections: {} })
}
