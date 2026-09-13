import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MODULES, isPromotedModule } from '../src/shared/modules'

/**
 * The Modules page's grouping.
 *
 * Twenty-one switches in one undifferentiated list made a module that adds a panel
 * look like the same kind of decision as one that can install packages across the
 * estate. The page now groups by `surface` plus promotion — both of which already
 * exist and are already tested, so the page is not inventing a second opinion
 * about what a module is.
 *
 * The failure this file exists to catch: a module matching NO group simply does not
 * render, and a switch that is missing from Settings looks exactly like a feature
 * that was removed from the product. The old flat `MODULES.map` could not have that
 * bug; a grouped list can.
 */

const SRC = readFileSync(
  join(__dirname, '../src/renderer/src/components/settings/Settings.tsx'),
  'utf8'
)

/** The predicates the page uses, restated. Kept in step by the assertions below. */
const GROUPS: ((m: (typeof MODULES)[number]) => boolean)[] = [
  (m) => isPromotedModule(m.id),
  (m) => m.surface === 'read' && !isPromotedModule(m.id),
  (m) => m.surface === 'operate'
]

describe('the Modules page groups', () => {
  it('puts every module in exactly one group', () => {
    for (const m of MODULES) {
      const hits = GROUPS.filter((g) => g(m)).length
      expect(hits, `${m.id} is in ${hits} groups`).toBe(1)
    }
  })

  it('leaves no module unreachable', () => {
    const shown = MODULES.filter((m) => GROUPS.some((g) => g(m)))
    expect(shown).toHaveLength(MODULES.length)
  })

  it('renders from the registry rather than a private list', () => {
    // The same rule tests/paletteReach.test.ts enforces for the command palette:
    // a second copy of the module list is a second chance for the two to disagree
    // about what ships.
    expect(SRC).toMatch(/MODULE_GROUPS\.map/)
    expect(SRC).toMatch(/MODULES\.filter\(g\.match\)/)
  })

  it('groups by the registry fields rather than by a new taxonomy', () => {
    // `surface` and promotion, both load-bearing and both tested elsewhere. A
    // hand-written category per module would be a third opinion after the registry
    // and the first-run card.
    expect(SRC).toMatch(/isPromotedModule\(m\.id\)/)
    expect(SRC).toMatch(/m\.surface === 'operate'/)
  })

  it('makes no promise on behalf of a module that breaks it', () => {
    // The defect this catches, which shipped for about an hour: the read group's
    // blurb read "None of these can change a server". That sentence is the
    // registry's CONTRACT for the `read` surface (shared/modules.ts, ModuleSurface)
    // and it is true of the surface as a design invariant -- but `rules` is filed
    // on that surface and DOES run jobs on hosts, unattended. Repeating the
    // contract as a user-facing sentence turned it into a security claim, shown
    // at the decision point, directly above the switch it is false about.
    //
    // A group label may describe its members. It may not make an absolute claim
    // about what they cannot do -- the registry is the place for that, where a
    // per-module exception can be written next to the module.
    const group = SRC.slice(SRC.indexOf("id: 'read'"), SRC.indexOf("id: 'operate'"))
    expect(group).not.toMatch(/None of these can change a server/)
    // And having named the exception once, keep naming it: `rules` is the member
    // that breaks the general sentence, so the general sentence has to mention it.
    expect(group).toMatch(/Rules/)
  })

  it('warns that switching a promoted module off removes its icon', () => {
    // The one visible consequence on this page that is bigger than "a panel goes
    // away", and the reason the promoted modules are broken out first.
    const group = SRC.slice(SRC.indexOf("id: 'promoted'"), SRC.indexOf("id: 'read'"))
    expect(group).toMatch(/icon/i)
  })
})
