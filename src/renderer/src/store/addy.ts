import { create } from 'zustand'
import type { AddyLink } from '../../../shared/addyLink'
import { moduleEnabled } from '../../../shared/modules'
import { useApp } from './app'
import { openMonitor, openSettings } from './nav'
import { toast } from './toast'

/**
 * The Sync & devices state that has to outlive the component showing it.
 *
 * Three things, and each was lost the same way: it lived in a component's
 * `useState`, and the component was unmounted by something the user did
 * elsewhere.
 *
 *  - THE RECOVERY PHRASE. Settings mounts only while it is the active view, so
 *    clicking any sidebar icon while the twelve words were on screen there
 *    threw them away — and nothing on the machine keeps another copy. The
 *    panel's own mount was no safer on a machine with no servers, where the
 *    monitor's empty state replaces the whole tree. Held here, it survives
 *    every unmount and either door shows it until the user has proved they
 *    wrote it down. It is the same renderer memory it always was, and it is
 *    cleared the moment that check passes.
 *  - A LINK FROM THE OS. Main held a link that arrived before the window and
 *    nothing ever read it, and a live link reached only whichever screen
 *    happened to be subscribed. It now waits here until a setup screen takes it.
 *  - CONFLICTS LEFT FOR LATER. The chooser and the panel are in different
 *    trees, and "Decide later" has to be undoable from the panel.
 */
interface AddyUiState {
  /** The twelve words, between `createAccount` returning them and the user
   *  typing some of them back. */
  phrase: string | null
  /** Which words (0-based) the user is asked to type back. Chosen once per
   *  phrase, so a remount does not reshuffle what they were typing. */
  checkWords: number[]
  /** A link the OS handed over, waiting for a setup screen to take it. */
  link: AddyLink | null
  /** Conflict ids the user chose to leave for now, this session. */
  deferredConflicts: number[]
}

export const useAddyUi = create<AddyUiState>(() => ({
  phrase: null,
  checkWords: [],
  link: null,
  deferredConflicts: []
}))

/** Three distinct positions out of `count`, in reading order. */
export function pickCheckWords(count: number, random: () => number = Math.random): number[] {
  const all = Array.from({ length: count }, (_, i) => i)
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[all[i], all[j]] = [all[j], all[i]]
  }
  return all.slice(0, Math.min(3, count)).sort((a, b) => a - b)
}

export function holdPhrase(phrase: string): void {
  useAddyUi.setState({ phrase, checkWords: pickCheckWords(phrase.trim().split(/\s+/).length) })
}

export function forgetPhrase(): void {
  useAddyUi.setState({ phrase: null, checkWords: [] })
}

export function clearLink(): void {
  useAddyUi.setState({ link: null })
}

export function deferConflict(id: number): void {
  useAddyUi.setState((s) => ({ deferredConflicts: [...s.deferredConflicts, id] }))
}

export function undeferConflicts(): void {
  useAddyUi.setState({ deferredConflicts: [] })
}

/**
 * Collect `opsmaxx://` links for the life of the window. Returns the stop.
 *
 * PULLED, NOT ONLY PUSHED. Main keeps the latest link until something asks for
 * it, and this asks once at start and again on every nudge — so a link that
 * launched the app cold, before there was a renderer to hear it, arrives the
 * same way as one clicked an hour later.
 *
 * And it goes somewhere: the link opens Sync & devices, because otherwise the
 * screen that can use it is one the user has to find. With the module off (an
 * upgraded install) the setup flow lives in Settings → Security instead.
 */
export function startAddyLinkWatch(): () => void {
  const bridge = window.opsmaxx?.addy
  if (typeof bridge?.takeLink !== 'function') return () => {}
  const go = (): void => {
    if (moduleEnabled(useApp.getState().settings.modules, 'addy')) openMonitor('addy')
    else openSettings('security')
  }
  const pull = (): void => {
    void bridge.takeLink().then(
      (l) => {
        if (!l) return
        useAddyUi.setState({ link: l })
        // After the saved settings are in, or a cold start would decide
        // where to go from the defaults and then be overwritten by them.
        if (useApp.getState().hydrated) return go()
        const off = useApp.subscribe((s) => {
          if (!s.hydrated) return
          off()
          go()
        })
      },
      () => undefined
    )
  }
  pull()
  const offLink = bridge.onLink?.(() => pull())
  // Said wherever the user is. A link that does nothing and says nothing is
  // indistinguishable from a broken app.
  const offBad = bridge.onLinkRefused?.((reason) => toast(reason, 'error'))
  return () => {
    offLink?.()
    offBad?.()
  }
}
