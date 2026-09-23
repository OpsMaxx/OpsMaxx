import { useCallback, useEffect, useRef, useState } from 'react'

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
 * Wire `allow` into the click handler, `noteKey` into onKeyDown, and render
 * `armed` as `aria-disabled` so the inert state is visible and announced.
 */
export function useArming(key: string): {
  armed: boolean
  allow: (e: React.MouseEvent) => boolean
  noteKey: (e: React.KeyboardEvent) => void
} {
  const since = useRef(performance.now())
  const keyDownAt = useRef<number | null>(null)
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    since.current = performance.now()
    setArmed(false)
    const t = setTimeout(() => setArmed(true), ARM_MS)
    return () => clearTimeout(t)
  }, [key])

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
