import { useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Loader2 } from 'lucide-react'
import { ContextMenu, type MenuEntry } from '../connections/ContextMenu'
import './primitives.css'

export interface SplitButtonProps {
  label: string
  icon?: ReactNode
  onClick: () => void
  entries: MenuEntry[]
  busy?: boolean
  variant: 'primary' | 'danger'
  iconOnly?: boolean
  ariaLabel: string
}

/**
 * A primary action with a menu of related ones beside it: Send ▾, Run ▾.
 * Existing `.btn` classes only. `busy` shows a spinner but does not disable,
 * because a busy Send is the Cancel button.
 */
export function SplitButton({
  label,
  icon,
  onClick,
  entries,
  busy,
  variant,
  iconOnly,
  ariaLabel
}: SplitButtonProps): React.JSX.Element {
  const [menu, setMenu] = useState<DOMRect | null>(null)
  // A press on ▾ while the menu is open closes it through the outside-click
  // handler before the click lands; without this the click would reopen it.
  const wasOpen = useRef(false)
  const cls = `btn ${variant} hc-splitbtn-main`
  return (
    <div className="hc-splitbtn" role="group" aria-label={ariaLabel}>
      <button
        type="button"
        className={cls}
        aria-label={iconOnly ? ariaLabel : undefined}
        title={ariaLabel}
        aria-busy={busy || undefined}
        onClick={onClick}
      >
        {busy ? <Loader2 size={13} className="spin" aria-hidden="true" /> : icon}
        {!iconOnly && <span>{label}</span>}
      </button>
      {entries.length > 0 && (
        <button
          type="button"
          className={`btn ${variant} hc-splitbtn-more`}
          aria-label={`More ${label} options`}
          title={`More ${label} options`}
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          onPointerDown={() => (wasOpen.current = menu !== null)}
          onClick={(e) => {
            const reopen = !wasOpen.current && menu === null
            wasOpen.current = false
            setMenu(reopen ? e.currentTarget.getBoundingClientRect() : null)
          }}
        >
          <ChevronDown size={13} aria-hidden="true" />
        </button>
      )}
      {menu && (
        <ContextMenu x={menu.left} y={menu.bottom} anchor={menu} entries={entries} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}
