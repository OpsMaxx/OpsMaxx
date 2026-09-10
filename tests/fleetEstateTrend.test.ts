import { describe, it, expect, beforeEach } from 'vitest'
import { useFleet, ESTATE_POINTS } from '../src/renderer/src/store/fleet'
import type { HostMetrics } from '../src/shared/ssh'

/**
 * The estate's own trend line.
 *
 * The overview was five numbers and no shape: everything it said was true of
 * that instant and nothing said whether it was going anywhere. "32% memory" is
 * a different fact when it was 12% ten minutes ago, and a dashboard read at a
 * glance is mostly reading direction.
 */

const host = (over: Partial<HostMetrics> = {}): HostMetrics =>
  ({ cpu: 50, memUsed: 1000, memTotal: 2000, ...over }) as HostMetrics

beforeEach(() => useFleet.setState({ hosts: {}, estate: [], samples: {}, errors: {}, facts: {} }))

describe('the point appended per sweep', () => {
  it('averages CPU across the servers that answered', () => {
    useFleet.getState().report('a', host({ cpu: 20 }), 1000)
    useFleet.getState().report('b', host({ cpu: 60 }), 1000)
    const last = useFleet.getState().estate.at(-1)!
    expect(last.cpu).toBe(40)
  })

  it('takes memory as a proportion of the whole estate', () => {
    useFleet.getState().report('a', host({ memUsed: 1000, memTotal: 4000 }), 1000)
    useFleet.getState().report('b', host({ memUsed: 1000, memTotal: 4000 }), 1000)
    expect(useFleet.getState().estate.at(-1)!.mem).toBe(25)
  })

  /**
   * A host that cannot report CPU is left OUT of the mean. `cpu` is null and
   * never zero for exactly this reason — counting it as zero would drag the
   * estate's line down and read as idle rather than as unmeasured.
   */
  it('ignores a host that could not report CPU', () => {
    useFleet.getState().report('a', host({ cpu: 80 }), 1000)
    useFleet.getState().report('b', host({ cpu: null as never }), 1000)
    expect(useFleet.getState().estate.at(-1)!.cpu).toBe(80)
  })

  it('is zero rather than NaN when nothing could report', () => {
    useFleet.getState().report('a', host({ cpu: null as never, memTotal: 0, memUsed: 0 }), 1000)
    const last = useFleet.getState().estate.at(-1)!
    expect(last.cpu).toBe(0)
    expect(last.mem).toBe(0)
  })
})

describe('one point per sweep, not one per server', () => {
  /**
   * A sweep reports each host separately. Without coalescing, fifteen servers
   * add fifteen points and the x-axis becomes the arrival order of hosts
   * rather than time — a line that looks like a spike every sweep.
   */
  it('coalesces a sweep into a single point', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      useFleet.getState().report(id, host(), 5000)
    }
    expect(useFleet.getState().estate).toHaveLength(1)
  })

  it('starts a new point once time has moved on', () => {
    useFleet.getState().report('a', host(), 1000)
    useFleet.getState().report('a', host(), 9000)
    expect(useFleet.getState().estate).toHaveLength(2)
  })

  // The coalesced point reflects every host in the sweep, not just the first.
  it('keeps recomputing as more of the sweep lands', () => {
    useFleet.getState().report('a', host({ cpu: 100 }), 1000)
    expect(useFleet.getState().estate.at(-1)!.cpu).toBe(100)
    useFleet.getState().report('b', host({ cpu: 0 }), 1000)
    expect(useFleet.getState().estate.at(-1)!.cpu).toBe(50)
  })
})

describe('the series is bounded', () => {
  it('keeps only the most recent points', () => {
    for (let i = 0; i < ESTATE_POINTS + 25; i++) {
      useFleet.getState().report('a', host({ cpu: i % 100 }), 10_000 + i * 2000)
    }
    expect(useFleet.getState().estate).toHaveLength(ESTATE_POINTS)
  })

  it('keeps them oldest first, so a sparkline reads left to right', () => {
    useFleet.getState().report('a', host(), 1000)
    useFleet.getState().report('a', host(), 9000)
    useFleet.getState().report('a', host(), 17000)
    const ats = useFleet.getState().estate.map((p) => p.at)
    expect(ats).toEqual([...ats].sort((x, y) => x - y))
  })
})
