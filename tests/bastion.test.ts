import { describe, it, expect } from 'vitest'

import {
  bastionKeyFindings,
  behindBastion,
  noBastionNote,
  revokeBlockFor
} from '../src/shared/bastion'
import { buildTopology, type TopologyServer } from '../src/shared/topology'

// Item 46's bastion-as-an-access-object. The same graph `topology.ts` uses for
// the reboot refusal, asked the access question instead: what does a key on
// this machine reach, and what goes dark if it is revoked.
//
// The transitive step is the feature. `dependentsOf` is one hop deep, so a
// bastion in front of a bastion looks like it guards two machines when it
// guards five, and an operator revoking a key there is told about the two.

function srv(id: string, name: string, via: (string | null)[] = []): TopologyServer {
  return {
    id,
    name,
    route: via.map((v, i) =>
      v === null
        ? { host: `bastion-${i}.example.internal`, port: 22, username: 'ops' }
        : { serverId: v, host: `${v}.example.internal`, port: 22, username: 'ops' }
    )
  }
}

/** edge -> mid -> app, and a second machine directly behind edge. */
const chain = (): ReturnType<typeof buildTopology> =>
  buildTopology([
    srv('edge', 'edge-1'),
    srv('mid', 'mid-1', ['edge']),
    srv('app', 'app-1', ['mid']),
    srv('web', 'web-1', ['edge'])
  ])

describe('what is behind a bastion', () => {
  it('walks past the first hop', () => {
    // `dependentsOf` alone would say two. There are three.
    const behind = behindBastion(chain(), 'edge')
    expect(behind.map((b) => b.name).sort()).toEqual(['app-1', 'mid-1', 'web-1'])
  })

  it('records how far behind each one is', () => {
    const byName = new Map(behindBastion(chain(), 'edge').map((b) => [b.name, b.depth]))
    expect(byName.get('mid-1')).toBe(1)
    expect(byName.get('web-1')).toBe(1)
    expect(byName.get('app-1')).toBe(2)
  })

  it('finds nothing behind a leaf', () => {
    expect(behindBastion(chain(), 'app')).toEqual([])
  })

  it('does not count the bastion itself', () => {
    expect(behindBastion(chain(), 'edge').some((b) => b.id === 'edge')).toBe(false)
  })

  it('is bounded twice, so a bug in the loop guard is a wrong answer not a hang', () => {
    // Deliberately redundant guards. A hang reads as broken infrastructure
    // rather than as a defect, which is the most expensive way for this to
    // fail, so the depth ceiling exists to turn that into a bad answer.
    const loop = buildTopology([srv('a', 'a-1', ['b']), srv('b', 'b-1', ['a'])])
    expect(behindBastion(loop, 'a').length).toBeLessThanOrEqual(loop.servers.size)
  })

  it('terminates on a route loop rather than walking it forever', () => {
    // A through B through A is a configuration mistake somebody made. It must
    // not become an infinite walk here.
    const loop = buildTopology([srv('a', 'a-1', ['b']), srv('b', 'b-1', ['a'])])
    expect(behindBastion(loop, 'a').map((x) => x.name)).toEqual(['b-1'])
  })
})

describe('an address match stays the weaker claim', () => {
  // `topology.ts` keeps a hop matched by `host:port` apart from one that names
  // a saved server precisely so a refusal does not assert a route entry that
  // does not exist. Flattening them one layer up would undo that.
  const byAddress = (): ReturnType<typeof buildTopology> =>
    buildTopology([
      { id: 'edge', name: 'edge-1', host: 'edge.example.internal', port: 22, route: [] },
      {
        id: 'web',
        name: 'web-1',
        host: 'web.example.internal',
        port: 22,
        route: [{ host: 'edge.example.internal', port: 22, username: 'ops' }]
      }
    ] as TopologyServer[])

  it('marks it as an address match', () => {
    expect(behindBastion(byAddress(), 'edge')[0]).toMatchObject({
      name: 'web-1',
      matchedBy: 'address'
    })
  })

  it('says so in the sentence rather than claiming a saved route', () => {
    const block = revokeBlockFor(byAddress(), 'edge')!
    expect(block.reason).toContain('not because anything names this server')
    expect(block.reason).toContain('edge.example.internal:22')
  })

  it('carries the first link’s weakness all the way down a chain', () => {
    // What ties a deep host to the bastion is the WHOLE path, and a path is
    // exactly as strong as its weakest claim about the bastion itself.
    const deep = buildTopology([
      { id: 'edge', name: 'edge-1', host: 'edge.example.internal', port: 22, route: [] },
      {
        id: 'mid',
        name: 'mid-1',
        host: 'mid.example.internal',
        port: 22,
        route: [{ host: 'edge.example.internal', port: 22, username: 'ops' }]
      },
      {
        id: 'app',
        name: 'app-1',
        host: 'app.example.internal',
        port: 22,
        route: [{ serverId: 'mid', host: 'mid.example.internal', port: 22, username: 'ops' }]
      }
    ] as TopologyServer[])
    const app = behindBastion(deep, 'edge').find((b) => b.name === 'app-1')!
    expect(app.matchedBy).toBe('address')
  })

  it('does not caveat a chain whose links all name saved servers', () => {
    expect(revokeBlockFor(chain(), 'edge')!.reason).not.toContain('not because anything names')
  })
})

