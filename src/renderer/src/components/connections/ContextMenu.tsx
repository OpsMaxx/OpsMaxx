import { Fragment, ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useClickOutside } from '../../hooks/useClickOutside'
import '../common/primitives.css'

export interface MenuEntry {
  label: string
  icon?: ReactNode
  onClick?: () => void
  danger?: boolean
  separator?: boolean
  disabled?: boolean
  /** Shortcut text shown at the right, e.g. "⌘D". A single digit is also a
   *  key: pressing it while the menu is open picks this entry. */
  shortcut?: string
  /** A muted second line under the label: what choosing this does. */
  detail?: string
  /** A checkbox item, or the selected item of a `radio` group. */
  checked?: boolean
  /** Radio group name; the item renders as `menuitemradio`. */
  radio?: string
  /** A non-interactive section header shown above this entry. */
  section?: string
}

interface ContextMenuProps {
  x: number
  y: number
  entries: MenuEntry[]
  onClose: () => void
  /** Open against this element's rect rather than at x/y. */
  anchor?: DOMRect
  /** Where to mount it. A menu opened inside the approval dialog has to live in
   *  that layer, or it paints underneath the dialog it was opened from. */
  container?: Element
  /** A muted closing line under the entries: a fact about all of them. */
  footer?: string
  /** The menu's accessible name. */
  ariaLabel?: string
}

export function ContextMenu({
  x,
  y,
  entries,
  onClose,
  anchor,
  container,
  footer,
  ariaLabel
}: ContextMenuProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const uid = useId()
  useClickOutside(ref, onClose)
  // First paint at the requested point, then corrected against the menu's
  // real size before the browser shows it. A fixed 230×320 estimate put a
  // long menu off the bottom of the window and a short one needlessly high.
  const [[px, py], setPos] = useState<[number, number]>(() =>
    anchor ? [anchor.left, anchor.bottom] : [x, y]
  )
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect()
    setPos(placeMenu({ x, y, anchor }, r.width, r.height, window.innerWidth, window.innerHeight))
  }, [x, y, anchor])
  const checkable = entries.some((e) => e.checked !== undefined || e.radio !== undefined)
  useEffect(() => {
    const onScroll = (): void => onClose()
    window.addEventListener('resize', onScroll)
    return () => window.removeEventListener('resize', onScroll)
  }, [onClose])
  // Reachable from the keyboard: a menu opened with Shift+F10 that focus
  // never entered could only be dismissed. Focus goes to the first item, and
  // back to whatever opened the menu when it closes — but only if nothing else
  // has taken it by then, so "Connect" still lands in the terminal it opened.
  useEffect(() => {
    const node = ref.current
    const opener = document.activeElement as HTMLElement | null
    node?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    return () => {
      const now = document.activeElement
      if (opener?.isConnected && (now === document.body || node?.contains(now))) opener.focus()
    }
  }, [])

  return createPortal(
    <div
      className="menu"
      role="menu"
      aria-label={ariaLabel}
      aria-describedby={footer ? `${uid}-foot` : undefined}
      style={{ top: py, left: px }}
      ref={ref}
      onKeyDown={(e) => {
        // Tab would walk out and leave the menu open behind the focus.
        if (e.key === 'Tab') {
          e.preventDefault()
          onClose()
          return
        }
        // Handled here rather than left to the document listener, so the one
        // press closes the menu and not also the dialog it was opened from.
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose()
          return
        }
        if (/^\d$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const hit = entries.find((x) => x.shortcut === e.key && !x.separator && !x.disabled)
          if (hit) {
            e.preventDefault()
            hit.onClick?.()
            onClose()
          }
          return
        }
        const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
        const i = items.indexOf(document.activeElement as HTMLButtonElement)
        const target =
          e.key === 'ArrowDown'
            ? items[(i + 1) % items.length]
            : e.key === 'ArrowUp'
              ? items[(i - 1 + items.length) % items.length]
              : e.key === 'Home'
                ? items[0]
                : e.key === 'End'
                  ? items[items.length - 1]
                  : null
        if (target === null) return
        e.preventDefault()
        target?.focus()
      }}
    >
      {entries.map((e, i) => (
        <Fragment key={i}>
          {e.section && (
            <div className="menu-label" role="presentation">
              {e.section}
            </div>
          )}
          {e.separator ? (
            <div className="menu-sep" role="separator" />
          ) : (
            <button
              role={e.radio !== undefined ? 'menuitemradio' : e.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={e.radio !== undefined || e.checked !== undefined ? !!e.checked : undefined}
              className={`menu-item${e.danger ? ' danger' : ''}`}
              aria-describedby={e.detail ? `${uid}-${i}` : undefined}
              disabled={e.disabled}
              onClick={() => {
                e.onClick?.()
                onClose()
              }}
            >
              {checkable && (
                <span className="hc-menu-check" aria-hidden="true">
                  {e.checked ? (e.radio !== undefined ? '●' : '✓') : ''}
                </span>
              )}
              {e.icon}
              {e.detail ? (
                <span className="hc-menu-text">
                  <span>{e.label}</span>
                  <span className="hc-menu-detail" id={`${uid}-${i}`} aria-hidden="true">
                    {e.detail}
                  </span>
                </span>
              ) : (
                <span>{e.label}</span>
              )}
              {e.shortcut && (
                <span className="hc-menu-shortcut" aria-hidden="true">
                  {e.shortcut}
                </span>
              )}
            </button>
          )}
        </Fragment>
      ))}
      {footer && (
        <div className="hc-menu-foot" id={`${uid}-foot`} role="presentation">
          {footer}
        </div>
      )}
    </div>,
    container ?? document.body
  )
}

/**
 * Where a menu of this size goes: at the point, or under the anchor (above it
 * when it does not fit below), then kept 8px inside the window.
 */
export function placeMenu(
  at: { x: number; y: number; anchor?: DOMRect },
  w: number,
  h: number,
  vw: number,
  vh: number
): [number, number] {
  const M = 8
  let { x, y } = at
  if (at.anchor) {
    x = at.anchor.left
    y = at.anchor.bottom + h + M > vh && at.anchor.top - h >= M ? at.anchor.top - h : at.anchor.bottom
  }
  return [Math.max(M, Math.min(x, vw - w - M)), Math.max(M, Math.min(y, vh - h - M))]
}
