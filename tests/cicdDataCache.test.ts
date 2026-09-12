import { describe, it, expect, beforeEach } from 'vitest'

import {
  refreshMcpDataCache,
  listCachedCicdConnections,
  getCachedCicdConnection
} from '../src/main/services/mcpDataCache'

/**
 * What the bridge is allowed to know about a CI/CD connection.
 *
 * Two separate properties are pinned here, and the second is the one that
 * fails silently:
 *
 *  1. The cache is scoped and shaped like every other cached subject.
 *  2. The key it reads is the key the renderer writes. `persist.ts` saves the
 *     slice as `cicdConnections`; this file parses `raw.cicdConnections`. A
 *     rename on either side does not throw — it yields an empty list, and
 *     every CI tool then reports that the user has no connections at all.
 */

/** A blob shaped like what `persist.ts` actually writes. */
const saved = {
  workspaces: [{ id: 'ws-1', name: 'Production' }],
  cicdConnections: [
    {
      id: 'ci-1',
      workspaceId: 'ws-1',
      name: 'Platform Jenkins',
      provider: 'jenkins',
      baseUrl: 'https://ci.internal/jenkins',
      username: 'svc-opsmaxx',
      vaultEntryId: 'vault-abc',
      route: { kind: 'server', serverId: 's1' },
      enabled: true
    },
    {
      id: 'ci-2',
      workspaceId: 'ws-2',
      name: 'Other Workspace GitLab',
      provider: 'gitlab',
      baseUrl: 'https://gitlab.example.com',
      vaultEntryId: 'vault-def',
      route: { kind: 'direct' },
      enabled: true
    }
  ]
}

describe('the CI/CD connections the MCP bridge can see', () => {
  beforeEach(() => {
    refreshMcpDataCache(saved)
  })

  it('reads the same key the renderer writes', () => {
    // The whole point of this file. If this is empty, the two sides have
    // drifted and every CI tool says "you have no connections" rather than
    // failing in a way anyone would notice.
    expect(listCachedCicdConnections()).toHaveLength(2)
    expect(getCachedCicdConnection('ci-1')?.name).toBe('Platform Jenkins')
  })

  it('scopes to the granted workspace, like every other cached subject', () => {
    const scoped = listCachedCicdConnections('ws-1')
    expect(scoped.map((c) => c.id)).toEqual(['ci-1'])
  })

  it('never carries the base URL or the vault reference', () => {
    // CachedVpn's rule, applied to a second subject: a field that does not
    // exist cannot leak into a tool response by someone adding one more line
    // to a template string. The bridge addresses a connection by the name the
    // user gave it and never learns where it points or what unlocks it.
    const c = getCachedCicdConnection('ci-1') as Record<string, unknown> | null
    expect(c).not.toBeNull()
    expect(c).not.toHaveProperty('baseUrl')
    expect(c).not.toHaveProperty('vaultEntryId')
    expect(c).not.toHaveProperty('username')
    expect(c).not.toHaveProperty('caPem')
    expect(c).not.toHaveProperty('route')
    expect(Object.keys(c as object).sort()).toEqual([
      'enabled',
      'id',
      'name',
      'provider',
      'workspaceId'
    ])
  })

  it('drops a record whose provider is not one of the three', () => {
    // Written by a newer version of the app. Defaulting it would hand an
    // arbitrary string to an adapter lookup that has exactly three branches;
    // the renderer keeps such a record and disables it, and the bridge — which
    // can only act through an adapter — does not see it at all.
    refreshMcpDataCache({
      cicdConnections: [
        { id: 'x', workspaceId: 'ws-1', name: 'Future CI', provider: 'buildkite' }
      ]
    })
    expect(listCachedCicdConnections()).toEqual([])
  })

  it('survives a blob with no CI key at all', () => {
    // Every install that predates this module.
    refreshMcpDataCache({ workspaces: [] })
    expect(listCachedCicdConnections()).toEqual([])
    expect(getCachedCicdConnection('ci-1')).toBeNull()
  })

  it('ignores a record missing the fields that identify it', () => {
    refreshMcpDataCache({
      cicdConnections: [
        { workspaceId: 'ws-1', provider: 'github', name: 'no id' },
        { id: 'no-ws', provider: 'github', name: 'no workspace' }
      ]
    })
    expect(listCachedCicdConnections()).toEqual([])
  })
})
