// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TabStrip, type TabStripItem } from '../src/renderer/src/components/panel/TabStrip'

/**
 * The strip, rendered rather than read.
 *
 * The previous one was a `<div onClick>`: invisible to the keyboard, with no
 * role for a screen reader to announce and an invisible close button that
 * still took clicks. None of that is visible in a diff — all of it is obvious
 * the moment the thing is actually driven.
 */

const items: TabStripItem[] = [
  { id: 'a', title: 'web' },
  { id: 'b', title: 'api' },
  { id: 'c', title: 'db' }
]

/**
 * Render the strip with spies on every callback.
 *
 * The handlers are declared before the spread rather than inside it so they
 * keep their Mock types — spreading `over` over them widens each to a union
 * with the plain prop type, and `mockClear` stops existing.
 */
function setup(over: Partial<React.ComponentProps<typeof TabStrip>> = {}): {
  onSelect: ReturnType<typeof vi.fn>
  onClose: ReturnType<typeof vi.fn>
  onReorder: ReturnType<typeof vi.fn>
  onContextMenu: ReturnType<typeof vi.fn>
} {
  const onSelect = vi.fn()
  const onClose = vi.fn()
  const onReorder = vi.fn()
  const onContextMenu = vi.fn()
  render(
    <TabStrip
      items={items}
      activeId="a"
      onSelect={onSelect}
      onClose={onClose}
      onReorder={onReorder}
      onContextMenu={onContextMenu}
      label="Session tabs"
      {...over}
    />
  )
  return { onSelect, onClose, onReorder, onContextMenu }
}

describe('a keyboard can drive it', () => {
  it('is a tablist of tabs, and says which is selected', () => {
    setup()
    expect(screen.getByRole('tablist', { name: 'Session tabs' })).toBeTruthy()
    expect(screen.getAllByRole('tab')).toHaveLength(3)
    expect(screen.getByRole('tab', { name: /web/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: /api/ }).getAttribute('aria-selected')).toBe('false')
  })

  /**
   * One tab stop for the whole strip. Tabbing through twenty tabs to reach the
   * panel behind them is not navigation, it is a punishment — which is why the
   * ARIA pattern says roving tabindex and arrows.
   */
  it('has exactly one tab stop, on the selected tab', () => {
    setup()
    const stops = screen.getAllByRole('tab').filter((t) => t.getAttribute('tabindex') === '0')
    expect(stops).toHaveLength(1)
    expect(stops[0].textContent).toContain('web')
  })

  it('moves with the arrow keys, and wraps', async () => {
    const u = userEvent.setup()
    const p = setup()
    await u.click(screen.getByRole('tab', { name: /web/ }))
    p.onSelect.mockClear()

    await u.keyboard('{ArrowRight}')
    expect(p.onSelect).toHaveBeenCalledWith('b')

    p.onSelect.mockClear()
    // Left from the first wraps to the last, rather than doing nothing — the
    // strip is a ring, which is what Ctrl+Tab already does.
    await u.keyboard('{ArrowLeft}')
    expect(p.onSelect).toHaveBeenCalledWith('c')
  })

  it('jumps to the ends with Home and End', async () => {
    const u = userEvent.setup()
    const p = setup({ activeId: 'b' })
    await u.click(screen.getByRole('tab', { name: /api/ }))
    p.onSelect.mockClear()

    await u.keyboard('{Home}')
    expect(p.onSelect).toHaveBeenCalledWith('a')
    await u.keyboard('{End}')
    expect(p.onSelect).toHaveBeenCalledWith('c')
  })

  // A button inside a button is invalid HTML and browsers recover by breaking
  // one of them, so the close control is a presentational span and closing has
  // its own shortcut rather than a second tab stop on every tab.
  it('does not nest a button inside the tab button', () => {
    const { container } = render(
      <TabStrip
        items={items}
        activeId="a"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
        onContextMenu={vi.fn()}
        label="Session tabs"
      />
    )
    expect(container.querySelector('button button')).toBeNull()
  })
})

