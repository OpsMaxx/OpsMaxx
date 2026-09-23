import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useClickOutside } from '../../hooks/useClickOutside'
import './primitives.css'

export interface PopoverProps {
  anchor: DOMRect | null
  open: boolean
  onClose: () => void
  children: ReactNode
  placement?: 'below' | 'above'
  /** Names the popover for assistive technology. */
  ariaLabel?: string
}

/** Where a popover of this size goes against its anchor, kept 8px inside the window. */
export function placePopover(
  anchor: DOMRect,
  placement: 'below' | 'above',
  w: number,
  h: number,
  vw: number,
  vh: number
): [number, number] {
  const M = 8
  const GAP = 4
  const below = anchor.bottom + GAP
  const above = anchor.top - GAP - h
  const fitsBelow = below + h + M <= vh
  const fitsAbove = above >= M
  const y = placement === 'above' ? (fitsAbove || !fitsBelow ? above : below) : fitsBelow || !fitsAbove ? below : above
  return [Math.max(M, Math.min(anchor.left, vw - w - M)), Math.max(M, Math.min(y, vh - h - M))]
}

/**
 * A floating panel against an anchor rect: a portal at `--z-popover`, closed
 * by Escape or a press outside it. It does not move focus in, because some
 * popovers (the variable card) open on hover; when it closes with focus inside
 * it, focus goes back to whatever had it when it opened.
 */
export function Popover({
  anchor,
  open,
  onClose,
  children,
  placement = 'below',
  ariaLabel
}: PopoverProps): React.JSX.Element | null {
  if (!open || !anchor) return null
  return (
    <PopoverBody anchor={anchor} onClose={onClose} placement={placement} ariaLabel={ariaLabel}>
      {children}
    </PopoverBody>
  )
}

function PopoverBody({
  anchor,
  onClose,
  children,
  placement,
  ariaLabel
}: {
  anchor: DOMRect
  onClose: () => void
  children: ReactNode
  placement: 'below' | 'above'
  ariaLabel?: string
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useClickOutside(ref, onClose)
  const [[x, y], setPos] = useState<[number, number]>([anchor.left, anchor.bottom + 4])
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect()
    setPos(placePopover(anchor, placement, r.width, r.height, window.innerWidth, window.innerHeight))
  }, [anchor, placement])
  useLayoutEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const node = ref.current
    return () => {
      const now = document.activeElement
      if (opener?.isConnected && (now === document.body || node?.contains(now))) opener.focus()
    }
  }, [])
  return createPortal(
    <div ref={ref} className="hc-popover" role="dialog" aria-label={ariaLabel} style={{ left: x, top: y }}>
      {children}
    </div>,
    document.body
  )
}
