import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SYNCED_COLLECTIONS, NOT_SYNCED } from '../src/shared/addy'

/**
 * Every collection the protocol names is either carried or explicitly not.
 *
 * `SYNCED_COLLECTIONS` is the protocol's list; `internal/protocol/
 * collections.go` in the addy repo is its other half. Neither says where the
 * bytes live on this machine, and the obvious way to write the engine — a
 * `switch` with a silent `default` — makes "nobody wired this" look exactly
 * like "deliberately left out".
 *
 * That is the same defect `NOT_SYNCED` exists to prevent across the trust
 * boundary, and here it is worse: a missing source is a collection that never
 * syncs, with no error and no symptom, until somebody notices their databases
 * never reached the second laptop. So the registry must account for every
 * name, and a reason is mandatory for the ones it does not carry.
 */

vi.mock('electron', () => ({
  app: { getPath: () => mkdtempSync(join(tmpdir(), 'opsmaxx-addy-cols-')), getVersion: () => '0' }
}))

const { SOURCES, PENDING, unaccountedCollections } = await import(
  '../src/main/services/addy/collections'
)

describe('the collection registry', () => {
  it('accounts for every name in the protocol list', () => {
    // The whole point of the file. A name that is in neither map is a silent
    // no-op, which is the one outcome nobody can debug from the outside.
    expect(unaccountedCollections()).toEqual([])
  })

  it('never puts a name in both', () => {
    // "Carried" and "cannot be carried yet" are contradictory claims, and the
    // engine would believe the first while the reason went on explaining the
    // second to anyone reading.
    const both = SYNCED_COLLECTIONS.filter((c) => c in SOURCES && c in PENDING)
    expect(both).toEqual([])
  })

  it('makes every pending entry say why, in a sentence', () => {
    // A bare `true` would read as "we did not get to it" and as "this cannot
    // work yet" equally well, and only one of those is a decision.
    for (const [name, reason] of Object.entries(PENDING)) {
      expect(reason, `${name} is pending with no reason`).toBeTruthy()
      expect(reason!.length, `${name}'s reason is too short to be one`).toBeGreaterThan(20)
    }
  })

  it('carries nothing the trust boundary says is device-local', () => {
    // The two lists are supposed to be disjoint by construction; this is the
    // check that they stayed that way after an edit to either.
    for (const name of Object.keys(SOURCES)) {
      expect(NOT_SYNCED, `${name} is wired for sync AND classified device-local`).not.toHaveProperty(
        name
      )
    }
  })

  it('reads absent as absent, not as empty', () => {
    // THE DISTINCTION THE ENGINE IS BUILT ON. A machine with no
    // `opsmaxx-data.json` has never had a `servers` list; a machine whose list
    // is `[]` has deleted its last server. The first must never be pushed over
    // another device's data, and the second must be. Both would be a Buffer if
    // this returned `Buffer.from('[]')` for a missing key.
    expect(SOURCES.servers!.read()).toBeNull()
    expect(SOURCES.vault!.read()).toBeNull()
  })

  it('knows which collections the renderer also holds in memory', () => {
    // The ones inside `opsmaxx-data.json`. Writing the file without telling
    // the renderer means the next keystroke in that window overwrites the
    // inbound copy — a sync that looks like it silently did nothing.
    expect(SOURCES.servers!.inRendererStore).toBe(true)
    // And the ones that are not. This flag is about the RENDERER only, and
    // reading it as "so nothing holds these in memory" is what let a pulled
    // vault sit on disk unseen for a whole session: `services/vault.ts` reads
    // its file once, at unlock, and `envSecretRegistry` caches its own. Both
    // are told separately, from the `onApplied` handler in main — see
    // `vaultExternalChange` and `envSecretsExternalChange`. `knownHosts` is
    // the only one of the three that really does re-read every call.
    expect(SOURCES.vault!.inRendererStore).toBeFalsy()
    expect(SOURCES.knownHosts!.inRendererStore).toBeFalsy()
  })
})
