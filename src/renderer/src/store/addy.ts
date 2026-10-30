import { create } from 'zustand'
import type { AddyLink } from '../../../shared/addyLink'
import type { HeldRecord } from '../../../shared/addy'
import { moduleEnabled } from '../../../shared/modules'
import { useApp } from './app'
import { openMonitor, openSettings } from './nav'
import { toast } from './toast'
import { t } from '../lib/i18n'
import type { MessageKey } from '../../../shared/i18n'

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
  /** Synced records this device will not use until confirmed here. Main owns
   *  the answer (services/syncTrust.ts); this is the last copy it gave. */
  held: HeldRecord[]
}

export const useAddyUi = create<AddyUiState>(() => ({
  phrase: null,
  checkWords: [],
  link: null,
  deferredConflicts: [],
  held: []
}))

/** Ask main again which synced records are waiting for a confirmation. */
export function refreshHeld(): void {
  void window.opsmaxx?.addy?.held?.().then(
    (held) => useAddyUi.setState({ held }),
    () => undefined
  )
}

const ARRIVED: Record<HeldRecord['kind'], MessageKey> = {
  server: 'store.addy.held.arrivedServer',
  database: 'store.addy.held.arrivedDatabase',
  cicd: 'store.addy.held.arrivedCicd',
  vpn: 'store.addy.held.arrivedVpn'
}

/** What a held record is waiting on, in one sentence a person can check. */
export function heldSentence(r: HeldRecord): string {
  if (r.arrived && r.changed.length === 0) return t(ARRIVED[r.kind])
  const what =
    r.changed.length === 1
      ? r.changed[0]
      : t('store.addy.held.list', { items: r.changed.slice(0, -1).join(', '), last: r.changed[r.changed.length - 1] })
  return t('store.addy.held.changed', { what, count: r.changed.length })
}

/**
 * Confirm one held record, after saying exactly what is being agreed to.
 *
 * A native confirm, as revoking a machine grant uses: the question is short,
 * and a button beside an explanation is still pressed without reading it.
 */
export async function confirmHeldRecord(r: HeldRecord): Promise<void> {
  const ws = r.changed.includes('workspace') ? t('store.addy.confirm.movedWorkspace') : ''
  const ok = window.confirm(
    t('store.addy.confirm.question', {
      name: r.name,
      sentence: heldSentence(r),
      destination: r.destination,
      workspace: ws
    })
  )
  if (!ok) return
  try {
    const held = await window.opsmaxx?.addy?.confirmHeld(r.kind, r.id)
    if (held) useAddyUi.setState({ held })
    toast(t('store.addy.confirm.done', { name: r.name }), 'ok')
  } catch (err) {
    toast(err instanceof Error ? err.message : t('store.addy.confirm.failed'), 'error')
  }
}

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

/** Forget deferrals for conflicts that no longer exist — resolved on another
 *  device, most likely — so "you left some for later" stops counting them. */
export function pruneDeferred(existing: number[]): void {
  useAddyUi.setState((s) => {
    const kept = s.deferredConflicts.filter((id) => existing.includes(id))
    return kept.length === s.deferredConflicts.length ? s : { deferredConflicts: kept }
  })
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
