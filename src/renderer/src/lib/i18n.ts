import { useSyncExternalStore } from 'react'
import {
  englishT,
  loadTranslator,
  parseLanguagePref,
  resolveLocale,
  type Locale,
  type Translate
} from '../../../shared/i18n'

// The renderer's active language. Module state rather than store state: `t()`
// has to work from lib/ and store/ code that is not a component, and a
// component re-renders on a change through `useT()`.

let locale: Locale = 'en'
let current: Translate = englishT
let system: readonly string[] = []
let wanted: Locale = 'en'
const listeners = new Set<() => void>()

/** Translate outside a component. Inside one, use `useT()` so a language
 *  change re-renders it. */
export const t: Translate = (key, vars) => current(key, vars)

export function useT(): Translate {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => current
  )
}

async function setLocale(next: Locale): Promise<void> {
  wanted = next
  if (next === locale) return
  const tr = await loadTranslator(next).catch(() => null)
  // A later choice may have overtaken this load; the later one wins.
  if (wanted !== next || !tr) return
  locale = next
  current = tr
  // Also what makes Chromium pick Simplified Chinese glyph shapes over Japanese
  // ones for the same code points.
  document.documentElement.lang = next
  listeners.forEach((l) => l())
}

/** Before the first render: main says which language, so the first frame is
 *  already in it. Never throws — at worst the app starts in English. */
export async function bootLocale(): Promise<void> {
  try {
    const boot = await window.opsmaxx.i18n.boot()
    system = boot.system
    await setLocale(boot.locale)
  } catch {
    // English it is.
  }
}

/** Follow the setting. Called whenever `settings.language` changes. */
export function applyLanguage(pref: unknown): Promise<void> {
  return setLocale(resolveLocale(parseLanguagePref(pref), system))
}
