import { describe, it, expect } from 'vitest'
import { FleetSampler } from '../src/main/services/fleetSampler'
import type { FleetTarget, FleetSweepProgress } from '../src/shared/fleet'

/**
 * How far the sweep has got, reported while it is going.
 *
 * The reason this exists: the sweep asks servers ONE AT A TIME on purpose, and
 * a host that has gone away costs a 45-second timeout before the next is even
 * tried. Every control that started a collection showed a 13px spinning icon
 * for all of that and nothing else, which was reported as a click that felt
 * like nothing happened.
 *
 * A spinner cannot be wrong about how much is left; a bar can, so these tests
 * pin the two ways it would be. It must advance past a server that FAILED —
 * otherwise it stalls exactly on the dead host that made it necessary — and it
 * must name the server BEFORE that server is asked, not after, or the slow one
 * is anonymous for the whole time it is being waited on.
 */

const target = (id: string): FleetTarget => ({
  serverId: id,
  serverName: `srv-${id}`,
  cfg: { host: 'h', port: 22, username: 'u' } as FleetTarget['cfg']
})

function harness(over: { targets?: FleetTarget[]; failOn?: string[] } = {}): {
  sampler: FleetSampler
  seen: FleetSweepProgress[]
  asked: string[]
} {
  const seen: FleetSweepProgress[] = []
  const asked: string[] = []
  const fail = new Set(over.failOn ?? [])
  const sampler = new FleetSampler({
    sample: async (key: string) => {
      asked.push(key)
      return fail.has(key)
        ? { ok: false, error: 'connection refused' }
        : { ok: true, data: { hostname: 'h', services: null, listeners: null } }
    },
    release: () => undefined,
    emit: () => undefined,
    progress: (p: FleetSweepProgress) => seen.push({ ...p }),
    vaultUnlocked: () => true
  } as never)

  sampler.configure({
    enabled: true,
    intervalMs: 120_000,
    targets: over.targets ?? [target('a'), target('b'), target('c')]
  })
  return { sampler, seen, asked }
}

describe('sweep progress', () => {
  it('reports each server before it is asked', async () => {
    const { sampler, seen, asked } = harness()
    await sampler.collectNow()

    const sweeping = seen.filter((p) => p.phase === 'sweeping')
    expect(sweeping.map((p) => p.serverId)).toEqual(['a', 'b', 'c'])
    // The point of "before": the host named in the report is the one the next
    // wait is about to be spent on, not the one already finished with.
    expect(sweeping[0].done).toBe(0)
    expect(asked.length).toBe(3)
  })

  it('counts every server, total against the estate', async () => {
    const { sampler, seen } = harness()
    await sampler.collectNow()
    const sweeping = seen.filter((p) => p.phase === 'sweeping')
    expect(sweeping.map((p) => p.done)).toEqual([0, 1, 2])
    expect(sweeping.every((p) => p.total === 3)).toBe(true)
  })

  it('advances past a server that failed', async () => {
    // The bar would otherwise stall on exactly the dead host that made the
    // whole indicator necessary.
    const { sampler, seen } = harness({ failOn: ['b'] })
    await sampler.collectNow()
    const sweeping = seen.filter((p) => p.phase === 'sweeping')
    expect(sweeping.map((p) => p.done)).toEqual([0, 1, 2])
  })

  it('ends the indicator when the sweep finishes', async () => {
    const { sampler, seen } = harness()
    await sampler.collectNow()
    // Last, and unconditional: a panel left showing a bar for a sweep that has
    // stopped is the same defect in the other direction.
    expect(seen[seen.length - 1].phase).toBe('done')
  })

  it('reports done even when the vault locks mid-sweep', async () => {
    let unlocked = true
    const seen: FleetSweepProgress[] = []
    const sampler = new FleetSampler({
      sample: async () => {
        unlocked = false
        return { ok: true, data: { hostname: 'h', services: null, listeners: null } }
      },
      release: () => undefined,
      emit: () => undefined,
      progress: (p: FleetSweepProgress) => seen.push({ ...p }),
      vaultUnlocked: () => unlocked
    } as never)
    sampler.configure({
      enabled: true,
      intervalMs: 120_000,
      targets: [target('a'), target('b')]
    })

    await sampler.collectNow()
    expect(seen[seen.length - 1].phase).toBe('done')
  })

  it('does not require a reporter', async () => {
    // Every other probe on this interface is optional so that a sampler built
    // without it behaves exactly as it did before. This one is too.
    const sampler = new FleetSampler({
      sample: async () => ({ ok: true, data: { hostname: 'h', services: null, listeners: null } }),
      release: () => undefined,
      emit: () => undefined,
      vaultUnlocked: () => true
    } as never)
    sampler.configure({ enabled: true, intervalMs: 120_000, targets: [target('a')] })
    await expect(sampler.collectNow()).resolves.toMatchObject({ swept: true })
  })

  it('survives a reporter that throws', async () => {
    // A window that goes away mid-sweep is the normal case, and it is not a
    // reason to stop collecting from the estate.
    const asked: string[] = []
    const sampler = new FleetSampler({
      sample: async (key: string) => {
        asked.push(key)
        return { ok: true, data: { hostname: 'h', services: null, listeners: null } }
      },
      release: () => undefined,
      emit: () => undefined,
      progress: () => {
        throw new Error('window destroyed')
      },
      vaultUnlocked: () => true
    } as never)
    sampler.configure({
      enabled: true,
      intervalMs: 120_000,
      targets: [target('a'), target('b')]
    })

    await sampler.collectNow()
    expect(asked.length).toBe(2)
  })
})
