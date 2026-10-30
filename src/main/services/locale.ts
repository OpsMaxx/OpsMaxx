import {
  englishT,
  loadTranslator,
  parseLanguagePref,
  resolveLocale,
  type LanguagePref,
  type Locale,
  type Translate
} from '../../shared/i18n'

// Main's copy of the language setting. The setting itself is an ordinary
// renderer setting (`settings.language`) and reaches main on `data:save` like
// every other one; main needs its own copy because the menu and anything else
// main draws are built here, before and without the renderer.

let pref: LanguagePref = 'system'
let loaded: Locale = 'en'
let current: Translate = englishT

export function currentLocale(system: readonly string[]): Locale {
  return resolveLocale(pref, system)
}

/** Main's translator. English until the chosen pack has loaded. */
export const mt: Translate = (key, vars) => current(key, vars)

/**
 * Read the setting out of the data blob and, when that changes the language,
 * load the pack and call `onChange` so whatever main has already drawn is drawn
 * again. `system` is the OS's preferred languages, passed in so this file needs
 * nothing from Electron.
 */
export function syncLanguage(data: unknown, system: readonly string[], onChange: () => void): void {
  const settings = (data as { settings?: { language?: unknown } } | null)?.settings
  pref = parseLanguagePref(settings?.language)
  const want = resolveLocale(pref, system)
  if (want === loaded) return
  loaded = want
  void loadTranslator(want).then(
    (t) => {
      // A later change may have overtaken this load; the later one wins.
      if (loaded !== want) return
      current = t
      onChange()
    },
    () => {
      // A pack that will not load leaves main in English rather than broken.
      if (loaded === want) current = englishT
    }
  )
}
