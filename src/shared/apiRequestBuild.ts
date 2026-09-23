/**
 * An `ApiRequest` plus its context, turned into the spec main sends.
 *
 * Build order (§3.4, SEC-M2): template everything; vault-resolve the auth
 * fields BEFORE encoding them; apply auth; encode the body; Content-Type;
 * vault-resolve the URL and headers; cookies; route; TLS and limits. The vault
 * rule: references resolve in headers, URLs, auth fields and structured body
 * rows, never in free-text bodies, because those can be echoed back.
 *
 * `sent` is the same build run again with a masking vault, then masked by
 * name. It is never a second network call. A missing server or VPN is
 * `route-missing`, never a silent fall back to direct.
 *
 * Synchronous on purpose: multipart is encoded here by hand rather than
 * through `new Response(formData)`, so the boundary is known and a send path
 * never waits on anything but main.
 */

import {
  COLLECTION_GONE_SERVER_ID,
  isProtocolName,
  isReferenceOnly,
  isSensitiveName,
  maskProtocol,
  protocolCarriesCredential,
  type Auth,
  type Body
} from './apiModel'
import type {
  ApiCollectionV2,
  Environment,
  GraphQlRequest,
  HttpRequest,
  Id,
  Route,
  RouteKey,
  Row,
  SentView,
  TransportErrorClass,
  Variable,
  WsRequest
} from './apiModel'
import {
  resolveValue,
  VAULT_LOCKED_MESSAGE,
  VaultUnavailableError,
  type SecretLookup
} from './apiSecrets'
import { ensureScheme, fillPathParams, maskUrl, splitUrl, withParams, wsUrlFor } from './apiUrl'
import { resolveTemplate, scopeChain } from './apiVariables'
import { buildGraphQlBody, parseVariables } from './graphql'
import {
  clampTimeout,
  MAX_REDIRECT_HOPS,
  methodAllowsBody,
  type HttpRequestSpec,
  type HttpSshTarget,
  type HttpVia
} from './httpClient'
import type { WsOpenSpec } from './httpSocket'

/**
 * A server as the build sees it. `target` is what `sshTargetFor` returns in the
 * renderer; it is passed in resolved because a shared module cannot import the
 * renderer's jump-chain lookup.
 */
export interface BuildServer {
  id: Id
  name: string
  tags: string[]
  target: HttpSshTarget
}

export interface BuildCtx {
  collection?: ApiCollectionV2
  env?: Environment
  globals: Variable[]
  /** Live, or masking for the Timeline view. */
  vault: SecretLookup
  cookieHeader?: (routeKey: RouteKey, url: string) => string
  servers: BuildServer[]
  vpns: { id: Id; name: string }[]
  route: Route
  requestId: string
  allowUnresolved?: boolean
  /**
   * Bytes chosen this session for a file part: a multipart row's id, or
   * `'body'` for a binary body. File contents are never persisted, so after a
   * restart this returns null and the build asks for the file again.
   */
  fileBytes?: (key: string) => ArrayBuffer | null
}

export type BuildFailure = {
  ok: false
  errorClass: TransportErrorClass
  message: string
  unresolved?: string[]
}

export type BuildResult =
  | { ok: true; spec: HttpRequestSpec; sent: SentView; routeKey: RouteKey; unresolved: string[] }
  | BuildFailure

export type WsBuildResult =
  | { ok: true; spec: WsOpenSpec; sent: SentView; routeKey: RouteKey }
  | BuildFailure

class BuildError extends Error {
  constructor(
    readonly errorClass: TransportErrorClass,
    message: string,
    readonly unresolved?: string[]
  ) {
    super(message)
  }
}

const MASK = '•••'
const MASKING_VAULT: SecretLookup = { unlocked: true, read: () => MASK }

/** Whatever the core needs, whichever protocol it came from. */
interface CoreInput {
  method: string
  url: string
  params: Row[]
  pathParams: Row[]
  headers: Row[]
  auth: Auth
  /** HTTP and GraphQL; a WebSocket has none. */
  body?: (tpl: (s: string) => string, vault: SecretLookup) => Encoded | null
  /** WebSocket subprotocols, templated and vault-resolved like header values. */
  protocols?: string[]
}

