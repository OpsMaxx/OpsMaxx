import { ipcMain } from 'electron'
import {
  LocalizedError,
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
 * again. `system` is the OS's preferred languages, passed in so a test can
 * choose them. Returns whether a load started, i.e. whether `onChange` is coming.
 */
export function syncLanguage(data: unknown, system: readonly string[], onChange: () => void): boolean {
  const settings = (data as { settings?: { language?: unknown } } | null)?.settings
  pref = parseLanguagePref(settings?.language)
  const want = resolveLocale(pref, system)
  if (want === loaded) return false
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
  return true
}

const localized = (e: unknown): unknown => (e instanceof LocalizedError ? new Error(mt(e.key, e.vars)) : e)

/**
 * Say a LocalizedError in the user's language on its way to the renderer.
 *
 * Electron hands a renderer only the message of what a handler threw, and a
 * LocalizedError's message is English, which is what logs and agents read. This
 * wraps ipcMain.handle the way installIpcDebugTap does, so no handler changes;
 * every other error, and every result, passes through untouched. Install it
 * BEFORE the debug tap, so the tap ends up nearer each handler and records the
 * English.
 */
export function installIpcErrorLocalization(): void {
  const real = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = ((channel: string, listener: (...args: unknown[]) => unknown): void =>
    real(channel, ((...args: unknown[]) => {
      let out: unknown
      try {
        out = listener(...args)
      } catch (e) {
        throw localized(e)
      }
      return out instanceof Promise
        ? out.catch((e: unknown) => {
            throw localized(e)
          })
        : out
    }) as never)) as typeof ipcMain.handle
}
