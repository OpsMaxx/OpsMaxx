import { describe, expect, it } from 'vitest'
import { splitTabStrip } from '../src/renderer/src/components/monitor/tabStrip'
import { modulesOnSurface, type ModuleDef } from '../src/shared/modules'

// Nineteen tabs on three wrapped rows is not navigation.
//
// The strip used to render every enabled module, wrapping. Two things followed
// and both were reported as bugs by people who could not name them: enabling
// one module reflowed every row, so the position of a tab depended on which
// OTHER modules were on; and the third row ate about a tenth of the window on
// a page whose content is a wall of cards.
//
// The ceiling fixes both and introduces one new way to be wrong, which is the
// one this file is about: an overflow that can swallow the tab you are
// standing on. That would be a strict regression — the wrapped strip was ugly
// but it always showed you where you were.

const read = modulesOnSurface('read')
const ids = (m: ModuleDef[]): string[] => m.map((x) => x.id)

describe('splitTabStrip', () => {
  it('leaves the strip alone when everything fits', () => {
    const s = splitTabStrip(read.slice(0, 4), 'overview', 6)
    expect(ids(s.head)).toEqual(ids(read.slice(0, 4)))
    expect(s.rest).toEqual([])
  })

  it('puts the tabs past the ceiling behind the overflow, in registry order', () => {
    const s = splitTabStrip(read, 'overview', 6)
    expect(s.head).toHaveLength(6)
    expect(ids(s.head)).toEqual(ids(read.slice(0, 6)))
    expect(ids(s.rest)).toEqual(ids(read.slice(6)))
  })

  it('never hides the tab you are standing on', () => {
    // The invariant, stated over every tab rather than over one example: a
    // strip that showed the selection for twelve of thirteen modules would
    // pass a single-case test and still strand somebody on Kubernetes.
    for (const m of read) {
      const s = splitTabStrip(read, m.id, 6)
      expect(ids(s.head), `${m.id} fell into the overflow while selected`).toContain(m.id)
      expect(ids(s.rest)).not.toContain(m.id)
    }
  })

  it('promotes a selection out of the overflow by evicting the last of the row', () => {
    const last = read[5]
    const buried = read[9]
    const s = splitTabStrip(read, buried.id, 6)
    expect(s.head).toHaveLength(6)
    expect(ids(s.head)).toEqual([...ids(read.slice(0, 5)), buried.id])
    // The evicted tab goes behind `More`; it is not dropped.
    expect(ids(s.rest)).toContain(last.id)
  })

  it('keeps every tab somewhere, whatever is selected', () => {
    // The failure a promotion invites is losing one: `head` and `rest` are
    // built by two different expressions, and nothing else notices if the tab
    // that was evicted never lands.
    for (const m of read) {
      const s = splitTabStrip(read, m.id, 6)
      expect([...ids(s.head), ...ids(s.rest)].sort()).toEqual(ids(read).sort())
    }
  })

  it('changes only its own tail when a module is enabled', () => {
    // The original defect, as a property. Adding a module used to move
    // everything, because the row it landed on depended on total width. Now the
    // tabs before it are exactly where they were.
    const fewer = read.filter((m) => m.id !== read[8].id)
    const before = splitTabStrip(fewer, 'overview', 6)
    const after = splitTabStrip(read, 'overview', 6)
    expect(ids(after.head)).toEqual(ids(before.head))
  })

  it('is stable for a fixed tab, which has its own button and never overflows', () => {
    const a = splitTabStrip(read, 'overview', 6)
    const b = splitTabStrip(read, 'alerts', 6)
    expect(ids(a.head)).toEqual(ids(b.head))
    expect(ids(a.rest)).toEqual(ids(b.rest))
  })

  it('puts everything behind the overflow rather than throwing when there is no room', () => {
    const s = splitTabStrip(read, 'cron', 0)
    expect(s.head).toEqual([])
    expect(ids(s.rest)).toEqual(ids(read))
  })

  it('survives a selection that is not in the list at all', () => {
    // FleetMonitor's own guard falls back to Overview when a module is switched
    // off while its tab is open, but this must not depend on that having run.
    const s = splitTabStrip(read.slice(0, 3), read[9].id, 6)
    expect(ids(s.head)).toEqual(ids(read.slice(0, 3)))
    expect(s.rest).toEqual([])
  })
})
