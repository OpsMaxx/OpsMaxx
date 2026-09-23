import { Kind, parse } from 'graphql'
import {
  newId,
  valueAtPath,
  type ApiRequest,
  type Environment,
  type GraphQlRequest,
  type HttpRequest,
  type HttpTabState,
  type Id,
  type ResponseState,
  type SentView,
  type TransportErrorClass
} from '../../../shared/apiModel'
import type { SecretLookup } from '../../../shared/apiSecrets'
import {
  buildGraphQlSpec,
  buildHttpSpec,
  buildWsSpec,
  type BuildCtx,
  type BuildServer,
  type BuildFailure,
  type BuildResult,
  type WsBuildResult
} from '../../../shared/apiRequestBuild'
import { toCurl } from '../../../shared/curl'
import type { HttpRequestSpec } from '../../../shared/httpClient'
import { classifyTransportError, maskUrlsIn } from '../../../shared/httpErrors'
import { MASKED, toHistoryEntry, type HistoryEntry } from '../../../shared/httpHistory'
import { ENV_REVIEW_MESSAGE, globalsReviewKey, useApi } from '../store/api'
import { useApp } from '../store/app'
import { useHttp } from '../store/http'
import { useHttpCookies } from '../store/httpCookies'
import { askProduction, useHttpRuntime } from '../store/httpRuntime'
import { useToasts } from '../store/toast'
import { useVault } from '../store/vault'
import { useWsSessions } from '../store/wsSessions'
import { sshTargetFor } from './ssh'

// Renderer glue between a tab and main: build, confirm, send, record. The
// production confirm lives here rather than in any button, so every entry
// point (Send, ⌘↵, the palette, history, WS resend) passes through it.

export interface ProductionCtx {
  method: string
  /** GraphQL operation type, when the request is GraphQL. */
  operation?: 'query' | 'mutation' | 'subscription'
  /** A WebSocket connect or send. */
  socket?: 'connect' | 'send'
  environment: Environment | null
  server: { id: Id; name: string; tags: string[] } | null
  /** The route's label, for the prompt. */
  via?: string
}

/**
 * The vault, read at SEND time from the live store. A snapshot taken earlier
 * would report the vault locked after an unlock, or keep serving values from
 * one that has since re-locked. Copied from lib/httpTransport.ts, which
 * cutover deletes.
 */
export function liveVault(): SecretLookup {
  const state = useVault.getState()
  return {
    unlocked: state.unlocked,
    read: ({ entryId, field }) => {
      const entry = state.entries.find((e) => e.id === entryId)
      if (!entry) return null
      return field === 'username' ? entry.username : entry.password
    }
  }
}

const PROD_TAG = /^prod(uction)?$/i
// Everything but a read asks: PURGE, MOVE, COPY, LOCK, MKCOL and custom verbs change things too.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function actionOf(ctx: ProductionCtx): string | null {
  if (ctx.socket) return ctx.socket === 'connect' ? 'WebSocket connect' : 'WebSocket message'
  if (ctx.operation) return ctx.operation === 'mutation' ? 'mutation' : null
  const method = ctx.method.toUpperCase()
  return SAFE_METHODS.has(method) ? null : method
}

/** Resolves true when the send may go ahead. */
export async function confirmIfProduction(ctx: ProductionCtx): Promise<boolean> {
  const action = actionOf(ctx)
  if (!action) return true
  const byEnv = ctx.environment?.production ? ctx.environment : null
  const byServer = ctx.server && ctx.server.tags.some((t) => PROD_TAG.test(t)) ? ctx.server : null
  if (!byEnv && !byServer) return true
  // When both make it production, "don't ask again" for one does not cover the other.
  const scope = [byEnv && `env:${byEnv.id}`, byServer && `server:${byServer.id}`].filter(Boolean).join('+')
  const key = `${scope}|${action}`
  if (Object.hasOwn(useHttpRuntime.getState().skip, key)) return true
  const target = byEnv ? byEnv.name : byServer!.name
  return askProduction(
    {
      action,
      target,
      ...(ctx.via && ctx.via !== target ? { via: ctx.via } : {}),
      skipLabel: `Don't ask again this session for ${action} on ${target}`
    },
    key
  )
}

// ------------------------------------------------------------------ context

