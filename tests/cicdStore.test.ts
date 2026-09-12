// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { stubBridge } from './setup/renderer'
import { useApp } from '../src/renderer/src/store/app'
import { hasBackupContent } from '../src/shared/backupContent'
import type { CicdConnection } from '../src/shared/cicd'

/**
 * A CI/CD connection in the renderer store.
 *
 * Two things make this slice unlike `httpChecks`, which it otherwise copies:
 *
 *  1. It POINTS AT THE VAULT. `vaultEntryId` is the only reference to a stored
 *     token, so a connection that leaves the store without releasing it leaves
 *     an entry nothing can ever reach again. Both delete paths have to do it —
 *     the workspace cascade never passes through `deleteCicdConnection`.
 *  2. It REACHES DISK. The array is written into `opsmaxx-data.json`, which
 *     SECURITY.md:40 documents as plaintext containing no credentials.
 */

const WS = 'ws-1'
const OTHER = 'ws-2'

const conn = (over: Partial<CicdConnection> = {}): CicdConnection => ({
  id: 'ci-1',
  workspaceId: WS,
  name: 'Build',
  provider: 'github',
  baseUrl: 'https://github.com',
  vaultEntryId: 'vault-1',
  route: { kind: 'direct' },
  // Normalised to a present `false` on the way in, the way apiCollections does
  // it, so "false means verify" is the only representation a view ever reads.
  insecureTls: false,
  enabled: true,
  ...over
})

// The bridge method the store releases a vault entry through. Recorded rather
// than stubbed with a no-op: "it released it" is the assertion.
let released: string[] = []

beforeEach(() => {
  released = []
  stubBridge({ cicd: { deleteSecrets: async (id: string) => void released.push(id) } })
  useApp.setState({
    workspaces: [
      { id: WS, name: 'Personal', color: 'cyan', hidden: false, locked: false, hasPassword: false },
      { id: OTHER, name: 'Work', color: 'cyan', hidden: false, locked: false, hasPassword: false }
    ],
    activeWorkspaceId: WS,
    cicdConnections: []
  } as never)
})

describe('a connection belongs to a workspace', () => {
  it('goes when the workspace goes', () => {
    useApp.getState().setCicdConnections([conn(), conn({ id: 'ci-2', workspaceId: OTHER })])
    useApp.getState().deleteWorkspace(WS)
    expect(useApp.getState().cicdConnections.map((c) => c.id)).toEqual(['ci-2'])
  })

  it('survives the deletion of a workspace that is not its own', () => {
    useApp.getState().setCicdConnections([conn()])
    useApp.getState().deleteWorkspace(OTHER)
    expect(useApp.getState().cicdConnections.map((c) => c.id)).toEqual(['ci-1'])
  })
})

describe('the vault entry goes with the connection', () => {
  it('is released when the connection is deleted', () => {
    useApp.getState().setCicdConnections([conn()])
    useApp.getState().deleteCicdConnection('ci-1')
    expect(useApp.getState().cicdConnections).toEqual([])
    expect(released).toEqual(['vault-1'])
  })

  it('is released for every connection the workspace took with it', () => {
    // The cascade never passes through deleteCicdConnection, so this is a
    // second implementation of the same rule and a second chance to forget it.
    useApp.getState().setCicdConnections([
      conn(),
      conn({ id: 'ci-2', vaultEntryId: 'vault-2' }),
      conn({ id: 'ci-3', workspaceId: OTHER, vaultEntryId: 'vault-3' })
    ])
    useApp.getState().deleteWorkspace(WS)
    expect(released.sort()).toEqual(['vault-1', 'vault-2'])
  })

  it('is released when a bulk set drops the row', () => {
    // A shortened list IS a delete. The only difference from the call above is
    // that the caller happened to hold a list rather than an id.
    useApp.getState().setCicdConnections([conn(), conn({ id: 'ci-2', vaultEntryId: 'vault-2' })])
    useApp.getState().setCicdConnections([conn()])
    expect(released).toEqual(['vault-2'])
  })

  it('releases nothing for an id that is not there', () => {
    useApp.getState().setCicdConnections([conn()])
    useApp.getState().deleteCicdConnection('never-existed')
    expect(released).toEqual([])
    expect(useApp.getState().cicdConnections).toHaveLength(1)
  })

  it('does not throw when the preload bridge has no cicd namespace yet', () => {
    // The renderer half of this module lands before the preload half, and
    // under `electron-vite dev` the renderer reloads ahead of it every session.
    stubBridge({})
    useApp.getState().setCicdConnections([conn()])
    expect(() => useApp.getState().deleteCicdConnection('ci-1')).not.toThrow()
    expect(useApp.getState().cicdConnections).toEqual([])
  })
})

