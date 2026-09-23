import { Fragment, ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  /** Shortcut text shown at the right, e.g. "⌘D". */
  shortcut?: string
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
}

export function ContextMenu({ x, y, entries, onClose, anchor }: ContextMenuProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
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
      style={{ top: py, left: px }}
      ref={ref}
      onKeyDown={(e) => {
        // Tab would walk out and leave the menu open behind the focus.
        if (e.key === 'Tab') {
          e.preventDefault()
          onClose()
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
              <span>{e.label}</span>
              {e.shortcut && (
                <span className="hc-menu-shortcut" aria-hidden="true">
                  {e.shortcut}
                </span>
              )}
            </button>
          )}
        </Fragment>
      ))}
    </div>,
    document.body
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
