import { useApp } from './app'
import { backfillModules, type ModuleState } from '../../../shared/modules'
import type { Server, MonitorGroup } from '../types'
import { hasBackupContent } from '../../../shared/backupContent'
import { apiSaveFields, applyExternalApi, hydrateApi, subscribeApiPersistence } from './persistHttp'

// Bump when the seed/shape changes in a way that should discard older on-disk
// data (e.g. removing the original sample/dummy dataset).
const SEED_VERSION = 2

interface Persisted {
  version?: number
  /**
   * The colour scheme, which was not saved at all until now.
   *
   * `theme` lives on AppState rather than in `settings` -- it is read as
   * `useApp(s => s.theme)` from three places -- and it was absent from both this
   * shape and `save()`, so every launch reset it to `'dark'`. Somebody who chose
   * light got it back for one session at a time.
   *
   * Restored by `replaceAll`, and nothing else has to be wired: App.tsx applies
   * the theme in an effect keyed on it, so putting the value back in the store is
   * what puts it on the screen.
   *
   * Absent in every save written before this, which is why it is optional; the
   * store's own default stands in.
   */
  theme?: unknown
  workspaces: unknown
  monitorGroups?: unknown
  // Absent in saves written before this was stored; the store falls back to
  // the first workspace when it is missing or names a deleted workspace.
  activeWorkspaceId?: unknown
  folders: unknown
  servers: unknown
  vpns: unknown
  tunnels: unknown
  databases: unknown
  // The HTTP client, owned by store/api and store/http and read and written
  // only through persistHttp. v1 records (the old client's) are migrated on
  // load; the key names are pinned by sync (shared/addy.ts), so they stay.
  apiCollections?: unknown
  apiWorkspace?: unknown
  // The pre-upgrade v1 blob, scrubbed, for "Recover old data…". Not synced.
  apiWorkspaceLegacy?: unknown
  // Open request tabs, drafts and layout. Per device: not synced, and not
  // backup-relevant data either (see subscribeApiPersistence).
  httpSession?: unknown
  // Absent in saves written before external service checks existed.
  httpChecks?: unknown
  // Absent in saves written before the CI/CD module existed. The records carry
  // a `vaultEntryId` and never a token — see shared/cicd.ts.
  cicdConnections?: unknown
  settings: unknown
  // Absent in saves written before the window was restored across restarts.
  tabs?: unknown
  activeTabId?: unknown
  panes?: unknown
  tabCwd?: unknown
  // Absent in saves written before Recent listed servers actually opened.
  recentServerIds?: unknown
}

let timer: ReturnType<typeof setTimeout> | null = null
// The HTTP session's own, slower debounce (§3.2): typing into a request draft
// saves every two seconds at most, not on every keystroke.
let sessionTimer: ReturnType<typeof setTimeout> | null = null

const saveSoon = (): void => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(save, 400)
}
const saveSoonSession = (): void => {
  // A data save already on its way writes the session too.
  if (timer) return
  if (sessionTimer) clearTimeout(sessionTimer)
  sessionTimer = setTimeout(save, 2000)
}

// Connecting to a server flips Server.status (online/offline/connecting)
// dozens of times a session, and collapsing a Fleet Monitor group flips
// MonitorGroup.collapsed — both change the array's reference, but neither is
// something a backup needs to capture. Comparing without them is what keeps
// "Backup out of date" meaning what it says: your servers, workspaces, vault
// or connections changed, not that you opened a terminal or collapsed a
// panel.
function serversWithoutStatus(servers: Server[]): Omit<Server, 'status'>[] {
  return servers.map(({ status: _status, ...rest }) => rest)
}
function monitorGroupsWithoutCollapsed(groups: MonitorGroup[]): Omit<MonitorGroup, 'collapsed'>[] {
  return groups.map(({ collapsed: _collapsed, ...rest }) => rest)
}

export async function initPersistence(): Promise<void> {
  try {
    await hydrate()
  } finally {
    // Every exit, including the failures, and deliberately in a `finally`.
    //
    // Until this is set, panels hold off saying "no servers" -- because an
    // empty list means "nobody has looked yet" as much as it means "there are
    // none". The cases that must NOT be left pending are the unhappy ones: a
    // build with no data bridge will never load anything, and a load that
    // throws is not going to arrive later either. Both are definite answers,
    // and leaving them false would trade a wrong claim for a screen that says
    // "loading" until it is closed -- the same defect pointed the other way,
    // which the rules panel already made once.
    useApp.setState({ hydrated: true })
  }
}

