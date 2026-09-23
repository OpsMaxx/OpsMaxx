/**
 * The HTTP client's data model: every saved, synced and session shape, plus
 * the few pure helpers every stream needs on day one.
 *
 * One file on purpose. REST, WebSocket and GraphQL share one tree, one tab
 * strip and one persistence path, so they share one vocabulary; a type that
 * lived beside its first consumer would be imported sideways by the other two.
 */

import type { HttpResponseOk } from './httpClient'
import { maskUserinfo } from './apiUrl'

/** `/^[A-Za-z0-9_-]{1,64}$/`, and never a prototype key. See `isValidId`. */
export type Id = string

export interface Row {
  id: Id
  enabled: boolean
  key: string
  value: string
  description?: string
}

/** `value` is a literal, `{{other}}`, or `vault:<entryId>#password|username`. */
export interface Variable {
  id: Id
  key: string
  value: string
  enabled: boolean
}

export type Auth =
  | { type: 'inherit' }
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'apikey'; name: string; value: string; in: 'header' | 'query' }

export type Body =
  | { mode: 'none' }
  | { mode: 'json' | 'text' | 'xml'; text: string }
  | { mode: 'urlencoded'; rows: Row[] }
  | { mode: 'multipart'; rows: MultipartRow[] }
  | { mode: 'binary'; fileName?: string }

/** `fileName` is a basename only; the bytes are never persisted. */
export interface MultipartRow extends Row {
  kind: 'text' | 'file'
  fileName?: string
}

export type Route =
  | { kind: 'direct' }
  | { kind: 'server'; serverId: Id }
  | { kind: 'vpn'; vpnProfileId: Id }
export type RouteKey = 'direct' | `server:${string}` | `vpn:${string}`

interface RequestCommon {
  id: Id
  name: string
  url: string
  headers: Row[]
  auth: Auth
  description?: string
}

export interface HttpRequest extends RequestCommon {
  kind: 'http'
  method: string
  params: Row[]
  pathParams: Row[]
  body: Body
  settings: { timeoutMs?: number; followRedirects: boolean; maxRedirects: number }
}

export interface SavedMessage {
  id: Id
  name: string
  format: 'text' | 'json' | 'hex' | 'base64'
  text: string
}

export interface WsRequest extends RequestCommon {
  kind: 'ws'
  params: Row[]
  protocols: string[]
  messages: SavedMessage[]
}

export interface GraphQlRequest extends RequestCommon {
  kind: 'graphql'
  query: string
  variables: string
  operationName?: string
  settings: { timeoutMs?: number }
}

export type ApiRequest = HttpRequest | WsRequest | GraphQlRequest
export type RequestKind = ApiRequest['kind']

export interface Folder {
  kind: 'folder'
  id: Id
  name: string
  items: Item[]
}
export type Item = Folder | ApiRequest

export interface ApiCollectionV2 {
  version: 2
  id: Id
  workspaceId: Id
  name: string
  description?: string
  items: Item[]
  variables: Variable[]
  auth: Exclude<Auth, { type: 'inherit' }>
  /** The collection route. Keeps v1's name so older synced builds still read it. */
  viaServerId: Id | null
  vpnProfileId?: Id | null
  insecureTls: boolean
  caPem?: string
  timeoutMs?: number
  importedFrom?: { kind: 'openapi'; url?: string; fileName?: string; at: string }
  needsReimport?: boolean
  /** Set by applyExternal when certificate settings changed on another device. */
  tlsReview?: boolean
  /** @deprecated v1 fields carried verbatim for older synced builds; never read by v2 code. */
  baseUrl?: string
  /** @deprecated see `baseUrl`. */
  specUrl?: string | null
  /** @deprecated see `baseUrl`. */
  specPath?: string | null
  /** @deprecated see `baseUrl`. */
  endpoints?: unknown[]
}

export type HostColor = 'blue' | 'violet' | 'pink' | 'jade' | 'rust' | 'olive'

