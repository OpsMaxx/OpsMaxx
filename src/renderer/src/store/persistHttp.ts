import {
  isValidId,
  MAX_COLLECTIONS_BYTES,
  persistableBody,
  stripLiteralSecrets,
  type ApiCollectionV2,
  type ApiRequest,
  type ApiWorkspaceV2,
  type HttpSessionV1,
  type Id,
  type Item
} from '../../../shared/apiModel'
import {
  isSnapshot,
  isWorkspaceV2,
  mergeIncoming,
  migrateApiState,
  normaliseWorkspace,
  type MigrationReport
} from '../../../shared/apiMigration'
import { hasBackupContent } from '../../../shared/backupContent'
import { certificateBlocks } from '../../../shared/httpClient'
import { globalsReviewKey, useApi } from './api'
import { useApp } from './app'
import { useHttp } from './http'
import { useToasts } from './toast'

// The HTTP client's one persistence choke point. Everything saved for
// `apiCollections` and `httpSession` passes `stripLiteralSecrets` here, and so
// does everything arriving from sync, so no store action or import can bypass it.

export interface ApiSaveFields {
  apiCollections: ApiCollectionV2[]
  apiWorkspace: ApiWorkspaceV2
  apiWorkspaceLegacy: unknown | null
  httpSession: HttpSessionV1
  apiLocal: ApiLocalV1
}

/**
 * Device-only HTTP state that has to survive a restart. NOT synced: a review
 * or an upgrade report is about what happened on this machine.
 */
export interface ApiLocalV1 {
  version: 1
  /** Kept until its banner is dismissed, so a user who never opened HTTP in the upgrade session still sees it. */
  report: MigrationReport | null
  /** Collections whose certificate settings arrived changed from another device, not yet reviewed here. */
  tlsReview: Id[]
  /** Environment ids and `globals:<wsId>` keys with synced variable changes not yet reviewed here. */
  envReview?: string[]
}

function readLocal(raw: unknown): { report: MigrationReport | null; tlsReview: Set<Id>; envReview: string[] } {
  const r = raw as Partial<ApiLocalV1> | null
  if (!r || typeof r !== 'object' || r.version !== 1) return { report: null, tlsReview: new Set(), envReview: [] }
  const report = r.report as Partial<MigrationReport> | null | undefined
  const valid =
    !!report &&
    typeof report.id === 'string' &&
    ['collections', 'requests', 'environments'].every((k) => typeof report[k as keyof MigrationReport] === 'number') &&
    ['needsReimport', 'dropped', 'rejected', 'baseUrlCollisions', 'shedForCap'].every((k) =>
      Array.isArray(report[k as keyof MigrationReport])
    )
  return {
    report: valid ? (report as MigrationReport) : null,
    tlsReview: new Set(Array.isArray(r.tlsReview) ? r.tlsReview.filter(isValidId) : []),
    envReview: Array.isArray(r.envReview)
      ? r.envReview.filter((k): k is string => typeof k === 'string' && isValidId(k.replace(/^globals:/, '')))
      : []
  }
}

/**
 * The `apiCollections` value of the last save that fitted under the cap.
 * Seeded by hydrate with what was on disk, so an over-cap first save writes
 * back exactly what was read.
 */
let lastGoodCollections: unknown = []

export function resetPersistHttpForTests(): void {
  lastGoodCollections = []
}

const ctx = () => ({ activeWorkspaceId: useApp.getState().activeWorkspaceId })

