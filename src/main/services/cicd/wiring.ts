// Where the adapters, the transport and the poller are joined, and the only
// place in main that holds the connection list.
//
// ---------------------------------------------------------------------------
// WHY THE PROBE RECORDS RESPONSES INSTEAD OF CATCHING ERRORS
// ---------------------------------------------------------------------------
//
// The poller schedules on things `CicdAdapter` deliberately hides. It needs the
// status code (304 is a free hit, 429 is a back-off, a 404 on a log is an
// EXPECTED state), `Retry-After`, and the rate-budget headers. Adapters throw a
// plain `Error` on a non-2xx and only GitLab's carries a status, so catching
// and sniffing the message would be guesswork that breaks the first time
// someone rewords an error.
//
// So the TRANSPORT is wrapped, not the adapter, at the `CicdHttpDeps.request`
// seam `service.ts` already exposes for tests: a recorder remembers the last
// `HttpResult`, the adapter runs on top of it and does the parsing it is good
// at, and the probe reads status and headers off the recorder afterwards. The
// adapter stays unaware that anything is scheduling it, which is the property
// that let it be tested without a socket.

import {
  CicdPoller,
  POLL_INTERVAL_MS,
  type CicdPollRequest,
  type CicdPollResponse,
  type CicdPollTarget
} from './poller'
import { createCicdAdapter, makeCicdHttp, resolveSecret, type CicdHttpDeps } from './service'
import { httpRequest } from '../httpClient'
import { loadData } from '../store'
import type { HttpResult } from '../../../shared/httpClient'
import { randomUUID } from 'node:crypto'
import { vaultList, vaultSave } from '../vault'
import type { VaultEntry } from '../../../shared/vault'
import type {
  CicdConnection,
  CicdLogChunk,
  AgentRunReport,
  CicdPanelState,
  CicdParam,
  CicdPipeline,
  CicdTriggerResult
} from '../../../shared/cicd'
import { triggerJenkins, jenkinsParams, cancelJenkins } from './jenkins'
import { triggerGitlab, listGitlabParams, cancelGitlab } from './gitlab'
import { triggerGithub, rerunGithub, cancelGithub } from './github'

/**
 * The connection list, read from the SAVED FILE — never from IPC.
 *
 * ---------------------------------------------------------------------------
 * WHY THE RENDERER DOES NOT GET TO SUPPLY THIS
 * ---------------------------------------------------------------------------
 *
 * An earlier version took the records straight off `cicd:configure`. That let
 * a compromised renderer name a `vaultEntryId` it had never been given and a
 * `baseUrl` it chose: main would resolve whatever entry that id pointed at —
 * an SSH server's password, a database credential — and put it in an
 * `Authorization` header aimed at an arbitrary host. No approval, no audit, no
 * user gesture, once per vault entry.
 *
 * `shared/httpClient.ts` already states the rule for SSH: "Credentials are
 * deliberately absent: main merges them from the encrypted store by `serverId`
 * … A renderer that could send a password could also exfiltrate one." Naming
 * the entry AND the destination is the same power one step removed.
 *
 * So the file on disk is the only source. `cicd:configure` becomes a signal
 * that it changed, carrying no data of its own. That also means the bridge
 * works before any window has mounted the panel, which is what the MCP tools
 * need — they were previously empty until the CI tab happened to be opened.
 */
let connections: CicdConnection[] = []

