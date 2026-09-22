import { describe, expect, it, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useApp } from '../src/renderer/src/store/app'

/**
 * The terminal's font family and cursor blink survive a restart.
 *
 * They could not. There was no `terminalFontFamily` key at all: the Settings
 * dropdown offering four fonts had no `value` and no `onChange`, and had been
 * that way since the first commit, so it snapped back to its first option
 * every time the pane was reopened. It also reached nothing — the terminal
 * read the `--font-mono` CSS token directly, which no setting can address.
 * `cursorBlink` was hardcoded `true` in `createTerm` behind a switch that held
 * its value in local React state.
 *
 * Reported as issue #35, "terminal Fonts Family and Color Schema resets
 * everytime". The colour scheme half was already wired and already persisted;
 * the font half is what the reporter was actually seeing.
 *
 * Two halves, asserted separately because they fail separately: the key has to
 * be in `DEFAULT_SETTINGS` (or `replaceAll` drops it on load) and it has to
 * survive the settings merge (or a partial save clobbers it).
 */

const SRC = join(process.cwd(), 'src/renderer/src')

describe('terminal appearance settings persist', () => {
  beforeEach(() => {
    useApp.setState({ settings: { ...useApp.getState().settings } })
  })

  it('round-trips a chosen font family through the settings merge', () => {
    useApp.getState().setSettings({ terminalFontFamily: 'Menlo' })
    expect(useApp.getState().settings.terminalFontFamily).toBe('Menlo')

    // A later unrelated write must not clobber it: setSettings merges, and a
    // whole-object replace here is the classic way a settings pane loses the
    // value the user just chose.
    useApp.getState().setSettings({ terminalFontSize: 15 })
    expect(useApp.getState().settings.terminalFontFamily).toBe('Menlo')
  })

  it('round-trips the cursor blink switch', () => {
    useApp.getState().setSettings({ terminalCursorBlink: false })
    expect(useApp.getState().settings.terminalCursorBlink).toBe(false)
  })

  it('survives a load, which merges over DEFAULT_SETTINGS', () => {
    // replaceAll does `{ ...DEFAULT_SETTINGS, ...data.settings }`. A key the
    // defaults do not declare is still restored by that spread, but one the
    // defaults DO declare is what makes an older save — written before the key
    // existed — come back with a sane value instead of `undefined` reaching
    // xterm.
    const saved = { ...useApp.getState().settings, terminalFontFamily: 'SF Mono' }
    useApp.getState().replaceAll({ settings: saved } as never)
    expect(useApp.getState().settings.terminalFontFamily).toBe('SF Mono')

    useApp.getState().replaceAll({ settings: {} } as never)
    expect(useApp.getState().settings.terminalFontFamily).toBe('')
    expect(useApp.getState().settings.terminalCursorBlink).toBe(true)
  })

  it('reaches xterm rather than stopping at the store', () => {
    // The half that made the dropdown decorative even once it had a key: the
    // terminal read the CSS token unconditionally. An empty setting still
    // means the app's stack, which is why the fallback has to stay.
    const hook = readFileSync(join(SRC, 'hooks/useTerminalSession.ts'), 'utf8')
    expect(hook).toContain('fontFamily: fontFamily || appFontStack()')
    expect(hook).toContain('term.options.fontFamily =')
    expect(hook).toContain('term.options.cursorBlink =')
  })
})
