import type { ModuleDef, ModuleId } from '../../../../shared/modules'

// Which module tabs stand in the strip, and which fall behind `More`.
//
// A pure function beside FleetMonitor rather than inside it, on the precedent
// of hostHealth.ts in this directory: FleetMonitor pulls in the whole app store
// and every panel in the product, so a rule expressed inside it can only be
// exercised by mounting all of that. The rule here is small and it is the one
// thing about the strip that can be silently wrong, so it is worth being able
// to state on its own — see tests/monitorTabStrip.test.ts.
//
// The rule, and the reason it is not just `slice(0, n)`:
//
// THE SELECTED TAB IS ALWAYS IN THE STRIP. An overflow whose contents depend
// only on registry order will happily swallow the tab you are looking at, and
// then the page you are on is named nowhere on screen — which is the defect
// the ceiling was introduced to fix, reintroduced by the fix. Picking something
// out of `More` promotes it into the row instead.
//
// What a promotion evicts is the LAST tab of the head, not the first. Registry
// order runs cheapest-and-most-used first, so the tab furthest down it is the
// one least likely to be missed while somebody is reading another one.

export interface TabStrip {
  /** Shown in the row, in order. */
  head: ModuleDef[]
  /** Everything else, shown behind the overflow control. */
  rest: ModuleDef[]
}

/**
 * @param tabs      Enabled read modules, in registry order.
 * @param active    The selected tab. Fixed tabs (`overview`, `alerts`) are
 *                  passed through as themselves and simply never match a
 *                  module, which is correct: they have their own buttons and
 *                  are never candidates for the overflow.
 * @param slots     How many module buttons the row has room for. Zero or fewer
 *                  puts everything behind the overflow rather than throwing —
 *                  a strip with no room is a rendering question, not an error.
 */
export function splitTabStrip(
  tabs: ModuleDef[],
  active: 'overview' | 'alerts' | ModuleId,
  slots: number
): TabStrip {
  if (slots <= 0) return { head: [], rest: [...tabs] }
  const head = tabs.slice(0, slots)
  if (head.some((m) => m.id === active)) return { head, rest: tabs.slice(slots) }
  const selected = tabs.find((m) => m.id === active)
  // Nothing to promote: either a fixed tab is selected, or the selected module
  // is not enabled at all. FleetMonitor's own guard has already fallen back to
  // Overview in the second case; this stays correct either way rather than
  // depending on that.
  if (!selected) return { head, rest: tabs.slice(slots) }
  const promoted = [...head.slice(0, slots - 1), selected]
  return { head: promoted, rest: tabs.filter((m) => !promoted.some((p) => p.id === m.id)) }
}
