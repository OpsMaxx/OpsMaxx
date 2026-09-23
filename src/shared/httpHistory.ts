/**
 * Request history entries: what is kept, and the structural redaction that
 * runs in the renderer and again in main before anything reaches disk.
 *
 * STRUCTURAL, NOT A REGEX OVER THE SERIALISED ENTRY. A header serialised as
 * `{"key":"X-Api-Key","value":"sk_live_…"}` has a `"` after the name, not the
 * `:` or `=` a text rule looks for, so a pattern pass over the JSON lets the
 * value straight through (review SEC-H1). Every place a credential can sit in a
 * request is walked by its own shape instead, and `isSensitiveName` is the one
 * predicate that decides.
 *
 * `sanitizeHistoryEntry` is the half main runs. It takes `unknown`, because the
 * renderer is the thing being defended against: it rebuilds the entry field by
 * field, so nothing the renderer invented survives, and then redacts it again.
 */

import { Kind, parse, print, visit, type ValueNode } from 'graphql'
import {
  isProtocolName,
  isSensitiveName,
  isValidId,
  protocolCarriesCredential,
  type ApiRequest,
  type Auth,
  type Body,
  type Id,
  type MultipartRow,
  type RequestKind,
  type ResponseState,
  type Route,
  type Row,
  type SentView,
  type TransportErrorClass
} from './apiModel'
import { userinfoSpan } from './httpClient'

export const MAX_HISTORY_ENTRIES = 2000
export const MAX_HISTORY_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_HISTORY_ENTRY_BYTES = 64 * 1024
export const MAX_HISTORY_BODY_BYTES = 16 * 1024

export interface HistoryEntry {
  id: string
  /** Epoch ms. */
  at: number
  kind: RequestKind
  /** The template request, `{{vars}}` kept, after structural redaction. */
  request: ApiRequest
  bodyOmitted?: 'unparseable' | 'too-large' | 'not-stored'
  environment?: string
  collection?: string
  /** The OpsMaxx workspace the request was sent from. Absent on entries written before it was recorded. */
  workspaceId?: Id
  route: Route
  routeLabel: string
  requestRef?: { collectionId: Id; requestId: Id }
  response?: {
    status: number
    statusText: string
    durationMs: number
    size: number
    contentType?: string
  }
  errorClass?: TransportErrorClass
}

export interface HistoryCtx {
  environment?: string
  collection?: string
  /** The tab's workspace. */
  workspaceId?: Id
  route: Route
  routeLabel: string
  requestRef?: { collectionId: Id; requestId: Id }
  now?: number
}

/** What a masked value is replaced with. The same glyphs `maskUrl` uses. */
export const MASKED = '•••'

// A value made only of references is not a secret, and keeping it is what lets
// "Send again" still authenticate: `Bearer {{token}}` names a variable, and the
// variable is resolved at send time from wherever it lives. Same rule as
// `stripLiteralSecrets` (§3.5), so the two cannot disagree about what counts.
const TEMPLATE = /\{\{[^{}]*\}\}/g
const VAULT_REF = /vault:[A-Za-z0-9_-]{1,64}#(?:password|username)/g
const SCHEME_WORD = /^\s*(?:bearer|basic|token)\b/i

export function referenceOnly(value: string): boolean {
  return value.replace(TEMPLATE, '').replace(VAULT_REF, '').replace(SCHEME_WORD, '').trim() === ''
}

/** `user:password`, each half empty or a reference. The first `:` splits them. */
export function userinfoIsReference(info: string): boolean {
  const colon = info.indexOf(':')
  return colon < 0 ? referenceOnly(info) : referenceOnly(info.slice(0, colon)) && referenceOnly(info.slice(colon + 1))
}

/** The value, or `•••` when it could be a credential. */
function maskValue(value: string): string {
  return referenceOnly(value) ? value : MASKED
}

function maskRows<R extends Row>(rows: R[]): R[] {
  return rows.map((r) => (isSensitiveName(r.key) ? { ...r, value: maskValue(r.value) } : r))
}

/**
 * Userinfo and sensitive query values masked. String work rather than `URL`,
 * because a template URL (`{{baseUrl}}/x?token={{t}}`) is not one `URL` accepts.
 */
