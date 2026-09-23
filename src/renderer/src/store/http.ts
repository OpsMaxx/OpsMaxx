import { create } from 'zustand'
import {
  DEFAULT_PREFS,
  defaults,
  isValidId,
  newId,
  type ApiRequest,
  type HttpLayoutPrefs,
  type HttpSessionV1,
  type HttpTabState,
  type Id,
  type RequestKind,
  type ResponseState,
  type Route,
  type SplitState
} from '../../../shared/apiModel'
import { moveId, REOPEN_LIMIT, successorAfterClose } from '../lib/tabs'
import { useApi } from './api'
import { useApp } from './app'
import { toast } from './toast'

// The HTTP workbench's session: open tabs, drafts, responses and layout prefs.
// Responses live only here, in memory. The persisted slice is `getHttpSession`.
//
// The dirty-close prompt and the "Closed · Reopen" toast are the UI's: this
// store closes what it is told to close, and `isDirty` is how the UI decides
// whether to ask first.

export interface ClosedTab {
  tab: HttpTabState
  index: number
  closedAt: number
}

export type CollectionSection = 'overview' | 'variables' | 'auth' | 'connection'

/**
 * A workbench-level surface opened from outside the workbench (palette, ⌘O,
 * the sidebar, the banner). `env` asks the environment picker to open its menu.
 */
export type HttpOverlay = 'import' | 'cookies' | 'save' | 'env' | null

/** A handler for a shortcut id, registered by the mounted workbench. */
export type HttpHotkey = (e?: KeyboardEvent) => boolean

interface HttpState {
  tabs: HttpTabState[]
  activeTab: Record<Id, Id | null>
  /** Per workspace, the scratch tab the empty workbench edits. Not in `tabs`. */
  ghost: Record<Id, HttpTabState>
  responses: Record<Id, ResponseState>
  prefs: HttpLayoutPrefs
  closedStack: ClosedTab[]
  sidebarTab: 'collections' | 'history'
  expanded: Id[]
  bannerDismissed?: string
  /** Session only: which section a collection tab should open on. */
  collectionSection: Record<Id, CollectionSection>
  overlay: HttpOverlay
  /** With `overlay: 'import'`: re-import into this collection rather than create one. */
  importTarget: Id | null
  /** Tabs waiting on the close prompt (unsaved edits, a live WebSocket). */
  pendingClose: Id[] | null

  openRequest: (ref: { collectionId: Id; requestId?: Id }, opts?: { preview?: boolean }) => Id
  /**
   * `route` is the scratch tab's own route (a history re-run keeps its route id);
   * `strippedFields` marks values that arrived masked, so they show "Not kept"
   * and the send refuses them.
   */
  openScratch: (kind: RequestKind, init?: ApiRequest, opts?: { route?: Route; strippedFields?: string[] }) => Id
  openCollectionTab: (collectionId: Id, section?: CollectionSection) => Id
  openEnvironments: () => Id
  ensureGhost: (wsId: Id) => HttpTabState
  /** Moves the ghost into the strip with the same id, so nothing remounts. */
  promoteGhost: (wsId: Id) => Id
  activateTab: (id: Id) => void
  closeTab: (id: Id) => void
  closeMany: (ids: Id[]) => void
  pin: (id: Id) => void
  /** `index` is the slot within the tab's own workspace strip. */
  reorder: (id: Id, index: number) => void
  reopenClosed: () => Id | null
  duplicateTab: (id: Id) => Id | null
  /** Pins the tab, and promotes it first if it is the ghost. */
  updateDraft: (tabId: Id, next: ApiRequest) => void
  /** A scratch tab's own route. A saved request's route is its collection's. */
  setRoute: (tabId: Id, route: Route) => void
  /** A scratch tab becomes the saved request it was just saved as. */
  attachRef: (tabId: Id, ref: { collectionId: Id; requestId: Id }) => void
  /** Saves a saved request's draft in place. False for a scratch tab: it needs the Save dialog. */
  saveInPlace: (tabId: Id) => boolean
  isDirty: (tabId: Id) => boolean
  /** The request a tab edits: its draft, else the saved request it points at. */
  requestFor: (tabId: Id) => ApiRequest | null
  setSplit: (tabId: Id, split: SplitState) => void
  /** Expands a collapsed response, for results the store cannot see (GraphQL errors[], a WS abnormal close). */
  revealResponse: (tabId: Id) => void
  setResponse: (tabId: Id, response: ResponseState) => void
  setPrefs: (patch: Partial<HttpLayoutPrefs>) => void
  setOverlay: (overlay: HttpOverlay, importTarget?: Id | null) => void
  /** The Import dialog; with a collection id, a re-import into that collection. */
  openImport: (collectionId?: Id) => void
  setExpanded: (id: Id, open: boolean) => void
  setSidebarTab: (tab: 'collections' | 'history') => void
  setPendingClose: (ids: Id[] | null) => void
  dismissBanner: (reportId: string) => void
  /** A deleted workspace's tabs, ghost and reopen history go with it. */
  onWorkspaceDeleted: (wsId: Id) => void
  getHttpSession: () => HttpSessionV1
  restoreHttpSession: (raw: unknown) => void
  subscribeHttpSession: (cb: (session: HttpSessionV1) => void) => () => void
}