async function hydrate(): Promise<void> {
  const bridge = window.opsmaxx
  if (!bridge?.data) return

  const saved = await bridge.data.load<Persisted>()
  if (saved && saved.version === SEED_VERSION && Array.isArray(saved.servers)) {
    // Read what was actually SAVED, before replaceAll runs. replaceAll merges
    // `{ ...DEFAULT_SETTINGS, ...data.settings }`, and DEFAULT_SETTINGS carries
    // defaultModuleState() — so after it, every module key is present and
    // backfillModules, which only fills ABSENT keys, has nothing left to do.
    // The saved object is the only thing that still knows this install predates
    // the module.
    //
    // Getting this wrong switched three modules on for every existing install
    // on upgrade, which is the exact thing backfillModules was written to
    // prevent. The unit test passed throughout because it exercised the
    // function with a partial object rather than the real call site.
    const savedModules = (saved as { settings?: { modules?: ModuleState } }).settings?.modules
    useApp.getState().replaceAll(saved as never)
    // An upgrade is not consent: the user has already decided what their app
    // looks like. A fresh install gets the defaults instead, from
    // defaultModuleState() in DEFAULT_SETTINGS.
    useApp.getState().setSettings({ modules: backfillModules(savedModules, false) })
    // After replaceAll, so migration sees the restored workspaces and active workspace.
    hydrateApi(saved)
  } else {
    // No data, or data written by an older (dummy-seeded) version — start clean
    // and overwrite it with the current empty seed.
    void save()
  }

  // Nothing is forwarding yet at launch, whatever the last save said.
  //
  // Here rather than inside `replaceAll`, which is where it used to be: that
  // is a Partial the tunnel manager and the database editor both call to save
  // an ordinary edit, so a reset living there fired on every save and marked
  // running tunnels inactive. A load is the only event that means it, and
  // this is the load.
  useApp.setState((s) => ({
    tunnels: s.tunnels.map((t) => ({ ...t, status: 'inactive' as const }))
  }))

  // The main-process lock file decides which workspaces are password
  // protected, so reconcile the freshly-loaded flags against it.
  const lockedIds = await window.opsmaxx?.workspaceLock.ids()
  if (lockedIds) {
    useApp.getState().syncWorkspaceLocks(lockedIds)
    // activeWorkspaceId is not restored through setWorkspace, so a protected
    // workspace would otherwise open unchallenged on launch.
    const st = useApp.getState()
    if (!st.isWorkspaceAccessible(st.activeWorkspaceId)) st.lockWorkspace(st.activeWorkspaceId)
  }

  // Main owns the vault's idle timer, same as the connection pool below.
  void window.opsmaxx?.vault?.setAutoLock?.(useApp.getState().settings.vaultAutoLockMinutes)

  // Main owns the connection pool, so mirror the retention policy into it.
  void window.opsmaxx?.ssh.setPoolIdle(useApp.getState().settings.sshMasterIdleMinutes)
  // Main defaults this ON and only ever hears otherwise from here, so a fresh
  // install and an install whose data file predates the setting behave the
  // same. Pushed at startup as well as on change: main holds the value in
  // memory and would otherwise run a job detached on the strength of a default
  // the user turned off last week.
  void window.opsmaxx?.jobs.setDetached(useApp.getState().settings.jobsDetached !== false)
  // Main holds no copy of this across restarts, so it has to be told at
  // startup as well as on change — otherwise somebody who turned the
  // shortcuts on last week has them silently off on every subsequent launch.
  // `=== true` rather than `!== false`: the default is OFF, because these are
  // taken from every application on the machine.
  // The answer says what was actually held, and the panel asks for it
  // separately — this push only states the wish.
  void window.opsmaxx?.addy?.setClipboardShortcuts?.(
    useApp.getState().settings.addyClipboardShortcuts === true
  )

  useApp.subscribe((state, prev) => {
    if (state.settings.jobsDetached !== prev.settings.jobsDetached) {
      void window.opsmaxx?.jobs.setDetached(state.settings.jobsDetached !== false)
    }
    if (state.settings.addyClipboardShortcuts !== prev.settings.addyClipboardShortcuts) {
      void window.opsmaxx?.addy?.setClipboardShortcuts?.(
        state.settings.addyClipboardShortcuts === true
      )
    }
    if (state.settings.sshMasterIdleMinutes !== prev.settings.sshMasterIdleMinutes) {
      void window.opsmaxx?.ssh.setPoolIdle(state.settings.sshMasterIdleMinutes)
    }
    if (state.settings.vaultAutoLockMinutes !== prev.settings.vaultAutoLockMinutes) {
      void window.opsmaxx?.vault?.setAutoLock?.(state.settings.vaultAutoLockMinutes)
    }
    const serversRefChanged = state.servers !== prev.servers
    const monitorGroupsRefChanged = state.monitorGroups !== prev.monitorGroups

    // Reference changes drive the save-to-disk timer below — status and
    // collapsed are still worth persisting across restarts, just not worth
    // telling the user their backup is stale over.
    const dataChanged =
      state.workspaces !== prev.workspaces ||
      state.folders !== prev.folders ||
      monitorGroupsRefChanged ||
      serversRefChanged ||
      state.vpns !== prev.vpns ||
      state.tunnels !== prev.tunnels ||
      state.databases !== prev.databases ||
      state.httpChecks !== prev.httpChecks ||
      state.cicdConnections !== prev.cicdConnections

    const serversContentChanged =
      serversRefChanged &&
      JSON.stringify(serversWithoutStatus(state.servers)) !== JSON.stringify(serversWithoutStatus(prev.servers))
    const monitorGroupsContentChanged =
      monitorGroupsRefChanged &&
      JSON.stringify(monitorGroupsWithoutCollapsed(state.monitorGroups)) !==
        JSON.stringify(monitorGroupsWithoutCollapsed(prev.monitorGroups))

    const backupRelevantChanged =
      state.workspaces !== prev.workspaces ||
      state.folders !== prev.folders ||
      monitorGroupsContentChanged ||
      serversContentChanged ||
      state.vpns !== prev.vpns ||
      state.tunnels !== prev.tunnels ||
      state.databases !== prev.databases ||
      // The HTTP client's collections and environments are not in this store:
      // subscribeApiPersistence below marks the backup stale for them.
      // Checks are stored data a backup carries, so adding one has to mark the
      // last backup stale like adding a server does.
      state.httpChecks !== prev.httpChecks ||
      // And so are CI connections. Stored data that saves to disk but does NOT
      // mark the backup stale is a silent data-loss path: the user restores a
      // backup the status bar told them was current and their connections are
      // not in it.
      state.cicdConnections !== prev.cicdConnections

    // Any change to stored data invalidates the last backup. Guarded on the
    // current flag so this cannot loop: writing settings re-enters with
    // backupRelevantChanged false.
    //
    // And guarded on there being something a backup would CONTAIN. The app
    // creates a default workspace for itself on first run, which changes
    // `state.workspaces` and used to mark the backup stale before the user had
    // created anything — so a brand new install opened with a red "Backup out
    // of date" about data that did not exist. See shared/backupContent.ts.
    if (backupRelevantChanged && !state.settings.backupDirty && hasBackupContent(state)) {
      useApp.getState().setSettings({ backupDirty: true })
    }

    // Which workspace is open is remembered across restarts, but it is not a
    // change to the stored data, so it neither marks the backup stale nor is
    // checked above.
    const activeChanged = state.activeWorkspaceId !== prev.activeWorkspaceId

    // The window layout is remembered too, and like the active workspace it is
    // not stored DATA -- it does not mark a backup stale.
    const windowChanged =
      state.tabs !== prev.tabs ||
      state.activeTabId !== prev.activeTabId ||
      state.panes !== prev.panes ||
      state.tabCwd !== prev.tabCwd ||
      state.recentServerIds !== prev.recentServerIds

    // Grouped with the window layout rather than with the data, and that
    // placement is the whole decision: a theme change has to trigger a SAVE, or
    // it is forgotten again on the next launch, but it must not mark the backup
    // stale. "Backup out of date" has to keep meaning that servers, workspaces,
    // vault entries or connections changed -- if switching to light mode raised
    // it, the warning would stop being believed, which is the failure
    // `serversWithoutStatus` above exists to prevent for a different field.
    const themeChanged = state.theme !== prev.theme

    if (
      dataChanged ||
      activeChanged ||
      windowChanged ||
      themeChanged ||
      state.settings !== prev.settings
    ) {
      saveSoon()
    }
  })

  // Collections and environments save on the 400 ms timer and mark the backup
  // stale; the session saves on its own 2 s timer and does not. Closing the
  // window flushes whatever is pending.
  subscribeApiPersistence(saveSoon, saveSoonSession, () => void save())

  /**
   * Somebody else changed the file. Take the named collections back in.
   *
   * Addy's sync engine writes inbound copies straight into
   * `opsmaxx-data.json`, which THIS store owns: it holds the blob in memory
   * and writes all of it 400ms after any change. So without this, a server
   * that arrived from another machine would be overwritten by the next
   * keystroke in this window and the sync would look like it had silently
   * failed.
   *
   * Only the named keys, and only the ones this store actually holds. A
   * blanket `replaceAll` would restore tabs, panes and the active workspace
   * too — all deliberately NOT synced — so another machine adding a server
   * would rearrange somebody's screen.
   */
  window.opsmaxx?.data?.onExternalChange?.((collections) => {
    void applyExternal(collections)
  })
}