interface Encoded {
  bytes: Uint8Array
  contentType: string
}

interface Assembled {
  method: string
  url: string
  headers: Record<string, string>
  body?: ArrayBuffer
  via: HttpVia
  routeKey: RouteKey
  routeLabel: string
  unresolved: string[]
  /** Where auth put its secret, so `sent` masks it whatever the name is. */
  authAt: { header?: string; query?: string }
  protocols: string[]
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

function base64(text: string): string {
  let binary = ''
  for (const byte of utf8(text)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function vaultResolve(value: string, vault: SecretLookup): string {
  try {
    return resolveValue(value, vault)
  } catch (err) {
    if (err instanceof VaultUnavailableError) {
      throw new BuildError(err.message === VAULT_LOCKED_MESSAGE ? 'vault-locked' : 'vault-entry-gone', err.message)
    }
    throw err
  }
}

function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase()
  return Object.keys(headers).find((k) => k.toLowerCase() === lower)
}

/** §2.8: which names, and where they were looked for. */
export function unresolvedMessage(names: string[], envName?: string): string {
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  const verb = names.length === 1 ? 'is' : 'are'
  return envName
    ? `${list} ${verb} not defined in ${envName} (or its collection or globals)`
    : `${list} ${verb} not defined in globals or this collection`
}

function routeFor(route: Route, ctx: BuildCtx): { via: HttpVia; routeKey: RouteKey; label: string } {
  if (route.kind === 'server' && route.serverId === COLLECTION_GONE_SERVER_ID) {
    throw new BuildError('route-missing', 'The collection this request belonged to no longer exists.')
  }
  if (route.kind === 'server') {
    const server = ctx.servers.find((s) => s.id === route.serverId)
    if (!server) {
      throw new BuildError('route-missing', 'The server this request is sent through no longer exists.')
    }
    return { via: { kind: 'server', server: server.target }, routeKey: `server:${server.id}`, label: server.name }
  }
  if (route.kind === 'vpn') {
    const vpn = ctx.vpns.find((v) => v.id === route.vpnProfileId)
    if (!vpn) throw new BuildError('route-missing', 'The VPN profile this request is sent through no longer exists.')
    return { via: { kind: 'vpn', vpnProfileId: vpn.id }, routeKey: `vpn:${vpn.id}`, label: vpn.name }
  }
  return { via: { kind: 'direct' }, routeKey: 'direct', label: 'This machine' }
}

const enabled = <R extends Row>(rows: R[]): R[] => rows.filter((r) => r.enabled && r.key.trim() !== '')

export const CONNECTION_REVIEW_MESSAGE = "Review this collection's connection changes"

function assemble(input: CoreInput, ctx: BuildCtx, vault: SecretLookup): Assembled {
  // Connection settings that arrived by sync (TLS off, a CA, a route or a
  // host) are not used until they are reviewed here: nothing is sent at all
  // while the review is pending, rather than a half-applied connection.
  if (ctx.collection?.tlsReview) throw new BuildError('other', CONNECTION_REVIEW_MESSAGE)
  // 1. Template everything, and stop on anything unresolved.
  const chain = scopeChain(ctx.globals, ctx.collection, ctx.env)
  const unresolved = new Set<string>()
  const tpl = (text: string): string => {
    const r = resolveTemplate(text, chain)
    for (const name of r.unresolved) unresolved.add(name)
    return r.text
  }
  const row = (r: Row): Row => ({ ...r, key: tpl(r.key), value: tpl(r.value) })
  const url = tpl(input.url)
  const params = enabled(input.params).map(row)
  const pathParams = input.pathParams.map(row)
  const headerRows = enabled(input.headers).map(row)
  const auth = input.auth.type === 'inherit' ? (ctx.collection?.auth ?? { type: 'none' }) : input.auth
  const authFields = Object.fromEntries(
    Object.entries(auth).map(([k, v]) => [k, k === 'type' || k === 'in' ? v : tpl(String(v))])
  ) as Auth
  const encoded = input.body?.(tpl, vault) ?? null
  const protocolTemplates = (input.protocols ?? []).map(tpl)
  if (unresolved.size > 0 && !ctx.allowUnresolved) {
    const names = [...unresolved]
    throw new BuildError('unresolved-variable', unresolvedMessage(names, ctx.env?.name), names)
  }
  if (url.trim() === '') throw new BuildError('other', 'Enter a URL to send this request.')

  // 2–3. Vault-resolve the auth fields, then encode them.
  const headers: Record<string, string> = {}
  const authQuery: Row[] = []
  let authHeader: [string, string] | null = null
  if (authFields.type === 'bearer') {
    const token = vaultResolve(authFields.token, vault)
    if (token.trim()) authHeader = ['Authorization', `Bearer ${token}`]
  } else if (authFields.type === 'basic') {
    const user = vaultResolve(authFields.username, vault)
    const pass = vaultResolve(authFields.password, vault)
    if (user || pass) authHeader = ['Authorization', `Basic ${base64(`${user}:${pass}`)}`]
  } else if (authFields.type === 'apikey' && authFields.name.trim()) {
    const value = vaultResolve(authFields.value, vault)
    if (authFields.in === 'query') authQuery.push({ id: 'auth', enabled: true, key: authFields.name, value })
    else authHeader = [authFields.name, value]
  }

  // 4. The body. Structured rows are vault-resolved by the encoder; free text is not.
  const body = encoded && methodAllowsBody(input.method) ? encoded : null

  // 6. Headers, vault-resolved. An explicit header beats one derived from auth or the body.
  for (const h of headerRows) headers[h.key] = vaultResolve(h.value, vault)
  if (authHeader && !findHeader(headers, authHeader[0])) headers[authHeader[0]] = authHeader[1]
  // 5. Content-Type, unless one was given.
  if (body && body.contentType && !findHeader(headers, 'content-type')) headers['Content-Type'] = body.contentType

  // 6. The URL: path params, then the query (vault refs resolved before encoding), then the rest.
  const pathValues: Record<string, string> = Object.create(null)
  for (const p of pathParams) pathValues[p.key] = vaultResolve(p.value, vault)
  const split = splitUrl(url)
  const query = (input.params.length > 0 ? params : split.query).map((r) => ({
    ...r,
    value: vaultResolve(r.value, vault)
  }))
  const withQuery = withParams(fillPathParams(url, pathValues), [...query, ...authQuery])
  const resolvedUrl = ensureScheme(vaultResolve(withQuery, vault)).url

  // 8. Route. Resolved before cookies because the jar is keyed by it.
  const { via, routeKey, label } = routeFor(ctx.route, ctx)

  // 7. Cookies from this route's jar, after any the user typed.
  const jar = ctx.cookieHeader?.(routeKey, resolvedUrl) ?? ''
  if (jar) {
    const typed = findHeader(headers, 'cookie')
    if (typed) headers[typed] = headers[typed] ? `${headers[typed]}; ${jar}` : jar
    else headers['Cookie'] = jar
  }

  return {
    method: input.method,
    url: resolvedUrl,
    headers,
    ...(body ? { body: toArrayBuffer(body.bytes) } : {}),
    via,
    routeKey,
    routeLabel: label,
    unresolved: [...unresolved],
    authAt: { header: authHeader?.[0], query: authQuery[0]?.key },
    // An empty subprotocol is never sent: ws throws on it, and a stripped one
    // is refused by the send path before it gets here.
    protocols: protocolTemplates.map((p) => vaultResolve(p, vault).trim()).filter(Boolean)
  }
}

function maskHeader(name: string, value: string, authHeader?: string): string {
  if (!isSensitiveName(name) && name.toLowerCase() !== authHeader?.toLowerCase()) return value
  const scheme = /^(bearer|basic|token|digest)\s/i.exec(value)
  return scheme ? `${scheme[1]} ${MASK}` : MASK
}

function tlsOf(ctx: BuildCtx): { insecureTls: boolean; caPem?: string; tls: SentView['tls'] } {
  const c = ctx.collection
  if (c?.insecureTls) return { insecureTls: true, tls: 'unverified' }
  if (c?.caPem) return { insecureTls: false, caPem: c.caPem, tls: 'custom-ca' }
  return { insecureTls: false, tls: 'verified' }
}

function maskQueryKey(url: string, key: string | undefined): string {
  if (!key) return url
  const { base, query } = splitUrl(url)
  const hash = url.slice(url.split('#')[0].length)
  return withParams(base, query.map((r) => (r.key === key ? { ...r, value: MASK } : r))) + hash
}

/** The masked twin of what went out. `bodyBytes` is the live body's size. */
function sentView(a: Assembled, ctx: BuildCtx, maxRedirects: number, timeoutMs: number, bodyBytes: number): SentView {
  return {
    method: a.method,
    url: maskUrl(maskQueryKey(a.url, a.authAt.query)),
    headers: Object.entries(a.headers).map(([k, v]) => [k, maskHeader(k, v, a.authAt.header)]),
    route: { key: a.routeKey, label: a.routeLabel },
    tls: tlsOf(ctx).tls,
    maxRedirects,
    timeoutMs,
    bodyBytes
  }
}

function fail(err: unknown): BuildFailure {
  if (err instanceof BuildError) {
    return { ok: false, errorClass: err.errorClass, message: err.message, ...(err.unresolved ? { unresolved: err.unresolved } : {}) }
  }
  return { ok: false, errorClass: 'other', message: err instanceof Error ? err.message : String(err) }
}

// -------------------------------------------------------------- body encoders

/** `name="…"` with the characters that would end or break the parameter escaped (HTML's rule). */
function dispositionValue(text: string): string {
  return text.replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/"/g, '%22')
}

function randomBoundary(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return `----OpsMaxxBoundary${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function missingFile(): never {
  throw new BuildError('other', 'File contents are not kept between sessions. Choose the file again to send it.')
}

function bodyEncoder(body: Body, ctx: BuildCtx): CoreInput['body'] {
  return (tpl, vault) => {
    switch (body.mode) {
      case 'none':
        return null
      case 'json':
      case 'text':
      case 'xml': {
        const contentType = { json: 'application/json', text: 'text/plain', xml: 'application/xml' }[body.mode]
        return { bytes: utf8(tpl(body.text)), contentType }
      }
      case 'urlencoded': {
        const form = new URLSearchParams()
        for (const r of enabled(body.rows)) form.append(tpl(r.key), vaultResolve(tpl(r.value), vault))
        return { bytes: utf8(form.toString()), contentType: 'application/x-www-form-urlencoded' }
      }
      case 'multipart': {
        const boundary = randomBoundary()
        const parts: Uint8Array[] = []
        for (const r of enabled(body.rows)) {
          const name = dispositionValue(tpl(r.key))
          if (r.kind === 'file') {
            const bytes = ctx.fileBytes?.(r.id) ?? missingFile()
            const file = dispositionValue(r.fileName ?? 'file')
            parts.push(
              utf8(
                `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${file}"\r\n` +
                  'Content-Type: application/octet-stream\r\n\r\n'
              ),
              new Uint8Array(bytes),
              utf8('\r\n')
            )
          } else {
            const value = vaultResolve(tpl(r.value), vault)
            parts.push(utf8(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
          }
        }
        parts.push(utf8(`--${boundary}--\r\n`))
        return { bytes: concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
      }
      case 'binary': {
        const bytes = ctx.fileBytes?.('body') ?? missingFile()
        return { bytes: new Uint8Array(bytes), contentType: 'application/octet-stream' }
      }
    }
  }
}