describe('a key on a bastion is a key to what is behind it', () => {
  const keys = [
    { fingerprint: 'SHA256:aaa', user: 'ops' },
    { fingerprint: 'SHA256:bbb', user: 'deploy' }
  ]

  it('names every server that key reaches', () => {
    const found = bastionKeyFindings(chain(), 'edge', keys)
    expect(found).toHaveLength(2)
    expect(found[0].reason).toContain('ops@edge-1')
    expect(found[0].reason).toContain('3 other servers')
    expect(found[0].reason).toContain('app-1')
  })

  // The operator's question is "what does this key open". A hundred rows for
  // one key answers a different one.
  it('gives one finding per key, not one per key and host', () => {
    expect(bastionKeyFindings(chain(), 'edge', keys).map((f) => f.fingerprint)).toEqual([
      'SHA256:aaa',
      'SHA256:bbb'
    ])
  })

  it('says nothing about a key on a host nothing routes through', () => {
    expect(bastionKeyFindings(chain(), 'app', keys)).toEqual([])
  })

  it('skips a key the collector could not fingerprint', () => {
    // A finding keyed on a null fingerprint could not be matched back to
    // anything, and a row naming no key is not a finding.
    const found = bastionKeyFindings(chain(), 'edge', [{ fingerprint: null, user: 'ops' }])
    expect(found).toEqual([])
  })
})

describe('revoking a key on a bastion', () => {
  it('separates what is directly behind from what is further', () => {
    const block = revokeBlockFor(chain(), 'edge')!
    expect(block.reason).toContain('2 servers directly and 1 further behind them')
  })

  it('does not invent a second clause when nothing is deeper', () => {
    const flat = buildTopology([srv('edge', 'edge-1'), srv('web', 'web-1', ['edge'])])
    const block = revokeBlockFor(flat, 'edge')!
    expect(block.reason).toContain('the way in to 1 server')
    expect(block.reason).not.toContain('further behind')
  })

  // A CONFIRMATION, not a refusal, and that is the difference from the reboot
  // check rather than an inconsistency: revoking a key on a bastion is
  // frequently the right thing to do, and refusing it outright sends people to
  // edit authorized_keys by hand where nothing checks anything.
  it('asks rather than refusing', () => {
    expect(revokeBlockFor(chain(), 'edge')!.reason).toContain('Revoking a key here removes that path')
  })

  it('returns nothing for a host with nothing behind it', () => {
    expect(revokeBlockFor(chain(), 'app')).toBeNull()
  })
})

describe('nothing found is not the same as nothing there', () => {
  const withHole = (): ReturnType<typeof buildTopology> =>
    buildTopology([srv('edge', 'edge-1'), srv('web', 'web-1', [null])])

  it('carries the unseen-hop note on a block it did produce', () => {
    const chainWithHole = buildTopology([
      srv('edge', 'edge-1'),
      srv('mid', 'mid-1', ['edge']),
      srv('other', 'other-1', [null])
    ])
    expect(revokeBlockFor(chainWithHole, 'edge')!.blindSpot).toContain('not backed by a saved server')
  })

  it('leaves the blind spot null when the graph has no holes', () => {
    expect(revokeBlockFor(chain(), 'edge')!.blindSpot).toBeNull()
  })

  // A caller must not be able to render silence here. "No dependents" and "no
  // route hop in this workspace mentioned it" are the same observation, and
  // only the second one is true.
  it('gives a host with nothing behind it a sentence, not a blank', () => {
    expect(noBastionNote(chain(), 'app')).toContain('No saved server routes through app-1')
  })

  it('adds what the graph could not see when there are unmatched hops', () => {
    const note = noBastionNote(withHole(), 'edge')
    expect(note).toContain('they are not the whole picture')
    expect(note).toContain('not backed by a saved server')
  })
})
