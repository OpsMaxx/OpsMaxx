import { describe, expect, it, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useApp } from '../src/renderer/src/store/app'

/**
 * The colour scheme survives a restart.
 *
 * It did not. `theme` lives on AppState rather than inside `settings`, and it was
 * absent from both the `Persisted` shape and `save()` in store/persist.ts -- so
 * it was never written, and every launch reset it to `'dark'`. Somebody who chose
 * light mode got it for one session at a time, which reads as the setting not
 * working rather than as the setting not being saved.
 *
 * Two halves are asserted here because they fail independently:
 *  - `save()` has to include the field (source-level, below);
 *  - `replaceAll` has to put it back, and has to NARROW it first. The blob is a
 *    file on disk, and App.tsx's `apply()` treats anything that is not 'dark' or
 *    'system' as light -- so an unrecognised value would silently mean light
 *    mode instead of falling back to the default.
 */

const PERSIST = readFileSync(join(__dirname, '../src/renderer/src/store/persist.ts'), 'utf8')

beforeEach(() => {
  useApp.setState({ theme: 'dark' })
})

describe('restoring the theme', () => {
  it('restores a saved theme', () => {
    useApp.getState().replaceAll({ theme: 'light' })
    expect(useApp.getState().theme).toBe('light')
  })

  it('restores every value the picker can produce', () => {
    for (const t of ['dark', 'light', 'system'] as const) {
      useApp.getState().replaceAll({ theme: t })
      expect(useApp.getState().theme, t).toBe(t)
    }
  })

  it('keeps the current theme when the saved blob has none', () => {
    // Every save written before this has no such key. The store default stands
    // in rather than the field becoming undefined.
    useApp.setState({ theme: 'light' })
    useApp.getState().replaceAll({})
    expect(useApp.getState().theme).toBe('light')
  })

  it('ignores a value that is not a theme', () => {
    useApp.setState({ theme: 'light' })
    useApp.getState().replaceAll({ theme: 'chartreuse' as never })
    expect(useApp.getState().theme).toBe('light')
  })
})

describe('saving the theme', () => {
  // Source-level, because `save()` is module-private and debounced behind a
  // store subscription. What broke was an omission from one object literal, and
  // that is exactly what this catches.
  it('writes the theme into the saved blob', () => {
    const save = PERSIST.slice(PERSIST.indexOf('function save('))
    expect(save).toMatch(/theme: s\.theme/)
  })

  it('does not let a theme change mark the backup stale', () => {
    // "Backup out of date" has to keep meaning that servers, workspaces, vault
    // entries or connections changed. If switching to light mode raised it, the
    // warning would stop being believed -- the same failure `serversWithoutStatus`
    // exists to prevent for Server.status.
    // The flag is computed alongside the window layout, which is the other
    // "save it, but it is not data" case, and is kept out of `dataChanged`.
    expect(PERSIST).toMatch(/const themeChanged = state\.theme !== prev\.theme/)
    const dataChanged = PERSIST.slice(
      PERSIST.indexOf('const dataChanged'),
      PERSIST.indexOf('const activeChanged')
    )
    expect(dataChanged).not.toContain('theme')
  })
})