// ------------------------------------------------------------------ builders

function buildWith(input: CoreInput, ctx: BuildCtx, settings: { timeoutMs?: number; maxRedirects: number }): BuildResult {
  try {
    const live = assemble(input, ctx, ctx.vault)
    const timeoutMs = clampTimeout(settings.timeoutMs ?? ctx.collection?.timeoutMs)
    const { insecureTls, caPem } = tlsOf(ctx)
    const spec: HttpRequestSpec = {
      url: live.url,
      method: live.method,
      headers: live.headers,
      ...(live.body ? { body: live.body } : {}),
      via: live.via,
      insecureTls,
      ...(caPem ? { caPem } : {}),
      maxRedirects: settings.maxRedirects,
      timeoutMs,
      requestId: ctx.requestId
    }
    // The masked twin is built from the same inputs; it cannot fail where the live one did not.
    const masked = assemble(input, ctx, MASKING_VAULT)
    return {
      ok: true,
      spec,
      sent: sentView(masked, ctx, settings.maxRedirects, timeoutMs, live.body?.byteLength ?? 0),
      routeKey: live.routeKey,
      unresolved: live.unresolved
    }
  } catch (err) {
    return fail(err)
  }
}

export function buildHttpSpec(req: HttpRequest, ctx: BuildCtx): BuildResult {
  const method = req.method.trim().toUpperCase() || 'GET'
  return buildWith(
    { method, url: req.url, params: req.params, pathParams: req.pathParams, headers: req.headers, auth: req.auth, body: bodyEncoder(req.body, ctx) },
    ctx,
    {
      timeoutMs: req.settings.timeoutMs,
      maxRedirects: req.settings.followRedirects ? Math.max(0, Math.min(req.settings.maxRedirects, MAX_REDIRECT_HOPS)) : 0
    }
  )
}

