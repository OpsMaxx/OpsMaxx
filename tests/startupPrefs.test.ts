import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Whether a login launch opens a window.
 *
 * Reported as a switch that could not be turned on, and it had two
 * independent causes — either of which fully explained the symptom, so
 * fixing one would have looked like fixing nothing:
 *
 *  1. The setting was `openAsHidden` on the OS login item. Electron's own
 *     documentation says that "does not work on macOS 13 and up", and on 15 it
 *     reads back false whatever was written — so the switch wrote a flag, read
 *     the discard, and snapped itself off.
 *
 *  2. `ready-to-show` called `show()` unconditionally, so even an OS that
 *     honoured the flag would have had its hidden launch overridden.
 *
 * The fix is to own the preference. These tests cover the half that can be
 * tested without a real logout: that the preference round-trips, that a
 * corrupt or hostile file cannot make the app start invisible by accident,
 * and that a hidden launch requires BOTH the preference and macOS saying it
 * started the app at login.
 */

let wasOpenedAtLogin = false

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const d = mkdtempSync(join(tmpdir(), 'opsmaxx-startup-'))
  return {
    app: {
      getPath: () => d,
      getLoginItemSettings: () => ({ wasOpenedAtLogin })
    }
  }
})

const load = async (): Promise<typeof import('../src/main/services/startupPrefs')> => {
  vi.resetModules()
  return import('../src/main/services/startupPrefs')
}

const realPlatform = process.platform
const setPlatform = (p: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

beforeEach(() => {
  wasOpenedAtLogin = false
  setPlatform('darwin')
})
afterEach(() => setPlatform(realPlatform))

describe('the preference itself', () => {
  it('defaults to showing a window', async () => {
    const m = await load()
    expect(m.startupPrefs().openAsHidden).toBe(false)
  })

  it('round-trips', async () => {
    const m = await load()
    m.setStartupPrefs({ openAsHidden: true })
    expect(m.startupPrefs().openAsHidden).toBe(true)
    m.setStartupPrefs({ openAsHidden: false })
    expect(m.startupPrefs().openAsHidden).toBe(false)
  })

  /**
   * A prefs file survives downgrades and hand edits, and this one decides
   * whether the app is visible at all. A truthy non-boolean must not be able
   * to make it start with no window.
   */
  it('narrows a hostile value rather than trusting it', async () => {
    const m = await load()
    const { writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { app } = await import('electron')
    const file = join((app as unknown as { getPath: () => string }).getPath(), 'opsmaxx-startup.json')

    for (const raw of ['{"openAsHidden":"yes"}', '{"openAsHidden":1}', '{}', 'not json at all']) {
      writeFileSync(file, raw)
      expect(m.startupPrefs().openAsHidden, raw).toBe(false)
    }
  })
})

describe('whether THIS launch stays hidden', () => {
  /**
   * Both halves are required. Somebody double-clicking the icon is asking for
   * a window whatever their login setting says, so the preference alone must
   * not hide it.
   */
  it('needs the preference AND a launch macOS started', async () => {
    const m = await load()
    m.setStartupPrefs({ openAsHidden: true })

    wasOpenedAtLogin = false
    expect(m.shouldStartHidden(), 'opened by hand: must show').toBe(false)

    wasOpenedAtLogin = true
    expect(m.shouldStartHidden(), 'opened at login with the pref set').toBe(true)
  })

  it('shows the window when the preference is off, even at login', async () => {
    const m = await load()
    m.setStartupPrefs({ openAsHidden: false })
    wasOpenedAtLogin = true
    expect(m.shouldStartHidden()).toBe(false)
  })

  // The concept is macOS-shaped — a Dock to wait in — and Electron ignores
  // the OS flag on Windows, so the UI must not promise it there.
  it('is never hidden off macOS', async () => {
    setPlatform('win32')
    const m = await load()
    m.setStartupPrefs({ openAsHidden: true })
    wasOpenedAtLogin = true
    expect(m.shouldStartHidden()).toBe(false)
  })
})
