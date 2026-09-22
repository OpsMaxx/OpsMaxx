import { describe, expect, it, beforeEach } from 'vitest'
import { useApp } from '../src/renderer/src/store/app'
import { saveDatabaseEdit } from '../src/renderer/src/store/dbEditor'

/**
 * Editing a tunnel or a database must not wipe every setting in the app.
 *
 * `replaceAll` takes a `Partial`, and two callers use it that way: the tunnel
 * manager saves an edit as `replaceAll({ tunnels })` and the database editor
 * as `replaceAll({ databases })`, each naming the one collection it changed.
 * Its body normalises every other key against live state -- `data.servers ??
 * s.servers`, `data.databases ?? s.databases`, and so on for all of them.
 *
 * All of them except `settings`, which was
 * `{ ...DEFAULT_SETTINGS, ...(data.settings ?? {}) }` with no `...s.settings`
 * in the middle. A partial call carries no `settings`, so that spread
 * collapsed to `DEFAULT_SETTINGS` and reset the lot: terminal scheme, font
 * size, compact density, vault auto-lock, shell integration, which modules
 * are enabled, every keyboard shortcut.
 *
 * This is the other half of issue #35. The colour-scheme dropdown was wired
 * correctly and its key really was persisted -- reading the settings pane
 * could not explain the reset, because the pane was not where it happened.
 * Editing an unrelated database connection was.
 */

describe('a partial replaceAll preserves settings', () => {
  beforeEach(() => {
    useApp.setState({ databases: [], tunnels: [] })
    useApp.getState().setSettings({ terminalScheme: 'nord', terminalFontSize: 17 })
  })

  it('keeps them when a caller names only one collection', () => {
    useApp.getState().replaceAll({ tunnels: [] })
    expect(useApp.getState().settings.terminalScheme).toBe('nord')
    expect(useApp.getState().settings.terminalFontSize).toBe(17)
  })

  it('keeps them when a database is edited', () => {
    useApp.setState({
      databases: [
        {
          id: 'db1',
          workspaceId: 'w1',
          name: 'Prod',
          kind: 'postgres',
          host: '10.0.0.1',
          port: 5432,
          username: 'app',
          database: 'app',
          ssl: false,
          uri: false,
          folderId: null,
          sshServerId: null,
          vpnProfileId: null
        }
      ] as never
    })
    saveDatabaseEdit('db1', { port: 5433 })
    expect(useApp.getState().settings.terminalScheme).toBe('nord')
    expect(useApp.getState().databases[0].port).toBe(5433)
  })

  it('still lets a real load replace them', () => {
    // The other direction, and the reason this cannot simply be `...s.settings`
    // on its own: hydrate and a backup restore pass a whole settings object,
    // and that has to win over whatever is in memory.
    useApp.getState().replaceAll({ settings: { terminalScheme: 'dracula' } } as never)
    expect(useApp.getState().settings.terminalScheme).toBe('dracula')
  })

  it('still fills a key an older save never carried', () => {
    // DEFAULT_SETTINGS has to stay underneath both, or a settings object
    // written before a key existed leaves `undefined` where a value belongs.
    useApp.getState().replaceAll({ settings: {} } as never)
    expect(useApp.getState().settings.terminalFontSize).toBe(13)
  })
})
