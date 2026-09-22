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

/**
 * The same shape, one key further down: a running tunnel stays running.
 *
 * `tunnels` does have the `?? s.tunnels` fallback the settings key was
 * missing, so the list survives. But the `.map` after it forces
 * `status: 'inactive'` on every tunnel on every call, and status is live
 * runtime state -- written by `setTunnelStatus` from the IPC subscription in
 * TunnelManager. So saving a database edit, or editing one tunnel, marked
 * every running tunnel inactive in the store.
 *
 * Milder than the settings wipe: nothing persisted is harmed, since hydrate
 * forces 'inactive' on load by design, and TunnelManager writes the real
 * status back on its next event or mount. What it costs in between is a
 * sidebar (TunnelSidebar.tsx:18 is the only reader of the stored value)
 * showing a grey dot against a forward that is up.
 *
 * The reset belongs to a LOAD -- nothing is forwarding yet at launch,
 * whatever the last save said. A partial call is not a load, which is what
 * the branch says.
 */
describe('a partial replaceAll preserves live tunnel status', () => {
  const tunnel = {
    id: 't1',
    workspaceId: 'w1',
    name: 'Postgres',
    kind: 'local' as const,
    listenHost: '127.0.0.1',
    listenPort: 5432,
    targetHost: '10.0.0.1',
    targetPort: 5432,
    serverId: 's1',
    status: 'active' as const
  }

  beforeEach(() => {
    useApp.setState({ tunnels: [{ ...tunnel }] as never, databases: [] })
  })

  it('keeps a running tunnel running when another collection is saved', () => {
    useApp.getState().replaceAll({ databases: [] })
    expect(useApp.getState().tunnels[0].status).toBe('active')
  })

  it('keeps it when a different tunnel is edited', () => {
    // TunnelManager saves its own edits as replaceAll({ tunnels }), so this
    // is the path where one tunnel's edit greyed out every other one.
    const state = useApp.getState()
    state.replaceAll({ tunnels: state.tunnels.map((t) => ({ ...t, name: 'Renamed' })) as never })
    expect(useApp.getState().tunnels[0].name).toBe('Renamed')
    expect(useApp.getState().tunnels[0].status).toBe('active')
  })
})
