import { useCallback, useEffect, useRef, useState } from 'react'
import { X, ChevronDown } from 'lucide-react'
import { clsx } from '../../lib/format'

/**
 * The tab strip.
 *
 * Generic over what a tab IS on purpose: this app has had two tab strips —
 * one for sessions and one for databases — that agreed on every hard part and
 * shared no code. Anything that can describe itself as an id, a title and an
 * optional glyph can be rendered here, so the next surface that wants tabs
 * inherits the keyboard model, the drag behaviour and the overflow handling
 * instead of reimplementing the easy 80% and missing the rest.
 *
 * ── What the accessibility here is actually for ────────────────────────────
 *
 * The previous strip was a `<div onClick>`. That is invisible to the keyboard:
 * no focus, no role, no way to reach a tab without a mouse, and nothing for a
 * screen reader to announce. This follows the ARIA tabs pattern properly —
 * one tab stop for the whole strip, arrows to move within it — which is also
 * simply better with a keyboard, for everybody.
 */

export interface TabStripItem {
  id: string
  title: string
  /** A glyph identifying the KIND of tab. Optional, drawn before the title. */
  icon?: React.ReactNode
  /** Live state — a connection dot, a spinner. Drawn before the icon. */
  status?: React.ReactNode
  /** Overrides the hover tooltip, which is otherwise the title. Use it when
   *  the title is truncated and the full thing is worth reading. */
  tooltip?: string
}