describe('restoring a save', () => {
  const base = { workspaces: [{ id: WS, name: 'Personal' }], settings: {} }

  it('round-trips the slice', () => {
    useApp.getState().replaceAll({ ...base, cicdConnections: [conn()] } as never)
    expect(useApp.getState().cicdConnections).toEqual([conn()])
  })

  it('leaves the slice alone when a save predates the module', () => {
    // No key at all is not the same as an empty list.
    useApp.setState({ cicdConnections: [conn()] } as never)
    useApp.getState().replaceAll(base as never)
    expect(useApp.getState().cicdConnections).toHaveLength(1)
  })

  it('keeps a connection with an unknown provider, switched off', () => {
    // Written by a NEWER version, or hand-edited. Dropping it destroys a record
    // the user made and hides the downgrade; trusting it hands an unknown
    // string to an adapter lookup with three branches. It stays visible and
    // never dials — and comes back to life when the newer version does.
    useApp
      .getState()
      .replaceAll({ ...base, cicdConnections: [conn({ provider: 'teamcity' as never })] } as never)
    const [restored] = useApp.getState().cicdConnections
    expect(restored).toBeDefined()
    expect(restored.provider).toBe('teamcity')
    expect(restored.enabled).toBe(false)
  })

  it('leaves the three known providers enabled', () => {
    // Pins the runtime provider list in app.ts against CicdProvider, which
    // erases at compile time and so cannot check itself.
    const providers: CicdConnection['provider'][] = ['jenkins', 'gitlab', 'github']
    useApp.getState().replaceAll({
      ...base,
      cicdConnections: providers.map((provider, i) => conn({ id: `ci-${i}`, provider }))
    } as never)
    expect(useApp.getState().cicdConnections.map((c) => c.enabled)).toEqual([true, true, true])
  })

  it('defaults a route that a save written before routes existed does not have', () => {
    useApp
      .getState()
      .replaceAll({ ...base, cicdConnections: [{ ...conn(), route: undefined }] } as never)
    expect(useApp.getState().cicdConnections[0].route).toEqual({ kind: 'direct' })
  })
})

describe('no credential reaches the saved blob', () => {
  // SECURITY.md:40 documents opsmaxx-data.json as plaintext containing no
  // credentials, and this array is written into it verbatim. `vaultEntryId` is
  // a pointer; anything token-shaped is stripped at the door rather than
  // trusted never to have been set.
  const withToken = { ...conn(), token: 'ghp_realLookingSecret', password: 'hunter2' }

  it('strips it on the way in', () => {
    useApp.getState().setCicdConnections([withToken as never])
    expect(JSON.stringify(useApp.getState().cicdConnections)).not.toMatch(/ghp_|hunter2/)
  })

  it('strips it on restore too', () => {
    useApp.getState().replaceAll({
      workspaces: [{ id: WS, name: 'Personal' }],
      settings: {},
      cicdConnections: [withToken]
    } as never)
    expect(useApp.getState().cicdConnections[0]).toEqual(conn())
  })
})

describe('persistence', () => {
  it('saves the slice and marks the backup stale', async () => {
    const save = vi.fn(async (_blob: { cicdConnections: CicdConnection[] }) => undefined)
    stubBridge({
      data: { load: async () => null, save },
      cicd: { deleteSecrets: async () => undefined },
      workspaceLock: { ids: async () => [] },
      vault: { setAutoLock: async () => undefined },
      ssh: { setPoolIdle: async () => undefined },
      jobs: { setDetached: async () => undefined }
    })
    const { initPersistence } = await import('../src/renderer/src/store/persist')
    await initPersistence()
    save.mockClear()

    useApp.getState().setCicdConnections([conn()])

    // backupRelevantChanged: stored data that does not mark the last backup
    // stale is a silent data-loss path — the user restores a backup the status
    // bar called current and their connections are not in it.
    expect(useApp.getState().settings.backupDirty).toBe(true)

    // dataChanged: the save is debounced 400ms behind the change.
    await vi.waitFor(() => expect(save).toHaveBeenCalled(), { timeout: 2000 })
    expect(save.mock.calls.at(-1)?.[0].cicdConnections).toEqual([conn()])
  })

  it('counts as something to back up on its own', () => {
    // Otherwise a user whose only data is CI connections is told there is
    // nothing to back up — which is what stops `backupDirty` above being set.
    expect(
      hasBackupContent({
        workspaces: [{}],
        folders: [],
        servers: [],
        databases: [],
        tunnels: [],
        vpns: [],
        cicdConnections: [conn()]
      })
    ).toBe(true)
  })
})

describe('saving one connection does not delete the others', () => {
  // The panel renders the ACTIVE workspace's slice. An earlier version saved by
  // handing that slice to `setCicdConnections`, which treats a bulk set as
  // authoritative — so adding a connection in workspace B told the store that
  // workspace A's connections had been deleted, and released their vault
  // entries on the way out. Irreversible, and silent.
  it('leaves another workspace untouched when one is added', () => {
    const a = conn({ id: 'a1', workspaceId: 'ws-a', vaultEntryId: 'vault-a' })
    const b = conn({ id: 'b1', workspaceId: 'ws-b', vaultEntryId: 'vault-b' })
    useApp.setState({ cicdConnections: [a, b] })

    // Exactly what the panel holds: one workspace's rows.
    const slice = useApp.getState().cicdConnections.filter((c) => c.workspaceId === 'ws-b')
    expect(slice).toHaveLength(1)

    useApp.getState().upsertCicdConnection(conn({ id: 'b2', workspaceId: 'ws-b' }))

    const ids = useApp.getState().cicdConnections.map((c) => c.id).sort()
    expect(ids).toEqual(['a1', 'b1', 'b2'])
  })

  it('replaces in place when the id already exists', () => {
    useApp.setState({ cicdConnections: [conn({ id: 'a1', name: 'Old' })] })
    useApp.getState().upsertCicdConnection(conn({ id: 'a1', name: 'New' }))
    const all = useApp.getState().cicdConnections
    expect(all).toHaveLength(1)
    expect(all[0].name).toBe('New')
  })

  it('normalises on the way in, like every other entry path', () => {
    useApp.setState({ cicdConnections: [] })
    useApp
      .getState()
      .upsertCicdConnection({ ...conn({ id: 'x' }), provider: 'buildkite' } as never)
    expect(useApp.getState().cicdConnections[0].enabled).toBe(false)
  })
})