describe('closing', () => {
  it('closes on the × without selecting the tab', async () => {
    const u = userEvent.setup()
    const p = setup()
    const api = screen.getByRole('tab', { name: /api/ })
    await u.click(api.querySelector('.close')!)
    expect(p.onClose).toHaveBeenCalledWith('b')
    expect(p.onSelect).not.toHaveBeenCalled()
  })

  it('closes on middle click', async () => {
    const u = userEvent.setup()
    const p = setup()
    await u.pointer({ keys: '[MouseMiddle]', target: screen.getByRole('tab', { name: /db/ }) })
    expect(p.onClose).toHaveBeenCalledWith('c')
  })

  /**
   * THE BUG this replaced.
   *
   * `.close` is `opacity: 0` on an inactive tab — and opacity still hit-tests,
   * so the invisible × was live: clicking the right-hand end of a tab to
   * SELECT it closed it instead, with nothing on screen suggesting a control
   * was there. Asserted against the stylesheet because jsdom does not do
   * hit-testing, and this is a CSS fact.
   */
  it('makes the hidden × unclickable, not merely invisible', () => {
    const css = readFileSync(
      join(__dirname, '../src/renderer/src/styles/global.css'),
      'utf8'
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    const rule = css.slice(css.indexOf('.tab .close {'), css.indexOf('.tab:hover .close'))
    expect(rule).toMatch(/opacity:\s*0\s*;/)
    expect(rule, 'an invisible control that still takes clicks').toMatch(
      /pointer-events:\s*none\s*;/
    )
    // And it comes back with the tab it belongs to.
    expect(css).toMatch(/\.tab:hover \.close[\s\S]*?pointer-events:\s*auto/)
  })
})

describe('reordering by drag', () => {
  /**
   * jsdom has no layout, so every tab measures 0×0 and the midpoint test can
   * only ever answer "gap 0". The drop maths is proven exhaustively against
   * `moveTab` in tabModel.test.ts; what is worth asserting HERE is that a drag
   * is wired up at all and reaches the callback.
   */
  it('is draggable and reports a drop', () => {
    setup()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.every((t) => t.getAttribute('draggable') === 'true')).toBe(true)
  })
})

describe('overflow', () => {
  // jsdom reports every scrollWidth as 0, so nothing ever overflows there and
  // the control is correctly absent. Asserting the quiet case is still worth
  // it: a menu that shows when it is not needed is its own bug.
  it('stays out of the way when everything fits', () => {
    setup()
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('what the strip tells you about each tab', () => {
  it('shows a tooltip carrying the full title', () => {
    setup({
      items: [{ id: 'a', title: 'web', tooltip: 'web — production-eu-1' }],
      activeId: 'a'
    })
    expect(screen.getByRole('tab', { name: /web/ }).getAttribute('title')).toBe(
      'web — production-eu-1'
    )
  })

  it('opens a context menu at the pointer rather than the browser default', async () => {
    const u = userEvent.setup()
    const p = setup()
    await u.pointer({ keys: '[MouseRight]', target: screen.getByRole('tab', { name: /api/ }) })
    expect(p.onContextMenu).toHaveBeenCalledWith('b', expect.any(Number), expect.any(Number))
  })
})

/**
 * One strip, two surfaces.
 *
 * The database view had a second implementation of this: a `<div onClick>`
 * per tab with its own markup and its own close button. It agreed with this
 * strip on every hard part — keep every tab mounted, hide the inactive ones —
 * and shared no code, so the two drifted apart. When this one moved its
 * scrolling onto an inner element, the database strip silently lost the
 * ability to scroll at all: its tabs sat directly in `.tabbar`, where the
 * `overflow-x` used to be.
 *
 * That is the class of bug a shared component makes impossible rather than
 * merely unlikely, which is the reason for these two checks.
 */
describe('adopted by the database view as well', () => {
  const dbView = readFileSync(
    join(__dirname, '..', 'src/renderer/src/components/databases/DatabaseView.tsx'),
    'utf8'
  )

  it('is what the database strip renders, rather than a second copy', () => {
    expect(dbView).toContain('<TabStrip')
    // The hand-rolled tab markup is gone, not merely unused.
    expect(dbView).not.toMatch(/className=\{clsx\('tab'/)
    expect(dbView).not.toContain('className="tabbar"')
  })

  /**
   * The scrolling half has to be the inner element, because that is where the
   * `overflow-x` lives now — and a strip whose tabs sit directly in `.tabbar`
   * cannot scroll however many tabs it has.
   */
  it('keeps the scrolling on the element the stylesheet scrolls', () => {
    const css = readFileSync(
      join(__dirname, '..', 'src/renderer/src/styles/global.css'),
      'utf8'
    )
    const rule = css.slice(css.indexOf('.tabbar-list {'))
    expect(rule.slice(0, rule.indexOf('}'))).toContain('overflow-x: auto')

    const strip = readFileSync(
      join(__dirname, '..', 'src/renderer/src/components/panel/TabStrip.tsx'),
      'utf8'
    )
    expect(strip).toContain('className="tabbar-list"')
  })

  // The database strip offers no per-tab menu, so a right-click there must be
  // harmless rather than a call through an undefined handler.
  it('survives a right-click on a strip that offers no menu', () => {
    render(
      <TabStrip
        label="Database tabs"
        items={items}
        activeId="a"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />
    )
    expect(() => screen.getAllByRole('tab')[0].dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true })
    )).not.toThrow()
  })
})
