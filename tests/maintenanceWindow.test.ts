import { describe, it, expect } from 'vitest'

import {
  checkMaintenanceWindow,
  describeMaintenanceWindow,
  maintenanceSnoozes,
  MAX_WINDOW_HOURS,
  type MaintenanceWindow
} from '../src/shared/maintenance'
import { STORE_ALERT_KINDS } from '../src/shared/webhook'

// Item 44's maintenance window. It is not a new suppression mechanism -- it is
// the snooze rows the alert store already writes, which are durable, carry an
// absolute end and are replayed at launch. A second way to silence an estate
// would be a second thing to reason about, and only one of them would have been.

const T0 = Date.UTC(2026, 0, 1, 12)
const HOUR = 3_600_000

const w = (over: Partial<MaintenanceWindow> = {}): MaintenanceWindow => ({
  serverIds: ['s1', 's2'],
  until: T0 + 2 * HOUR,
  note: 'Kernel patching',
  ...over
})

describe('what a window refuses to be', () => {
  it('will not cover no servers', () => {
    expect(checkMaintenanceWindow(w({ serverIds: [] }), T0).ok).toBe(false)
  })

  it('will not end before it starts', () => {
    expect(checkMaintenanceWindow(w({ until: T0 - HOUR }), T0).ok).toBe(false)
    expect(checkMaintenanceWindow(w({ until: T0 }), T0).ok).toBe(false)
  })

  // A silence nobody has to renew is a silence nobody remembers setting, and
  // the estate goes quiet for a month because somebody meant to patch on
  // Tuesday.
  it('will not run longer than a day', () => {
    expect(checkMaintenanceWindow(w({ until: T0 + MAX_WINDOW_HOURS * HOUR }), T0).ok).toBe(true)
    expect(checkMaintenanceWindow(w({ until: T0 + (MAX_WINDOW_HOURS + 1) * HOUR }), T0).ok).toBe(false)
  })

  it('will not open without a reason somebody can read later', () => {
    const r = checkMaintenanceWindow(w({ note: '   ' }), T0)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('why it went quiet')
  })
})

describe('the rows it writes', () => {
  it('covers every kind, not a subset the operator has to reason about', () => {
    // Somebody rebooting a machine is not asking to keep being told about its
    // disk.
    const rows = maintenanceSnoozes(w({ serverIds: ['s1'] }), T0)
    expect(rows.map((r) => r.kind).sort()).toEqual([...STORE_ALERT_KINDS].sort())
  })

  it('covers every server named and no others', () => {
    const rows = maintenanceSnoozes(w(), T0)
    expect(new Set(rows.map((r) => r.serverId))).toEqual(new Set(['s1', 's2']))
    expect(rows).toHaveLength(2 * STORE_ALERT_KINDS.length)
  })

  // Derived from the absolute end, so every row stops at the same moment
  // however long the loop takes -- rather than each being "two hours from
  // whenever this one was written".
  it('ends every row at the same moment', () => {
    const rows = maintenanceSnoozes(w(), T0)
    expect(new Set(rows.map((r) => r.ms))).toEqual(new Set([2 * HOUR]))
  })
})

describe('what the operator is told before they do it', () => {
  it('says what stops and, more importantly, what does not', () => {
    const text = describeMaintenanceWindow(w(), ['web-1', 'db-1'], T0)
    expect(text).toContain('web-1, db-1')
    expect(text).toContain('2h')
    // The three things a window must not do, said out loud rather than assumed.
    expect(text).toContain('keep being sampled')
    expect(text).toContain('chips stay up')
    expect(text).toContain('Webhook endpoints still receive')
  })
})
