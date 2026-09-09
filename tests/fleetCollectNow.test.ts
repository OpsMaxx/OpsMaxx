import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FleetSampler } from '../src/main/services/fleetSampler'
import type { FleetTarget } from '../src/shared/fleet'

/**
 * "Check now", which used to collect nothing.
 *
 * Three panels carried a button with that label. It called `fleet:facts` or
 * `fleet:access` — both PURE CACHE READS — so the click re-read what was
 * already in memory and re-rendered it unchanged. Even the sweep the panels
 * hoped for would not have helped: facts, keys, posture and drift each sit
 * behind their own hourly due time, and `sampleNow()` does not clear them, so
 * a requested sweep on a recently-swept estate re-collects metrics and skips
 * exactly the data those panels display.
 *
 * These tests are written against the sampler because that is where the
 * hourly clock lives, and the clock is the bug.
 */

const target = (id: string): FleetTarget => ({
  serverId: id,
  serverName: `srv-${id}`,
  cfg: { host: 'h', port: 22, username: 'u' } as FleetTarget['cfg']
})

interface Harness {
  sampler: FleetSampler
  factsCalls: string[]
}

function harness(over: { enabled?: boolean; targets?: FleetTarget[] } = {}): Harness {
  const factsCalls: string[] = []
  const sampler = new FleetSampler({
    sample: async () => ({ ok: true, data: { hostname: 'h', services: null, listeners: null } }),
    sampleFacts: async (key: string) => {
      factsCalls.push(key)
      return { ok: true, facts: { at: 1, hostname: 'h' } } as never
    },
    release: () => undefined,
    emit: () => undefined,
    vaultUnlocked: () => true,
    history: () => ({
      transaction: <T,>(fn: () => T): T => fn(),
      recordSamples: () => undefined,
      upsertFact: () => 'created' as const,
      retireFacts: () => 0,
      recordEvent: () => undefined
    })
  } as never)

  sampler.configure({
    enabled: over.enabled ?? true,
    intervalMs: 120_000,
    targets: over.targets ?? [target('a'), target('b')]
  })
  return { sampler, factsCalls }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('collecting on demand', () => {
  /**
   * The bug, stated as a difference. A second `sampleNow()` inside the hour
   * collects no facts, because their due time has not come round; a
   * `collectNow()` does, because it clears it.
   */
  it('collects facts again inside the hour, where sampleNow does not', async () => {
    const h = harness()
    await h.sampler.collectNow()
    const afterFirst = h.factsCalls.length
    expect(afterFirst).toBeGreaterThan(0)

    // A plain requested sweep: metrics yes, facts no — the schedule stands.
    await h.sampler.sampleNow()
    expect(h.factsCalls.length, 'sampleNow must respect the hourly clock').toBe(afterFirst)

    // Check now: the schedule is cleared, so the facts are collected again.
    await h.sampler.collectNow()
    expect(h.factsCalls.length, 'collectNow must ignore the hourly clock').toBeGreaterThan(
      afterFirst
    )
  })

  it('reports how many servers it collected from', async () => {
    const h = harness()
    const r = await h.sampler.collectNow()
    expect(r.swept).toBe(true)
    expect(r.servers).toBe(2)
    expect(r.reason).toBeUndefined()
  })

  it('collects only the servers it was given', async () => {
    const h = harness()
    const r = await h.sampler.collectNow(['a'])
    expect(r.servers).toBe(1)
  })

  /**
   * The other half of the reported bug: a button that collected nothing and a
   * button whose feature is switched off looked identical. The caller has to
   * be able to tell them apart in order to say so.
   */
  it('says when sampling is off rather than pretending it swept', async () => {
    const h = harness({ enabled: false })
    const r = await h.sampler.collectNow()
    expect(r.swept).toBe(false)
    expect(r.reason).toBe('disabled')
    expect(h.factsCalls).toEqual([])
  })

  it('says when there is nothing to collect', async () => {
    const h = harness({ targets: [] })
    const r = await h.sampler.collectNow()
    expect(r.swept).toBe(false)
    expect(r.reason).toBe('no-targets')
  })

  /**
   * A sweep already running refuses a second — correctly, two would double the
   * load. But it may already have walked past these hosts under the old due
   * times, so returning then would report a collection that did not happen.
   */
  it('does not report a collection that a running sweep skipped', async () => {
    const h = harness()
    const first = h.sampler.sampleNow()
    const r = await h.sampler.collectNow()
    await first
    expect(r.swept).toBe(true)
    // Facts were collected for both servers despite a sweep being in flight
    // when the request arrived.
    expect(new Set(h.factsCalls).size).toBe(2)
  })
})