export interface Environment {
  id: Id
  workspaceId: Id
  name: string
  color: HostColor
  production: boolean
  variables: Variable[]
  /** SHOULD: unused until the per-environment route override is built. */
  route?: Route
}

export interface ApiWorkspaceV2 {
  version: 2
  environments: Environment[]
  /** An `Object.create(null)` map keyed by workspaceId. */
  activeEnvironment: Record<Id, Id | null>
  /** An `Object.create(null)` map keyed by workspaceId. */
  globals: Record<Id, Variable[]>
}

export type SplitState = 'normal' | 'response-collapsed' | 'request-collapsed'

export interface HttpTabState {
  id: Id
  workspaceId: Id
  preview: boolean
  split: SplitState
  kind: 'request' | 'collection' | 'environments'
  /** Absent means a scratch tab. */
  ref?: { collectionId: Id; requestId?: Id }
  /** Absent means the saved request is shown unedited. */
  draft?: ApiRequest
  /** Scratch tabs only; a saved request takes its collection's route. */
  route?: Route
  /** JSON paths stripped at the last save, shown as "Not kept from last session". */
  strippedFields?: string[]
}

export interface HttpLayoutPrefs {
  orientation: 'auto' | 'horizontal' | 'vertical'
  ratios: Record<RequestKind, { h: number; v: number }>
  lastSplit: SplitState
  kvDescriptions: boolean
  showAutoHeaders: boolean
  wrap: boolean
  gqlVariablesOpen: boolean
  gqlSchemaOpen: boolean
  gqlSchemaPinned: boolean
  wsSavedOpen: boolean
  codeOpen: boolean
}

export const DEFAULT_PREFS: HttpLayoutPrefs = {
  orientation: 'auto',
  ratios: { http: { h: 0.5, v: 0.4 }, graphql: { h: 0.5, v: 0.45 }, ws: { h: 0.4, v: 0.3 } },
  lastSplit: 'normal',
  kvDescriptions: false,
  showAutoHeaders: false,
  wrap: true,
  gqlVariablesOpen: true,
  gqlSchemaOpen: false,
  gqlSchemaPinned: false,
  wsSavedOpen: false,
  codeOpen: false
}

export interface HttpSessionV1 {
  version: 1
  tabs: HttpTabState[]
  activeTab: Record<Id, Id | null>
  sidebarTab: 'collections' | 'history'
  expanded: Id[]
  prefs: HttpLayoutPrefs
  /** The id of the migration report whose banner was dismissed. */
  bannerDismissed?: string
}

export type TransportErrorClass =
  | 'dns'
  | 'refused'
  | 'timeout'
  | 'tls-not-tls'
  | 'tls'
  | 'reset'
  | 'aborted'
  | 'route-missing'
  | 'vault-locked'
  | 'vault-entry-gone'
  | 'unresolved-variable'
  | 'socket-cap'
  | 'bridge-stale'
  | 'prod-declined'
  | 'other'

export type ResponseState =
  | { status: 'idle' }
  | { status: 'sending'; startedAt: number; requestId: string }
  | { status: 'done'; response: HttpResponseOk; sentAs: SentView; at: number }
  | {
      status: 'error'
      errorClass: TransportErrorClass
      message: string
      code?: string
      unresolved?: string[]
    }

/** A masked copy of what went out, for the Timeline. Never a second network call. */
export interface SentView {
  method: string
  url: string
  headers: [string, string][]
  route: { key: RouteKey; label: string }
  tls: 'verified' | 'custom-ca' | 'unverified'
  maxRedirects: number
  timeoutMs: number
  bodyBytes: number
}

export const MAX_COLLECTIONS_BYTES = 4 * 1024 * 1024
export const MAX_PERSISTED_BODY_BYTES = 256 * 1024

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/
// These three pass the charset, and each one written as a key into a plain
// object reaches the prototype instead of the map.
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * The server id of the route a saved request gets when its collection is gone
 * (deleted, or removed by sync). No server has it, so every build refuses it
 * as route-missing instead of falling back to direct.
 */
