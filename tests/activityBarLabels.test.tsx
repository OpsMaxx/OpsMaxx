// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { useApp } from '../src/renderer/src/store/app'
import { useNav } from '../src/renderer/src/store/nav'
import { defaultModuleState } from '../src/shared/modules'
import { ActivityBar, ACTIVITY_ITEMS } from '../src/renderer/src/components/layout/ActivityBar'

/**
 * The rail says what its buttons are, without being hovered.
 *
 * Reported: "there are no labels for buttons in the left navbar, only
 * tooltips." A tooltip costs a hover and cannot be read while deciding where to
 * go — which is exactly when somebody needs to know what the eleventh icon in a
 * column of fifteen does. Naming them is the fix; the constraint is that the
 * rail is a fixed-width column whose height already overflows on a short
 * window, so a label must not be able to widen it or make a button taller than
 * its neighbours.
 */

const CSS = readFileSync(join(__dirname, '../src/renderer/src/styles/global.css'), 'utf8')
const TOKENS = readFileSync(join(__dirname, '../src/renderer/src/styles/tokens.css'), 'utf8')

/** One CSS rule's body, by selector. Anchored, because `.activitybar {` is also
 *  a substring of `.app-body > .activitybar {`. */
function rule(selector: string): string {
  const at = CSS.search(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{`, 'm'))
  if (at < 0) return ''
  return CSS.slice(at, CSS.indexOf('}', at))
}

beforeEach(() => {
  stubBridge({})
  useApp.setState((st) => ({
    activity: 'connections',
    settings: { ...st.settings, modules: defaultModuleState() }
  }))
  useNav.setState({ monitorTab: 'overview', fleetRail: 'monitor' })
})

const labels = (): string[] =>
  [...document.querySelectorAll('.activity-label')].map((el) => el.textContent ?? '')

describe('every button in the rail says what it is', () => {
  it('prints a label under each icon', () => {
    const { container } = render(<ActivityBar />)
    const buttons = container.querySelectorAll('.activity-btn')
    expect(buttons.length).toBeGreaterThan(8)
    for (const b of buttons) {
      expect(b.querySelector('.activity-label')?.textContent, b.getAttribute('title') ?? '').toBeTruthy()
    }
  })

  it('names the destinations, the two fleet rails and the fixed controls', () => {
    render(<ActivityBar />)
    for (const word of ['Connections', 'Databases', 'Tunnels', 'Monitoring', 'Operations', 'Settings'])
      expect(labels(), word).toContain(word)
  })
})

describe('the label does not replace the sentence', () => {
  /**
   * Every one of these buttons explained itself through `title` and nothing
   * else, and for two of them that sentence is the only thing that says what a
   * red dot means. A visible word is a worse accessible name than the sentence,
   * so the labels are aria-hidden and each button carries the sentence as its
   * aria-label — the name a screen reader reads is unchanged.
   */
  it('keeps the full sentence as the accessible name', () => {
    render(<ActivityBar />)
    expect(screen.getByRole('button', { name: /^Report a bug/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Monitoring — reading the estate/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Operations — changing the estate/ })).toBeTruthy()
  })

  it('keeps the tooltip, which is where the long form still lives', () => {
    render(<ActivityBar />)
    expect(screen.getByTitle('Tunnels & VPN')).toBeTruthy()
    expect(screen.getByTitle(/^Settings/)).toBeTruthy()
  })

  it('hides the visible word from the accessibility tree', () => {
    const { container } = render(<ActivityBar />)
    for (const el of container.querySelectorAll('.activity-label'))
      expect(el.getAttribute('aria-hidden')).not.toBeNull()
  })

  // The palette lists the same destinations in a full-width row, where the
  // honest name fits. `rail` is the rail's shorter form and must not leak.
  it('leaves the palette’s own labels alone', () => {
    expect(ACTIVITY_ITEMS.find((i) => i.id === 'tunnels')?.label).toBe('Tunnels & VPN')
    expect(ACTIVITY_ITEMS.find((i) => i.id === 'http')?.label).toBe('HTTP Client')
  })
})

describe('a label cannot break the column', () => {
  /**
   * The width is measured, not guessed: "Connections" renders at 62px in the
   * rail's own font and size, inside 66px of usable button. A label longer than
   * that ellipsises rather than widening the rail or wrapping to a second line
   * — a two-line label would make one button taller than its neighbours, and
   * the fixed height is what stops the column squashing instead of scrolling.
   */
  it('is capped, on one line, and ellipsised', () => {
    const r = rule('.activity-label')
    expect(r).toMatch(/max-width:\s*100%/)
    expect(r).toMatch(/white-space:\s*nowrap/)
    expect(r).toMatch(/text-overflow:\s*ellipsis/)
    expect(r).toMatch(/overflow:\s*hidden/)
  })

  it('keeps every rail label short enough to have been measured', () => {
    render(<ActivityBar />)
    // "Connections" is the longest at eleven characters and it fits with a few
    // pixels to spare. Anything longer has not been measured, and the rail is
    // not the place to find that out.
    for (const l of labels()) expect(l.length, l).toBeLessThanOrEqual(11)
  })

  it('still gives each button a fixed height, so the rail scrolls rather than squashing', () => {
    const r = rule('.activity-btn')
    expect(r).toMatch(/flex:\s*none/)
    expect(r).toMatch(/height:\s*\d+px/)
  })

  // Grown from 52px, which fit an icon and nothing else.
  it('widened the rail to hold a word', () => {
    const at = TOKENS.indexOf('--activitybar-w:')
    expect(at).toBeGreaterThan(-1)
    const px = Number(TOKENS.slice(at).match(/--activitybar-w:\s*(\d+)px/)?.[1])
    expect(px).toBeGreaterThanOrEqual(78)
  })

  // The invariants the rail already had, restated because this change moved
  // both of the numbers they depend on. See tests/promotedModules.test.tsx.
  it('leaves the scrolling middle able to scroll', () => {
    expect(rule('.activitybar')).toMatch(/min-height:\s*0/)
    expect(rule('.activitybar')).toMatch(/overflow:\s*hidden/)
    expect(rule('.activity-scroll')).toMatch(/overflow-y:\s*auto/)
  })

  /**
   * The dot marks the icon, and the icon is no longer the whole button.
   * `right: 7px` put it in empty space a third of the button away from the
   * thing it was marking once the button grew wider than its icon.
   */
  it('pins the badge to the icon rather than the button’s corner', () => {
    expect(rule('.activity-badge')).toMatch(/left:\s*calc\(50% \+ \d+px\)/)
  })
})
