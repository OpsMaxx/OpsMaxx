import { describe, expect, it } from 'vitest'
import { parseMetrics, MIN_CPU_WINDOW_MS, type CpuSnap } from '../src/main/services/metrics'

/**
 * CPU is a delta, and a delta needs a window.
 *
 * Reported as: "CPU 96.9 of 80" raised and cleared over and over on a host
 * that had not been over 7% in twenty-four hours according to another monitor.
 *
 * Nothing owned the spacing of the two /proc/stat readings. The monitor strip,
 * the monitor tab, the fleet card and the background sweep all sample the same
 * host on their own timers, the shared cache only covers 1.5 seconds, and the
 * base snapshot was replaced on every poll — so two real samples could land a
 * couple of hundred milliseconds apart. Over 200ms on a small VM the entire
 * delta is a few dozen jiffies, and the biggest consumer inside that window is
 * the probe: sshd waking, a shell forking, two greps and a df. The sampler was
 * measuring itself and reporting it as the host.
 */

/** A /proc/stat block. `busy` is spread across user; the rest is idle. */
const stat = (busy: number, idle: number, cores = 4): string =>
  [
    '__CPU__',
    `cpu  ${busy} 0 0 ${idle} 0 0 0 0 0 0`,
    ...Array.from(
      { length: cores },
      (_, i) => `cpu${i} ${Math.round(busy / cores)} 0 0 ${Math.round(idle / cores)} 0 0 0 0 0 0`
    )
  ].join('\n')

const T0 = 1_700_000_000_000

describe('the CPU sampling window', () => {
  it('refuses to divide two readings taken moments apart', () => {
    // 20 jiffies of work in 20 jiffies of wall clock reads as 100% — and it is
    // the probe's own cost, not the host's load. Null is the codebase's
    // "not measured", and every consumer already handles it.
    const prev: CpuSnap = { total: 100_000, idle: 90_000, at: T0 }
    const { data } = parseMetrics(stat(20_020, 90_000), prev, T0 + 200)
    expect(data.cpu).toBeNull()
    expect(data.cpuCores).toBeNull()
  })

  it('reports once the window is wide enough', () => {
    const prev: CpuSnap = { total: 100_000, idle: 90_000, at: T0 }
    // 1000 more jiffies total, 900 of them idle: 10% busy.
    const { data } = parseMetrics(stat(10_100, 90_900), prev, T0 + MIN_CPU_WINDOW_MS)
    expect(data.cpu).toBeCloseTo(10, 5)
  })

  it('keeps the old base while the window is still too narrow', () => {
    // The base must NOT advance on a refused reading, or the next poll starts
    // another too-short window and the host never reports at all.
    const prev: CpuSnap = { total: 100_000, idle: 90_000, at: T0 }
    const { snap } = parseMetrics(stat(20_020, 90_000), prev, T0 + 200)
    // parse still hands back what it read; sample() is what decides to keep
    // the old base, and it does so from the timestamps.
    expect(snap).not.toBeNull()
    expect((snap as CpuSnap).at).toBe(T0 + 200)
  })

  it('trusts a pair taken inside one command however close together', () => {
    // The first sample of a host sleeps on purpose between two reads, so that
    // pair carries its own window and this rule must not discard it.
    const text = [stat(100_000 - 90_000, 90_000), stat(10_100, 90_900).replace('__CPU__\n', '')]
      .join('\n')
    const { data } = parseMetrics(text, null, T0)
    expect(data.cpu).not.toBeNull()
  })

  it('still reports for a snapshot written before this rule existed', () => {
    // An upgrade must not blank the graph until every host has been re-based.
    const prev = { total: 100_000, idle: 90_000 } as CpuSnap
    const { data } = parseMetrics(stat(10_100, 90_900), prev, T0)
    expect(data.cpu).toBeCloseTo(10, 5)
  })
})

describe('what counts as busy', () => {
  it('does not count guest time twice', () => {
    // /proc/stat already counts guest inside user and guest_nice inside nice.
    // Summing all ten fields inflates the denominator, so a host running VMs
    // reads lower than it is.
    const prev: CpuSnap = { total: 0, idle: 0, at: T0 }
    const withGuest = ['__CPU__', 'cpu  50 0 0 50 0 0 0 0 40 10'].join('\n')
    const { data } = parseMetrics(withGuest, prev, T0 + MIN_CPU_WINDOW_MS)
    // 100 jiffies total, 50 idle → 50%. Counting guest would make it 150
    // total and report 33%.
    expect(data.cpu).toBeCloseTo(50, 5)
  })
})