export function maskHistoryUrl(url: string): string {
  const span = userinfoSpan(url)
  const info = span ? url.slice(span.start, span.end) : ''
  const bare =
    span && !userinfoIsReference(info)
      ? `${url.slice(0, span.start)}${MASKED}${url.slice(span.end)}`
      : url
  const q = bare.indexOf('?')
  if (q < 0) return bare
  const hash = bare.indexOf('#', q)
  const end = hash < 0 ? bare.length : hash
  const query = bare
    .slice(q + 1, end)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=')
      if (eq < 0) return pair
      let name = pair.slice(0, eq)
      try {
        name = decodeURIComponent(name.replace(/\+/g, ' '))
      } catch {
        /* a malformed escape is still a name worth checking as written */
      }
      return isSensitiveName(name) ? `${pair.slice(0, eq)}=${maskValue(pair.slice(eq + 1))}` : pair
    })
    .join('&')
  return `${bare.slice(0, q)}?${query}${bare.slice(end)}`
}

/**
 * The save strip's rule for a subprotocol, so history and a saved request
 * agree: a reference, or a plain protocol name that carries no credential,
 * is kept. Anything else (a token, `…authorization.k8s.io.<token>`) is not.
 */
function keepProtocol(p: string): boolean {
  return referenceOnly(p) || (isProtocolName(p) && !protocolCarriesCredential(p))
}

const VALUE_KEYS = new Set(['value', 'val'])
const NAME_KEYS = ['name', 'key']

/**
 * Sensitive keys masked at any depth. Parsed JSON has no cycles, but it can nest.
 *
 * Also the name/value shape — `[{"name": "password", "value": "hunter2"}]` —
 * where the credential's name is DATA rather than a key, so the key test alone
 * never sees it: a `value`/`val` beside a sensitive `name`/`key` is masked too.
 */
function maskJson(value: unknown, depth = 0): unknown {
  if (depth > 64) return MASKED
  if (Array.isArray(value)) return value.map((v) => maskJson(v, depth + 1))
  if (value && typeof value === 'object') {
    // Keys compared case-insensitively: `{"Name": "token", "Value": …}` is
    // the same shape as the lower-case one.
    const named = Object.entries(value).some(
      ([k, n]) => NAME_KEYS.includes(k.toLowerCase()) && typeof n === 'string' && isSensitiveName(n)
    )
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      const secret = isSensitiveName(k) || (named && VALUE_KEYS.has(k.toLowerCase()))
      out[k] =
        secret && v !== null && v !== ''
          ? typeof v === 'string'
            ? maskValue(v)
            : MASKED
          : maskJson(v, depth + 1)
    }
    return out
  }
  return value
}

/**
 * A GraphQL document with every literal under a sensitive argument or input
 * field masked — `login(password: "hunter2")` keeps its shape and loses the
 * value. A `$variable` is left alone: its value lives in the variables, which
 * are masked as JSON. Null when the document does not parse, so the caller
 * can drop it rather than keep something it could not read.
 */
function maskGraphQl(query: string): string | null {
  if (query.trim() === '') return query
  let doc
  try {
    doc = parse(query, { noLocation: true, maxTokens: 20_000 })
  } catch {
    return null
  }
  let changed = false
  const masked: ValueNode = { kind: Kind.STRING, value: MASKED }
  const guard = (node: { name: { value: string }; value: ValueNode }) => {
    if (!isSensitiveName(node.name.value) || node.value.kind === Kind.VARIABLE) return undefined
    if (node.value.kind === Kind.STRING && referenceOnly(node.value.value)) return undefined
    changed = true
    return { ...node, value: masked }
  }
  const next = visit(doc, { Argument: guard, ObjectField: guard })
  return changed ? print(next) : query
}

/** JSON text with its sensitive keys masked, or null when it does not parse. */
function maskJsonText(text: string): string | null {
  if (text.trim() === '') return text
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const masked = maskJson(parsed)
  // The user's own formatting is kept when nothing changed.
  return JSON.stringify(masked) === JSON.stringify(parsed) ? text : JSON.stringify(masked, null, 2)
}

const bytesOf = (s: string): number => new TextEncoder().encode(s).length

function maskAuth(auth: Auth): Auth {
  switch (auth.type) {
    case 'bearer':
      return { type: 'bearer', token: maskValue(auth.token) }
    case 'basic':
      return { type: 'basic', username: auth.username, password: maskValue(auth.password) }
    case 'apikey':
      return { ...auth, value: maskValue(auth.value) }
    default:
      return auth
  }
}

type Omitted = HistoryEntry['bodyOmitted']

