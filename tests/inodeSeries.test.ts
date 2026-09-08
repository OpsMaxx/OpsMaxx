import { describe, it, expect } from 'vitest'

import { metricsToSamples } from '../src/main/services/fleetSampler'
import { METRICS } from '../src/main/services/history'
import { CAPACITY_METRICS, CAPACITY_THRESHOLDS } from '../src/shared/capacity'
import type { HostMetrics } from '../src/shared/ssh'

// Item 47, step 1.
//
// Inodes were MEASURED every sweep -- `df -iP /` has been in the probe since it
// was written -- and never stored. So a host running out of them had a number
// on the overview, no series behind it, and no forecast in front of it. Running
// out of inodes looks exactly like a full disk to everything except `df -i`,
// which is the one place nobody looks: every program says "No space left on
// device" about a filesystem that visibly has space.

const host = (over: Partial<HostMetrics> = {}): HostMetrics =>
  ({
    cpu: 12,
    memPct: 34,
    memUsed: 1024,
    memTotal: 4096,
    diskPct: 56,
    diskUsed: 500,
    diskTotal: 1000,
    inodePct: 78,
    netRx: 7,
    netTx: 8,
    uptime: 9000,
    hostname: 'web-1',
    kernel: '6.1.0',
    cores: 4,
    services: [],
    listeners: [],
    listenerSource: 'ss',
    ...over
  }) as HostMetrics

describe('the inode series', () => {
  it('is recorded, which it was not before', () => {
    expect(metricsToSamples(host()).inodePct).toBe(78)
  })

  // The guard matters more here than it does for cpu. btrfs and zfs report no
  // inode figures AT ALL -- `df -i` answers with dashes -- and a zero would
  // draw exactly those hosts as having none left.
  it('records nothing at all when the filesystem does not count inodes', () => {
    const s = metricsToSamples(host({ inodePct: null }))
    expect('inodePct' in s).toBe(false)
  })

  it('was APPENDED to METRICS, because every id above it is already on disk', () => {
    // The ids are the index + 1 and are stable forever. Inserting rather than
    // appending would silently re-point every stored row of every install.
    //
    // Pinned by INDEX rather than by "is last". `dbBytes` was appended after it
    // for item 47, and "last" would have had to be re-typed for a change that
    // did not touch this metric at all -- while the thing that actually matters,
    // that `inodePct` is still id 9, would have gone unasserted.
    expect(METRICS.indexOf('inodePct')).toBe(8)
    expect(METRICS.indexOf('cpu')).toBe(0)
    expect(METRICS.indexOf('diskPct')).toBe(3)
  })
})

describe('the inode forecast', () => {
  it('is a capacity metric, so "when does this fill" has an answer for it', () => {
    expect(CAPACITY_METRICS).toContain('inodePct')
  })

  it('forecasts against 90, the same line as disk and not the 85 that turns a bar red', () => {
    // 90 answers "when will it be in trouble"; 85 answers "is it now".
    // Forecasting the moment a warning appears would say "fills in 3 days"
    // about a host that has three days until it goes amber.
    expect(CAPACITY_THRESHOLDS.inodePct).toBe(90)
    expect(CAPACITY_THRESHOLDS.inodePct).toBe(CAPACITY_THRESHOLDS.diskPct)
  })

  it('has no threshold invented for cpu, which is busy rather than full', () => {
    expect(CAPACITY_THRESHOLDS.cpu).toBeUndefined()
  })
})
