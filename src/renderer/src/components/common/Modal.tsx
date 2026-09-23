import { ReactNode, RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { approvalShowing, useClickOutside } from '../../hooks/useClickOutside'
import { clsx } from '../../lib/format'

/**
 * The one dialog primitive.
 *
 * It was already the container five of the seven add-flows used; what differed
 * between them was everything inside it. Two nested a bordered `.card` in the
 * body and put their own action row at the bottom of THAT, which is how the
 * confirm button ended up mid-left in one dialog and bottom-right in the next.
 * A third put its actions in the body, so on a long config both the button and
 * the sentence explaining why it was disabled started out below the fold.
 *
 * So the footer stops being something a caller composes. `confirm` and
 * `cancelLabel` describe the two buttons every one of these dialogs has, and
 * this decides where they go and what they look like: right-aligned under a
 * divider, primary 28px accent, secondary 28px bordered, no icons on either.
 * `footer` remains for the handful of dialogs that genuinely need a third
 * control, and it lands in the same right-aligned row.
 *
 * Icons are off the text CTAs on purpose. "＋ Create" and "Import profile" and
 * "Save" were the same act in three costumes; a glyph on one and not the next
 * makes two buttons that do the same thing look like two different things.
 */

interface ConfirmAction {
  label: string
  onClick: () => void
  /** Off until the form is valid. The sentence saying WHY belongs under the
   *  offending field — see `Field` — not in the button's tooltip. */
  disabled?: boolean
  /** Destructive and irreversible: a filled red button rather than an
   *  outlined one. Reversible destructive actions do not qualify. */
  destructive?: boolean
}

interface ModalProps {
  title: string
  subtitle?: string
  onClose: () => void
  children: ReactNode
  /** The commit. Rendered as the last thing in the footer, always. */
  confirm?: ConfirmAction
  /** Defaults to "Cancel". Pass `null` for a dialog that has no way back —
   *  there is currently none, and one should have to say so. */
  cancelLabel?: string | null
  /** A sentence at the left of the footer: what the dialog is waiting on, or
   *  what it found. Never the reason a field is wrong. */
  footerNote?: ReactNode
  /** Extra controls, to the left of Cancel. Use `confirm` for the commit. */
  footer?: ReactNode
  size?: 'md' | 'lg'
  /**
   * Which layer this dialog belongs on. Higher wins, whatever the order the
   * two were opened in and whatever order they sit in the tree.
   *
   * Only one dialog in the app sets it: the second-factor prompt, which the
   * vault dialog used to cover completely. Both render the same `.scrim`, and
   * `.scrim` carries one z-index for all of them, so stacking fell through to
   * DOM order -- and App.tsx happens to mount the vault dialog after the
   * prompt. The user was then looking at "Vault locked" while a live SSH
   * challenge with a 135-second fuse sat underneath it, unanswerable, until
   * the connection died with "the challenge was not answered in time".
   *
   * A dialog that something is WAITING ON outranks one that merely needs
   * doing. That is the whole rule, and it is a property of the dialog rather
   * than of where somebody put it in the tree.
   */
  priority?: number
  /**
   * False for a dialog that must not be closed by a stray Escape or a click
   * that lands outside it. Defaults to true, which is right for every dialog
   * whose close does nothing but close it.
   *
   * The second-factor prompt is not one of those: closing it REPLIES to the
   * server with an empty answer, which is a wrong second factor and spends one
   * of the host's MaxAuthTries. See SshPrompt's `cancel`.
   */
  dismissible?: boolean
}

// ---------------------------------------------------------------- layering
//
// Every dialog renders `.scrim`, which is `position: fixed` with a single
// z-index, so two open at once stack by DOM order and the document-level
// Escape and outside-click handlers of BOTH of them fire on one keypress.
// This is the list that decides which one is actually in front, and therefore
// which one those handlers belong to.
//
// A module-level array rather than context: `Modal` is used from thirty places
// and several of them are mounted outside any provider a context would need,
// and the thing being tracked is genuinely global -- there is one screen.

interface OpenModal {
  id: number
  priority: number
}

const openModals: OpenModal[] = []
const layerListeners = new Set<() => void>()
let nextModalId = 1

const announceLayers = (): void => {
  for (const l of layerListeners) l()
}

/** Open dialogs, lowest layer first. Priority decides, then the order they opened. */
const byLayer = (): OpenModal[] =>
  openModals
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.priority - b.m.priority || a.i - b.i)
    .map(({ m }) => m)

/**
 * This dialog's place in the stack: what to paint at, and whether the keyboard
 * and the mouse belong to it.
 *
 * Registration happens in an effect, so on the very first render this dialog
 * is not in the list yet. That case is treated as "on top", which is what it
 * is about to be -- reporting it as covered would arm nothing and paint it at
 * the bottom for a frame.
 */
function useModalLayer(priority: number): { layer: number; top: boolean } {
  const idRef = useRef(0)
  if (idRef.current === 0) idRef.current = nextModalId++
  const id = idRef.current
  const [, bump] = useState(0)

  useEffect(() => {
    const listener = (): void => bump((n) => n + 1)
    layerListeners.add(listener)
    return () => {
      layerListeners.delete(listener)
    }
  }, [])

  useEffect(() => {
    openModals.push({ id, priority })
    announceLayers()
    return () => {
      const i = openModals.findIndex((m) => m.id === id)
      if (i !== -1) openModals.splice(i, 1)
      announceLayers()
    }
  }, [id, priority])

  const order = byLayer()
  const pos = order.findIndex((m) => m.id === id)
  /**
   * `.scrim` paints at `--z-modal` plus this; these ride on top of it in the
   * same space.
   *
   * The headroom above is `--z-menu`, fifty steps up, so this has room for fifty open
   * dialogs before it would reach something else — and `priority` costs one
   * step, not a band, for the same reason. If a design ever wants real bands here,
   * raise `--z-menu` rather than widening the multiplier.
   */
  return { layer: pos < 0 ? order.length : pos, top: pos < 0 || pos === order.length - 1 }
}