function redactBody(body: Body): { body: Body; omitted?: Omitted } {
  switch (body.mode) {
    case 'json': {
      const text = maskJsonText(body.text)
      if (text === null) return { body: { mode: 'json', text: '' }, omitted: 'unparseable' }
      if (bytesOf(text) > MAX_HISTORY_BODY_BYTES) {
        return { body: { mode: 'json', text: '' }, omitted: 'too-large' }
      }
      return { body: { mode: 'json', text } }
    }
    case 'urlencoded':
    case 'multipart': {
      // A file row's bytes were never in the model; its `value` is cleared in
      // case something put one there.
      const rows = maskRows(body.rows as MultipartRow[]).map((r) =>
        r.kind === 'file' ? { ...r, value: '' } : r
      )
      if (bytesOf(JSON.stringify(rows)) > MAX_HISTORY_BODY_BYTES) {
        return { body: { mode: body.mode, rows: [] }, omitted: 'too-large' }
      }
      return { body: { mode: body.mode, rows } as Body }
    }
    // Free text can carry anything in any shape, and there is no structure to
    // find a credential in. Kept as a mode only.
    case 'text':
    case 'xml':
      return {
        body: { mode: body.mode, text: '' },
        ...(body.text === '' ? {} : { omitted: 'not-stored' as const })
      }
    case 'binary':
      return { body: { mode: 'binary' }, omitted: 'not-stored' }
    default:
      return { body: { mode: 'none' } }
  }
}

/** The template request with every credential-shaped value masked. Pure. */
export function redactHistoryRequest(req: ApiRequest): {
  request: ApiRequest
  bodyOmitted?: Omitted
} {
  const common = {
    id: req.id,
    name: req.name,
    url: maskHistoryUrl(req.url),
    headers: maskRows(req.headers),
    auth: maskAuth(req.auth),
    ...(req.description !== undefined ? { description: req.description } : {})
  }
  if (req.kind === 'http') {
    const { body, omitted } = redactBody(req.body)
    return {
      request: {
        ...common,
        kind: 'http',
        method: req.method,
        params: maskRows(req.params),
        pathParams: maskRows(req.pathParams),
        body,
        settings: { ...req.settings }
      },
      ...(omitted ? { bodyOmitted: omitted } : {})
    }
  }
  if (req.kind === 'ws') {
    // Saved messages are frames by another name, and frames are never stored.
    return {
      request: {
        ...common,
        kind: 'ws',
        params: maskRows(req.params),
        // A subprotocol can be a credential: Kubernetes exec takes
        // `base64url.bearer.authorization.k8s.io.<token>`, and many APIs put a
        // JWT there because a browser cannot send a header. Kept only when it
        // is a reference.
        protocols: req.protocols.map((p) => (keepProtocol(p) ? p : MASKED)),
        messages: []
      }
    }
  }
  const variables = maskJsonText(req.variables)
  const query = maskGraphQl(req.query)
  const tooLarge =
    variables !== null && query !== null && bytesOf(variables) + bytesOf(query) > MAX_HISTORY_BODY_BYTES
  const omitted: Omitted =
    variables === null || query === null ? 'unparseable' : tooLarge ? 'too-large' : undefined
  return {
    request: {
      ...common,
      kind: 'graphql',
      query: omitted ? '' : (query as string),
      variables: omitted ? '' : (variables as string),
      ...(req.operationName !== undefined ? { operationName: req.operationName } : {}),
      settings: { ...req.settings }
    },
    ...(omitted ? { bodyOmitted: omitted } : {})
  }
}

function contentTypeOf(headers: Record<string, string>): string | undefined {
  return Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1]
}

const newHistoryId = (): string => `hst_${crypto.randomUUID().replace(/-/g, '')}`

export function toHistoryEntry(
  req: ApiRequest,
  _sent: SentView,
  result: Extract<ResponseState, { status: 'done' | 'error' }>,
  ctx: HistoryCtx
): HistoryEntry {
  const { request, bodyOmitted } = redactHistoryRequest(req)
  const entry: HistoryEntry = {
    id: newHistoryId(),
    // Never in the future: a future entry is one the 30-day horizon never reaches.
    at: Math.min(ctx.now ?? Date.now(), Date.now()),
    kind: req.kind,
    request,
    ...(bodyOmitted ? { bodyOmitted } : {}),
    ...(ctx.environment !== undefined ? { environment: ctx.environment } : {}),
    ...(ctx.collection !== undefined ? { collection: ctx.collection } : {}),
    ...(ctx.workspaceId !== undefined && isValidId(ctx.workspaceId) ? { workspaceId: ctx.workspaceId } : {}),
    route: ctx.route,
    routeLabel: ctx.routeLabel,
    ...(ctx.requestRef ? { requestRef: ctx.requestRef } : {})
  }
  if (result.status === 'error') return { ...entry, errorClass: result.errorClass }
  const r = result.response
  const contentType = contentTypeOf(r.headers)
  return {
    ...entry,
    response: {
      status: r.status,
      statusText: r.statusText,
      durationMs: r.durationMs,
      size: r.body.byteLength,
      ...(contentType !== undefined ? { contentType } : {})
    }
  }
}

