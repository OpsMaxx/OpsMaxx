import { createPortal } from 'react-dom'
import { CheckCircle2, Info, AlertTriangle, X } from 'lucide-react'
import { useToasts, useToastSlot } from '../../store/toast'
import { clsx } from '../../lib/format'

/**
 * The place an approval dialog keeps for toasts, directly above itself. See
 * `useToastSlot`. The newest slot wins when two approvals are up at once.
 */
export function ToastSlot(): React.JSX.Element {
  return (
    <div
      className="toast-slot"
      ref={(el) => {
        if (!el) return
        useToastSlot.setState((s) => ({ slots: [...s.slots, el] }))
        return () => useToastSlot.setState((s) => ({ slots: s.slots.filter((x) => x !== el) }))
      }}
    />
  )
}

export function Toasts(): React.JSX.Element {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  const slot = useToastSlot((s) => s.slots.at(-1))
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