export const COLLECTION_GONE_SERVER_ID = ''

/** The cookie-jar and cache key for a route. */
export function routeKeyOf(route: Route): RouteKey {
  return route.kind === 'server' ? `server:${route.serverId}` : route.kind === 'vpn' ? `vpn:${route.vpnProfileId}` : 'direct'
}

export function isValidId(id: unknown): id is Id {
  return typeof id === 'string' && ID_SHAPE.test(id) && !PROTOTYPE_KEYS.has(id)
}

export function newId(prefix: 'col' | 'fld' | 'req' | 'env' | 'var' | 'row' | 'msg' | 'tab'): Id {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`
}

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK_64 = 0xffffffffffffffffn

/**
 * A deterministic id: `<prefix>_<FNV-1a 64-bit hex>` over the parts.
 *
 * Migration relies on it: two independent runs over the same v1 data must
 * produce deep-equal output, or two devices upgrading the same synced blob
 * would each mint their own ids and every request would look new to the other.
 * Each part is length-prefixed, so `('ab', 'c')` and `('a', 'bc')` differ.
 */
export function stableId(prefix: string, ...parts: string[]): Id {
  const bytes = new TextEncoder().encode(parts.map((p) => `${p.length}:${p}`).join(''))
  let hash = FNV_OFFSET
  for (const byte of bytes) hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK_64
  return `${prefix}_${hash.toString(16).padStart(16, '0')}`
}

const SENSITIVE_EXACT = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'ocp-apim-subscription-key',
  'x-functions-key'
])
const SENSITIVE_PATTERNS = [
  // secretRedaction's rule-1 class.
  /(password|passwd|secret|token|api[_-]?key|private[_-]?key)/,
  /(^|[-_])(key|sig|signature|session|sid|jwt|auth|code|credential|client[-_]?secret)$/,
  /^x-amz-(signature|credential|security-token)$/
]

/**
 * The one predicate for "this name carries a credential": history, the
 * Timeline, Copy as cURL, snippets, warnings and error masking all ask it, so
 * they cannot disagree about what counts.
 */
export function isSensitiveName(name: string): boolean {
  const lower = name.toLowerCase()
  return SENSITIVE_EXACT.has(lower) || SENSITIVE_PATTERNS.some((re) => re.test(lower))
}

// ---------------------------------------------------------------------------
// The persistence strip (§3.5). Used only at the save choke point.
// ---------------------------------------------------------------------------

const TEMPLATE_TOKEN = /\{\{[^{}]*\}\}/g
const VAULT_TOKEN = /vault:[A-Za-z0-9_-]{1,64}#(?:password|username)/g
const SCHEME_WORD = /^\s*(bearer|basic|token)\b/i
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie'])

/**
 * Whether a credential slot holds only references. `{{token}}`, a `vault:` ref
 * and `Bearer {{t}}` are kept; `Bearer eyJ…{{x}}` has a literal left over and
 * is not.
 */
export function isReferenceOnly(value: string): boolean {
  return value.replace(TEMPLATE_TOKEN, '').replace(VAULT_TOKEN, '').replace(SCHEME_WORD, '').trim() === ''
}

/** The URL with any literal userinfo removed. See `maskUserinfo`. */
export function stripUrlPassword(url: string): string {
  return maskUserinfo(url, '')
}

type Stripper = { stripped: string[] }

function stripUrl(url: string, path: string, out: Stripper): string {
  const next = stripUrlPassword(url)
  // Trimming alone is not a strip; losing userinfo is.
  if (next !== url.replace(/^\s+/, '')) out.stripped.push(path)
  return next
}

function stripAuth<A extends Auth>(auth: A, path: string, out: Stripper): A {
  const secret =
    auth.type === 'bearer' ? 'token' : auth.type === 'basic' ? 'password' : auth.type === 'apikey' ? 'value' : null
  if (!secret) return auth
  const value = (auth as unknown as Record<string, string>)[secret]
  if (isReferenceOnly(value)) return auth
  out.stripped.push(`${path}.${secret}`)
  return { ...auth, [secret]: '' }
}

function stripRequest<R extends ApiRequest>(req: R, path: string, out: Stripper): R {
  const at = (p: string): string => (path ? `${path}.${p}` : p)
  const headers = req.headers.map((row, i) => {
    if (!CREDENTIAL_HEADERS.has(row.key.trim().toLowerCase()) || isReferenceOnly(row.value)) return row
    out.stripped.push(at(`headers.${i}.value`))
    return { ...row, value: '' }
  })
  const next = { ...req, url: stripUrl(req.url, at('url'), out), headers, auth: stripAuth(req.auth, at('auth'), out) }
  if (req.kind !== 'ws') return next
  const protocols = req.protocols.map((p, i) => {
    if (protocolKeptOnSave(p)) return p
    out.stripped.push(at(`protocols.${i}`))
    return ''
  })
  return { ...next, protocols } as R
}

/**
 * A subprotocol that is a protocol name (graphql-transport-ws, mqtt,
 * v12.stomp), not a credential smuggled through Sec-WebSocket-Protocol.
 * ponytail: shape, not a registry. A short token-charset name with no long
 * random run is kept; anything else is stripped like any credential slot.
 */
/**
 * Whether the save strip keeps a subprotocol: a reference, or a protocol name
 * with no sensitive dot-part. The WS pane's "Not saved" warning should be
 * exactly `!protocolKeptOnSave(p)`, so what it warns about is what is dropped.
 */
export function protocolKeptOnSave(p: string): boolean {
  return isReferenceOnly(p) || (isProtocolName(p) && !protocolCarriesCredential(p))
}

export function isProtocolName(p: string): boolean {
  return /^[A-Za-z][A-Za-z0-9._-]{0,39}$/.test(p) && !/[A-Za-z0-9]{24,}/.test(p)
}

/**
 * A subprotocol that carries a credential, as Kubernetes does with
 * `base64url.bearer.authorization.k8s.io.<token>`: one of its dot-separated
 * parts is a sensitive name, and it is not a `{{variable}}`. Moved here from
 * store/wsSessions so the save strip and the socket pane share one rule.
 */
export function protocolCarriesCredential(protocol: string): boolean {
  if (/^\s*\{\{[^{}]*\}\}\s*$/.test(protocol)) return false
  return protocol.split('.').some((part) => isSensitiveName(part))
}

/** For display: everything after the first sensitive part becomes •••. */
export function maskProtocol(protocol: string): string {
  if (!protocolCarriesCredential(protocol)) return protocol
  const parts = protocol.split('.')
  const at = parts.findIndex((part) => isSensitiveName(part))
  // The name stays readable; the part a token lives in does not.
  const keep = at === parts.length - 1 ? at : at + 1
  return [...parts.slice(0, keep), '•••'].join('.')
}

function stripItems(items: Item[], path: string, out: Stripper): Item[] {
  return items.map((item, i) =>
    item.kind === 'folder'
      ? { ...item, items: stripItems(item.items, `${path}.${i}.items`, out) }
      : stripRequest(item, `${path}.${i}`, out)
  )
}

/**
 * Removes literal credentials before anything is written to disk or synced.
 *
 * Only credential SLOTS are stripped: auth secret fields, the `Authorization`,
 * `Proxy-Authorization` and `Cookie` header values, and URL userinfo
 * passwords. Other sensitive-looking rows, WS messages and GraphQL variables
 * are kept and warned about instead (§3.5, Q2): stripping user content would
 * break the feature. For a session, each tab's `strippedFields` is set to the
 * paths removed from its draft, relative to the draft, so the editor can say
 * "Not kept from last session". The returned paths are relative to `x`.
 */
export function stripLiteralSecrets<T extends ApiRequest | ApiCollectionV2 | HttpSessionV1>(
  x: T
): { value: T; stripped: string[] } {
  const out: Stripper = { stripped: [] }
  if ('tabs' in x) {
    const tabs = x.tabs.map((tab, i) => {
      if (!tab.draft) return tab
      const own: Stripper = { stripped: [] }
      const draft = stripRequest(tab.draft, '', own)
      out.stripped.push(...own.stripped.map((p) => `tabs.${i}.draft.${p}`))
      // Paths marked earlier (by an earlier save, or by history's masking)
      // stay marked while their value is still empty or the mask, so a
      // restart cannot turn a "not kept" value back into one that sends.
      const earlier = (tab.strippedFields ?? []).filter((p) => stillUnkept(valueAtPath(draft, p)))
      const fields = [...new Set([...earlier, ...own.stripped])]
      return { ...tab, draft, strippedFields: fields.length ? fields : undefined }
    })
    return { value: { ...x, tabs }, stripped: out.stripped }
  }
  if ('version' in x) {
    const c = x as ApiCollectionV2
    const value: ApiCollectionV2 = {
      ...c,
      auth: stripAuth(c.auth, 'auth', out),
      items: stripItems(c.items, 'items', out),
      variables: c.variables.map((v, i) =>
        v.key === 'baseUrl' ? { ...v, value: stripUrl(v.value, `variables.${i}.value`, out) } : v
      )
    }
    if (c.importedFrom?.url) {
      value.importedFrom = { ...c.importedFrom, url: stripUrl(c.importedFrom.url, 'importedFrom.url', out) }
    }
    if (c.baseUrl) value.baseUrl = stripUrl(c.baseUrl, 'baseUrl', out)
    return { value: value as T, stripped: out.stripped }
  }
  return { value: stripRequest(x as ApiRequest, '', out) as T, stripped: out.stripped }
}

/** The value at a dotted path (`headers.2.value`), or undefined. */
export function valueAtPath(root: unknown, path: string): unknown {
  let node = root
  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, key)) return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

/** A marked path is still not kept while its value is empty or the mask. A path that no longer exists is not. */
const stillUnkept = (v: unknown): boolean =>
  v !== undefined && (typeof v !== 'string' || v === '' || v.includes('•••'))

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * A body small enough to save. Over 256 KiB the content is dropped and the
 * mode kept, so the editor reopens on the right tab with nothing in it rather
 * than on a body that was silently cut in half.
 */
export function persistableBody(body: Body): { body: Body; dropped: boolean } {
  if (utf8Bytes(JSON.stringify(body)) <= MAX_PERSISTED_BODY_BYTES) return { body, dropped: false }
  switch (body.mode) {
    case 'json':
    case 'text':
    case 'xml':
      return { body: { mode: body.mode, text: '' }, dropped: true }
    case 'urlencoded':
    case 'multipart':
      return { body: { mode: body.mode, rows: [] }, dropped: true }
    default:
      return { body, dropped: false }
  }
}

const commonDefaults = (name: string): RequestCommon => ({
  id: newId('req'),
  name,
  url: '',
  headers: [],
  auth: { type: 'inherit' }
})

export const defaults: {
  http(): HttpRequest
  ws(): WsRequest
  graphql(): GraphQlRequest
  collection(ws: Id, name: string): ApiCollectionV2
} = {
  http: () => ({
    ...commonDefaults('New request'),
    kind: 'http',
    method: 'GET',
    params: [],
    pathParams: [],
    body: { mode: 'none' },
    settings: { followRedirects: true, maxRedirects: 5 }
  }),
  ws: () => ({
    ...commonDefaults('New WebSocket'),
    kind: 'ws',
    params: [],
    protocols: [],
    messages: []
  }),
  graphql: () => ({
    ...commonDefaults('New GraphQL request'),
    kind: 'graphql',
    query: '',
    variables: '',
    settings: {}
  }),
  collection: (ws, name) => ({
    version: 2,
    id: newId('col'),
    workspaceId: ws,
    name,
    items: [],
    variables: [],
    auth: { type: 'none' },
    viaServerId: null,
    insecureTls: false
  })
}