// ---------------------------------------------------------------------------
// Main's half: rebuild from unknown, then redact again
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, max = 8192): string => (typeof v === 'string' ? v.slice(0, max) : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const idOf = (v: unknown): Id => (isValidId(v) ? v : 'unknown')
const basename = (v: unknown): string | undefined =>
  typeof v === 'string' ? v.split(/[\\/]/).pop()?.slice(0, 255) || undefined : undefined

function rowOf(r: Obj): Row {
  return {
    id: idOf(r.id),
    enabled: r.enabled !== false,
    key: str(r.key, 1024),
    value: str(r.value),
    ...(typeof r.description === 'string' ? { description: str(r.description, 1024) } : {})
  }
}

const rowsOf = (v: unknown): Obj[] => (Array.isArray(v) ? v.slice(0, 500).filter(isObj) : [])

function authOf(v: unknown): Auth {
  if (!isObj(v)) return { type: 'none' }
  switch (v.type) {
    case 'inherit':
      return { type: 'inherit' }
    case 'bearer':
      return { type: 'bearer', token: str(v.token) }
    case 'basic':
      return { type: 'basic', username: str(v.username, 1024), password: str(v.password) }
    case 'apikey':
      return {
        type: 'apikey',
        name: str(v.name, 1024),
        value: str(v.value),
        in: v.in === 'query' ? 'query' : 'header'
      }
    default:
      return { type: 'none' }
  }
}

function bodyOf(v: unknown): Body {
  if (!isObj(v)) return { mode: 'none' }
  switch (v.mode) {
    case 'json':
    case 'text':
    case 'xml':
      return { mode: v.mode, text: str(v.text, MAX_HISTORY_ENTRY_BYTES) }
    case 'urlencoded':
      return { mode: 'urlencoded', rows: rowsOf(v.rows).map(rowOf) }
    case 'multipart':
      return {
        mode: 'multipart',
        rows: rowsOf(v.rows).map((r) => {
          const fileName = basename(r.fileName)
          return { ...rowOf(r), kind: r.kind === 'file' ? 'file' : 'text', ...(fileName ? { fileName } : {}) }
        })
      }
    case 'binary':
      return { mode: 'binary' }
    default:
      return { mode: 'none' }
  }
}

function requestOf(v: unknown): ApiRequest | null {
  if (!isObj(v)) return null
  const common = {
    id: idOf(v.id),
    name: str(v.name, 500),
    url: str(v.url),
    headers: rowsOf(v.headers).map(rowOf),
    auth: authOf(v.auth),
    ...(typeof v.description === 'string' ? { description: str(v.description) } : {})
  }
  const settings = isObj(v.settings) ? v.settings : {}
  const timeout = typeof settings.timeoutMs === 'number' ? { timeoutMs: num(settings.timeoutMs) } : {}
  switch (v.kind) {
    case 'http':
      return {
        ...common,
        kind: 'http',
        method: str(v.method, 32).toUpperCase() || 'GET',
        params: rowsOf(v.params).map(rowOf),
        pathParams: rowsOf(v.pathParams).map(rowOf),
        body: bodyOf(v.body),
        settings: {
          ...timeout,
          followRedirects: settings.followRedirects !== false,
          maxRedirects: num(settings.maxRedirects)
        }
      }
    case 'ws':
      return {
        ...common,
        kind: 'ws',
        params: rowsOf(v.params).map(rowOf),
        protocols: Array.isArray(v.protocols) ? v.protocols.slice(0, 20).map((p) => str(p, 200)) : [],
        messages: []
      }
    case 'graphql':
      return {
        ...common,
        kind: 'graphql',
        query: str(v.query, MAX_HISTORY_ENTRY_BYTES),
        variables: str(v.variables, MAX_HISTORY_ENTRY_BYTES),
        ...(typeof v.operationName === 'string' ? { operationName: str(v.operationName, 200) } : {}),
        settings: timeout
      }
    default:
      return null
  }
}

function routeOf(v: unknown): Route {
  if (isObj(v) && v.kind === 'server' && isValidId(v.serverId)) {
    return { kind: 'server', serverId: v.serverId }
  }
  if (isObj(v) && v.kind === 'vpn' && isValidId(v.vpnProfileId)) {
    return { kind: 'vpn', vpnProfileId: v.vpnProfileId }
  }
  return { kind: 'direct' }
}

const ERROR_CLASSES: ReadonlySet<string> = new Set<TransportErrorClass>([
  'dns', 'refused', 'timeout', 'tls-not-tls', 'tls', 'reset', 'aborted', 'route-missing',
  'vault-locked', 'vault-entry-gone', 'unresolved-variable', 'socket-cap', 'bridge-stale',
  'prod-declined', 'other'
])
const OMITTED: ReadonlySet<string> = new Set(['unparseable', 'too-large', 'not-stored'])

/**
 * An entry the renderer handed over, rebuilt field by field and redacted
 * again. Null when it is not recognisably an entry at all.
 *
 * A compromised renderer controls every byte of what it sends, so nothing here
 * trusts `toHistoryEntry` to have run: unknown fields are dropped, strings are
 * capped, ids are validated, and the same structural redaction is applied a
 * second time. Main then adds `redactPatterns` over the string leaves, which
 * only it can import.
 */
export function sanitizeHistoryEntry(raw: unknown): HistoryEntry | null {
  if (!isObj(raw)) return null
  const request = requestOf(raw.request)
  if (!request) return null
  const { request: redacted, bodyOmitted } = redactHistoryRequest(request)
  const omitted =
    bodyOmitted ?? (OMITTED.has(raw.bodyOmitted as string) ? (raw.bodyOmitted as Omitted) : undefined)
  const ref = raw.requestRef
  const res = isObj(raw.response) ? raw.response : null
  const at = num(raw.at)
  return {
    id: typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw.id) ? raw.id : newHistoryId(),
    at: at > 0 ? Math.min(at, Date.now()) : Date.now(),
    kind: request.kind,
    request: redacted,
    ...(omitted ? { bodyOmitted: omitted } : {}),
    ...(typeof raw.environment === 'string' ? { environment: str(raw.environment, 200) } : {}),
    ...(typeof raw.collection === 'string' ? { collection: str(raw.collection, 200) } : {}),
    ...(isValidId(raw.workspaceId) ? { workspaceId: raw.workspaceId } : {}),
    route: routeOf(raw.route),
    routeLabel: str(raw.routeLabel, 200),
    ...(isObj(ref) && isValidId(ref.collectionId) && isValidId(ref.requestId)
      ? { requestRef: { collectionId: ref.collectionId, requestId: ref.requestId } }
      : {}),
    ...(res
      ? {
          response: {
            status: num(res.status),
            statusText: str(res.statusText, 200),
            durationMs: num(res.durationMs),
            size: num(res.size),
            ...(typeof res.contentType === 'string' ? { contentType: str(res.contentType, 200) } : {})
          }
        }
      : {}),
    ...(ERROR_CLASSES.has(raw.errorClass as string)
      ? { errorClass: raw.errorClass as TransportErrorClass }
      : {})
  }
}

