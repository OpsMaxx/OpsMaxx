import { useEffect, RefObject } from 'react'

/**
 * The layers that paint above every dialog and popover (see `--z-approval` and
 * `--z-toast` in tokens.css) without being part of the Modal stack.
 *
 * A Modal underneath one of them still believes it is on top, so without this a
 * press on an approval's Deny was "outside" it, and so was the Escape meant for
 * the question on screen. The SFTP overwrite dialog closes by cancelling, so
 * answering an AI approval cancelled an upload batch.
 */
const ABOVE_EVERYTHING = '.approval-scrim, .agent-approval-scrim, .toasts'

/** True for a press that landed on an approval or a toast. */
export const inLayerAbove = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest(ABOVE_EVERYTHING) !== null

/**
 * True while an approval is on screen. The keyboard is the approval's then:
 * every key a document-level handler hears was pressed at the question.
 */
export const approvalShowing = (): boolean =>
  document.querySelector('.approval-scrim, .agent-approval-scrim') !== null

export function useClickOutside<T extends HTMLElement>(
  ref: RefObject<T | null>,
  onOutside: () => void,
  active = true
): void {
  useEffect(() => {
    if (!active) return
    const handler = (e: MouseEvent): void => {
      if (inLayerAbove(e.target)) return
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !approvalShowing()) onOutside()
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('keydown', key)
    }
  }, [ref, onOutside, active])
}
