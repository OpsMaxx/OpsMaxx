import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteFileSync } from './atomicWrite'

/**
 * Whether a login launch opens a window, decided by us rather than by macOS.
 *
 * It used to be `openAsHidden` on the OS login item, and that setting is dead:
 * Electron's own documentation says it "does not work on macOS 13 and up", and
 * on macOS 15 `getLoginItemSettings()` reads it back as false whatever was
 * written. So the switch wrote a flag the OS discarded, read the discard, and
 * snapped itself off — a control that could not be turned on.
 *
 * A second bug hid behind that one: `ready-to-show` called `show()`
 * unconditionally, so even an OS that honoured the flag would have had its
 * hidden launch overridden a moment later. Neither half worked, and each was a
 * complete explanation of the symptom on its own.
 *
 * Owning the preference fixes both. The OS is asked only for the thing it
 * still does reliably — launch this app at login — and whether that launch
 * puts a window on screen is our decision, made here, before any window
 * exists. That is also why this is a file in main and not a renderer setting:
 * like the updater's prefs next door, the decision is needed before there is a
 * renderer to ask.
 */

const FILE = join(app.getPath('userData'), 'opsmaxx-startup.json')

export interface StartupPrefs {
  /** Launch at login without putting a window on screen. */
  openAsHidden: boolean
}

export const DEFAULT_STARTUP_PREFS: StartupPrefs = { openAsHidden: false }

/**
 * Read the preference, narrowing rather than trusting.
 *
 * A prefs file survives downgrades and hand edits, so the field is coerced
 * back to a boolean rather than believed because the JSON parsed. The failure
 * this avoids is a truthy string making the app launch with no window and no
 * setting that admits to it.
 */
export function startupPrefs(): StartupPrefs {
  try {
    if (!existsSync(FILE)) return { ...DEFAULT_STARTUP_PREFS }
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<StartupPrefs>
    return {
      openAsHidden: typeof raw.openAsHidden === 'boolean' ? raw.openAsHidden : false
    }
  } catch {
    // A corrupt file means the default, not a crash on the path that decides
    // whether the app is visible at all.
    return { ...DEFAULT_STARTUP_PREFS }
  }
}

/** Write the preference. Via a temp file, so a torn write cannot survive. */
export function setStartupPrefs(next: StartupPrefs): StartupPrefs {
  const value: StartupPrefs = { openAsHidden: next.openAsHidden === true }
  try {
    atomicWriteFileSync(FILE, JSON.stringify(value))
  } catch {
    // Losing the preference is survivable; failing to launch is not.
  }
  return value
}

/**
 * Whether THIS launch should open a window.
 *
 * Both halves matter. The preference alone is not enough — someone who
 * double-clicks the icon is asking for a window, whatever their login setting
 * says — so the hidden launch applies only when macOS reports that it started
 * the app at login.
 *
 * `wasOpenedAtLogin` is the one part of the old login-item API that still
 * works on modern macOS; `wasOpenedAsHidden` and `restoreState` are documented
 * as broken on 13 and up, which is why neither is consulted here.
 */
export function shouldStartHidden(): boolean {
  if (process.platform !== 'darwin') return false
  if (!startupPrefs().openAsHidden) return false
  try {
    return app.getLoginItemSettings().wasOpenedAtLogin === true
  } catch {
    return false
  }
}
