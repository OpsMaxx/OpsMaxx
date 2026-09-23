import { create } from 'zustand'
import {
  COLLECTION_GONE_SERVER_ID,
  defaults,
  newId,
  stableId,
  type ApiCollectionV2,
  type ApiRequest,
  type ApiWorkspaceV2,
  type Environment,
  type HttpTabState,
  type Id,
  type Item,
  type Route,
  type Variable
} from '../../../shared/apiModel'
import { mergeIncoming, migrateApiState, type MigrationReport } from '../../../shared/apiMigration'
import { scopeChain, type VariableScopeChain } from '../../../shared/apiVariables'
import { useApp } from './app'

// The HTTP client's saved data: collections and their trees, environments,
// globals. Every action is immutable. Nothing here strips secrets or saves;
// that is persistHttp's choke point, so no path into this store can bypass it.

type CollectionPatch = Partial<Omit<ApiCollectionV2, 'version' | 'id'>>

interface ApiState {
  collections: ApiCollectionV2[]
  workspace: ApiWorkspaceV2
  /** The scrubbed pre-upgrade blob, kept for "Recover old data…". */
  legacy: unknown | null
  report: MigrationReport | null
  /**
   * Environment ids, and `globals:<wsId>` keys, whose variables arrived
   * changed by sync and are not yet reviewed on this device. Sends that
   * would resolve them are refused until then. Device-only (persistHttp's
   * apiLocal).
   */
  envReview: string[]

  createCollection: (name: string, route?: Route) => Id
  updateCollection: (id: Id, patch: CollectionPatch) => void
  addItem: (colId: Id, parentId: Id | null, item: Item, index?: number) => void
  updateRequest: (colId: Id, reqId: Id, next: ApiRequest) => void
  renameItem: (colId: Id, itemId: Id, name: string) => void
  moveItem: (colId: Id, itemId: Id, toColId: Id, toParentId: Id | null, index: number) => void
  /** Returns the copy's id, or null when the item does not exist. */
  duplicateItem: (colId: Id, itemId: Id) => Id | null
  /** Returns an undo that restores the subtree at its original index. */
  deleteItem: (colId: Id, itemId: Id) => () => void
  replaceItems: (colId: Id, items: Item[]) => void
  setEnvironment: (env: Environment) => void
  deleteEnvironment: (id: Id) => void
  duplicateEnvironment: (id: Id) => Id | null
  setActiveEnvironment: (wsId: Id, envId: Id | null) => void
  setGlobals: (wsId: Id, vars: Variable[]) => void
  clearTlsReview: (colId: Id) => void
  /** Accepts synced changes to an environment (its id) or to a workspace's globals (`globalsReviewKey(wsId)`). */
  acceptEnvReview: (key: string) => void
  /**
   * The user accepted the connection changes another device made. The build
   * refuses to send while a review is pending, so accepting is what lets the
   * synced TLS, CA, route and hosts take effect on this device.
   */
  acceptTlsReview: (colId: Id) => void
  /**
   * "Recover old data…": the pre-upgrade blob, migrated again. A collection
   * whose id is still here comes back beside it as "<name> (recovered)", once;
   * environments are merged by name. Returns the ids of collections added.
   */
  recoverLegacy: () => Id[]
  /** Whether a pre-upgrade blob is kept, so "Recover old data…" can be offered. */
  hasLegacy: () => boolean
  /** Called by store/app when a workspace is deleted: its collections, environments and globals go with it. */
  onWorkspaceDeleted: (wsId: Id) => void

  collectionsIn: (wsId: Id) => ApiCollectionV2[]
  findRequest: (colId: Id, reqId: Id) => ApiRequest | null
  effectiveRoute: (tab: HttpTabState) => Route
  scopeChainFor: (tab: HttpTabState) => VariableScopeChain
}

// One string, owned by shared/httpErrors, which maps it to its Review fix.
export { ENV_REVIEW_TEXT as ENV_REVIEW_MESSAGE } from '../../../shared/httpErrors'

/** The envReview key for a workspace's globals. */
export const globalsReviewKey = (wsId: Id): string => `globals:${wsId}`

export function emptyWorkspace(): ApiWorkspaceV2 {
  return { version: 2, environments: [], activeEnvironment: Object.create(null), globals: Object.create(null) }
}

/** A copy of a null-prototype map with one key set. */
function withKey<V>(map: Record<Id, V>, key: Id, value: V): Record<Id, V> {
  return Object.assign(Object.create(null), map, { [key]: value })
}

