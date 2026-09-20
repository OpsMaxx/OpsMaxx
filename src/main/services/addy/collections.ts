import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { atomicWriteFileSync } from '../atomicWrite'
import { loadData, saveData } from '../store'
import { SYNCED_COLLECTIONS, type SyncedCollection } from '../../../shared/addy'

/**
 * Where each synced collection actually lives on this machine.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A REGISTRY AND NOT A SWITCH STATEMENT
 * ---------------------------------------------------------------------------
 *
 * `SYNCED_COLLECTIONS` is the protocol's list and `internal/protocol/
 * collections.go` is its other half. Neither says where the bytes come from,
 * and the natural way to write the engine — a `switch` with a `default: break`
 * — makes a collection nobody wired indistinguishable from one deliberately
 * left out. That is the same defect `NOT_SYNCED` exists to prevent on the
 * other side of the line, and it is worse here: a missing case means a
 * collection that silently never syncs, with no error, until somebody notices
 * their databases never reached the second laptop.
 *
 * So every name in `SYNCED_COLLECTIONS` must appear either in `SOURCES` or in
 * `PENDING` with a reason, and `tests/addyCollections.test.ts` fails the build
 * otherwise.
 *
 * ---------------------------------------------------------------------------
 * BYTES, NOT OBJECTS
 * ---------------------------------------------------------------------------
 *
 * A source reads and writes a `Buffer`, and the engine seals whatever it is
 * handed without looking inside. That is what lets `vault` travel at all: it
 * is `opsmaxx-vault.json` verbatim, already ciphertext under the user's master
 * password, and nothing in the sync path may open it. Treating one collection
 * as bytes and the rest as JSON would have meant a second code path for the
 * one collection where a mistake is unrecoverable.
 */

export interface CollectionSource {
  /** The local bytes, or `null` when this machine has nothing to send.
   *
   *  `null` is not an empty value: an empty `servers` array is a real state a
   *  user can reach by deleting their last server, and pushing it is correct.
   *  `null` means the key or file is absent, which is "this machine has never
   *  had one" — and pushing THAT over another device's data is the mistake. */
  read(): Buffer | null
  /** Apply an inbound copy. Throws rather than half-writing. */
  write(body: Buffer): void
  /** True when applying this needs the renderer told, because the renderer
   *  holds the same data in memory and will otherwise write its stale copy
   *  back over the top on its next save. */
  readonly inRendererStore?: boolean
}

const userFile = (name: string): string => join(app.getPath('userData'), name)

/**
 * One key inside `opsmaxx-data.json`.
 *
 * Eleven of the sixteen collections live in that one blob, which the RENDERER
 * owns: it holds the whole thing in a zustand store and writes all of it on
 * every change. So applying an inbound copy has two halves, and the second is
 * not optional — see `inRendererStore`. Writing the file alone would be undone
 * by the renderer's next keystroke.
 */
function blobKey(key: string): CollectionSource {
  return {
    inRendererStore: true,
    read(): Buffer | null {
      const data = loadData() as Record<string, unknown> | null
      if (!data || !(key in data)) return null
      return Buffer.from(JSON.stringify(data[key]), 'utf8')
    },
    write(body: Buffer): void {
      const data = (loadData() as Record<string, unknown> | null) ?? {}
      // Parsed here rather than spliced as text: a body that is not JSON is a
      // corrupt object, and finding that out now is better than writing it
      // into the file every panel reads.
      data[key] = JSON.parse(body.toString('utf8'))
      saveData(data)
    }
  }
}

/** A whole file in userData, carried verbatim. */
function wholeFile(name: string): CollectionSource {
  return {
    read(): Buffer | null {
      const path = userFile(name)
      return existsSync(path) ? readFileSync(path) : null
    },
    write(body: Buffer): void {
      // Temp-then-rename, like every other writer of these files. A truncated
      // vault is the worst outcome available here.
      //
      // Through a string because that is what the shared writer takes, which
      // is exact for these three: all of them are JSON text, and a UTF-8 round
      // trip of UTF-8 is the same bytes. It would NOT be exact for arbitrary
      // binary, so a future binary collection needs a buffer-taking writer
      // rather than this function with its eyes shut.
      atomicWriteFileSync(userFile(name), body.toString('utf8'))
    }
  }
}

export const SOURCES: Partial<Record<SyncedCollection, CollectionSource>> = {
  apiCollections: blobKey('apiCollections'),
  apiWorkspace: blobKey('apiWorkspace'),
  cicdConnections: blobKey('cicdConnections'),
  databases: blobKey('databases'),
  folders: blobKey('folders'),
  httpChecks: blobKey('httpChecks'),
  monitorGroups: blobKey('monitorGroups'),
  servers: blobKey('servers'),
  tunnels: blobKey('tunnels'),
  vpns: blobKey('vpns'),
  workspaces: blobKey('workspaces'),

  // Opaque. Already ciphertext under the master password, and the recovery
  // phrase is not a skeleton key for it — two secrets, each doing the job it
  // was designed for. Nothing in this path opens it.
  vault: wholeFile('opsmaxx-vault.json'),
  // Hostnames and their key fingerprints. Syncing it is what stops a second
  // machine asking about every host in the estate as though it were new,
  // which is the prompt people learn to click through.
  knownHosts: wholeFile('opsmaxx-known-hosts.json'),
  // WHICH environment variables were registered as secret-bearing and what
  // they point at — not the values, which are in the keychain and machine
  // bound. The pointers are what a second machine needs.
  env: wholeFile('opsmaxx-env-secrets.json')
}

/**
 * Named in the protocol, not carried yet, each with the reason.
 *
 * A REASON IS MANDATORY here for the same argument `NOT_SYNCED` makes: "we did
 * not get to it" and "this cannot be carried yet" look identical in a list of
 * names, and only one of them is a decision.
 */
export const PENDING: Partial<Record<SyncedCollection, string>> = {
  // There is no local store to read. The provisioning manifest is M6 work and
  // its format was deliberately designed early so this needs no protocol
  // change when it arrives — see docs/plans/addy.md. Wiring a source now would
  // mean inventing the file it reads.
  manifest:
    'hot-device provisioning has no local store yet; the collection name is reserved so M6 needs no protocol change',
  // Addy's own: what the user CALLS each device, keyed on pub_sign. Nothing
  // writes it because nothing can rename a device yet. The collection exists
  // because the roster label is a birth name and entries are immutable, so the
  // rename has to live somewhere that a rotation re-seals.
  deviceNames:
    'no rename affordance exists yet, so there is nothing local to carry; the roster label stands in until there is'
}

/** Every name accounted for, or the build fails. Exported for the test. */
export function unaccountedCollections(): string[] {
  return SYNCED_COLLECTIONS.filter((c) => !(c in SOURCES) && !(c in PENDING))
}
