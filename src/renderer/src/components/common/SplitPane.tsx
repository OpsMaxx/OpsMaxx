import { useLayoutEffect, useRef, type ReactNode } from 'react'
import './primitives.css'

export interface SplitPaneProps {
  orientation: 'horizontal' | 'vertical'
  ratio: number
  onRatio: (ratio: number) => void
  /** Minimum sizes of the two panes, in px. */
  min: [number, number]
  collapsed: 'a' | 'b' | null
  onCollapse: (side: 'a' | 'b' | null) => void
  collapsedA?: ReactNode
  collapsedB?: ReactNode
  children: [ReactNode, ReactNode]
  label: string
  /** The ratio a double-click on the splitter restores. Without it, a double-click does nothing. */
  defaultRatio?: number
  /** Right-click, Shift+F10 or the ContextMenu key on the splitter: the caller's menu, at this point. */
  onMenu?: (at: { x: number; y: number }) => void
}

/** Arrow keys move the splitter by this share. */
export const SPLIT_STEP = 0.05
/** The splitter's own size, in px (its hit area is wider, in CSS). */
export const SPLITTER_PX = 4

/**
 * Keep both panes at or above their minimums. When the container cannot hold
 * both (or has no size, as in a test DOM), the minimums are ignored rather
 * than inverted, and only the ratio's own 5–95% bounds apply.
 */
export function clampRatio(ratio: number, size: number, min: [number, number]): number {
  const lo = size > 0 ? min[0] / size : 0
  const hi = size > 0 ? 1 - (min[1] + SPLITTER_PX) / size : 1
  const r = Math.min(0.95, Math.max(0.05, ratio))
  return lo <= hi ? Math.min(hi, Math.max(lo, r)) : r
}

/**
 * Two panes and a draggable, focusable splitter between them.
 *
 * 'horizontal' is side by side (a left, b right); 'vertical' is stacked (a on
 * top). A collapsed pane keeps its children mounted, hidden, so an editor's
 * undo history and scroll survive a collapse; its bar is shown instead.
 */
export function SplitPane(props: SplitPaneProps): React.JSX.Element {
  const { orientation, ratio, onRatio, min, collapsed, onCollapse, children, label } = props
  const box = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const horizontal = orientation === 'horizontal'
  const panes = useRef<[HTMLDivElement | null, HTMLDivElement | null]>([null, null])
  const sep = useRef<HTMLDivElement>(null)

  // Collapsing the pane that holds focus would drop it on <body>. It goes to
  // the collapsed bar's first control instead, or the splitter.
  useLayoutEffect(() => {
    if (!collapsed) return
    const pane = panes.current[collapsed === 'a' ? 0 : 1]
    // Still inside it here: the browser only moves focus off a hidden element
    // at the next rendering update, after this effect.
    if (!pane?.contains(document.activeElement)) return
    const bar = pane.previousElementSibling?.classList.contains('hc-split-bar') ? pane.previousElementSibling : null
    const target = bar?.querySelector<HTMLElement>('button, [href], input, [tabindex="0"]') ?? sep.current
    target?.focus()
  }, [collapsed])

  const size = (): number => {
    const r = box.current?.getBoundingClientRect()
    return r ? (horizontal ? r.width : r.height) : 0
  }
  const setRatio = (r: number): void => {
    if (collapsed) onCollapse(null)
    onRatio(clampRatio(r, size(), min))
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      if (!props.onMenu) return
      e.preventDefault()
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      props.onMenu({ x: r.left, y: r.bottom })
      return
    }
    const dir =
      e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : 0
    if (dir) {
      e.preventDefault()
      // From a collapsed state an arrow first restores; the next one moves.
      if (collapsed) onCollapse(null)
      else setRatio(ratio + dir * SPLIT_STEP)
    } else if (e.key === 'Home') {
      e.preventDefault()
      onCollapse('a')
    } else if (e.key === 'End') {
      e.preventDefault()
      onCollapse('b')
    }
  }

  const valueNow = collapsed === 'a' ? 0 : collapsed === 'b' ? 100 : Math.round(ratio * 100)
  const pane = (side: 'a' | 'b'): ReactNode => {
    const isCollapsed = collapsed === side
    const other = collapsed !== null && !isCollapsed
    const basis = side === 'a' ? `calc(${ratio * 100}% - ${SPLITTER_PX / 2}px)` : undefined
    return (
      <>
        {isCollapsed && (
          <div className="hc-split-bar">{side === 'a' ? props.collapsedA : props.collapsedB}</div>
        )}
        <div
          ref={(el) => {
            panes.current[side === 'a' ? 0 : 1] = el
          }}
          className="hc-split-pane"
          hidden={isCollapsed}
          style={other || side === 'b' ? { flex: '1 1 0' } : { flex: `0 0 ${basis}` }}
        >
          {children[side === 'a' ? 0 : 1]}
        </div>
      </>
    )
  }

  return (
    <div ref={box} className={`hc-split ${horizontal ? 'hc-split--h' : 'hc-split--v'}`}>
      {pane('a')}
      <div
        ref={sep}
        className="hc-split-sep"
        role="separator"
        tabIndex={0}
        aria-label={label}
        aria-orientation={horizontal ? 'vertical' : 'horizontal'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={valueNow}
        onKeyDown={onKeyDown}
        onDoubleClick={() => {
          if (props.defaultRatio === undefined) return
          if (collapsed) onCollapse(null)
          onRatio(props.defaultRatio)
        }}
        onContextMenu={(e) => {
          if (!props.onMenu) return
          e.preventDefault()
          props.onMenu({ x: e.clientX, y: e.clientY })
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.currentTarget.setPointerCapture?.(e.pointerId)
          dragging.current = true
        }}
        onPointerMove={(e) => {
          if (!dragging.current) return
          const r = box.current!.getBoundingClientRect()
          const s = horizontal ? r.width : r.height
          if (s > 0) setRatio(((horizontal ? e.clientX - r.left : e.clientY - r.top) - SPLITTER_PX / 2) / s)
        }}
        onPointerUp={(e) => {
          dragging.current = false
          e.currentTarget.releasePointerCapture?.(e.pointerId)
        }}
      />
      {pane('b')}
    </div>
  )
}