// ---------------------------------------------------------------- focus
//
// A dialog that focus never entered was answered by whatever still had it:
// the production confirm opened from ⌘↵ in an editor, and the next ⌘↵ sent
// again instead of answering it. So focus goes in when the dialog opens,
// Tab stays inside it while it is in front, and focus goes back to whatever
// opened it when it closes -- unless something else has already taken it,
// such as the tab a Save just created.

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), ' +
  'textarea:not(:disabled), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'

const focusables = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest('[hidden]'))

/**
 * Where focus lands when a dialog opens: wherever an autoFocus already put it,
 * else the confirm button -- or Cancel, when the confirm is destructive, so
 * that a reflexive Enter cannot delete or send to production -- else the
 * dialog itself.
 */
function initialFocus(dialog: HTMLElement): HTMLElement {
  const footer = dialog.querySelector('.modal-footer')
  const confirm = footer?.querySelector<HTMLButtonElement>('button.primary:not(:disabled), button.danger:not(:disabled)')
  const cancel = footer?.querySelector<HTMLButtonElement>('button.secondary:not(:disabled)')
  if (confirm?.classList.contains('danger')) return cancel ?? confirm
  return confirm ?? dialog
}

function useDialogFocus(ref: RefObject<HTMLDivElement | null>, top: boolean): void {
  // Read during the first render, before any autoFocus inside the dialog runs.
  const [opener] = useState(() => document.activeElement as HTMLElement | null)
  const topRef = useRef(top)
  topRef.current = top

  useLayoutEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (!dialog.contains(document.activeElement)) initialFocus(dialog).focus()
    return () => {
      const now = document.activeElement
      if (opener?.isConnected && opener !== document.body && (now === document.body || now === null || dialog.contains(now))) {
        opener.focus()
      }
    }
    // Mount and unmount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const dialog = ref.current
      if (e.key !== 'Tab' || !dialog || !topRef.current || approvalShowing()) return
      const items = focusables(dialog)
      if (items.length === 0) {
        e.preventDefault()
        dialog.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const at = document.activeElement as HTMLElement | null
      // A menu, popover or toast painted over the dialog handles its own Tab.
      if (at?.closest('[role="menu"], .hc-popover, .toasts')) return
      const inside = !!at && dialog.contains(at)
      if (!inside || (e.shiftKey && at === first) || (!e.shiftKey && at === last)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [ref])
}

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  confirm,
  cancelLabel = 'Cancel',
  footerNote,
  footer,
  size = 'md',
  priority = 0,
  dismissible = true
}: ModalProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const { layer, top } = useModalLayer(priority)
  // Only the dialog in front. Both of these listen on `document`, so without
  // the guard one Escape closes every open dialog at once -- including ones
  // the user cannot see, whose close is not always harmless.
  useClickOutside(ref, onClose, dismissible && top)
  useDialogFocus(ref, top)
  const hasFooter = confirm !== undefined || footer !== undefined || footerNote !== undefined
  return (
    <div className="scrim" style={{ '--modal-layer': layer } as React.CSSProperties}>
      <div className={clsx('modal', size === 'lg' && 'lg')} ref={ref} role="dialog" aria-modal tabIndex={-1}>
        <div className="modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <div className="sub">{subtitle}</div>}
          </div>
          <button className="icon-btn close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {hasFooter && (
          <div className="modal-footer">
            {footerNote !== undefined && <span className="footer-note">{footerNote}</span>}
            {footer}
            {cancelLabel !== null && (
              <button className="btn secondary size-28" onClick={onClose}>
                {cancelLabel}
              </button>
            )}
            {confirm && (
              <button
                className={clsx(
                  'btn size-28',
                  confirm.destructive ? 'danger fill' : 'primary'
                )}
                disabled={confirm.disabled}
                onClick={confirm.onClick}
              >
                {confirm.label}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

interface FieldProps {
  label: ReactNode
  /** Marked in the label, at rest. A required field discovered by pressing a
   *  disabled button and reading a banner is a field the form hid. */
  required?: boolean
  /** What is wrong with what is currently in the control. Rendered directly
   *  under it, and it puts the danger border on the control itself. */
  error?: string | null
  /** Shown when there is no error. Both would be two competing sentences in
   *  the same slot. */
  hint?: ReactNode
  children: ReactNode
}

/**
 * A labelled control with its validation attached to it.
 *
 * The frp publish dialog was the only one of the seven that said what was
 * wrong beside the thing that was wrong; the rest either said nothing, put a
 * banner at the top of the body, or waited for the submit to fail. The
 * difference was never conviction — it was that doing it the good way meant
 * threading a conditional class into the <input> and remembering the danger
 * colour. Here it is one prop.
 */
export function Field({ label, required, error, hint, children }: FieldProps): React.JSX.Element {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {required && <span className="field-req">Required</span>}
      </span>
      <span className={clsx('field-control', error && 'invalid')}>{children}</span>
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : (
        hint && <span className="field-hint">{hint}</span>
      )}
    </label>
  )
}