interface TabStripProps {
  items: readonly TabStripItem[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  /** `toIndex` is a position among `items`. */
  onReorder: (id: string, toIndex: number) => void
  onContextMenu: (id: string, x: number, y: number) => void
  /** Named for a screen reader: "Session tabs", "Database tabs". */
  label: string
  /** Trailing controls — the new-tab button and anything beside it. */
  children?: React.ReactNode
}

export function TabStrip({
  items,
  activeId,
  onSelect,
  onClose,
  onReorder,
  onContextMenu,
  label,
  children
}: TabStripProps): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const [dragId, setDragId] = useState<string | null>(null)
  // Where the dragged tab would land, as a gap index: 0 is before the first
  // tab, items.length is after the last. A gap rather than a tab id, because
  // "after the last" is a real destination that no tab id can name.
  const [dropGap, setDropGap] = useState<number | null>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  /**
   * Keep the active tab on screen.
   *
   * Necessary because the strip scrolls and the keyboard can move the
   * selection past either edge: without this, Ctrl+Tab through twenty tabs
   * silently selects tabs nobody can see, which reads as the shortcut being
   * broken. `nearest` rather than `center` so a tab already in view does not
   * make the strip jump under the pointer.
   */
  useEffect(() => {
    if (!activeId) return
    const el = tabRefs.current.get(activeId)
    // Feature-checked like ResizeObserver above, and for the same reason: this
    // component is rendered outside a full browser by the test suite, and a
    // missing scroll helper must not take the strip down with it.
    if (typeof el?.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [activeId])

  /**
   * Whether anything is cut off, which decides if the overflow button shows.
   *
   * Watched rather than computed once: the strip's width changes with the
   * window, the sidebar and the tab count, and a button that appears only
   * after a re-render for some other reason is worse than one that never
   * appears at all.
   */
  useEffect(() => {
    const el = listRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = (): void => setOverflowing(el.scrollWidth > el.clientWidth + 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [items.length])

  /**
   * Arrow keys move within the strip; Home and End jump to its ends.
   *
   * The ARIA tabs pattern, and the reason the whole strip is ONE tab stop:
   * tabbing through twenty tabs to reach the panel behind them is not
   * navigation, it is a punishment.
   */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      const idx = items.findIndex((t) => t.id === activeId)
      if (idx === -1) return
      let next: number | null = null
      if (e.key === 'ArrowRight') next = (idx + 1) % items.length
      else if (e.key === 'ArrowLeft') next = (idx - 1 + items.length) % items.length
      else if (e.key === 'Home') next = 0
      else if (e.key === 'End') next = items.length - 1
      if (next === null) return
      e.preventDefault()
      const target = items[next]
      onSelect(target.id)
      // Focus follows selection here, which the pattern allows for tabs whose
      // panels are already mounted — and every panel here is, because
      // unmounting one would tear down a live session.
      tabRefs.current.get(target.id)?.focus()
    },
    [items, activeId, onSelect]
  )

  /** The gap a pointer at `clientX` is nearest to, for the drop indicator. */
  const gapFor = useCallback(
    (clientX: number): number => {
      let gap = items.length
      for (let i = 0; i < items.length; i++) {
        const el = tabRefs.current.get(items[i].id)
        if (!el) continue
        const box = el.getBoundingClientRect()
        // Past the midpoint belongs to the gap after this tab, which is what
        // makes a drag feel like it is pushing tabs aside rather than
        // snapping to whichever one the pointer happens to be over.
        if (clientX < box.left + box.width / 2) {
          gap = i
          break
        }
      }
      return gap
    },
    [items]
  )

  const finishDrag = useCallback((): void => {
    setDragId(null)
    setDropGap(null)
  }, [])

  return (
    <div className="tabbar">
      <div
        className="tabbar-list"
        ref={listRef}
        role="tablist"
        aria-label={label}
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        onDragOver={(e) => {
          if (!dragId) return
          e.preventDefault()
          setDropGap(gapFor(e.clientX))
        }}
        onDrop={(e) => {
          if (!dragId) return
          e.preventDefault()
          const gap = gapFor(e.clientX)
          const from = items.findIndex((t) => t.id === dragId)
          // A drop into the gap after its own position is where it already is.
          // Reordering anyway would be a no-op that still rewrote the array and
          // re-rendered every tab.
          if (from !== -1 && gap !== from && gap !== from + 1) {
            onReorder(dragId, gap > from ? gap - 1 : gap)
          }
          finishDrag()
        }}
        onDragEnd={finishDrag}
      >
        {items.map((t, i) => {
          const active = t.id === activeId
          return (
            <div key={t.id} className="tab-slot">
              {dropGap === i && <span className="tab-drop" aria-hidden />}
              <button
                ref={(el) => {
                  if (el) tabRefs.current.set(t.id, el)
                  else tabRefs.current.delete(t.id)
                }}
                type="button"
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={active}
                aria-controls={`tabpanel-${t.id}`}
                // Roving tabindex: one stop for the strip, arrows within it.
                tabIndex={active ? 0 : -1}
                className={clsx('tab', active && 'active', dragId === t.id && 'dragging')}
                title={t.tooltip ?? t.title}
                draggable
                onDragStart={(e) => {
                  setDragId(t.id)
                  e.dataTransfer.effectAllowed = 'move'
                  // Firefox refuses to start a drag without payload. The value
                  // is never read — `dragId` is the source of truth, because
                  // dataTransfer cannot be inspected during dragover.
                  e.dataTransfer.setData('text/plain', t.id)
                }}
                onClick={() => onSelect(t.id)}
                onAuxClick={(e) => {
                  // Middle-click closes, as everywhere else. preventDefault
                  // stops the autoscroll cursor appearing over the strip.
                  if (e.button === 1) {
                    e.preventDefault()
                    onClose(t.id)
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  onContextMenu(t.id, e.clientX, e.clientY)
                }}
              >
                {t.status}
                {t.icon}
                <span className="title">{t.title}</span>
                <span
                  // A span, not a button: a button inside a button is invalid
                  // HTML, and browsers recover from it by breaking one of them.
                  // The tab itself carries the role, and closing has its own
                  // keyboard route (Ctrl+W) rather than a second tab stop per
                  // tab, which is what the ARIA pattern advises.
                  role="presentation"
                  className="close"
                  aria-hidden
                  onClick={(e) => {
                    e.stopPropagation()
                    onClose(t.id)
                  }}
                >
                  <X size={13} />
                </span>
              </button>
              {i === items.length - 1 && dropGap === items.length && (
                <span className="tab-drop" aria-hidden />
              )}
            </div>
          )
        })}
      </div>

      {/**
       * The overflow list, shown only when something is actually cut off.
       *
       * A scrolling strip alone is not enough: with twenty tabs the ones off
       * the end are unreachable except by scrolling blind, and the tab you
       * want is exactly the one you cannot see. This lists every tab by name.
       */}
      {overflowing && (
        <div className="tab-overflow">
          <button
            type="button"
            className="tab-new"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={`All tabs (${items.length})`}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <ChevronDown size={16} />
          </button>
          {menuOpen && (
            <>
              {/* Catches the click that dismisses the menu, including one on
                  another tab — without it the menu would stay open behind the
                  panel it just switched to. */}
              <div className="tab-overflow-scrim" onClick={() => setMenuOpen(false)} />
              <div className="tab-overflow-menu" role="menu">
                {items.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="menuitem"
                    className={clsx('tab-overflow-item', t.id === activeId && 'active')}
                    onClick={() => {
                      onSelect(t.id)
                      setMenuOpen(false)
                    }}
                  >
                    {t.icon}
                    <span className="title">{t.title}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {children}
    </div>
  )
}