function locate(
  items: Item[],
  id: Id,
  parentId: Id | null = null
): { item: Item; parentId: Id | null; index: number } | null {
  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    if (item.id === id) return { item, parentId, index }
    if (item.kind === 'folder') {
      const found = locate(item.items, id, item.id)
      if (found) return found
    }
  }
  return null
}

function updateIn(items: Item[], id: Id, fn: (item: Item) => Item): Item[] {
  return items.map((item) =>
    item.id === id ? fn(item) : item.kind === 'folder' ? { ...item, items: updateIn(item.items, id, fn) } : item
  )
}

function removeIn(items: Item[], id: Id): Item[] {
  return items
    .filter((item) => item.id !== id)
    .map((item) => (item.kind === 'folder' ? { ...item, items: removeIn(item.items, id) } : item))
}

function spliced(items: Item[], item: Item, index?: number): Item[] {
  const at = index === undefined ? items.length : Math.max(0, Math.min(index, items.length))
  return [...items.slice(0, at), item, ...items.slice(at)]
}

function insertIn(items: Item[], parentId: Id | null, item: Item, index?: number): Item[] {
  if (parentId === null) return spliced(items, item, index)
  return updateIn(items, parentId, (parent) =>
    parent.kind === 'folder' ? { ...parent, items: spliced(parent.items, item, index) } : parent
  )
}

function withFreshIds(item: Item): Item {
  return item.kind === 'folder'
    ? { ...item, id: newId('fld'), items: item.items.map(withFreshIds) }
    : { ...item, id: newId('req') }
}

