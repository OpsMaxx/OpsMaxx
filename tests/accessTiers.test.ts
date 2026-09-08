import { describe, it, expect } from 'vitest'

import { migrateGroupsForTests } from '../src/main/services/policyStore'
import { AI_CAPABILITIES } from '../src/shared/mcp'
import type { AccessGroup, PolicyState } from '../src/shared/mcp'

// "Read Only" used to be the name of a group that left `terminal` at 'allow'.
// It is the first card and the one a cautious user picks BECAUSE of the name,
// so the most conservative-sounding tier in the product was the one granting an
// autonomous agent unattended arbitrary shell on production.
//
// The fix is two moves that must not be confused with each other: a new group
// that genuinely is read-only takes the name, and the old group keeps every
// permission it had and gets a name that admits what it does.

// Reaching the seed through the migration, which is a no-op on a fresh state.
const groups = (): AccessGroup[] =>
  migrateGroupsForTests({
    version: 1,
    groups: [],
    assignments: [],
    serverMeta: [],
    filePolicyGeneration: 0
  } as unknown as PolicyState).groups

const byId = (id: string): AccessGroup => {
  const g = groups().find((x) => x.id === id)
  if (!g) throw new Error(`no group ${id}`)
  return g
}

describe('the tier named Read Only is read only', () => {
  it('refuses to run commands', () => {
    expect(byId('grp-observer').capabilities.terminal).toBe('deny')
  })

  // A query is `DROP TABLE` as readily as it is `SELECT`, so the capability
  // that "runs queries" is a write capability wearing a read name.
  it('refuses database access, which is query execution', () => {
    expect(byId('grp-observer').capabilities.databaseAccess).toBe('deny')
  })

  // The load-bearing assertion. Anything that can change the host is denied,
  // and it is written as "every capability not on the allow list" rather than
  // as a list of denials, so a capability added later fails this test until
  // somebody decides which side of the line it is on.
  it('allows nothing beyond looking', () => {
    const READS: string[] = ['viewServer', 'readFiles', 'sftpDownload', 'serverMetrics']
    const caps = byId('grp-observer').capabilities
    for (const { id } of AI_CAPABILITIES) {
      if (READS.includes(id)) continue
      expect(caps[id], `${id} must be denied on a read-only tier`).toBe('deny')
    }
  })

  // 'ask' would be the wrong shape here, not merely a weaker one: the point of
  // this tier is that it can be handed out and then not thought about.
  it('never uses ask, so nothing about it is left to a prompt', () => {
    expect(Object.values(byId('grp-observer').capabilities)).not.toContain('ask')
  })

  it('is first, because the first card is the one a cautious user picks', () => {
    expect(groups()[0].id).toBe('grp-observer')
  })
})

describe('the renamed group keeps every permission it had', () => {
  // The rename must not move anybody's grants. An agent that could run commands
  // yesterday can still run them today — the name changed, the policy did not.
  it('still runs commands, and now says so in its name', () => {
    const g = byId('grp-read-only')
    expect(g.capabilities.terminal).toBe('allow')
    expect(g.name).toBe('Commands, no writes')
    expect(g.name).not.toBe('Read Only')
  })

  it('still denies exactly what it denied before', () => {
    const c = byId('grp-read-only').capabilities
    expect(c.writeFiles).toBe('deny')
    expect(c.sftpUpload).toBe('deny')
    expect(c.sshTunnel).toBe('deny')
    expect(c.sudo).toBe('deny')
  })

  it('keeps its id, so existing assignments still resolve', () => {
    expect(groups().some((g) => g.id === 'grp-read-only')).toBe(true)
  })
})

describe('no two tiers can be confused for one another', () => {
  it('gives Read Only to exactly one group', () => {
    expect(groups().filter((g) => g.name === 'Read Only')).toHaveLength(1)
  })

  it('has no duplicate names or ids', () => {
    const g = groups()
    expect(new Set(g.map((x) => x.name)).size).toBe(g.length)
    expect(new Set(g.map((x) => x.id)).size).toBe(g.length)
  })
})

describe('upgrading an existing install', () => {
  const existing = (over: Partial<AccessGroup> = {}): PolicyState =>
    ({
      version: 1,
      groups: [
        {
          id: 'grp-read-only',
          name: 'Read Only',
          builtIn: true,
          capabilities: { terminal: 'allow', writeFiles: 'deny' },
          filePolicies: [],
          ...over
        } as unknown as AccessGroup
      ],
      assignments: [{ id: 'asn-1', scope: { kind: 'global' }, groupId: 'grp-read-only' }],
      serverMeta: [],
      filePolicyGeneration: 0
    }) as unknown as PolicyState

  it('renames the stale group without touching a single capability', () => {
    const before = { ...existing().groups[0].capabilities }
    const after = migrateGroupsForTests(existing()).groups.find((g) => g.id === 'grp-read-only')!
    expect(after.name).toBe('Commands, no writes')
    expect(after.capabilities).toEqual(before)
  })

  it('leaves the assignment pointing at the same group', () => {
    const s = migrateGroupsForTests(existing())
    expect(s.assignments[0].groupId).toBe('grp-read-only')
  })

  it('introduces the new read-only tier that the install has never seen', () => {
    const s = migrateGroupsForTests(existing())
    const obs = s.groups.find((g) => g.id === 'grp-observer')
    expect(obs).toBeDefined()
    expect(obs!.capabilities.terminal).toBe('deny')
  })

  // Adding a group grants nobody anything — nothing is assigned to it. That is
  // what makes this migration safe to run unconditionally, unlike a capability
  // backfill.
  it('adds no assignment, so no agent gains or loses access', () => {
    expect(migrateGroupsForTests(existing()).assignments).toHaveLength(1)
  })

  // A user who renamed the group themselves has intent on record, and it
  // outranks anything the migration wants — the same rule file-policy `retire`
  // follows.
  it('leaves a user-renamed group alone', () => {
    const s = migrateGroupsForTests(existing({ name: 'Our auditors' }))
    expect(s.groups.find((g) => g.id === 'grp-read-only')!.name).toBe('Our auditors')
  })

  it('does not rename a custom group that happens to be called Read Only', () => {
    const st = existing()
    st.groups[0] = { ...st.groups[0], builtIn: false }
    expect(migrateGroupsForTests(st).groups.find((g) => g.id === 'grp-read-only')!.name).toBe(
      'Read Only'
    )
  })

  it('is idempotent — running it twice changes nothing further', () => {
    const once = migrateGroupsForTests(existing())
    const twice = migrateGroupsForTests(JSON.parse(JSON.stringify(once)) as PolicyState)
    expect(twice.groups.map((g) => `${g.id}:${g.name}`)).toEqual(
      once.groups.map((g) => `${g.id}:${g.name}`)
    )
  })

  // The invariant, independent of how the migration is ordered internally: a
  // user choosing a tier must never be shown two cards with the same name and
  // different powers. (Swapping the two halves of backfillGroups does not break
  // this — the rename is scoped by id — but the guarantee is what matters here,
  // not the implementation that currently provides it.)
  it('never leaves two groups sharing the Read Only name', () => {
    const s = migrateGroupsForTests(existing())
    expect(s.groups.filter((g) => g.name === 'Read Only')).toHaveLength(1)
  })
})