/** Every string leaf passed through `fn`, keys untouched. For main's `redactPatterns` pass. */
export function mapStringLeaves<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === 'string') return fn(value) as T
  if (Array.isArray(value)) return value.map((v) => mapStringLeaves(v, fn)) as T
  if (isObj(value)) {
    const out: Obj = {}
    for (const [k, v] of Object.entries(value)) out[k] = mapStringLeaves(v, fn)
    return out as T
  }
  return value
}

/**
 * Whether an entry belongs in `workspaceId`'s history. One that records its
 * workspace is shown there only. One from before that was recorded is shown
 * everywhere when it is direct with no saved request, since it names nothing
 * another workspace owns; otherwise it is hidden, because only the renderer
 * knows which workspace owns a server, a VPN profile or a collection.
 */
export function historyInWorkspace(entry: HistoryEntry, workspaceId: Id): boolean {
  if (entry.workspaceId !== undefined) return entry.workspaceId === workspaceId
  return entry.route.kind === 'direct' && !entry.requestRef
}

/** Case-insensitive substring match, never a RegExp (SEC-L10). */
export function historyMatches(entry: HistoryEntry, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  const method = entry.request.kind === 'http' ? entry.request.method : entry.kind
  return [entry.request.url, entry.request.name, method, String(entry.response?.status ?? '')].some(
    (s) => s.toLowerCase().includes(q)
  )
}