function findTab(tabId: Id): HttpTabState | null {
  const { tabs, ghost } = useHttp.getState()
  return tabs.find((t) => t.id === tabId) ?? Object.values(ghost).find((t) => t.id === tabId) ?? null
}

function requestOf(tab: HttpTabState): ApiRequest | null {
  if (tab.draft) return tab.draft
  return tab.ref?.requestId ? useApi.getState().findRequest(tab.ref.collectionId, tab.ref.requestId) : null
}

function activeEnv(workspaceId: Id): Environment | null {
  const ws = useApi.getState().workspace
  const id = Object.hasOwn(ws.activeEnvironment, workspaceId) ? ws.activeEnvironment[workspaceId] : null
  return ws.environments.find((e) => e.id === id) ?? null
}

interface SendCtx {
  tab: HttpTabState
  req: ApiRequest
  build: BuildCtx
  env: Environment | null
  server: { id: Id; name: string; tags: string[] } | null
  /** The routed server exists but could not be turned into a target. */
  routeError?: string
}

/** How a send is built. `allowUnresolved` is "Send anyway" (§2.8). */
export interface SendOpts {
  allowUnresolved?: boolean
}

function contextFor(tabId: Id, opts: SendOpts & { vault?: SecretLookup } = {}): SendCtx | null {
  const tab = findTab(tabId)
  const req = tab && requestOf(tab)
  if (!tab || !req) return null
  const api = useApi.getState()
  const app = useApp.getState()
  const collection = tab.ref ? api.collections.find((c) => c.id === tab.ref!.collectionId) : undefined
  const env = activeEnv(tab.workspaceId)
  const effective = api.effectiveRoute(tab)
  // Only the tab's own workspace: history is global, and a route id from
  // another workspace must be route-missing here, never that workspace's
  // server (whose lock this workspace does not hold). Only the one server the
  // route names is resolved, and a malformed one is reported, not thrown.
  const routed =
    effective.kind === 'server'
      ? app.servers.find((s) => s.id === effective.serverId && s.workspaceId === tab.workspaceId)
      : undefined
  let servers: BuildServer[] = []
  let routeError: string | undefined
  if (routed) {
    try {
      servers = [{ id: routed.id, name: routed.name, tags: routed.tags ?? [], target: sshTargetFor(routed) }]
    } catch (err) {
      routeError = `${routed.name} cannot be used as a route: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  const vpns = app.vpns.filter((v) => v.workspaceId === tab.workspaceId).map((v) => ({ id: v.id, name: v.name }))
  const files = useHttpRuntime.getState().files[tab.id] ?? {}
  return {
    tab,
    req,
    env,
    ...(routeError ? { routeError } : {}),
    server: servers[0] ? { id: servers[0].id, name: servers[0].name, tags: servers[0].tags } : null,
    build: {
      collection,
      env: env ?? undefined,
      globals: Object.hasOwn(api.workspace.globals, tab.workspaceId) ? api.workspace.globals[tab.workspaceId] : [],
      vault: opts.vault ?? liveVault(),
      cookieHeader: (routeKey, url) => useHttpCookies.getState().headerFor(tab.workspaceId, routeKey, url),
      servers,
      vpns,
      route: effective,
      requestId: newId('req'),
      fileBytes: (key) => (Object.hasOwn(files, key) ? files[key].bytes : null),
      ...(opts.allowUnresolved ? { allowUnresolved: true } : {})
    }
  }
}

function failed(f: BuildFailure): ResponseState {
  return { status: 'error', errorClass: f.errorClass, message: f.message, ...(f.unresolved ? { unresolved: f.unresolved } : {}) }
}

const DECLINED: ResponseState = { status: 'error', errorClass: 'prod-declined', message: 'Not sent.' }

function recordHistory(ctx: SendCtx, sent: SentView, result: Extract<ResponseState, { status: 'done' | 'error' }>): void {
  try {
    const collection = ctx.build.collection
    const entry = toHistoryEntry(ctx.req, sent, result, {
      workspaceId: ctx.tab.workspaceId,
      environment: ctx.env?.name,
      collection: collection?.name,
      route: ctx.build.route,
      routeLabel: sent.route.label,
      ...(ctx.tab.ref?.requestId ? { requestRef: { collectionId: ctx.tab.ref.collectionId, requestId: ctx.tab.ref.requestId } } : {})
    })
    void window.opsmaxx.httpHistory.append(entry).catch(() => {})
  } catch {
    // History is a convenience. A failure to record must never fail a send.
  }
}

function classify(error: string, code?: string): ResponseState {
  if (code === 'ABORTED') return { status: 'error', errorClass: 'aborted', message: 'Cancelled.', code }
  try {
    // The raw error is kept: the response pane words it from the class and masks its URLs.
    const c = classifyTransportError(error, code)
    return { status: 'error', errorClass: c.class, message: maskUrlsIn(error), ...(code ? { code } : {}) }
  } catch {
    return { status: 'error', errorClass: 'other', message: maskUrlsIn(error), ...(code ? { code } : {}) }
  }
}

/** Confirmed, sent, and recorded. Shared by REST and GraphQL. */
async function dispatch(ctx: SendCtx, built: BuildResult, production: Omit<ProductionCtx, 'environment' | 'server'>): Promise<void> {
  const { setResponse } = useHttp.getState()
  const tabId = ctx.tab.id
  if (!built.ok) {
    setResponse(tabId, failed(built))
    return
  }
  const confirmed = await confirmIfProduction({ ...production, environment: ctx.env, server: ctx.server, via: built.sent.route.label })
  if (!confirmed) {
    setResponse(tabId, DECLINED)
    return
  }
  // Closed while the prompt was up: nothing is sent for a tab that is gone.
  if (!findTab(tabId)) return
  // Sending from a preview tab keeps it (§2.9): the response must not vanish with the next preview.
  useHttp.getState().pin(tabId)
  const requestId = ctx.build.requestId
  useHttpRuntime.setState((s) => ({ inflight: { ...s.inflight, [tabId]: requestId } }))
  setResponse(tabId, { status: 'sending', startedAt: Date.now(), requestId })

  let result: Awaited<ReturnType<typeof window.opsmaxx.http.request>>
  try {
    result = await window.opsmaxx.http.request(built.spec)
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  // Cancelled, or sent again, while this one was in flight.
  if (useHttpRuntime.getState().inflight[tabId] !== requestId) return
  useHttpRuntime.setState((s) => {
    const { [tabId]: _done, ...inflight } = s.inflight
    return { inflight }
  })

  let state: Extract<ResponseState, { status: 'done' | 'error' }>
  if (result.ok) {
    // Cookies belong to the URL that answered, which after a redirect is not
    // the one asked for. A cross-origin hop that dropped the route was sent
    // from this machine, so its cookies go in the direct jar, never the
    // route's: that route's `localhost` is a different machine.
    const jarRoute = result.routeDropped ? 'direct' : built.routeKey
    useHttpCookies.getState().store(ctx.tab.workspaceId, jarRoute, result.finalUrl ?? built.spec.url, result.setCookie ?? [])
    state = { status: 'done', response: result, sentAs: built.sent, at: Date.now() }
  } else {
    state = classify(result.error, result.code) as typeof state
  }
  setResponse(tabId, state)
  recordHistory(ctx, built.sent, state)
}

// ------------------------------------------------------------------ entry points

export async function send(tabId: Id, opts: SendOpts = {}): Promise<void> {
  const ctx = contextFor(tabId, opts)
  if (!ctx) return
  if (ctx.req.kind === 'graphql') return runGraphQl(tabId, undefined, opts)
  if (ctx.req.kind === 'ws') return openSocket(tabId, opts)
  await dispatch(ctx, unkeptFailure(ctx) ?? buildHttpSpec(ctx.req, ctx.build), { method: ctx.req.method })
}

export function cancel(tabId: Id): void {
  const requestId = useHttpRuntime.getState().inflight[tabId]
  if (!requestId) return
  useHttpRuntime.setState((s) => {
    const { [tabId]: _gone, ...inflight } = s.inflight
    return { inflight }
  })
  useHttp.getState().setResponse(tabId, { status: 'error', errorClass: 'aborted', message: 'Cancelled.' })
  void window.opsmaxx.http.cancel(requestId).catch(() => {})
}

/** The type of the operation that will run: the named one, or the only one. */
export function operationType(query: string, operationName?: string): 'query' | 'mutation' | 'subscription' {
  try {
    const ops = parse(query).definitions.filter((d) => d.kind === Kind.OPERATION_DEFINITION)
    const op = operationName ? ops.find((d) => d.name?.value === operationName) : ops.length === 1 ? ops[0] : undefined
    if (op) return op.operation
  } catch {
    /* Unparseable: fall through to the cautious answer. */
  }
  // Unknown means ask: treating an unreadable document as a mutation costs a prompt, not a write.
  return /\bmutation\b/.test(query) ? 'mutation' : 'query'
}

export async function runGraphQl(tabId: Id, operationName?: string, opts: SendOpts = {}): Promise<void> {
  const ctx = contextFor(tabId, opts)
  if (!ctx || ctx.req.kind !== 'graphql') return
  const req: GraphQlRequest = ctx.req
  const name = operationName ?? req.operationName
  await dispatch(ctx, unkeptFailure(ctx) ?? buildGraphQlSpec(req, ctx.build, operationName), {
    method: 'POST',
    operation: operationType(req.query, name)
  })
}

/**
 * The spec a WebSocket connect should open, after the production confirm.
 * `openSocket` is the only caller of `wsSessions.connect`, so no path opens a
 * socket without the confirm.
 */
export async function prepareSocket(tabId: Id, opts: SendOpts = {}): Promise<WsBuildResult> {
  const ctx = contextFor(tabId, opts)
  if (!ctx || ctx.req.kind !== 'ws') {
    return { ok: false, errorClass: 'other', message: 'This tab is not a WebSocket request.' }
  }
  const built = unkeptFailure(ctx) ?? buildWsSpec(ctx.req, ctx.build)
  if (!built.ok) return built
  const confirmed = await confirmIfProduction({
    method: 'GET',
    socket: 'connect',
    environment: ctx.env,
    server: ctx.server,
    via: built.sent.route.label
  })
  if (!confirmed) return { ok: false, errorClass: 'prod-declined', message: 'Not connected.' }
  // Closed while the prompt was up: a socket for a gone tab would never be closed.
  if (!findTab(tabId)) return { ok: false, errorClass: 'other', message: 'The tab was closed.' }
  return built
}

// wsSessions never imports this module (no cycle): the spec travels one way,
// from the build and the confirm here into the store.
export async function openSocket(tabId: Id, opts: SendOpts = {}): Promise<void> {
  const built = await prepareSocket(tabId, opts)
  // Nothing to connect or report for a tab that closed meanwhile.
  if (!findTab(tabId)) return
  const ws = useWsSessions.getState()
  if (built.ok) {
    useHttp.getState().pin(tabId)
    return ws.connect(tabId, built.spec, built.sent)
  }
  // A decline is reported too, as 'prod-declined', the same state an HTTP send
  // records: the pane says it was not connected, and why.
  ws.fail(tabId, built)
}

export async function sendWsMessage(tabId: Id, text: string): Promise<void> {
  const ctx = contextFor(tabId)
  if (!ctx || ctx.req.kind !== 'ws') return
  const confirmed = await confirmIfProduction({
    method: 'GET',
    socket: 'send',
    environment: ctx.env,
    server: ctx.server,
    via: routeLabel(ctx)
  })
  if (confirmed && findTab(tabId)) await useWsSessions.getState().send(tabId, text)
}

/**
 * Opens the entry as a new scratch tab on the route it was sent through, and
 * sends it. The route comes from the id: a server or VPN that is gone is
 * `route-missing` in the build, never a fall back to direct.
 */
export async function sendAgainFromHistory(entry: HistoryEntry): Promise<void> {
  // A saved request that still exists is sent as it is now: the history copy
  // is redacted, and its masked values are not the real ones.
  const ref = entry.requestRef
  if (ref && useApi.getState().findRequest(ref.collectionId, ref.requestId)) {
    await send(useHttp.getState().openRequest(ref))
    return
  }
  const { request, strippedFields } = requestFromHistory(entry)
  const tabId = useHttp.getState().openScratch(entry.kind, request, { route: entry.route, strippedFields })
  await send(tabId)
}


const hasMask = (v: unknown): boolean => typeof v === 'string' && v.includes(MASKED)

/**
 * A history entry as a new scratch request. Every value history masked is
 * listed in `strippedFields` (paths relative to the request, the same form
 * as the save strip), so the editors mark it "Not kept" and the send path
 * refuses until each one is re-entered. Used by "Send again" and by the
 * history list's "Open as new request".
 */
export function requestFromHistory(entry: HistoryEntry): { request: ApiRequest; strippedFields: string[] } {
  const request = { ...structuredClone(entry.request), id: newId('req') } as ApiRequest
  const paths: string[] = []
  if (hasMask(request.url)) paths.push('url')
  const rows = (section: string, list: { value: string }[] | undefined): void =>
    list?.forEach((r, i) => hasMask(r.value) && paths.push(`${section}.${i}.value`))
  rows('headers', request.headers)
  for (const field of ['token', 'password', 'value']) if (hasMask(valueAtPath(request.auth, field))) paths.push(`auth.${field}`)
  if (request.kind !== 'graphql') rows('params', request.params)
  if (request.kind === 'http') {
    rows('pathParams', request.pathParams)
    const body = request.body
    if (body.mode === 'urlencoded' || body.mode === 'multipart') rows('body.rows', body.rows)
    else if ((body.mode === 'json' || body.mode === 'text' || body.mode === 'xml') && hasMask(body.text)) paths.push('body.text')
  }
  if (request.kind === 'graphql' && hasMask(request.variables)) paths.push('variables')
  if (request.kind === 'ws') request.protocols.forEach((p, i) => hasMask(p) && paths.push(`protocols.${i}`))
  return { request, strippedFields: paths }
}

/** Refuses a send while any value history (or the save strip) marked is still the mask. */
/** The route's label, as the build puts it in `sent.route.label`. */
function routeLabel(ctx: SendCtx): string {
  const route = ctx.build.route
  if (route.kind === 'server') return ctx.server?.name ?? 'Server removed'
  if (route.kind === 'vpn') return ctx.build.vpns.find((v) => v.id === route.vpnProfileId)?.name ?? 'VPN removed'
  return 'This machine'
}

/** What stops a send before the build: a route that cannot be used, or a value not kept. */
function unkeptFailure(ctx: SendCtx): BuildFailure | null {
  if (ctx.routeError) return { ok: false, errorClass: 'route-missing', message: ctx.routeError }
  // Variables another device changed are not used here until reviewed: the
  // active environment's, or this workspace's globals.
  const pending = useApi.getState().envReview
  if ((ctx.env && pending.includes(ctx.env.id)) || pending.includes(globalsReviewKey(ctx.tab.workspaceId))) {
    return { ok: false, errorClass: 'other', message: ENV_REVIEW_MESSAGE }
  }
  // A stripped subprotocol is empty, and an empty one would break the handshake silently.
  const unkept = (ctx.tab.strippedFields ?? []).some((path) => {
    const value = valueAtPath(ctx.req, path)
    return hasMask(value) || (/^protocols\.\d+$/.test(path) && value === '')
  })
  return unkept ? { ok: false, errorClass: 'other', message: 'Enter the values that were not kept' } : null
}

/**
 * Runs `query` (introspection) with the GraphQL tab's URL, auth, headers,
 * variables and route. A phase of its own: no response state, no history, no
 * cookie-jar write, and no production confirm, because introspection only
 * reads. HTTP ≥ 400 is still `ok: true`; the caller reads `errors[]`.
 */
export async function introspect(
  tabId: Id,
  query: string
): Promise<{ ok: true; status: number; text: string } | { ok: false; errorClass: TransportErrorClass; message: string }> {
  const ctx = contextFor(tabId)
  if (!ctx || ctx.req.kind !== 'graphql') {
    return { ok: false, errorClass: 'other', message: 'This tab is not a GraphQL request.' }
  }
  const built = unkeptFailure(ctx) ?? buildGraphQlSpec({ ...ctx.req, query, variables: '', operationName: undefined }, ctx.build)
  if (!built.ok) return { ok: false, errorClass: built.errorClass, message: maskUrlsIn(built.message) }
  let result: Awaited<ReturnType<typeof window.opsmaxx.http.request>>
  try {
    result = await window.opsmaxx.http.request(built.spec)
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  if (result.ok) return { ok: true, status: result.status, text: new TextDecoder().decode(result.body) }
  const failed = classify(result.error, result.code)
  return {
    ok: false,
    errorClass: failed.status === 'error' ? failed.errorClass : 'other',
    message: maskUrlsIn(result.error)
  }
}

const MASKING_VAULT: SecretLookup = { unlocked: true, read: () => '•••' }

/**
 * Copies the tab's request as a cURL command. `mask` builds with a masking
 * vault and copies the masked view, so it works with the vault locked and
 * nothing secret reaches the clipboard; `include` resolves vault references
 * now, from the live vault. Unresolved `{{vars}}` are copied as written.
 * Resolves false when there was nothing to copy; notes go to a toast.
 */
/**
 * The tab's HTTP or GraphQL request, built exactly as `send` builds it (same
 * route, cookies and file bytes) but never sent and never confirmed. Shared
 * by `liveSpecFor` and `copyAsCurl`.
 */
function buildOnly(
  tabId: Id,
  opts: SendOpts & { vault?: SecretLookup }
): { req: HttpRequest | GraphQlRequest; built: BuildResult } | null {
  const ctx = contextFor(tabId, opts)
  if (!ctx || ctx.req.kind === 'ws') return null
  const built =
    unkeptFailure(ctx) ?? (ctx.req.kind === 'http' ? buildHttpSpec(ctx.req, ctx.build) : buildGraphQlSpec(ctx.req, ctx.build))
  return { req: ctx.req, built }
}

/**
 * What `send` would hand main right now, with vault references resolved from
 * the live vault. Nothing is sent, so there is no production confirm. Null on
 * any build failure: a locked vault, an unresolved variable, a missing route,
 * a value that was not kept. For the snippet drawer's "include secrets".
 */
export async function liveSpecFor(tabId: Id): Promise<HttpRequestSpec | null> {
  const r = buildOnly(tabId, {})
  return r?.built.ok ? r.built.spec : null
}

/**
 * What `send` would show in the Timeline right now: built with the masking
 * vault, so it works with the vault locked and holds no secret. Unresolved
 * `{{vars}}` stay as written. Nothing is sent and nothing is confirmed. Null
 * for a WebSocket tab or any build failure (a missing route, for one).
 */
export function maskedSentFor(tabId: Id): SentView | null {
  const r = buildOnly(tabId, { allowUnresolved: true, vault: MASKING_VAULT })
  return r?.built.ok ? r.built.sent : null
}

export async function copyAsCurl(tabId: Id, opts: { secrets: 'mask' | 'include' }): Promise<boolean> {
  const include = opts.secrets === 'include'
  const r = buildOnly(tabId, { allowUnresolved: true, ...(include ? {} : { vault: MASKING_VAULT }) })
  if (!r) return false
  if (!r.built.ok) {
    useToasts.getState().push(`Could not copy as cURL: ${r.built.message}`, 'error')
    return false
  }
  const { text, notes } = toCurl(r.req, include ? r.built.spec : r.built.sent, opts)
  window.opsmaxx.clipboard.write(text)
  useToasts.getState().push(['Copied as cURL.', ...notes].join(' '), 'ok')
  return true
}

/**
 * A tab that leaves the strip takes its in-flight request and its file bytes
 * with it: the request is aborted in main, and the bytes (never persisted)
 * are dropped. Subscribed once, at module load; a store subscription outlives
 * the state resets tests do.
 */
useHttp.subscribe((s, prev) => {
  if (s.tabs === prev.tabs) return
  const open = new Set(s.tabs.map((t) => t.id))
  const runtime = useHttpRuntime.getState()
  const gone = prev.tabs
    .map((t) => t.id)
    .filter((id) => !open.has(id) && (Object.hasOwn(runtime.inflight, id) || Object.hasOwn(runtime.files, id)))
  if (gone.length === 0) return
  const aborted = gone.filter((id) => Object.hasOwn(runtime.inflight, id)).map((id) => runtime.inflight[id])
  useHttpRuntime.setState((r) => {
    const inflight = { ...r.inflight }
    const files = { ...r.files }
    for (const id of gone) {
      delete inflight[id]
      delete files[id]
    }
    return { inflight, files }
  })
  for (const requestId of aborted) void window.opsmaxx?.http?.cancel?.(requestId)?.catch?.(() => {})
})
