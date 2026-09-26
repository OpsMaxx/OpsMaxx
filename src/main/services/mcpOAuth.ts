/**
 * OAuth 2.1 authorization server for the MCP bridge.
 *
 * OpsMaxx is both the resource server and the authorization server. There is no
 * external IdP: the human is already sitting in front of the app that holds the
 * credentials, so consent belongs in that window rather than behind a browser
 * sign-in to somewhere else. That is the argument CLI pairing already makes,
 * where the 6-digit code is shown ONLY in the OpsMaxx window.
 *
 * Every shape here was observed from a real client rather than assumed. Claude
 * Code registers dynamically with `token_endpoint_auth_method: "none"`, so
 * there is no client secret anywhere in this flow and PKCE is the only thing
 * standing between a local process and a code exchange. Every PKCE check below
 * is load-bearing.
 */
import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { atomicWriteFileSync } from './atomicWrite'
import { getMcpConfig, createSession, rotateSessionToken, getSession, revokeSession } from './mcpAuth'
import type { SessionMode, WorkspaceRef } from '../../shared/mcp'
import { isSessionMode } from '../../shared/mcp'

const OAUTH_FILE = join(app.getPath('userData'), 'opsmaxx-mcp-oauth.json')

/** Short, so a leaked access token dies fast; the refresh token carries the session. */
const ACCESS_TOKEN_MINUTES = 60
/** A code is redeemed within a second or two in practice. */
const CODE_TTL_MS = 60_000
/** A consent nobody answers must not sit open forever. */
const CONSENT_TTL_MS = 5 * 60_000

// Matching control characters is the entire purpose: a client-supplied name is
// rendered to a human who approves an access grant on the strength of it, and
// an escape sequence there can redraw or hide what they are agreeing to.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

export interface OAuthClient {
  clientId: string
  clientName: string
  redirectUris: string[]
  createdAt: string
}

interface PendingCode {
  code: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  resource: string | null
  sessionId: string
  expiresAt: number
}

interface RefreshRecord {
  tokenHash: string
  clientId: string
  sessionId: string
}

interface Persisted {
  clients: OAuthClient[]
  refreshTokens: RefreshRecord[]
}

let store: Persisted | null = null

function load(): Persisted {
  if (store) return store
  try {
    if (existsSync(OAUTH_FILE)) {
      const parsed = JSON.parse(readFileSync(OAUTH_FILE, 'utf8')) as Partial<Persisted>
      store = { clients: parsed.clients ?? [], refreshTokens: parsed.refreshTokens ?? [] }
      return store
    }
  } catch {
    /* a corrupt file must not lock the user out of authorizing again */
  }
  store = { clients: [], refreshTokens: [] }
  return store
}

function persist(): void {
  atomicWriteFileSync(OAUTH_FILE, JSON.stringify(load()))
}

const hashToken = (raw: string): string => createHash('sha256').update(raw).digest('hex')

/** Constant-time lookup, for the same reason authenticate() in mcpAuth is. */
function findByTokenHash<T extends { tokenHash: string }>(list: T[], raw: string): T | undefined {
  const want = Buffer.from(hashToken(raw), 'hex')
  return list.find((record) => {
    const got = Buffer.from(record.tokenHash, 'hex')
    return got.length === want.length && timingSafeEqual(got, want)
  })
}

/**
 * A native client listens on an ephemeral loopback port, so the port cannot be
 * known ahead of time (RFC 8252 section 7.3). Claude Code registers
 * `http://localhost:<port>/callback` and re-registers on every login, so the
 * exact string it registered is what gets matched at /authorize; this decides
 * only what may be REGISTERED in the first place.
 *
 * Loopback only, by literal host: a name that merely resolves to 127.0.0.1
 * today is a DNS answer, and DNS is not a trust boundary.
 */
export function isAllowedRedirectUri(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'http:') return false
  const host = url.hostname
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]' && host !== '::1') return false
  // A fragment is never legal on a redirect_uri, and a query of the client's
  // own would collide with the parameters the server appends.
  return url.hash === '' && url.search === ''
}

export function baseUrl(): string {
  return `http://127.0.0.1:${getMcpConfig().port}`
}