export const useApi = create<ApiState>((set, get) => {
  const mapCollection = (id: Id, fn: (c: ApiCollectionV2) => ApiCollectionV2): void =>
    set((s) => ({ collections: s.collections.map((c) => (c.id === id ? fn(c) : c)) }))
  const mapItems = (colId: Id, fn: (items: Item[]) => Item[]): void =>
    mapCollection(colId, (c) => ({ ...c, items: fn(c.items) }))
  const collection = (id: Id): ApiCollectionV2 | undefined => get().collections.find((c) => c.id === id)

  return {
    collections: [],
    workspace: emptyWorkspace(),
    legacy: null,
    report: null,
    envReview: [],

    createCollection: (name, route) => {
      const c = defaults.collection(useApp.getState().activeWorkspaceId, name)
      if (route?.kind === 'server') c.viaServerId = route.serverId
      if (route?.kind === 'vpn') c.vpnProfileId = route.vpnProfileId
      set((s) => ({ collections: [...s.collections, c] }))
      return c.id
    },

    updateCollection: (id, patch) => mapCollection(id, (c) => ({ ...c, ...patch })),

    addItem: (colId, parentId, item, index) => mapItems(colId, (items) => insertIn(items, parentId, item, index)),

    updateRequest: (colId, reqId, next) =>
      mapItems(colId, (items) => updateIn(items, reqId, (item) => (item.kind === 'folder' ? item : { ...next, id: reqId }))),

    renameItem: (colId, itemId, name) => mapItems(colId, (items) => updateIn(items, itemId, (item) => ({ ...item, name }))),

    moveItem: (colId, itemId, toColId, toParentId, index) => {
      const source = collection(colId)
      const found = source && locate(source.items, itemId)
      if (!found || !collection(toColId)) return
      // A folder dropped into itself or its own subtree would vanish from the tree.
      if (toParentId === itemId) return
      if (found.item.kind === 'folder' && toParentId && locate(found.item.items, toParentId)) return
      mapItems(colId, (items) => removeIn(items, itemId))
      mapItems(toColId, (items) => insertIn(items, toParentId, found.item, index))
    },

    duplicateItem: (colId, itemId) => {
      const found = locate(collection(colId)?.items ?? [], itemId)
      if (!found) return null
      const copy = { ...withFreshIds(found.item), name: `${found.item.name} copy` }
      mapItems(colId, (items) => insertIn(items, found.parentId, copy, found.index + 1))
      return copy.id
    },

    deleteItem: (colId, itemId) => {
      const found = locate(collection(colId)?.items ?? [], itemId)
      if (!found) return () => {}
      mapItems(colId, (items) => removeIn(items, itemId))
      return () => {
        if (collection(colId)) mapItems(colId, (items) => insertIn(items, found.parentId, found.item, found.index))
      }
    },

    replaceItems: (colId, items) => mapItems(colId, () => items),

    setEnvironment: (env) =>
      set((s) => {
        const exists = s.workspace.environments.some((e) => e.id === env.id)
        const environments = exists
          ? s.workspace.environments.map((e) => (e.id === env.id ? env : e))
          : [...s.workspace.environments, env]
        return { workspace: { ...s.workspace, environments } }
      }),

    deleteEnvironment: (id) =>
      set((s) => {
        const activeEnvironment: Record<Id, Id | null> = Object.create(null)
        for (const [ws, envId] of Object.entries(s.workspace.activeEnvironment)) {
          activeEnvironment[ws] = envId === id ? null : envId
        }
        return {
          workspace: {
            ...s.workspace,
            environments: s.workspace.environments.filter((e) => e.id !== id),
            activeEnvironment
          }
        }
      }),

    duplicateEnvironment: (id) => {
      const env = get().workspace.environments.find((e) => e.id === id)
      if (!env) return null
      const copy: Environment = {
        ...env,
        id: newId('env'),
        name: `${env.name} copy`,
        variables: env.variables.map((v) => ({ ...v, id: newId('var') }))
      }
      get().setEnvironment(copy)
      return copy.id
    },

    setActiveEnvironment: (wsId, envId) =>
      set((s) => ({
        workspace: { ...s.workspace, activeEnvironment: withKey(s.workspace.activeEnvironment, wsId, envId) }
      })),

    setGlobals: (wsId, vars) =>
      set((s) => ({ workspace: { ...s.workspace, globals: withKey(s.workspace.globals, wsId, vars) } })),

    clearTlsReview: (colId) => mapCollection(colId, (c) => ({ ...c, tlsReview: false })),

    acceptEnvReview: (key) => set((s) => ({ envReview: s.envReview.filter((k) => k !== key) })),

    acceptTlsReview: (colId) => get().clearTlsReview(colId),

    recoverLegacy: () => {
      const { legacy, collections, workspace } = get()
      const blob = legacy as { apiCollections?: unknown; apiWorkspace?: unknown } | null
      if (!blob || typeof blob !== 'object') return []
      const ctx = { activeWorkspaceId: useApp.getState().activeWorkspaceId }
      const m = migrateApiState(blob.apiCollections, blob.apiWorkspace, ctx)
      const have = new Set(collections.map((c) => c.id))
      const added: ApiCollectionV2[] = []
      for (const c of m.collections) {
        const copy = have.has(c.id) ? { ...c, id: stableId('col', c.id, 'recovered'), name: `${c.name} (recovered)` } : c
        if (have.has(copy.id)) continue
        have.add(copy.id)
        added.push(copy)
      }
      const merged = mergeIncoming(workspace, m.workspace, { ...ctx, workspaceIds: [...new Set(m.collections.map((c) => c.workspaceId))] })
      if (added.length || merged !== workspace) set({ collections: [...collections, ...added], workspace: merged })
      return added.map((c) => c.id)
    },

    hasLegacy: () => get().legacy !== null,

    onWorkspaceDeleted: (wsId) =>
      set((s) => {
        const without = <V>(map: Record<Id, V>): Record<Id, V> => {
          const next: Record<Id, V> = Object.assign(Object.create(null), map)
          delete next[wsId]
          return next
        }
        return {
          collections: s.collections.filter((c) => c.workspaceId !== wsId),
          workspace: {
            ...s.workspace,
            environments: s.workspace.environments.filter((e) => e.workspaceId !== wsId),
            activeEnvironment: without(s.workspace.activeEnvironment),
            globals: without(s.workspace.globals)
          }
        }
      }),

    collectionsIn: (wsId) => get().collections.filter((c) => c.workspaceId === wsId),

    findRequest: (colId, reqId) => {
      const found = locate(collection(colId)?.items ?? [], reqId)
      return found && found.item.kind !== 'folder' ? found.item : null
    },

    effectiveRoute: (tab) => {
      if (!tab.ref) return tab.route ?? { kind: 'direct' }
      const c = collection(tab.ref.collectionId)
      // A draft whose collection is gone must not quietly send from this machine.
      if (!c) return { kind: 'server', serverId: COLLECTION_GONE_SERVER_ID }
      if (c.vpnProfileId) return { kind: 'vpn', vpnProfileId: c.vpnProfileId }
      if (c.viaServerId) return { kind: 'server', serverId: c.viaServerId }
      return { kind: 'direct' }
    },

    scopeChainFor: (tab) => {
      const { workspace } = get()
      const envId = Object.hasOwn(workspace.activeEnvironment, tab.workspaceId)
        ? workspace.activeEnvironment[tab.workspaceId]
        : null
      const env = workspace.environments.find((e) => e.id === envId)
      const globals = Object.hasOwn(workspace.globals, tab.workspaceId) ? workspace.globals[tab.workspaceId] : []
      return scopeChain(globals, tab.ref ? collection(tab.ref.collectionId) : null, env)
    }
  }
})