export function buildWsSpec(req: WsRequest, ctx: BuildCtx): WsBuildResult {
  try {
    const input: CoreInput = {
      method: 'GET',
      url: req.url,
      params: req.params,
      pathParams: [],
      headers: req.headers,
      auth: req.auth,
      protocols: req.protocols
    }
    const live = assemble(input, ctx, ctx.vault)
    const { insecureTls, caPem } = tlsOf(ctx)
    const url = wsUrlFor(live.url)
    const spec: WsOpenSpec = {
      url,
      ...(live.protocols.length ? { protocols: live.protocols } : {}),
      headers: live.headers,
      via: live.via,
      insecureTls,
      ...(caPem ? { caPem } : {})
    }
    const masked = assemble(input, ctx, MASKING_VAULT)
    const sent = sentView({ ...masked, url: wsUrlFor(masked.url) }, ctx, 0, 0, 0)
    if (live.protocols.length) {
      // What the handshake offered, from the DRAFT: a protocol written as a
      // {{variable}} or vault reference shows as that reference, never its
      // resolved value (a short token resolves to something name-shaped);
      // a literal is shown only when it is a protocol name with no
      // credential in it.
      const shown = req.protocols
        .filter((p) => p.trim() !== '')
        .map((p) =>
          // Verbatim only when it is nothing but references: a literal with a
          // template glued on (eyJ…{{x}}) is still a literal.
          isReferenceOnly(p)
            ? p.trim()
            : protocolCarriesCredential(p)
              ? maskProtocol(p)
              : isProtocolName(p)
                ? p
                : MASK
        )
      sent.headers.push(['Sec-WebSocket-Protocol', shown.join(', ')])
    }
    return { ok: true, spec, sent, routeKey: live.routeKey }
  } catch (err) {
    return fail(err)
  }
}

export function buildGraphQlSpec(req: GraphQlRequest, ctx: BuildCtx, operationName?: string): BuildResult {
  const body: CoreInput['body'] = (tpl) => {
    const vars = parseVariables(tpl(req.variables))
    if (!vars.ok) throw new BuildError('other', `Variables: ${vars.error}`)
    const name = operationName ?? req.operationName
    const text = buildGraphQlBody({ query: req.query, variables: vars.variables, operationName: name || undefined })
    return { bytes: utf8(text), contentType: 'application/json' }
  }
  return buildWith(
    { method: 'POST', url: req.url, params: [], pathParams: [], headers: req.headers, auth: req.auth, body },
    ctx,
    { timeoutMs: req.settings.timeoutMs, maxRedirects: 0 }
  )
}
