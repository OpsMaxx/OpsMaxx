import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FleetSampler } from '../src/main/services/fleetSampler'
import type { FleetSampleEvent, FleetTarget } from '../src/shared/fleet'
import type { SshHop } from '../src/shared/ssh'

/**
 * A server reached through a bastion has to be sampled exactly like a direct
 * one, and the gate in front of the sweep did not know the chain existed.
 *
 * `credentialReady` was asked about the TARGET's id alone. That is the whole
 * question for a direct connection and half of it for a chained one: every hop
 * authenticates independently with its own stored credential, so a bastion
 * whose password lives in the vault makes everything behind it unsampleable
 * while the vault is shut — whatever the targets' own credentials are.
 *
 * Unasked, such a server was not skipped, it was ATTEMPTED: resolveChainSecrets
 * threw VaultLockedError on the hop, the sweep caught it and recorded the
 * server unreachable, once per interval, for as long as the vault stayed
 * closed. In the monitor that is a healthy machine showing as down — and since
 * the posture, access, inventory and drift panels are pure reads of this
 * sampler's cache, all of them go empty for the same server at the same time.
 *
 * The real FleetSampler is driven here; only its injected probes are doubles,
 * which is the seam the class was written around.
 */

const hop = (serverId: string): SshHop & { serverId: string } => ({
  serverId,
  host: 'bastion.internal',
  port: 22,
  username: 'ops',
  auth: 'key'
})

/** A target, optionally behind a chain of saved-server jump hosts. */
const cfgFor = (hops: SshHop[]): FleetTarget['cfg'] =>
  ({ host: 'h', port: 22, username: 'u', auth: 'key', sessionId: 's', cols: 80, rows: 24, hops }) as FleetTarget['cfg']

const target = (id: string, hops: (SshHop & { serverId: string })[] = []): FleetTarget => ({
  serverId: id,
  serverName: `srv-${id}`,
  cfg: cfgFor(hops)
})

interface Harness {
  sampler: FleetSampler
  events: FleetSampleEvent[]
  calls: string[]
  /** Make one id's credential unreadable, as a locked vault does. */
  block: (id: string) => void
}

function harness(): Harness {
  const events: FleetSampleEvent[] = []
  const calls: string[] = []
  const blocked = new Set<string>()

  const sampler = new FleetSampler({
    sample: async (key) => {
      calls.push(key)
      return { ok: true, data: { hostname: key } }
    },
    release: () => undefined,
    emit: (e) => events.push(e),
    credentialReady: (serverId) => !blocked.has(serverId)
  })

  return { sampler, events, calls, block: (id) => blocked.add(id) }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('a target behind a jump host whose credential cannot be read', () => {
  it('is skipped rather than attempted and reported unreachable', async () => {
    const h = harness()
    h.block('bastion')
    h.sampler.configure({
      enabled: true,
      intervalMs: 60_000,
      targets: [target('behind', [hop('bastion')]), target('direct')]
    })
    await vi.advanceTimersByTimeAsync(0)

    // The direct server is unaffected — that is the whole shape of the
    // reported defect: one server in the list works and its neighbour, behind
    // a bastion, reads as down.
    expect(h.calls).toEqual(['fleet:direct'])
    // Skipped and never attempted: no failure event, so nothing paints the
    // host red and nothing writes an audit entry per interval.
    expect(h.events.some((e) => e.error)).toBe(false)
    expect(h.sampler.status()).toMatchObject({ running: true, vaultBlockedCount: 1 })
    h.sampler.dispose()
  })

  it('counts every hop, not just the first', async () => {
    const h = harness()
    h.block('inner')
    h.sampler.configure({
      enabled: true,
      intervalMs: 60_000,
      targets: [target('behind', [hop('outer'), hop('inner')])]
    })
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(h.calls).toEqual([])
    // Every target blocked, so this is the whole-estate park and it says so
    // rather than claiming to be running.
    expect(h.sampler.status()).toMatchObject({ running: false, idleReason: 'vault-locked' })
    h.sampler.dispose()
  })

  it('samples it normally once every credential on the route is readable', async () => {
    const h = harness()
    h.sampler.configure({
      enabled: true,
      intervalMs: 60_000,
      targets: [target('behind', [hop('outer'), hop('inner')])]
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(h.calls).toEqual(['fleet:behind'])
    expect(h.sampler.status()).toMatchObject({ running: true, vaultBlockedCount: 0 })
    h.sampler.dispose()
  })

  it('does not block on a hop that carries its credential inline', async () => {
    // A hop that names no saved server has nothing to resolve from the vault,
    // so it can never be the reason a target is skipped. Blocking every id in
    // sight must not reach it.
    const h = harness()
    h.block('')
    h.sampler.configure({
      enabled: true,
      intervalMs: 60_000,
      targets: [
        {
          serverId: 'behind',
          serverName: 'srv-behind',
          cfg: cfgFor([{ host: 'b', port: 22, username: 'ops', auth: 'key', keyPath: '/k' }])
        }
      ]
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(h.calls).toEqual(['fleet:behind'])
    h.sampler.dispose()
  })
})
