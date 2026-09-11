import { useCallback, useRef, useState } from 'react'

/**
 * A draggable divider, in the one shape every divider in this app needs.
 *
 * The sidebar grew this inline and it stayed inline for as long as there was
 * one of them. The database view needs two — a schema column that widens and a
 * query editor that gets taller — and three copies of a pointer-capture dance
 * is where a copy starts drifting from its siblings.
 *
 * Clamped rather than free. A divider dragged to zero leaves a pane the user
 * cannot get back without knowing to drag an invisible edge, and one dragged
 * past the window leaves the other pane in the same state; `min` and `max` are
 * the difference between a resizable layout and a layout somebody can break.
 */
export function useDragSize(
  initial: number,
  opts: {
    min: number
    max: number
    /** 'x' widens to the right, 'y' grows downward. */
    axis?: 'x' | 'y'
    /** Called once when the drag ends, for callers that persist the result. */
    onCommit?: (value: number) => void
  }
): {
  size: number
  dragging: boolean
  onMouseDown: (e: React.MouseEvent) => void
} {
  const { min, max, axis = 'x', onCommit } = opts
  const [size, setSize] = useState(initial)
  const [dragging, setDragging] = useState(false)
  // Read by the listeners, which are registered once per drag and would
  // otherwise close over the size at mousedown.
  const latest = useRef(initial)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Without this the drag selects the text under the cursor, which is what
      // makes a hand-rolled divider feel broken rather than merely plain.
      e.preventDefault()
      setDragging(true)
      const start = axis === 'x' ? e.clientX : e.clientY
      const from = latest.current

      const move = (ev: MouseEvent): void => {
        const delta = (axis === 'x' ? ev.clientX : ev.clientY) - start
        const next = Math.min(max, Math.max(min, from + delta))
        latest.current = next
        setSize(next)
      }
      const up = (): void => {
        setDragging(false)
        document.removeEventListener('mousemove', move)
        document.removeEventListener('mouseup', up)
        onCommit?.(latest.current)
      }
      document.addEventListener('mousemove', move)
      document.addEventListener('mouseup', up)
    },
    [axis, min, max, onCommit]
  )

  return { size, dragging, onMouseDown }
}