export function protectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: `${baseUrl()}/mcp`,
    authorization_servers: [baseUrl()],
    bearer_methods_supported: ['header'],
    scopes_supported: []
  }
}

export function authorizationServerMetadata(): Record<string, unknown> {
  const base = baseUrl()
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    revocation_endpoint: `${base}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    // S256 only. `plain` is not a weaker option here, it is no option at all:
    // against a public client on a loopback redirect it protects nothing.
    code_challenge_methods_supported: ['S256']
  }
}

export function wwwAuthenticateHeader(): string {
  return `Bearer resource_metadata="${baseUrl()}/.well-known/oauth-protected-resource"`
}

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591)
// ---------------------------------------------------------------------------

export function registerClient(body: unknown): { ok: true; client: OAuthClient } | { ok: false; error: string } {
  const input = (body ?? {}) as { client_name?: unknown; redirect_uris?: unknown }
  const uris = Array.isArray(input.redirect_uris)
    ? input.redirect_uris.filter((u): u is string => typeof u === 'string')
    : []
  if (uris.length === 0) return { ok: false, error: 'redirect_uris is required' }
  if (!uris.every(isAllowedRedirectUri)) {
    return { ok: false, error: 'redirect_uris must be loopback http URIs with no query or fragment' }
  }
  const rawName = typeof input.client_name === 'string' ? input.client_name : ''
  // Observed as "Claude Code (opsmaxx)" -- the client's own name plus the key it
  // was configured under. A human reads this in the consent dialog and decides
  // on the strength of it, so it is untrusted display text: strip control
  // characters and cap the length.
  const clientName = rawName.replace(CONTROL_CHARS, '').trim().slice(0, 100) || 'Unnamed client'
  const client: OAuthClient = {
    clientId: randomBytes(16).toString('hex'),
    clientName,
    redirectUris: uris,
    createdAt: new Date().toISOString()
  }
  const state = load()
  state.clients.push(client)
  persist()
  return { ok: true, client }
}

export function getClient(clientId: string): OAuthClient | null {
  return load().clients.find((c) => c.clientId === clientId) ?? null
}

// ---------------------------------------------------------------------------
// Consent, which happens in the OpsMaxx window
// ---------------------------------------------------------------------------

export interface PendingConsent {
  id: string
  clientId: string
  clientName: string
  redirectUri: string
  codeChallenge: string
  state: string | null
  resource: string | null
  createdAt: number
}

type Outcome =
  | { code: string; redirectUri: string; state: string | null }
  | { error: string; redirectUri: string; state: string | null }

const pendingConsents = new Map<string, PendingConsent>()
const pendingCodes = new Map<string, PendingCode>()
const outcomes = new Map<string, Outcome>()

function sweep(): void {
  const now = Date.now()
  for (const [id, consent] of pendingConsents) {
    if (now - consent.createdAt > CONSENT_TTL_MS) {
      pendingConsents.delete(id)
      outcomes.set(id, { error: 'access_denied', redirectUri: consent.redirectUri, state: consent.state })
    }
  }
  for (const [code, entry] of pendingCodes) if (now > entry.expiresAt) pendingCodes.delete(code)
}

export interface AuthorizeRequest {
  clientId: string
  redirectUri: string
  codeChallenge: string
  codeChallengeMethod: string
  state: string | null
  resource: string | null
  responseType: string
}

export function beginAuthorization(
  request: AuthorizeRequest
): { ok: true; consentId: string } | { ok: false; error: string; description: string } {
  sweep()
  const client = getClient(request.clientId)
  if (!client) return { ok: false, error: 'invalid_client', description: 'Unknown client_id.' }
  if (request.responseType !== 'code') {
    return { ok: false, error: 'unsupported_response_type', description: 'Only response_type=code is supported.' }
  }
  // Exact match against what THIS client registered. Not a prefix, not a host
  // comparison: the registered string or nothing.
  if (!client.redirectUris.includes(request.redirectUri)) {
    return { ok: false, error: 'invalid_request', description: 'redirect_uri does not match a registered one.' }
  }
  if (request.codeChallengeMethod !== 'S256') {
    return { ok: false, error: 'invalid_request', description: 'code_challenge_method must be S256.' }
  }
  // A base64url SHA-256 digest is 43 characters. Anything shorter is not one.
  if (!request.codeChallenge || request.codeChallenge.length < 43) {
    return { ok: false, error: 'invalid_request', description: 'A PKCE code_challenge is required.' }
  }
  const consent: PendingConsent = {
    id: randomBytes(16).toString('hex'),
    clientId: client.clientId,
    clientName: client.clientName,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    state: request.state,
    resource: request.resource,
    createdAt: Date.now()
  }
  pendingConsents.set(consent.id, consent)
  return { ok: true, consentId: consent.id }
}

export function listPendingConsents(): PendingConsent[] {
  sweep()
  return [...pendingConsents.values()]
}

/**
 * The human approved, having chosen an access group and the workspaces.
 *
 * There is deliberately no default group: the caller must pass one. A default
 * here would be a grant nobody chose, and this is the one point in the flow
 * where a person is actually looking at what is being handed over.
 */
export function approveConsent(
  consentId: string,
  grant: { groupId: string | null; groupName: string; workspaces: WorkspaceRef[]; mode?: SessionMode }
): { ok: true } | { ok: false; error: string } {
  const consent = pendingConsents.get(consentId)
  if (!consent) return { ok: false, error: 'That authorization request is no longer open.' }
  // A profile, or Custom with a group -- either way something a person chose.
  // Bypass is not offered here: it is confirmed where it is set, and a consent
  // card has no such step. It can be picked afterwards under Active Sessions.
  const mode: SessionMode = grant.mode && isSessionMode(grant.mode) ? grant.mode : 'custom'
  if (mode === 'bypass') return { ok: false, error: 'Bypass cannot be granted from a consent request.' }
  if (mode === 'custom' && !grant.groupId) return { ok: false, error: 'An access group must be chosen.' }
  if (grant.workspaces.length === 0) return { ok: false, error: 'At least one workspace must be chosen.' }

  const { session } = createSession({
    agentName: consent.clientName,
    workspaces: grant.workspaces,
    groupId: mode === 'custom' ? grant.groupId : null,
    groupName: grant.groupName,
    ttlMinutes: ACCESS_TOKEN_MINUTES,
    kind: 'oauth',
    mode
  })

  const code = randomBytes(32).toString('hex')
  pendingCodes.set(code, {
    code,
    clientId: consent.clientId,
    redirectUri: consent.redirectUri,
    codeChallenge: consent.codeChallenge,
    resource: consent.resource,
    sessionId: session.id,
    expiresAt: Date.now() + CODE_TTL_MS
  })
  pendingConsents.delete(consentId)
  outcomes.set(consentId, { code, redirectUri: consent.redirectUri, state: consent.state })
  return { ok: true }
}

export function denyConsent(consentId: string): void {
  const consent = pendingConsents.get(consentId)
  if (!consent) return
  pendingConsents.delete(consentId)
  // The redirect target is carried on the outcome rather than looked up again:
  // the consent is gone by the time anything asks, and a denial that cannot
  // redirect leaves the client hanging until its own timeout instead of being
  // told no.
  outcomes.set(consentId, { error: 'access_denied', redirectUri: consent.redirectUri, state: consent.state })
}

/**
 * Where the holding page should send the browser, once a human has answered.
 * Null while the request is still open.
 */
export function consentRedirectUrl(consentId: string): string | null {
  const outcome = outcomes.get(consentId)
  if (!outcome) return null
  if ('code' in outcome) {
    const url = new URL(outcome.redirectUri)
    url.searchParams.set('code', outcome.code)
    if (outcome.state !== null) url.searchParams.set('state', outcome.state)
    return url.toString()
  }
  const url = new URL(outcome.redirectUri)
  url.searchParams.set('error', outcome.error)
  if (outcome.state !== null) url.searchParams.set('state', outcome.state)
  return url.toString()
}

/** Whether a human has answered yet, without disclosing the code. */
export function consentAnswered(consentId: string): boolean {
  return outcomes.has(consentId)
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

export interface TokenResult {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
}

function verifyPkce(verifier: string, challenge: string): boolean {
  const computed = createHash('sha256').update(verifier).digest('base64url')
  const a = Buffer.from(computed)
  const b = Buffer.from(challenge)
  return a.length === b.length && timingSafeEqual(a, b)
}

function issueRefresh(clientId: string, sessionId: string): string {
  const raw = randomBytes(32).toString('hex')
  const state = load()
  state.refreshTokens.push({ tokenHash: hashToken(raw), clientId, sessionId })
  persist()
  return raw
}

export function exchangeCode(params: {
  code: string
  clientId: string
  redirectUri: string
  codeVerifier: string
  resource: string | null
}): { ok: true; token: TokenResult } | { ok: false; error: string; description: string } {
  sweep()
  const entry = pendingCodes.get(params.code)
  // Single use, always. Deleted before anything below can reject it, so a failed
  // attempt still burns the code rather than leaving it for a second try.
  if (entry) pendingCodes.delete(params.code)
  if (!entry || Date.now() > entry.expiresAt) {
    return { ok: false, error: 'invalid_grant', description: 'The authorization code is unknown or expired.' }
  }
  if (entry.clientId !== params.clientId) {
    return { ok: false, error: 'invalid_grant', description: 'This code was issued to a different client.' }
  }
  if (entry.redirectUri !== params.redirectUri) {
    return { ok: false, error: 'invalid_grant', description: 'redirect_uri does not match the one used to authorize.' }
  }
  if (!params.codeVerifier || !verifyPkce(params.codeVerifier, entry.codeChallenge)) {
    return { ok: false, error: 'invalid_grant', description: 'PKCE verification failed.' }
  }
  // RFC 8707: a token must not be usable at an audience the user never saw.
  if (entry.resource && params.resource && entry.resource !== params.resource) {
    return { ok: false, error: 'invalid_target', description: 'resource does not match the authorization request.' }
  }
  const rotated = rotateSessionToken(entry.sessionId, ACCESS_TOKEN_MINUTES)
  if (!rotated) return { ok: false, error: 'invalid_grant', description: 'The session behind this code is gone.' }
  return {
    ok: true,
    token: {
      access_token: rotated.token,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_MINUTES * 60,
      refresh_token: issueRefresh(entry.clientId, entry.sessionId)
    }
  }
}

export function refresh(params: {
  refreshToken: string
  clientId: string
}): { ok: true; token: TokenResult } | { ok: false; error: string; description: string } {
  const state = load()
  const record = findByTokenHash(state.refreshTokens, params.refreshToken)
  if (!record || record.clientId !== params.clientId) {
    return { ok: false, error: 'invalid_grant', description: 'Unknown refresh token.' }
  }
  // Rotation: the presented token dies here whatever happens next, so a stolen
  // one is useful at most once, and its use shows up as a failure for the
  // legitimate client rather than passing unnoticed.
  state.refreshTokens = state.refreshTokens.filter((r) => r !== record)
  persist()

  const session = getSession(record.sessionId)
  if (!session || session.revoked) {
    return { ok: false, error: 'invalid_grant', description: 'This session has been revoked in OpsMaxx.' }
  }
  const rotated = rotateSessionToken(record.sessionId, ACCESS_TOKEN_MINUTES)
  if (!rotated) return { ok: false, error: 'invalid_grant', description: 'This session is gone.' }
  return {
    ok: true,
    token: {
      access_token: rotated.token,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_MINUTES * 60,
      refresh_token: issueRefresh(record.clientId, record.sessionId)
    }
  }
}

/** RFC 7009. Revoking any token of a session ends the session itself. */
export function revoke(token: string): void {
  const state = load()
  const record = findByTokenHash(state.refreshTokens, token)
  if (!record) return
  state.refreshTokens = state.refreshTokens.filter((r) => r.sessionId !== record.sessionId)
  persist()
  revokeSession(record.sessionId)
}

/** Called when a session is revoked in the app, so a refresh cannot resurrect it. */
export function forgetSession(sessionId: string): void {
  const state = load()
  const before = state.refreshTokens.length
  state.refreshTokens = state.refreshTokens.filter((r) => r.sessionId !== sessionId)
  if (state.refreshTokens.length !== before) persist()
}

export function resetOAuthForTests(): void {
  store = null
  pendingConsents.clear()
  pendingCodes.clear()
  outcomes.clear()
  try {
    if (existsSync(OAUTH_FILE)) atomicWriteFileSync(OAUTH_FILE, JSON.stringify({ clients: [], refreshTokens: [] }))
  } catch {
    /* ignore */
  }
}