let hotkeys: Record<string, HttpHotkey> | null = null

export function resetHttpForTests(): void {
  hotkeys = null
}

/**
 * The mounted workbench's shortcut handlers, keyed by command id.
 *
 * Registered rather than imported by useHotkeys so that the send pipeline,
 * CodeMirror and the rest of the HTTP chunk stay out of the entry bundle: the
 * handlers exist exactly while the workbench is mounted.
 */
export function registerHttpHotkeys(map: Record<string, HttpHotkey>): () => void {
  hotkeys = map
  return () => {
    if (hotkeys === map) hotkeys = null
  }
}

export function httpHotkey(id: string): HttpHotkey | undefined {
  return hotkeys && Object.hasOwn(hotkeys, id) ? hotkeys[id] : undefined
}

const SPLITS: readonly SplitState[] = ['normal', 'response-collapsed', 'request-collapsed']
const TAB_KINDS: readonly HttpTabState['kind'][] = ['request', 'collection', 'environments']

const activeWorkspace = (): Id => useApp.getState().activeWorkspaceId

/**
 * A result that should not stay hidden behind a collapsed response. Cancelling
 * and declining the production confirm are the user's own doing, not news.
 */
export function isErrorResult(r: ResponseState): boolean {
  if (r.status === 'error') return r.errorClass !== 'prod-declined' && r.errorClass !== 'aborted'
  return r.status === 'done' && r.response.status >= 400
}

function isTab(value: unknown): value is HttpTabState {
  const t = value as Partial<HttpTabState> | null
  return typeof t === 'object' && t !== null && isValidId(t.id) && isValidId(t.workspaceId)
}

/** A restored tab, with every field the UI branches on forced into range. */
function cleanTab(t: HttpTabState): HttpTabState {
  const out: HttpTabState = {
    id: t.id,
    workspaceId: t.workspaceId,
    preview: t.preview === true,
    split: SPLITS.includes(t.split) ? t.split : 'normal',
    kind: TAB_KINDS.includes(t.kind) ? t.kind : 'request'
  }
  if (t.ref && isValidId(t.ref.collectionId)) {
    out.ref = { collectionId: t.ref.collectionId }
    if (isValidId(t.ref.requestId)) out.ref.requestId = t.ref.requestId
  }
  if (t.draft && typeof t.draft === 'object') out.draft = t.draft
  if (t.route && typeof t.route === 'object') out.route = t.route
  if (Array.isArray(t.strippedFields)) out.strippedFields = t.strippedFields.filter((p) => typeof p === 'string')
  return out
}

/** A request tab with nothing to edit cannot render: dropped rather than crashed on. */
const renderable = (t: HttpTabState): boolean => t.kind !== 'request' || !!t.draft || !!t.ref?.requestId