function sizeOf(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function capRequest<R extends ApiRequest>(req: R): { req: R; dropped: boolean } {
  if (req.kind !== 'http') return { req, dropped: false }
  const { body, dropped } = persistableBody(req.body)
  return { req: dropped ? { ...req, body } : req, dropped }
}

function capItems(items: Item[]): Item[] {
  return items.map((item) => (item.kind === 'folder' ? { ...item, items: capItems(item.items) } : capRequest(item).req))
}

/**
 * A custom CA, certificate blocks only. One from sync or an old save could
 * carry a private key, which is refused outright rather than filtered.
 */
function withSafeCa(c: ApiCollectionV2): ApiCollectionV2 {
  if (c.caPem === undefined) return c
  const checked = certificateBlocks(c.caPem)
  if ('error' in checked) {
    const { caPem: _dropped, ...rest } = c
    return rest
  }
  return checked.pem === c.caPem ? c : { ...c, caPem: checked.pem }
}

/**
 * The v1 fields an older build reads without a guard, always present with
 * their v1 types. `apiCollections` syncs to devices still on v0.51.x, and a
 * rollback reads it too: WsConsole and GraphQlConsole call `baseUrl.trim()`,
 * HttpView tests `viaServerId !== null`, and the old sync path applies records
 * without normalising them. A `baseUrl` already carried is kept, because
 * changing it makes an old client rebuild that collection's document and drop
 * its edits; a collection made here takes its baseUrl variable, else ''.
 */
function withV1Fields(c: ApiCollectionV2): ApiCollectionV2 {
  const variable = c.variables.find((v) => v.enabled && v.key === 'baseUrl')
  return {
    ...c,
    name: typeof c.name === 'string' ? c.name : '',
    // Through a VPN, a v0.51 device (which cannot use one) must have nothing to send to directly.
    baseUrl: c.vpnProfileId ? '' : typeof c.baseUrl === 'string' ? c.baseUrl : (variable?.value ?? ''),
    specUrl: typeof c.specUrl === 'string' ? c.specUrl : null,
    specPath: typeof c.specPath === 'string' ? c.specPath : null,
    viaServerId: typeof c.viaServerId === 'string' ? c.viaServerId : null,
    insecureTls: c.insecureTls === true,
    endpoints: Array.isArray(c.endpoints) ? c.endpoints : []
  }
}

/** A collection as it may be written: bodies capped, literal credentials gone, CA filtered, v1-readable. */
function persistable(c: ApiCollectionV2): ApiCollectionV2 {
  // tlsReview is this device's, never synced (it lives in apiLocal): another
  // device's flag must not raise ours, and our Review must not clear theirs.
  const { tlsReview: _deviceOnly, ...rest } = c
  return withV1Fields(withSafeCa(stripLiteralSecrets({ ...rest, items: capItems(rest.items) }).value))
}

function persistableSession(session: HttpSessionV1): HttpSessionV1 {
  const capped = session.tabs.map((tab) => {
    if (!tab.draft) return { tab, dropped: false }
    const { req, dropped } = capRequest(tab.draft)
    return { tab: dropped ? { ...tab, draft: req } : tab, dropped }
  })
  const stripped = stripLiteralSecrets({ ...session, tabs: capped.map((c) => c.tab) }).value
  // An over-cap body is "not kept from last session" too.
  return {
    ...stripped,
    tabs: stripped.tabs.map((tab, i) =>
      capped[i].dropped ? { ...tab, strippedFields: [...(tab.strippedFields ?? []), 'body'] } : tab
    )
  }
}

/** Migrates v1 or loads v2 into store/api, and restores the session into store/http. */
export function hydrateApi(saved: Partial<Record<keyof ApiSaveFields, unknown>>): void {
  // A v2 record passes through migration untouched, so this is also the v2 load.
  const m = migrateApiState(saved.apiCollections, saved.apiWorkspace, ctx())
  const local = readLocal(saved.apiLocal)
  const collections = m.collections.map((c) => {
    const safe = withSafeCa(c)
    const { tlsReview: _synced, ...rest } = safe
    return local.tlsReview.has(c.id) ? { ...rest, tlsReview: true } : rest
  })
  // The fallback for an over-cap save is what was loaded, as v2: writing the
  // raw value back could put v1 records on disk under a v2 build.
  lastGoodCollections = collections.map(persistable)
  const migrated = m.legacy !== null
  useApi.setState({
    collections,
    workspace: m.workspace,
    // A fresh migration stashes the scrubbed v1 blob; otherwise keep the stash from the upgrade.
    legacy: migrated ? m.legacy : (saved.apiWorkspaceLegacy ?? null),
    report: migrated ? m.report : local.report,
    envReview: local.envReview
  })
  useHttp.getState().restoreHttpSession(saved.httpSession)
}

/** Stripped, and refused over the 4 MiB cap (the last good save is kept). */
export function apiSaveFields(): ApiSaveFields {
  const { collections, workspace, legacy, report } = useApi.getState()
  const stripped = collections.map(persistable)
  let apiCollections: ApiCollectionV2[]
  if (sizeOf(stripped) > MAX_COLLECTIONS_BYTES) {
    // Refused, not truncated: a cut-down save is a silent loss of whatever
    // was cut. The last good one stays on disk and the user is told.
    apiCollections = lastGoodCollections as ApiCollectionV2[]
    useToasts
      .getState()
      .push('Collections are over 4 MB and were not saved. Delete or re-import a large collection to save again.', 'error', undefined, {
        key: 'http-collections-cap'
      })
  } else {
    apiCollections = stripped
    lastGoodCollections = stripped
  }
  return {
    apiCollections,
    apiWorkspace: workspace,
    apiWorkspaceLegacy: legacy,
    httpSession: persistableSession(useHttp.getState().getHttpSession()),
    apiLocal: {
      version: 1,
      report: report && useHttp.getState().bannerDismissed !== report.id ? report : null,
      tlsReview: collections.filter((c) => c.tlsReview).map((c) => c.id),
      envReview: useApi.getState().envReview
    }
  }
}

/**
 * A store/api change arms the 400 ms timer and marks the backup dirty; an
 * httpSession change arms the 2,000 ms timer and does not. `beforeunload`
 * flushes through `saveNow`, or the 400 ms timer when none is given.
 */
export function subscribeApiPersistence(
  saveSoon400: () => void,
  saveSoon2000: () => void,
  saveNow: () => void = saveSoon400
): () => void {
  const stopApi = useApi.subscribe((s, prev) => {
    const reviewOnly = s.envReview !== prev.envReview
    if (s.collections === prev.collections && s.workspace === prev.workspace && s.legacy === prev.legacy) {
      // A review accepted or raised is device state: saved, but not a backup change.
      if (reviewOnly) saveSoon400()
      return
    }
    saveSoon400()
    const app = useApp.getState()
    // persist.ts's guard, plus the API data itself: somebody whose only data
    // is collections has something a backup would contain.
    const content = hasBackupContent(app) || s.collections.length > 0 || s.workspace.environments.length > 0
    if (!app.settings.backupDirty && content) app.setSettings({ backupDirty: true })
  })
  const stopSession = useHttp.getState().subscribeHttpSession(() => saveSoon2000())
  const flush = (): void => saveNow()
  window.addEventListener('beforeunload', flush)
  return () => {
    stopApi()
    stopSession()
    window.removeEventListener('beforeunload', flush)
  }
}

const variablesKey = (vars: { key: string; value: string; enabled: boolean }[]): string =>
  JSON.stringify(vars.map((v) => [v.key, v.value, v.enabled]))

/**
 * What a synced workspace changes that sends would resolve: every environment
 * that is new or whose variables changed, and every workspace whose globals
 * changed. A compromised peer re-pointing prod's baseUrl would otherwise get
 * vault-resolved secrets sent to it; these keys are refused until reviewed.
 */
function workspaceReviewKeys(before: ApiWorkspaceV2, after: ApiWorkspaceV2): string[] {
  const keys: string[] = []
  for (const env of after.environments) {
    const was = before.environments.find((e) => e.id === env.id)
    // A production flag turned off by sync is reviewed too: it is what makes
    // the production confirm ask, so a peer could otherwise silence it.
    if (!was || variablesKey(was.variables) !== variablesKey(env.variables) || was.production !== env.production) {
      keys.push(env.id)
    }
  }
  for (const wsId of Object.keys(after.globals)) {
    const was = Object.hasOwn(before.globals, wsId) ? before.globals[wsId] : []
    if (variablesKey(was) !== variablesKey(after.globals[wsId])) keys.push(globalsReviewKey(wsId))
  }
  return keys
}

/** The host a template URL names itself, or null when it inherits one (`{{baseUrl}}/x`). */
function hostOf(url: string): string | null {
  const m = /^\s*[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(url)
  return m ? m[1].slice(m[1].lastIndexOf('@') + 1).toLowerCase() : null
}

function hostsIn(c: ApiCollectionV2): Set<string> {
  const hosts = new Set<string>()
  const add = (url: string): void => {
    const h = hostOf(url)
    if (h !== null) hosts.add(h)
  }
  const walk = (items: Item[]): void =>
    items.forEach((i) => (i.kind === 'folder' ? walk(i.items) : add(i.url)))
  walk(c.items)
  c.variables.filter((v) => v.key === 'baseUrl').forEach((v) => add(v.value))
  return hosts
}

/**
 * Connection settings that another device changed, which this one reviews
 * before any send uses them: verification turned off, a CA set or changed, a
 * route (server or VPN) changed, or a request or baseUrl pointing at a host
 * this collection did not name before.
 */
function connectionChanged(before: ApiCollectionV2, after: ApiCollectionV2): boolean {
  if (!before.insecureTls && after.insecureTls) return true
  if ((before.caPem ?? '') !== (after.caPem ?? '')) return true
  if ((before.viaServerId ?? null) !== (after.viaServerId ?? null)) return true
  if ((before.vpnProfileId ?? null) !== (after.vpnProfileId ?? null)) return true
  // Any collection variable, not only baseUrl: a request's host can come
  // from any of them ({{apiHost}}), so a change to one is a change of where
  // requests go. Simpler and stricter than resolving every URL to compare.
  if (variablesKey(before.variables) !== variablesKey(after.variables)) return true
  const known = hostsIn(before)
  return [...hostsIn(after)].some((h) => !known.has(h))
}

/** Migrates or merges synced data, strips it, and raises `tlsReview` where certificate settings changed. */
export function applyExternalApi(patch: { apiCollections?: unknown; apiWorkspace?: unknown }): void {
  const state = useApi.getState()
  const next: { collections?: ApiCollectionV2[]; workspace?: ApiWorkspaceV2 } = {}

  if (patch.apiCollections !== undefined) {
    const current = new Map(state.collections.map((c) => [c.id, c]))
    const incoming = Array.isArray(patch.apiCollections) ? patch.apiCollections : []
    const migrated = migrateApiState(incoming, isSnapshot(patch.apiWorkspace) ? patch.apiWorkspace : null, ctx())
    const collections = migrated.collections.map((c) => {
      const mine = current.get(c.id)
      const raw = incoming.find((r) => (r as { id?: unknown } | null)?.id === c.id) as { version?: unknown } | undefined
      // A v1 record from an older device for a collection this device already
      // migrated: keep ours. Re-converting it would throw away every v2 edit.
      if (mine && raw?.version !== 2) return mine
      const clean = persistable(c)
      // A collection seen for the first time that skips verification or
      // trusts its own CA is reviewed too: arriving new is not consent.
      // Never the incoming flag (persistable dropped it); ours stays until reviewed here.
      const review =
        (mine ? connectionChanged(mine, clean) : clean.insecureTls || clean.caPem !== undefined) || mine?.tlsReview === true
      return review ? { ...clean, tlsReview: true } : clean
    })
    // Compared as both would be saved (persistable is idempotent), so a record
    // kept from this device and one arriving cleaned compare equal, and an
    // unchanged sync causes no setState, no save and no sync back.
    const asSaved = (list: ApiCollectionV2[]): string => JSON.stringify(list.map(persistable))
    if (asSaved(collections) !== asSaved(state.collections)) next.collections = collections
  }

  if (patch.apiWorkspace !== undefined) {
    if (isWorkspaceV2(patch.apiWorkspace)) {
      const ws = normaliseWorkspace(patch.apiWorkspace)
      if (JSON.stringify(ws) !== JSON.stringify(state.workspace)) next.workspace = ws
    } else if (isSnapshot(patch.apiWorkspace)) {
      const owners = [...new Set((next.collections ?? state.collections).map((c) => c.workspaceId))]
      const merged = mergeIncoming(state.workspace, patch.apiWorkspace, { ...ctx(), workspaceIds: owners })
      if (merged !== state.workspace) next.workspace = merged
    }
  }

  // Nothing new means no setState, so no save and no sync back: the loop dies here.
  if (next.workspace) {
    const raised = workspaceReviewKeys(state.workspace, next.workspace).filter((k) => !state.envReview.includes(k))
    if (raised.length) (next as { envReview?: string[] }).envReview = [...state.envReview, ...raised]
  }
  if (next.collections || next.workspace) useApi.setState(next)
}