/** Shaped like `persist.ts` writes it. */
interface SavedShape {
  cicdConnections?: unknown
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const PROVIDERS = new Set(['jenkins', 'gitlab', 'github'])

/**
 * Re-read the saved connections.
 *
 * Deliberately tolerant in the same direction as the renderer's
 * `normalizeCicd`: a record whose provider is unrecognised is kept out of the
 * runtime list rather than dialled with an adapter that has three branches.
 */
export function reload(data?: unknown): CicdConnection[] {
  const raw = (data ?? loadData()) as SavedShape | null
  const list = Array.isArray(raw?.cicdConnections) ? raw.cicdConnections : []
  connections = list.filter(isRecord).filter(
    (c) =>
      typeof c.id === 'string' &&
      typeof c.workspaceId === 'string' &&
      typeof c.baseUrl === 'string' &&
      typeof c.vaultEntryId === 'string' &&
      typeof c.provider === 'string' &&
      PROVIDERS.has(c.provider)
  ) as unknown as CicdConnection[]
  return connections
}

export function listConnections(): CicdConnection[] {
  return connections
}

export function getConnection(id: string): CicdConnection | null {
  return connections.find((c) => c.id === id) ?? null
}

function requireConnection(id: string): CicdConnection {
  const c = getConnection(id)
  if (!c) throw new Error(`No CI/CD connection is configured with that id.`)
  return c
}

/**
 * Records the last raw response an adapter's requests produced.
 *
 * The recorder sits at `CicdHttpDeps.request` — the low-level transport —
 * rather than wrapping `CicdHttp` or the adapter. That is the seam `service.ts`
 * already exposes for tests, it needs no new plumbing, and an `HttpResult`
 * carries exactly what scheduling wants: the status and the headers.
 *
 * When an adapter makes several requests (GitHub's discovery is a join), the
 * LAST recorded response is the one reported — but ONLY as a refusal. See the
 * catch in `pollOnce`: an adapter that threw after a 2xx must not report that
 * 2xx, and some adapters (`jenkins.stages`) swallow a non-2xx without throwing,
 * so a recorded status is evidence about one request, never a verdict on the
 * call.
 */
function recordingRequest(
  inner: NonNullable<CicdHttpDeps['request']>,
  etag?: string
): { request: NonNullable<CicdHttpDeps['request']>; last: () => HttpResult | null } {
  let last: HttpResult | null = null
  let first = true
  const request: NonNullable<CicdHttpDeps['request']> = async (spec, ctx) => {
    // `If-None-Match` is added here rather than inside an adapter, because a
    // conditional request is a SCHEDULING concern and an adapter has no idea it
    // is being polled. Only the first request of a read carries it: the poller
    // caches one ETag per target, and an adapter that fans out would otherwise
    // send one call's tag to a different endpoint.
    const withTag =
      first && etag ? { ...spec, headers: { ...spec.headers, 'If-None-Match': etag } } : spec
    first = false
    const res = await inner(withTag, ctx)
    last = res
    return res
  }
  return { request, last: () => last }
}

/**
 * The two things `pollOnce` reaches outside itself, injected so a test opens
 * no socket and touches no vault. Same convention as `CicdPollDeps.read` and
 * `ServiceCheckRunner`'s probe: the seam exists because a scheduler that can
 * only be tested against a live CI server is a scheduler nobody tests.
 */
export interface CicdProbeDeps {
  request?: NonNullable<CicdHttpDeps['request']>
  secretFor?: (connection: CicdConnection) => string
}

function headerOf(res: HttpResult | null, name: string): string | undefined {
  if (!res || !res.ok) return undefined
  const want = name.toLowerCase()
  for (const [k, v] of Object.entries(res.headers ?? {})) {
    if (k.toLowerCase() === want) return v
  }
  return undefined
}

function statusOf(res: HttpResult | null): number {
  // 0 means "no server answered". A transport failure must not be mistaken for
  // anything a CI server said, least of all a 404 — which on a log is an
  // expected state and would stop the poller backing off when it should.
  return res && res.ok ? res.status : 0
}

function intOf(v: string | undefined): number | undefined {
  if (v === undefined) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** `Retry-After` is seconds or an HTTP date. Both appear in the wild. */
function retryAfterMs(res: HttpResult | null): number | undefined {
  const raw = headerOf(res, 'retry-after')
  if (!raw) return undefined
  const secs = Number(raw)
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000
  const at = Date.parse(raw)
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
}

/** GitHub is the only one of the three that reports a budget. */
function rateOf(res: HttpResult | null): CicdPollResponse['rate'] {
  const remaining = intOf(headerOf(res, 'x-ratelimit-remaining'))
  const limit = intOf(headerOf(res, 'x-ratelimit-limit'))
  if (remaining === undefined || limit === undefined) return undefined
  const reset = intOf(headerOf(res, 'x-ratelimit-reset'))
  return { remaining, limit, ...(reset !== undefined ? { resetAt: reset * 1000 } : {}) }
}

/**
 * Where a log target resumes from, keyed by the poller's own cache key.
 *
 * The poller does not model a cursor — it schedules, it does not read — so the
 * resume point lives here, beside the thing that actually calls `getLog`. Keyed
 * by `cacheKey` because that is already the identity of "this exact read",
 * and pruned with the targets it belongs to.
 */
const logCursors = new Map<string, string>()

/**
 * One scheduled read.
 *
 * Everything returned is derived from what came back on the wire. A thrown
 * adapter error with no recorded response is a transport failure and reports
 * status 0, distinguishable from any answer a server gave.
 */
export async function pollOnce(
  req: CicdPollRequest,
  deps: CicdProbeDeps = {}
): Promise<CicdPollResponse> {
  const connection = getConnection(req.target.connectionId) ?? req.connection
  const rec = recordingRequest(deps.request ?? httpRequest, req.etag)

  try {
    // Inside the try, not above it. A locked vault, a missing vault entry and
    // "routes through a server that no longer exists" all throw here, and this
    // function's contract is that it REPORTS a failure rather than rejecting —
    // an earlier version promised that in its doc comment and then let those
    // three escape, losing the rate budget and `Retry-After` on the way out.
    const secret = (deps.secretFor ?? resolveSecret)(connection)
    const adapter = createCicdAdapter(connection, secret, { request: rec.request })
    // A 304 is the whole point of sending the tag: GitHub does not charge for
    // one. The adapter will throw on it (it is not a 2xx and carries no body),
    // so the recorded status is checked before the parsed result is used.
    if (req.target.kind === 'log') {
      const chunk = await adapter.getLog(
        req.target.pipelineRef,
        req.target.runId ?? '',
        req.target.stepName,
        logCursors.get(req.cacheKey)
      )
      if (chunk.cursor) logCursors.set(req.cacheKey, chunk.cursor)
      const res = rec.last()
      return {
        status: statusOf(res),
        etag: headerOf(res, 'etag'),
        rate: rateOf(res)
      }
    }
    const runs = await adapter.listRuns(req.target.pipelineRef, req.target.limit ?? 20)
    const res = rec.last()
    return {
      status: statusOf(res),
      runs,
      etag: headerOf(res, 'etag'),
      rate: rateOf(res)
    }
  } catch (err) {
    const res = rec.last()
    const seen = statusOf(res)
    return {
      // NOT `statusOf(res)`.
      //
      // An adapter can throw AFTER a successful sub-request — GitLab's job
      // lookup 200s and then finds no matching job, a JSON body parses as
      // garbage, GitHub's discovery join fails on its second call. Reporting
      // the last recorded 2xx here made the poller record a fresh, successful
      // read over stale rows and clear the error: the panel then showed old
      // data with a current timestamp, which is the single lie this module
      // exists to prevent. Only a status the server itself used to REFUSE is
      // passed through; anything else is a failed call, and 0 says so.
      status: seen >= 400 ? seen : 0,
      etag: headerOf(res, 'etag'),
      retryAfterMs: retryAfterMs(res),
      rate: rateOf(res),
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Start a run.
 *
 * Not gated here. The UI gates it with a confirm modal and the bridge gates it
 * with `gate()` plus `evaluateCiTrigger`; this function is the thing both of
 * those call once they have their answer. Putting the gate inside would mean a
 * second, weaker copy of a decision that has one right place.
 */
export async function triggerRun(
  connectionId: string,
  pipelineRef: string,
  ref: string,
  params?: Record<string, string>
): Promise<CicdTriggerResult> {
  const c = requireConnection(connectionId)
  const secret = resolveSecret(c)
  const http = makeCicdHttp(c, secret)
  switch (c.provider) {
    case 'jenkins':
      return triggerJenkins(http, pipelineRef, params)
    case 'gitlab':
      return triggerGitlab(http, { projectId: pipelineRef, ref, variables: params })
    case 'github':
      return triggerGithub(http, { connectionId, baseUrl: c.baseUrl }, { pipelineRef, ref, inputs: params })
  }
}

export async function rerunRun(
  connectionId: string,
  pipelineRef: string,
  runId: string
): Promise<CicdTriggerResult> {
  const c = requireConnection(connectionId)
  const secret = resolveSecret(c)
  const http = makeCicdHttp(c, secret)
  if (c.provider === 'github') {
    return rerunGithub(http, { connectionId, baseUrl: c.baseUrl }, { pipelineRef, runId })
  }
  // Jenkins has no re-run: a build is started again from its job, with the same
  // parameters if the caller supplies them. GitLab retries a pipeline, which is
  // a different endpoint per subject. Rather than fake a shared verb, say so.
  throw new Error(
    `Re-running a finished run is a ${c.provider === 'jenkins' ? 'Jenkins' : 'GitLab'} concept this module does not expose yet. Start a new run instead.`
  )
}

export async function listParams(connectionId: string, pipelineRef: string): Promise<CicdParam[]> {
  const c = requireConnection(connectionId)
  const secret = resolveSecret(c)
  const http = makeCicdHttp(c, secret)
  switch (c.provider) {
    case 'jenkins':
      return jenkinsParams(http, pipelineRef)
    case 'gitlab':
      return listGitlabParams(http, pipelineRef)
    case 'github':
      return createCicdAdapter(c, secret).listParams(pipelineRef)
  }
}


export async function cancelRun(
  connectionId: string,
  pipelineRef: string,
  runId: string
): Promise<CicdTriggerResult> {
  const c = requireConnection(connectionId)
  const secret = resolveSecret(c)
  const http = makeCicdHttp(c, secret)
  switch (c.provider) {
    case 'jenkins':
      return cancelJenkins(http, pipelineRef, runId)
    case 'gitlab':
      return cancelGitlab(http, { projectId: pipelineRef, pipelineId: runId })
    case 'github':
      return cancelGithub(http, { connectionId, baseUrl: c.baseUrl }, { pipelineRef, runId })
  }
}

/**
 * Dial a connection that has not been saved yet.
 *
 * The secret is passed in rather than resolved, because at this point there is
 * no vault entry: the user has typed a token into the connect modal and wants
 * to know whether it works before anything is written anywhere. Nothing is
 * stored by this call — that is the whole contract of the Verify button.
 */
export async function verify(
  connection: CicdConnection,
  secret: string
): Promise<{ ok: true; identity: string; scopes?: string[]; expiresAt?: number } | { ok: false; error: string }> {
  try {
    const out = await createCicdAdapter(connection, secret).verify()
    return { ok: true, ...out }
  } catch (err) {
    // A locked vault is not a reachability problem, and neither is a bad token.
    // The message the adapter produced already distinguishes them; this only
    // stops a rejected promise crossing IPC as an opaque failure.
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function getLog(
  connectionId: string,
  pipelineRef: string,
  runId: string,
  stepName?: string,
  cursor?: string
): Promise<CicdLogChunk> {
  const c = requireConnection(connectionId)
  const secret = resolveSecret(c)
  return createCicdAdapter(c, secret).getLog(pipelineRef, runId, stepName, cursor)
}

/**
 * Drop the vault entry a deleted connection owned.
 *
 * Same shape as `deleteVpnSecrets`: read, filter, save. An id that is not
 * there is not an error — a delete that raced a delete is the normal way this
 * gets called twice.
 */
export async function deleteSecrets(vaultEntryId: string): Promise<void> {
  if (!vaultEntryId) return
  const listed = vaultList()
  if (!listed.ok || !listed.entries) return
  const remaining = listed.entries.filter((e) => e.id !== vaultEntryId)
  if (remaining.length === listed.entries.length) return
  const saved = vaultSave(remaining)
  if (!saved.ok) throw new Error(saved.error ?? 'The vault refused the change.')
}


export async function getRun(
  connectionId: string,
  pipelineRef: string,
  runId: string,
  attempt = 1
): Promise<{ run: unknown; steps: unknown[] }> {
  const c = requireConnection(connectionId)
  const secret = resolveSecret(c)
  return createCicdAdapter(c, secret).getRun(pipelineRef, runId, attempt)
}

/**
 * Store a token and hand back the id that points at it.
 *
 * The connect modal is the one place a token exists in the renderer, and this
 * is where it stops existing there: the renderer sends it once, main writes the
 * vault entry, and what comes back is an id. The module itself is banned from
 * importing the vault (`MODULE_FORBIDDEN_IMPORTS`), which is exactly why this
 * lives in main rather than beside the form.
 */
export async function createSecret(label: string, token: string): Promise<string> {
  if (!token) throw new Error('No token was supplied.')
  const listed = vaultList()
  if (!listed.ok || !listed.entries) {
    throw new Error(listed.error ?? 'The vault is locked. Unlock it to save this connection.')
  }
  const now = new Date().toISOString()
  const entry: VaultEntry = {
    id: randomUUID(),
    kind: 'key',
    name: label,
    username: '',
    password: token,
    url: '',
    fields: [],
    notes: '',
    tags: [],
    createdAt: now,
    updatedAt: now
  }
  const saved = vaultSave([...listed.entries, entry])
  if (!saved.ok) throw new Error(saved.error ?? 'The vault refused the change.')
  return entry.id
}


// ---------------------------------------------------------------------------
// What an agent started
// ---------------------------------------------------------------------------

/**
 * Runs an AI agent asked for during this session.
 *
 * STOP ALL AI ACCESS revokes sessions and denies pending approvals. It cannot
 * stop a build the provider already accepted — and, worse, the operator
 * pressing it at 2am has no way to know a build exists. `list_runs` is the
 * agent's tool, not a notification. The switch was telling them what it revoked
 * and staying silent about what it could not.
 *
 * So this records what was started, purely to be able to SAY it. Nothing here
 * cancels anything: auto-cancelling on the panic button would be a destructive,
 * unapproved action taken on the operator's behalf, and a pipeline stopped
 * half-way is not a pipeline that never ran.
 *
 * In memory, this session only. A record that survived a restart would be a
 * claim about the world that nothing had checked since.
 */
interface AgentRun {
  connectionId: string
  pipelineRef: string
  /** Absent on Jenkins (a queue item) and on GHES (204 with no body). */
  runId?: string
  at: number
}

const agentRuns: AgentRun[] = []

/** Ages out a record we can never resolve, so the dialog cannot cry wolf forever. */
const AGENT_RUN_TTL_MS = 6 * 60 * 60 * 1000

export function noteAgentRun(
  connectionId: string,
  pipelineRef: string,
  result: CicdTriggerResult
): void {
  agentRuns.push({
    connectionId,
    pipelineRef,
    ...(result.run ? { runId: result.run.id } : {}),
    at: Date.now()
  })
}

/** A cancel that the provider accepted answers the question this ledger asks. */
export function forgetAgentRun(connectionId: string, runId: string): void {
  const i = agentRuns.findIndex((r) => r.connectionId === connectionId && r.runId === runId)
  if (i >= 0) agentRuns.splice(i, 1)
}

/**
 * Agent-started runs that may still be going.
 *
 * Cross-referenced against what the poller has actually seen, so a run observed
 * to have finished drops out rather than haunting the dialog. A run with no id
 * cannot be checked and is reported as unchecked.
 */
export function agentRunsInFlight(now = Date.now()): AgentRunReport[] {
  const snap = poller?.snapshot()
  const out: AgentRunReport[] = []
  for (let i = agentRuns.length - 1; i >= 0; i--) {
    const r = agentRuns[i]
    if (now - r.at > AGENT_RUN_TTL_MS) {
      agentRuns.splice(i, 1)
      continue
    }
    const connection = connections.find((c) => c.id === r.connectionId)
    const seen = r.runId
      ? snap?.targets
          .filter((t) => t.connectionId === r.connectionId)
          .flatMap((t) => t.runs)
          .find((run) => run.id === r.runId)
      : undefined
    if (seen && seen.outcome.status !== 'running' && seen.outcome.status !== 'queued') {
      // Observed finished. Not news any more.
      agentRuns.splice(i, 1)
      continue
    }
    out.push({
      connectionName: connection?.name ?? r.connectionId,
      pipeline: pipelines.get(r.connectionId)?.find((p) => p.ref === r.pipelineRef)?.name ?? r.pipelineRef,
      ...(seen?.label ? { run: seen.label } : {}),
      startedAt: r.at,
      state: seen ? (seen.outcome.status as 'running' | 'queued') : 'unknown'
    })
  }
  return out.reverse()
}

// ---------------------------------------------------------------------------
// The poller
// ---------------------------------------------------------------------------

let poller: CicdPoller | null = null

/**
 * Pipelines discovered per connection, and the poll targets built from them.
 *
 * DISCOVERY LIVES HERE, not in the renderer. The panel knows which accounts the
 * user saved; it has no way to know what pipelines those accounts contain
 * without asking a provider, which is main's job. An earlier shape had the
 * renderer supply poll targets — it could not build any, so the poller was
 * configured with an empty list and never started its timer. The panel was a
 * permanently empty page with no error anywhere.
 */
const pipelines = new Map<string, CicdPipeline[]>()

function targetsFor(connectionId: string): CicdPollTarget[] {
  return (pipelines.get(connectionId) ?? []).map((p) => ({
    id: `${connectionId}\u0000${p.ref}`,
    connectionId,
    pipelineRef: p.ref,
    kind: 'runs' as const
  }))
}

function allTargets(): CicdPollTarget[] {
  return connections.filter((c) => c.enabled).flatMap((c) => targetsFor(c.id))
}

/**
 * What the panel actually renders, built from the poller's state.
 *
 * The poller's own types are about SCHEDULING — when to ask next, how far it
 * has backed off. The panel needs something else: how fresh this is, whether
 * the last attempt failed, and the rows. Projecting here rather than sending
 * the scheduler's shape across IPC is what stops the renderer keying a Map on
 * a field that does not exist.
 */
function panelState(connectionId: string): CicdPanelState {
  const snap = poller?.snapshot()
  const sched = snap?.connections.find((c) => c.connectionId === connectionId)
  const targets = (snap?.targets ?? []).filter((t) => t.connectionId === connectionId)
  const byRef = new Map(targets.map((t) => [t.targetId, t]))
  const defs = pipelines.get(connectionId) ?? []
  // A failure ages a row; it never empties one. The last good runs stay
  // attached and `readAt` says how old they are.
  const withRuns = defs.map((p) => {
    const t = byRef.get(`${connectionId}\u0000${p.ref}`)
    const last = t?.runs?.[0]
    return last ? { ...p, last } : p
  })
  const failed = targets.filter((t) => t.error)
  const provider = connections.find((c) => c.id === connectionId)?.provider
  return {
    connectionId,
    intervalSec: Math.round((provider ? POLL_INTERVAL_MS[provider] : 20_000) / 1000),
    readAt: sched?.lastReadAt,
    ...(failed.length > 0 ? { error: failed[0].error } : {}),
    failures: failed.length,
    ...(sched?.rate ? { budget: sched.rate } : {}),
    pipelines: withRuns
  }
}

/**
 * Ask each enabled connection what pipelines it has, then schedule them.
 *
 * Discovery failures are per-connection and do not stop the others: one
 * unreachable Jenkins must not take a working GitHub account down with it.
 * A connection whose discovery failed keeps whatever pipelines it had, for the
 * same reason a failed poll keeps its rows.
 */
async function discover(emit: (event: CicdPanelState) => void): Promise<void> {
  for (const c of connections) {
    if (!c.enabled) {
      pipelines.delete(c.id)
      continue
    }
    try {
      const secret = resolveSecret(c)
      const found = await createCicdAdapter(c, secret).listPipelines()
      pipelines.set(c.id, found)
    } catch {
      // Keep the previous list. The poll that follows will report the failure
      // against the rows the user can already see, which is more useful than
      // an empty panel with a message.
      if (!pipelines.has(c.id)) pipelines.set(c.id, [])
    }
    emit(panelState(c.id))
  }
  poller?.configure(connections, allTargets())
}

export function configure(emit: (event: CicdPanelState) => void): void {
  reload()
  broadcast = emit
  if (!poller) {
    poller = new CicdPoller({
      read: pollOnce,
      // Every completed read refreshes the panel's view of that connection.
      emit: (e) => emit(panelState(e.target.connectionId)),
      // The transition channel, which is what an alert would hang off.
      change: (e) => emit(panelState(e.target.connectionId))
    })
  }
  // Schedule what is already known immediately, so a reconfigure does not go
  // quiet while discovery runs.
  poller.configure(connections, allTargets())
  // Prune cursors for targets that no longer exist. The map is keyed by the
  // poller's cache key, which starts with the target id.
  const live = new Set(allTargets().map((t) => t.id))
  for (const key of logCursors.keys()) {
    if (![...live].some((id) => key.startsWith(id))) logCursors.delete(key)
  }
  void discover(emit)
}

/** The panel's Refresh button. Optional id narrows it to one connection. */
export function refresh(connectionId?: string): void {
  poller?.refresh(connectionId)
}

export function snapshot(): CicdPanelState[] {
  return connections.map((c) => panelState(c.id))
}

export function dispose(): void {
  poller?.dispose()
  poller = null
  connections = []
  pipelines.clear()
  agentRuns.length = 0
  logCursors.clear()
  broadcast = null
}

/** Kept so a caller that arrives before `configure` does not silently no-op. */
let broadcast: ((event: CicdPanelState) => void) | null = null
export function hasSubscriber(): boolean {
  return broadcast !== null
}