/** The store keys an inbound collection can land in. A collection not in here
 *  lives somewhere else on disk and needs no reload — `vault`, `knownHosts`
 *  and `env` are read from their own files by the code that uses them. */
const STORE_KEYS = new Set([
  'workspaces',
  'monitorGroups',
  'folders',
  'servers',
  'vpns',
  'tunnels',
  'databases',
  'httpChecks',
  'cicdConnections'
])

/** Collections persistHttp takes in: migrated or merged, stripped, and TLS changes flagged for review. */
const API_KEYS = ['apiCollections', 'apiWorkspace'] as const

async function applyExternal(collections: string[]): Promise<void> {
  const wanted = collections.filter((c) => STORE_KEYS.has(c))
  const api = API_KEYS.filter((k) => collections.includes(k))
  if (wanted.length === 0 && api.length === 0) return
  const saved = await window.opsmaxx?.data.load<Record<string, unknown>>()
  if (!saved) return
  // Present-checked like the rest: a key the file does not carry is left alone.
  const apiPatch = Object.fromEntries(api.filter((k) => k in saved).map((k) => [k, saved[k]]))
  if (Object.keys(apiPatch).length > 0) applyExternalApi(apiPatch)
  const patch: Record<string, unknown> = {}
  for (const key of wanted) {
    // Present-check rather than `?? []`: a key the file does not carry is one
    // this build has never written, and replacing live state with an empty
    // array on the strength of that is how a sync deletes somebody's servers.
    if (key in saved) patch[key] = saved[key]
  }
  if (Object.keys(patch).length > 0) useApp.setState(patch as never)
}

