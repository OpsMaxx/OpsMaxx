import { ReactNode, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useClickOutside } from '../../hooks/useClickOutside'

export interface MenuEntry {
  label: string
  icon?: ReactNode
  onClick?: () => void
  danger?: boolean
  separator?: boolean
  disabled?: boolean
}

interface ContextMenuProps {
  x: number
  y: number
  entries: MenuEntry[]
  onClose: () => void
}

export function ContextMenu({ x, y, entries, onClose }: ContextMenuProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useClickOutside(ref, onClose)
  const [px, py] = clamp(x, y)
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
      {entries.map((e, i) =>
        e.separator ? (
          <div className="menu-sep" role="separator" key={i} />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`menu-item${e.danger ? ' danger' : ''}`}
            disabled={e.disabled}
            onClick={() => {
              e.onClick?.()
              onClose()
            }}
          >
            {e.icon}
            <span>{e.label}</span>
          </button>
        )
      )}
    </div>,
    document.body
  )
}

function clamp(x: number, y: number): [number, number] {
  const menuW = 230
  const menuH = 320
  const px = Math.min(x, window.innerWidth - menuW - 8)
  const py = Math.min(y, window.innerHeight - menuH - 8)
  return [Math.max(8, px), Math.max(8, py)]
}
