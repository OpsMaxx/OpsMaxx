import type { CSSProperties } from 'react'
import { clsx } from '../../lib/format'

/**
 * The on/off toggle, as a control.
 *
 * `.switch` used to be drawn on a bare `<span onClick>` at every call site: no
 * role, no tab stop, no key handling, so a module could not be switched on or
 * off without a mouse and a screen reader announced nothing at all. A few gates
 * in the VPN flows had grown their own role/tabIndex/onKeyDown copies; the rest
 * never did.
 *
 * A `<button role="switch">` gets all of it from the platform: it is focusable,
 * Space and Enter press it, `disabled` removes it from the tab order, and the
 * global `:focus-visible` ring draws on it. Inside a `<label>` it is also that
 * label's control, so clicking the words beside it toggles it too.
 *
 * `label` names it for assistive technology where no wrapping `<label>` does.
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  className,
  style,
  tabIndex
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label?: string
  disabled?: boolean
  className?: string
  style?: CSSProperties
  tabIndex?: number
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      tabIndex={tabIndex}
      className={clsx('switch', checked && 'on', disabled && 'disabled', className)}
      style={style}
      onClick={() => onChange(!checked)}
    />
  )
}
