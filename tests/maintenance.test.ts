import { describe, it, expect } from 'vitest'

import { activeMaintenance, remainingText } from '../src/shared/maintenance'
import type { SnoozableAlert } from '../src/shared/maintenance'


// ---------------------------------------------------------------------------
// Whether a window is open right now
// ---------------------------------------------------------------------------
//
// Opening a window was well built. What happened next was that the panel went
// back to looking exactly as it had before — same composer, same "2 hours",
// same empty reason field, same "Open a window" button — while the header still
// read "3 outstanding" and the status bar still read "3 alerts". Fleet-wide
// alert suppression is the easiest way to miss a production outage, and the app
// forgot to mention it was on.

describe('what is silenced right now', () => {
  const at = 1_000_000
  const a = (serverId: string, until?: number): SnoozableAlert => ({ serverId, snoozedUntil: until })

  it('says nothing is silenced when nothing is', () => {
    expect(activeMaintenance([a('s1'), a('s2')], at)).toBeNull()
    expect(activeMaintenance([], at)).toBeNull()
  })

  // A stored "a window is open" flag would be a second copy of the truth: it
  // survives the snoozes expiring and then claims a window is open while
  // nothing is silent. This reads the snoozes themselves, so there is nothing
  // to keep in step.
  it('treats an expired snooze as not silenced', () => {
    expect(activeMaintenance([a('s1', at - 1)], at)).toBeNull()
    expect(activeMaintenance([a('s1', at)], at)).toBeNull()
    expect(activeMaintenance([a('s1', at + 1)], at)).not.toBeNull()
  })

  it('counts servers, not alerts, for the server figure', () => {
    const m = activeMaintenance([a('s1', at + 100), a('s1', at + 200), a('s2', at + 50)], at)
    expect(m).toMatchObject({ serverCount: 2, alertCount: 3 })
  })

  // The window is not over while anything is still quiet, so the honest "until"
  // is the last one to wake up rather than the first.
  it('reports the latest expiry, not the earliest', () => {
    expect(activeMaintenance([a('s1', at + 100), a('s2', at + 900)], at)?.until).toBe(at + 900)
  })

  // "3 outstanding" reads the same whether the fleet is announcing or silent.
  // This is what lets the heading say which.
  it('knows when everything outstanding is muted', () => {
    expect(activeMaintenance([a('s1', at + 5), a('s2', at + 5)], at)?.all).toBe(true)
    expect(activeMaintenance([a('s1', at + 5), a('s2')], at)?.all).toBe(false)
  })
})

describe('how long is left', () => {
  const at = 1_000_000
  it.each([
    [at + 60_000 * 107, '1h 47m'],
    [at + 60_000 * 120, '2h'],
    [at + 60_000 * 12, '12m'],
    [at + 30_000, 'under a minute'],
    [at, 'ending now'],
    [at - 5, 'ending now']
  ])('%i → %s', (until, text) => {
    expect(remainingText(until, at)).toBe(text)
  })
})
