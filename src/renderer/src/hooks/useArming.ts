import { useCallback, useLayoutEffect, useRef, useState } from 'react'

/** How long a "yes" stays inert after what it would answer appears or moves. */
export const ARM_MS = 750

/**
 * Click-arming for an approve button.
 *
 * An agent can withdraw its request (it disconnects, or cancels the call) and
 * immediately ask something else, so the question under the operator's pointer
 * can change between their deciding and their clicking. For `ARM_MS` after
 * `key` changes — a new request, or a list whose rows just moved — a press on
 * a yes does nothing, and neither does an Enter or Space that went down before
 * the button armed and fired after. Deny, Decide later and the kill switch are
 * never behind this: a mis-aimed no costs nothing.
 *
 * THE CLOCK RESTARTS DURING RENDER, not in an effect. An effect runs after
 * paint, so the render that moved a different request under the pointer was
 * painted armed, with `allow` still measuring from the previous key: a click in
 * that frame counted. Captured here, the new key is inert in the very render
 * that shows it. The timer only exists to re-render once the delay is up.
 *
 * Wire `allow` into the click handler, `noteKey` into onKeyDown, and render
 * `armed` as `aria-disabled` so the inert state is visible and announced.
 */
export function useArming(key: string): {
  armed: boolean
  allow: (e: React.MouseEvent) => boolean
  noteKey: (e: React.KeyboardEvent) => void
} {
  const keyRef = useRef(key)
  const since = useRef(performance.now())
  if (keyRef.current !== key) {
    keyRef.current = key
    since.current = performance.now()
  }
  const keyDownAt = useRef<number | null>(null)
  const [ticks, tick] = useState(0)

  const armed = performance.now() >= since.current + ARM_MS

  // Every render that shows the yes as not armed schedules another render —
  // keyed on what THIS render decided, not on a fresh reading of the clock.
  // A timer can fire a fraction of a millisecond before performance.now()
  // says the delay is up, and the effect runs a moment after the render: with
  // `[key]` alone, or with the effect re-measuring `left`, that render could
  // read "not armed" while the effect found no time left, and nothing ever
  // re-rendered. The yes then stayed inert until something else happened to
  // re-render it. Re-running on `ticks` and `armed` closes both gaps.
  useLayoutEffect(() => {
    if (armed) return
    const left = Math.max(0, Math.ceil(since.current + ARM_MS - performance.now()))
    const t = setTimeout(() => tick((n) => n + 1), left)
    return () => clearTimeout(t)
  }, [key, ticks, armed])

  const allow = useCallback((e: React.MouseEvent): boolean => {
    const armAt = since.current + ARM_MS
    if (performance.now() < armAt) return false
    // `detail` is 0 for a click the keyboard produced. Space fires on keyup,
    // so a press begun before arming can land after it.
    return !(e.detail === 0 && keyDownAt.current !== null && keyDownAt.current < armAt)
  }, [])

  const noteKey = useCallback((e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') keyDownAt.current = performance.now()
  }, [])

  return { armed, allow, noteKey }
}