export const useHttp = create<HttpState>((set, get, api) => {
  const newTab = (workspaceId: Id, init: Partial<HttpTabState>): HttpTabState => ({
    id: newId('tab'),
    workspaceId,
    preview: false,
    // A new tab takes the last split state chosen.
    split: get().prefs.lastSplit,
    kind: 'request',
    ...init
  })
  const activate = (t: HttpTabState): void => set((s) => ({ activeTab: { ...s.activeTab, [t.workspaceId]: t.id } }))
  const mapTab = (id: Id, fn: (t: HttpTabState) => HttpTabState): void =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? fn(t) : t)) }))
  const tab = (id: Id): HttpTabState | undefined => get().tabs.find((t) => t.id === id)
  const append = (t: HttpTabState): Id => {
    set((s) => ({ tabs: [...s.tabs, t] }))
    activate(t)
    return t.id
  }
  const ghostWorkspace = (id: Id): Id | undefined => Object.keys(get().ghost).find((ws) => get().ghost[ws].id === id)
  const savedRequest = (t: HttpTabState): ApiRequest | null =>
    t.ref?.requestId ? useApi.getState().findRequest(t.ref.collectionId, t.ref.requestId) : null

  return {
    tabs: [],
    activeTab: {},
    ghost: {},
    responses: {},
    prefs: DEFAULT_PREFS,
    closedStack: [],
    sidebarTab: 'collections',
    expanded: [],
    collectionSection: {},
    overlay: null,
    importTarget: null,
    pendingClose: null,

    openRequest: (ref, { preview = false } = {}) => {
      const ws = activeWorkspace()
      const { tabs } = get()
      const existing = tabs.find(
        (t) => t.workspaceId === ws && t.ref?.collectionId === ref.collectionId && t.ref?.requestId === ref.requestId
      )
      if (existing) {
        if (!preview && existing.preview) get().pin(existing.id)
        activate(existing)
        return existing.id
      }
      const t = newTab(ws, { kind: ref.requestId ? 'request' : 'collection', ref: { ...ref }, preview })
      const previewAt = preview ? tabs.findIndex((x) => x.workspaceId === ws && x.preview) : -1
      if (previewAt === -1) return append(t)
      // The next single click replaces the preview tab in place.
      const replaced = tabs[previewAt]
      const { [replaced.id]: _gone, ...responses } = get().responses
      set({ tabs: tabs.map((x, i) => (i === previewAt ? t : x)), responses })
      activate(t)
      return t.id
    },

    openScratch: (kind, init, opts) =>
      append(
        newTab(activeWorkspace(), {
          draft: init ?? defaults[kind](),
          ...(opts?.route ? { route: opts.route } : {}),
          ...(opts?.strippedFields?.length ? { strippedFields: [...opts.strippedFields] } : {})
        })
      ),

    openCollectionTab: (collectionId, section) => {
      const id = get().openRequest({ collectionId })
      if (section) set((s) => ({ collectionSection: { ...s.collectionSection, [id]: section } }))
      return id
    },

    openEnvironments: () => {
      const ws = activeWorkspace()
      const existing = get().tabs.find((t) => t.workspaceId === ws && t.kind === 'environments')
      if (existing) {
        activate(existing)
        return existing.id
      }
      return append(newTab(ws, { kind: 'environments' }))
    },

    ensureGhost: (wsId) => {
      const existing = get().ghost[wsId]
      if (existing) return existing
      const g = newTab(wsId, { draft: defaults.http() })
      set((s) => ({ ghost: { ...s.ghost, [wsId]: g } }))
      return g
    },

    promoteGhost: (wsId) => {
      const t = { ...get().ensureGhost(wsId), preview: false }
      const fresh = newTab(wsId, { draft: defaults.http() })
      set((s) => ({ tabs: [...s.tabs, t], ghost: { ...s.ghost, [wsId]: fresh } }))
      activate(t)
      return t.id
    },

    activateTab: (id) => {
      const t = tab(id)
      if (t) activate(t)
    },

    closeTab: (id) => get().closeMany([id]),

    closeMany: (ids) => {
      const doomed = new Set(ids)
      const { tabs, activeTab, responses, closedStack, collectionSection } = get()
      const closing = tabs.flatMap((t, index) => (doomed.has(t.id) ? [{ tab: t, index, closedAt: Date.now() }] : []))
      if (closing.length === 0) return
      const like = tabs.map((t) => ({ id: t.id, workspaceId: t.workspaceId, title: '' }))
      const nextActive = { ...activeTab }
      for (const ws of Object.keys(nextActive)) nextActive[ws] = successorAfterClose(like, doomed, nextActive[ws])
      const keep = <V>(map: Record<Id, V>): Record<Id, V> =>
        Object.fromEntries(Object.entries(map).filter(([id]) => !doomed.has(id)))
      set({
        tabs: tabs.filter((t) => !doomed.has(t.id)),
        activeTab: nextActive,
        responses: keep(responses),
        collectionSection: keep(collectionSection),
        closedStack: [...closedStack, ...closing].slice(-REOPEN_LIMIT)
      })
    },

    pin: (id) => mapTab(id, (t) => ({ ...t, preview: false })),

    reorder: (id, index) =>
      set((s) => {
        const moving = s.tabs.find((t) => t.id === id)
        if (!moving) return {}
        const strip = s.tabs.filter((t) => t.workspaceId === moving.workspaceId)
        const byId = new Map(strip.map((t) => [t.id, t]))
        const order = moveId(
          strip.map((t) => t.id),
          id,
          index
        ).map((tabId) => byId.get(tabId)!)
        // Other workspaces' tabs keep their slots; this workspace's are refilled in the new order.
        let i = 0
        return { tabs: s.tabs.map((t) => (t.workspaceId === moving.workspaceId ? order[i++] : t)) }
      }),

    reopenClosed: () => {
      const entry = get().closedStack.at(-1)
      if (!entry) return null
      set((s) => ({ closedStack: s.closedStack.slice(0, -1) }))
      const { tab: t, index } = entry
      const same = get().tabs.find(
        (x) =>
          x.workspaceId === t.workspaceId &&
          x.ref &&
          x.ref.collectionId === t.ref?.collectionId &&
          x.ref.requestId === t.ref?.requestId
      )
      if (same) {
        activate(same)
        return same.id
      }
      set((s) => ({ tabs: [...s.tabs.slice(0, index), t, ...s.tabs.slice(index)] }))
      activate(t)
      return t.id
    },

    duplicateTab: (id) => {
      const t = tab(id)
      const req = t && get().requestFor(id)
      if (!t || !req) return null
      // A copy of a saved request is a new, unsaved one that sends the same way.
      // Not while its collection holds a synced change for review: the copy
      // would have no collection, so nothing would hold it, and it would send
      // the possibly-changed host straight away.
      const api = useApi.getState()
      const held = t.ref && api.collections.find((c) => c.id === t.ref!.collectionId && c.tlsReview)
      if (held) {
        toast('Review this collection’s changes first.', 'info', {
          label: 'Review',
          run: () => get().openCollectionTab(held.id, 'connection')
        })
        return null
      }
      const copy = newTab(t.workspaceId, { draft: structuredClone(req), route: api.effectiveRoute(t) })
      set((s) => {
        const at = s.tabs.findIndex((x) => x.id === id) + 1
        return { tabs: [...s.tabs.slice(0, at), copy, ...s.tabs.slice(at)] }
      })
      activate(copy)
      return copy.id
    },

    updateDraft: (tabId, next) => {
      const ghostWs = ghostWorkspace(tabId)
      if (ghostWs !== undefined) get().promoteGhost(ghostWs)
      mapTab(tabId, (t) => ({ ...t, draft: next, preview: false }))
    },

    setRoute: (tabId, route) => {
      const ghostWs = ghostWorkspace(tabId)
      if (ghostWs !== undefined) {
        set((s) => ({ ghost: { ...s.ghost, [ghostWs]: { ...s.ghost[ghostWs], route } } }))
        return
      }
      mapTab(tabId, (t) => (t.ref ? t : { ...t, route }))
    },

    attachRef: (tabId, ref) =>
      mapTab(tabId, ({ draft: _d, route: _r, strippedFields: _s, ...t }) => ({
        ...t,
        ref: { ...ref },
        preview: false
      })),

    saveInPlace: (tabId) => {
      const t = tab(tabId)
      // No saved request to write to (a scratch tab, or one deleted or moved
      // away since): the Save dialog, never a draft dropped on the floor.
      if (!t?.ref?.requestId || !savedRequest(t)) return false
      if (t.draft) useApi.getState().updateRequest(t.ref.collectionId, t.ref.requestId, t.draft)
      mapTab(tabId, ({ draft: _d, strippedFields: _s, ...rest }) => rest)
      return true
    },

    isDirty: (tabId) => {
      const t = tab(tabId)
      if (!t?.draft || !t.ref?.requestId) return false
      const saved = savedRequest(t)
      return !saved || JSON.stringify(saved) !== JSON.stringify({ ...t.draft, id: saved.id })
    },

    requestFor: (tabId) => {
      const t = tab(tabId) ?? Object.values(get().ghost).find((g) => g.id === tabId)
      if (!t) return null
      return t.draft ?? savedRequest(t)
    },

    setSplit: (tabId, split) => {
      mapTab(tabId, (t) => ({ ...t, split }))
      if (get().prefs.lastSplit !== split) set((s) => ({ prefs: { ...s.prefs, lastSplit: split } }))
    },

    revealResponse: (tabId) => {
      if (tab(tabId)?.split === 'response-collapsed') mapTab(tabId, (t) => ({ ...t, split: 'normal' }))
    },

    setResponse: (tabId, response) => {
      set((s) => ({ responses: { ...s.responses, [tabId]: response } }))
      // A success leaves a collapsed response collapsed, with the status in its bar.
      if (isErrorResult(response)) get().revealResponse(tabId)
    },

    setPrefs: (patch) => set((s) => ({ prefs: { ...s.prefs, ...patch } })),

    setOverlay: (overlay, importTarget = null) => set({ overlay, importTarget }),

    openImport: (collectionId) => set({ overlay: 'import', importTarget: collectionId ?? null }),

    setExpanded: (id, open) =>
      set((s) => {
        if (s.expanded.includes(id) === open) return {}
        return { expanded: open ? [...s.expanded, id] : s.expanded.filter((x) => x !== id) }
      }),

    setSidebarTab: (sidebarTab) => set({ sidebarTab }),

    setPendingClose: (pendingClose) => set({ pendingClose }),

    dismissBanner: (reportId) => set({ bannerDismissed: reportId }),

    onWorkspaceDeleted: (wsId) =>
      set((s) => {
        // Their sockets and in-flight requests are released by wsSessions' and
        // httpSend's subscriptions, which see these tabs leave `tabs`.
        const gone = new Set(s.tabs.filter((t) => t.workspaceId === wsId).map((t) => t.id))
        const { [wsId]: _a, ...activeTab } = s.activeTab
        const { [wsId]: _g, ...ghost } = s.ghost
        return {
          tabs: s.tabs.filter((t) => !gone.has(t.id)),
          activeTab,
          ghost,
          responses: Object.fromEntries(Object.entries(s.responses).filter(([id]) => !gone.has(id))),
          closedStack: s.closedStack.filter((c) => c.tab.workspaceId !== wsId)
        }
      }),

    getHttpSession: () => {
      const { tabs, activeTab, sidebarTab, expanded, prefs, bannerDismissed } = get()
      return { version: 1, tabs, activeTab, sidebarTab, expanded, prefs, bannerDismissed }
    },

    restoreHttpSession: (raw) => {
      const saved = raw as Partial<HttpSessionV1> | null
      if (typeof saved !== 'object' || saved === null || saved.version !== 1) return
      const tabs = Array.isArray(saved.tabs) ? saved.tabs.filter(isTab).map(cleanTab).filter(renderable) : []
      const activeTab: Record<Id, Id | null> = {}
      for (const [ws, id] of Object.entries(saved.activeTab ?? {})) {
        if (isValidId(ws)) activeTab[ws] = tabs.some((t) => t.id === id && t.workspaceId === ws) ? id : null
      }
      const prefs = { ...DEFAULT_PREFS, ...saved.prefs, ratios: { ...DEFAULT_PREFS.ratios, ...saved.prefs?.ratios } }
      if (!SPLITS.includes(prefs.lastSplit)) prefs.lastSplit = 'normal'
      set({
        tabs,
        activeTab,
        sidebarTab: saved.sidebarTab === 'history' ? 'history' : 'collections',
        expanded: Array.isArray(saved.expanded) ? saved.expanded.filter(isValidId) : [],
        prefs,
        bannerDismissed: typeof saved.bannerDismissed === 'string' ? saved.bannerDismissed : undefined
      })
    },

    subscribeHttpSession: (cb) =>
      api.subscribe((s, prev) => {
        const changed =
          s.tabs !== prev.tabs ||
          s.activeTab !== prev.activeTab ||
          s.sidebarTab !== prev.sidebarTab ||
          s.expanded !== prev.expanded ||
          s.prefs !== prev.prefs ||
          s.bannerDismissed !== prev.bannerDismissed
        if (changed) cb(s.getHttpSession())
      })
  }
})