/** Writes everything now, pending timers included. For a relaunch that must not lose the last edits. */
export function flushSave(): Promise<void> {
  return save()
}

function save(): Promise<void> {
  if (timer) clearTimeout(timer)
  if (sessionTimer) clearTimeout(sessionTimer)
  timer = sessionTimer = null
  const s = useApp.getState()
  return (
    window.opsmaxx?.data.save({
      version: SEED_VERSION,
      theme: s.theme,
      workspaces: s.workspaces,
      activeWorkspaceId: s.activeWorkspaceId,
      monitorGroups: s.monitorGroups,
      folders: s.folders,
      servers: s.servers,
      vpns: s.vpns,
      tunnels: s.tunnels,
      databases: s.databases,
      // Stripped of literal credentials and capped at the one choke point.
      ...apiSaveFields(),
      httpChecks: s.httpChecks,
      cicdConnections: s.cicdConnections,
      settings: s.settings,
      /**
       * The window as the user left it.
       *
       * Warp, iTerm2 and tmux all restore; this opened an empty window every
       * time, so the first minute of every session was rebuilding a layout the
       * app had just thrown away.
       *
       * Tabs, their pane layout and which one was in front. NOT `tabSession`:
       * those are shell ids belonging to a process that has exited, and a
       * restored id would either match nothing or, worse, match something new.
       * `tabCwd` travels because a local shell reopening where it was is the
       * point of remembering it at all.
       */
      tabs: s.tabs,
      activeTabId: s.activeTabId,
      panes: s.panes,
      tabCwd: s.tabCwd,
      recentServerIds: s.recentServerIds
    }) ?? Promise.resolve()
  )
}
