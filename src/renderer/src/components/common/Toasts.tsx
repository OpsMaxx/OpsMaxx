import { useCallback } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, Info, AlertTriangle, X } from 'lucide-react'
import { useToasts, useToastSlot } from '../../store/toast'
import { clsx } from '../../lib/format'

/**
 * The place an approval dialog keeps for toasts, directly above itself. See
 * `useToastSlot`.
 *
 * The ref is stable on purpose. An inline callback is a new function every
 * render, and React 19 then runs its cleanup and calls it again — so the AI
 * dialog, which re-renders every second for its countdown, re-registered its
 * slot each tick, and a slot chosen as "last registered" moved the stack into
 * it, under the SSH agent prompt in front of it.
 */
export function ToastSlot(): React.JSX.Element {
  const register = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    useToastSlot.setState((s) => ({ slots: [...s.slots, el] }))
    return () => useToastSlot.setState((s) => ({ slots: s.slots.filter((x) => x !== el) }))
  }, [])
  return <div className="toast-slot" ref={register} />
}

/**
 * The slot in front: the one latest in the document. Both approval scrims sit
 * on the same layer, so the later one paints over the earlier, and toasts in
 * the earlier slot would be behind it.
 */
const frontSlot = (slots: HTMLElement[]): HTMLElement | undefined =>
  slots.reduce<HTMLElement | undefined>(
    (front, el) =>
      !front || front.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING ? el : front,
    undefined
  )

export function Toasts(): React.JSX.Element {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  const slot = useToastSlot((s) => frontSlot(s.slots))
  const stack = (
    <div className={clsx('toasts', slot && 'in-slot')}>
      {toasts.map((t) => (
        <div
          key={t.id}
          className={clsx('toast', t.kind)}
          // A toast with a button is not click-to-dismiss: its whole point is
          // that button, and a stray click on the message should not throw away
          // the only route to fixing the problem. Keyed on the action rather
          // than on `sticky`, because an actionable message now clears itself
          // and would otherwise become click-to-destroy the moment it stopped
          // being permanent.
          onClick={t.sticky || t.action ? undefined : () => dismiss(t.id)}
          role={t.kind === 'error' ? 'alert' : 'status'}
        >
          {t.kind === 'ok' && <CheckCircle2 size={16} style={{ color: 'var(--ok)' }} />}
          {t.kind === 'error' && <AlertTriangle size={16} style={{ color: 'var(--danger)' }} />}
          {t.kind === 'info' && <Info size={16} style={{ color: 'var(--accent-ink)' }} />}
          <span className="grow">{t.message}</span>
          {t.action && (
            <button
              className="btn sm primary"
              style={{ flexShrink: 0 }}
              onClick={(e) => {
                e.stopPropagation()
                dismiss(t.id)
                t.action?.run()
              }}
            >
              {t.action.label}
            </button>
          )}
          {/* Offered whenever the toast cannot be dismissed by clicking it:
              an actionable message clears itself after nine seconds, and this
              is how someone who is done with it gets those nine seconds back. */}
          {(t.sticky || t.action) && (
            <button
              className="icon-btn sm"
              title="Dismiss"
              style={{ flexShrink: 0 }}
              onClick={(e) => {
                e.stopPropagation()
                dismiss(t.id)
              }}
            >
              <X size={14} />
            </button>
          )}
        </div>
      ))}
    </div>
  )
  return slot ? createPortal(stack, slot) : stack
}
