import type { ReactNode } from 'react'

/**
 * A tooltip that survives its control being disabled.
 *
 * ===========================================================================
 * WHY A WRAPPER AND NOT JUST `title` ON THE BUTTON
 * ===========================================================================
 *
 * Chromium does not dispatch mouse events to a disabled form control, so its
 * `title` never fires. That is fine when the tooltip says what the button
 * DOES — losing it while the button cannot be pressed costs nothing. It is
 * exactly wrong when the tooltip says WHY IT IS DISABLED, because the sentence
 * becomes unreachable at the only moment it is worth reading.
 *
 * That is how a control comes to look broken rather than unavailable: full
 * opacity, highlights under the pointer, says nothing, does nothing. The
 * Kubernetes exec button was reported that way, and its `title` was the only
 * thing that explained the rule behind it.
 *
 * A span is not disabled, so it still receives the hover.
 *
 * USE THIS when the explanation is about the disabled state. An ordinary
 * `title` is still right for a control that is always live, or where the
 * tooltip only describes the action.
 */
export function Explain({
  why,
  children
}: {
  why: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <span title={why} style={{ display: 'inline-flex' }}>
      {children}
    </span>
  )
}
