import { create } from 'zustand'

export type ToastKind = 'info' | 'ok' | 'error'

/** The thing to do about it.
 *
 *  A message that tells someone to go and do something, without giving them a
 *  way to do it, has handed them a research task. "Unlock the vault and try
 *  again" means: find the vault, work out what a vault is, unlock it, come back,
 *  and remember what you were doing. The button removes all of that. */
export interface ToastAction {
  label: string
  run: () => void
}

export interface ToastOptions {
  /** Keep this message until it is dismissed, whatever its kind.
   *
   *  For the rare non-error that must not be missed — the kill switch summary
   *  is the one that earns it. Reach for it only when the message reports
   *  something irreversible that the reader has to see. */
  sticky?: boolean
}

export interface Toast {
  id: number
  kind: ToastKind
  message: string
  action?: ToastAction
  /** Errors stay until dismissed; everything else goes away by itself.
   *
   *  Having a button is NOT what makes a message worth keeping. This used to
   *  read `kind === 'error' || action !== undefined`, which made every
   *  acknowledgement carrying a convenience link permanent: "An AI agent
   *  changed the server web-01." with a Show it button sat there until clicked,
   *  while the same sentence about a removal — no button — faded in three
   *  seconds. Stacked up over a session that is a wall of notices nobody asked
   *  to keep. A button buys a longer window to reach it, not immortality. */
  sticky: boolean
}

let tid = 0

// Long enough to read a sentence, short enough not to sit in the way.
const AUTO_DISMISS_MS = 3200

// A message with a button has to be noticed AND reached. 3.2s is enough to read
// a sentence and not enough to decide to click something at the other end of
// it, so an actionable message gets a window sized for the click rather than
// for the reading.
const ACTION_DISMISS_MS = 9000

interface ToastState {
  toasts: Toast[]
  push: (message: string, kind?: ToastKind, action?: ToastAction, opts?: ToastOptions) => void
  dismiss: (id: number) => void
  clear: () => void
}

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (message, kind = 'info', action, opts) => {
    const id = ++tid
    const sticky = opts?.sticky ?? kind === 'error'
    set((s) => {
      // Collapse an identical message rather than stacking it. A failing
      // reconnect can emit the same sentence repeatedly, and three copies of
      // one problem reads as three problems.
      const withoutDuplicate = s.toasts.filter((t) => t.message !== message)
      return { toasts: [...withoutDuplicate, { id, kind, message, action, sticky }] }
    })
    if (!sticky) {
      const ms = action ? ACTION_DISMISS_MS : AUTO_DISMISS_MS
      setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms)
    }
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] })
}))

/**
 * Show a message.
 *
 * Pass an `action` whenever the message asks the user to do something — which
 * is nearly always, for an error. `toast('Unlock the vault and try again')` is
 * a dead end; `toast('...', 'error', { label: 'Unlock vault', run: unlock })`
 * is a fix.
 *
 * Errors stay until dismissed. Anything else clears itself, with a longer
 * window when it carries a button. Pass `{ sticky: true }` for the rare
 * non-error that must not be missed.
 */
export const toast = (
  message: string,
  kind?: ToastKind,
  action?: ToastAction,
  opts?: ToastOptions
): void => useToasts.getState().push(message, kind, action, opts)
