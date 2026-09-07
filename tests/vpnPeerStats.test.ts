import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { handshakeAgeSec, toPeerStat, toStats } from '../src/main/services/vpn/drivers/wireguard'
import type { VpnPeerStat, VpnStats } from '../src/shared/vpn'

// Item 44's per-peer WireGuard stats, the parent's half.
//
// The sidecar's half is `sidecar/netd/stats_test.go`, against recorded UAPI
// output. What is asserted here is the CONVERSION and the promise: an absolute
// handshake stamp becomes an age exactly as the aggregate's does, and a peer's
// public key never reaches an agent.

const clock = { nowMs: () => 1_000_000_000_000 }

describe('a peer row is aged the same way the aggregate is', () => {
  // Two conversions of one field drift. The aggregate has used
  // `handshakeAgeSec` since it was written and the rows use the same function.
  it('turns an absolute stamp into an age', () => {
    expect(handshakeAgeSec(1_000_000_000 - 42, clock)).toBe(42)
  })

  // Zero means never, and never is not "a long time ago" -- the distinction the
  // sidecar preserves and the parent must not flatten.
  it('reports a peer that has never handshaked as absent, not as ancient', () => {
    expect(handshakeAgeSec(0, clock)).toBeUndefined()
    expect(handshakeAgeSec(undefined, clock)).toBeUndefined()
  })

  it('never reports a negative age from a clock that moved', () => {
    expect(handshakeAgeSec(1_000_000_000 + 3_600, clock)).toBe(0)
  })
})

describe('the promise list_vpns makes', () => {
  // Its own description says endpoints, keys and listener addresses are never
  // included and cannot be requested. Adding a public key to `VpnStats` is
  // exactly the change that could break that quietly.
  const mcp = (): string =>
    readFileSync(fileURLToPath(new URL('../src/main/services/mcpServer.ts', import.meta.url)), 'utf8')

  it('still says keys are never included', () => {
    const at = mcp().indexOf("'list_vpns'")
    expect(at).toBeGreaterThan(0)
    expect(mcp().slice(at, at + 1200)).toContain('keys')
    expect(mcp().slice(at, at + 1200)).toContain('never included')
  })

  it('reads no peer row anywhere in the agent surface', () => {
    // `stats.proxies` is frp's table and is deliberately shown. `stats.peers`
    // carries a public key per row and is not.
    const body = mcp()
    expect(body).toContain('stats?.proxies')
    expect(body).not.toContain('stats?.peers')
    expect(body).not.toContain('publicKey')
  })
})

describe('turning the sidecar’s sample into a status', () => {
  const sample = (over: Record<string, unknown> = {}): Parameters<typeof toStats>[1] =>
    ({
      tunnelId: 't',
      rxBytes: 2040,
      txBytes: 1030,
      peers: 2,
      sampledAt: 1,
      peerRows: [
        {
          publicKey: 'aaa',
          endpoint: '203.0.113.9:51820',
          rxBytes: 2000,
          txBytes: 1000,
          lastHandshakeUnixSec: 1_000_000_000 - 30
        },
        { publicKey: 'bbb', rxBytes: 40, txBytes: 30, lastHandshakeUnixSec: 0 }
      ],
      ...over
    }) as Parameters<typeof toStats>[1]

  // Absent and empty are different answers: a tunnel whose peers were removed,
  // and a sidecar from a build that reports no rows at all.
  it('leaves peers absent rather than empty when the sidecar sent none', () => {
    expect('peers' in toStats(clock, sample({ peerRows: undefined }))).toBe(false)
    expect('peers' in toStats(clock, sample({ peerRows: [] }))).toBe(false)
  })

  it('ages each row through the same conversion as the aggregate', () => {
    const s = toStats(clock, sample())
    expect(s.peers?.[0].lastHandshakeSec).toBe(30)
    // Zero means never, and it must not become an age of thirty years.
    expect(s.peers?.[1].lastHandshakeSec).toBeUndefined()
  })

  it('keeps each row’s own bytes rather than the aggregate’s', () => {
    const s = toStats(clock, sample())
    expect(s.peers?.map((p) => p.rxBytes)).toEqual([2000, 40])
    expect(s.rxBytes).toBe(2040)
  })

  it('omits an endpoint the peer does not have rather than writing an empty one', () => {
    const one = toPeerStat(clock, { publicKey: 'a', rxBytes: 0, txBytes: 0 })
    expect('endpoint' in one).toBe(false)
    expect(one.rxBytes).toBe(0)
  })
})

describe('what the shape allows', () => {

  it('carries each peer’s own numbers rather than the aggregate’s', () => {
    const peers: VpnPeerStat[] = [
      { publicKey: 'a', rxBytes: 2000, txBytes: 1000, lastHandshakeSec: 30 },
      { publicKey: 'b', rxBytes: 40, txBytes: 30 }
    ]
    const s: VpnStats = { rxBytes: 2040, txBytes: 1030, sampledAt: 1, peers }
    expect(s.peers?.[1].lastHandshakeSec).toBeUndefined()
    expect(s.rxBytes).toBe((s.peers ?? []).reduce((a, p) => a + p.rxBytes, 0))
  })
})
