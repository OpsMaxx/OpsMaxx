// GitLab CI adapter.
//
// The mapping, because it is not the obvious one: a `CicdPipeline` is a GitLab
// PROJECT, a `CicdRun` is one of that project's pipelines, and a `CicdStep` is
// a job. That is the level the user triggers and watches — "run the pipeline on
// `main`" is a project-scoped verb, and GitLab's own sidebar is organised the
// same way.
//
// Triggering is not on the adapter (see the header of `shared/cicd.ts`), so
// `triggerGitlab` and `playGitlabJob` are exported separately.

import { remoteText } from '../../../shared/remoteText'
import {
  gitlabOutcome,
  type CicdAdapter,
  type CicdCapabilities,
  type CicdHttp,
  type CicdLogChunk,
  type CicdParam,
  type CicdPathSegment,
  type CicdPipeline,
  type CicdResponse,
  type CicdRun,
  type CicdStep,
  type CicdTriggerResult
} from '../../../shared/cicd'

/**
 * The header main merges the PAT into. The adapter never sees the token.
 *
 * `read_api` is enough for every read here; creating a pipeline needs the full
 * `api` scope. That split is documented, not inferred.
 */
export const GITLAB_AUTH_HEADER = 'PRIVATE-TOKEN'

/** GitLab's documented ceiling. Asking for more is silently clamped to this. */
const MAX_PER_PAGE = 100

/** One log refetch never hands the UI more than this; the rest is reported as withheld. */
const MAX_TRACE_BYTES = 2 * 1024 * 1024

/** Developer. Below this a project's pipelines can be read but not created. */
const ACCESS_DEVELOPER = 30

export interface GitlabAdapterOptions {
  connectionId: string
  /** Restrict to these projects (numeric id, or `group/project`). Empty means every visible project. */
  projectIds?: string[]
  /** Page size. Clamped to GitLab's max of 100. */
  perPage?: number
  /** Hard stop on paging, so a provider that keeps advertising a next page cannot loop forever. */
  maxPages?: number
}

/** Carries the HTTP status and any `Retry-After`, so a caller can throttle rather than guess. */
export class GitlabApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number
  ) {
    super(message)
    this.name = 'GitlabApiError'
  }
}

// ---------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------

const enc = (id: string): string => encodeURIComponent(String(id))

const headerOf = (res: CicdResponse, name: string): string | undefined => {
  const want = name.toLowerCase()
  for (const [k, v] of Object.entries(res.headers ?? {})) {
    if (k.toLowerCase() === want && v !== '') return v
  }
  return undefined
}

const retryAfterMs = (res: CicdResponse): number | undefined => {
  const raw = headerOf(res, 'retry-after')
  if (!raw) return undefined
  const secs = Number(raw)
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : undefined
}

// Remote response text goes through `remoteText` before it reaches an Error.
// A CI server's error body is not ours: a self-hosted instance (or anything
// answering in front of one) chooses it, and these messages surface in the UI,
// in a failed-trigger note, and in MCP tool results. `remoteText` flattens
// newlines and strips C0/C1, bidi overrides and zero-width characters, so a
// crafted `message` cannot reverse the sentence it lands in or forge a line
// break into something that reads as OpsMaxx's own words.
/** GitLab puts its human-readable reason in `message` or `error`. */
const reasonOf = (res: CicdResponse): string => {
  try {
    const b = JSON.parse(res.body) as { message?: unknown; error?: unknown }
    const m = b.message ?? b.error
    if (typeof m === 'string' && m) return remoteText(m, 200)
    if (m && typeof m === 'object') return remoteText(JSON.stringify(m), 200)
  } catch {
    /* not JSON — fall through */
  }
  return remoteText(res.body, 200) || `HTTP ${res.status}`
}

const expectOk = (res: CicdResponse, what: string): void => {
  if (res.status >= 200 && res.status < 300) return
  throw new GitlabApiError(`GitLab ${what} failed (${res.status}): ${reasonOf(res)}`, res.status, retryAfterMs(res))
}

const parseJson = <T>(res: CicdResponse, what: string): T => {
  try {
    return JSON.parse(res.body) as T
  } catch {
    throw new GitlabApiError(`GitLab returned a non-JSON ${what} response`, res.status)
  }
}

const qs = (params: Record<string, string | undefined>): string =>
  Object.entries(params)
    .filter((e): e is [string, string] => e[1] !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')

const replaceParam = (query: string, key: string, value: string): string => {
  const p = new URLSearchParams(query)
  p.set(key, value)
  return p.toString()
}

/** `<https://host/api/v4/projects?page=2&per_page=100>; rel="next", <…>; rel="last"` */
const nextLinkQuery = (link: string | undefined): string | null => {
  if (!link) return null
  for (const part of link.split(',')) {
    if (!/rel="?next"?/.test(part)) continue
    const url = part.match(/<([^>]+)>/)?.[1]
    if (!url) continue
    const q = url.indexOf('?')
    return q === -1 ? '' : url.slice(q + 1)
  }
  return null
}

/**
 * The query for the next page, or null when this was the last one.
 *
 * Deliberately never reads `x-total` or `x-total-pages`: past 10,000 records
 * GitLab stops sending them AND drops `rel="last"`, so anything that computes
 * "page N of M" is wrong exactly on the lists big enough to care. The only
 * trustworthy end-of-list signals are the absence of a next link/page/cursor.
 */
const nextQuery = (res: CicdResponse, current: string): string | null => {
  const link = nextLinkQuery(headerOf(res, 'link'))
  if (link !== null) return link
  const page = headerOf(res, 'x-next-page')
  if (page) return replaceParam(current, 'page', page)
  const cursor = headerOf(res, 'x-next-cursor')
  if (cursor) return replaceParam(current, 'cursor', cursor)
  return null
}

// ---------------------------------------------------------------------------
// GitLab payload shapes — only the fields actually read
// ---------------------------------------------------------------------------

interface GlNamespace {
  id?: number | string
  full_path?: string
  kind?: string
}
interface GlProject {
  id: number | string
  name?: string
  path?: string
  path_with_namespace?: string
  namespace?: GlNamespace
  permissions?: {
    project_access?: { access_level?: number } | null
    group_access?: { access_level?: number } | null
  }
}
interface GlGroup {
  id: number | string
  full_path?: string
}
interface GlPipeline {
  id: number | string
  iid?: number | string
  status?: string
  ref?: string
  sha?: string
  name?: string
  web_url?: string
  created_at?: string
  started_at?: string
  finished_at?: string
  duration?: number | null
  user?: { username?: string; name?: string } | null
}
interface GlJob {
  id: number | string
  name?: string
  status?: string
  duration?: number | null
  started_at?: string
  finished_at?: string
}

const ms = (iso: string | undefined | null): number | undefined => {
  if (!iso) return undefined
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : undefined
}

const spanMs = (
  duration: number | null | undefined,
  started?: string,
  finished?: string
): number | undefined => {
  if (typeof duration === 'number' && Number.isFinite(duration)) return Math.round(duration * 1000)
  const a = ms(started)
  const b = ms(finished)
  return a !== undefined && b !== undefined ? b - a : undefined
}

const TERMINAL = new Set(['success', 'failed', 'canceled', 'skipped'])

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export function createGitlabAdapter(http: CicdHttp, opts: GitlabAdapterOptions): CicdAdapter {
  const perPage = Math.min(Math.max(opts.perPage ?? MAX_PER_PAGE, 1), MAX_PER_PAGE)
  const maxPages = Math.max(opts.maxPages ?? 50, 1)

  const get = async (path: string, headers?: Record<string, string>): Promise<CicdResponse> =>
    http({ method: 'GET', path, headers })

  async function paged<T>(
    path: string,
    params: Record<string, string | undefined>,
    limit?: number
  ): Promise<T[]> {
    const out: T[] = []
    let query = qs({ per_page: String(perPage), ...params })
    for (let page = 0; page < maxPages; page++) {
      const res = await get(`${path}?${query}`)
      expectOk(res, `GET ${path}`)
      const rows = parseJson<T[]>(res, path)
      if (!Array.isArray(rows)) throw new GitlabApiError(`GitLab ${path} did not return a list`, res.status)
      out.push(...rows)
      if (limit !== undefined && out.length >= limit) return out.slice(0, limit)
      if (rows.length === 0) break
      const next = nextQuery(res, query)
      if (next === null) break
      query = next
    }
    return limit === undefined ? out : out.slice(0, limit)
  }

  /**
   * Groups become path segments. A segment the token cannot open is marked
   * `ghost`: a group the user can name (it is in the project's full path) but
   * cannot open, because they are a member of the subgroup and not of its
   * parent. Pretending such a parent is absent re-roots the tree and makes two
   * unrelated subgroups look like siblings, so it is rendered and simply not
   * navigable.
   */
  const pathOf = (p: GlProject, groupIds: Map<string, string>): CicdPathSegment[] => {
    const full = p.namespace?.full_path ?? p.path_with_namespace?.split('/').slice(0, -1).join('/') ?? ''
    if (!full) return []
    const segments: CicdPathSegment[] = []
    const parts = full.split('/').filter(Boolean)
    let acc = ''
    for (const label of parts) {
      acc = acc ? `${acc}/${label}` : label
      const own = acc === p.namespace?.full_path && p.namespace?.id !== undefined ? String(p.namespace.id) : undefined
      const id = groupIds.get(acc) ?? own
      segments.push(id ? { id, label } : { id: '', label, ghost: true })
    }
    return segments
  }

  const toPipeline = (p: GlProject, groupIds: Map<string, string>): CicdPipeline => {
    const access = Math.max(
      p.permissions?.project_access?.access_level ?? -1,
      p.permissions?.group_access?.access_level ?? -1
    )
    return {
      connectionId: opts.connectionId,
      ref: String(p.id),
      name: p.name ?? p.path ?? String(p.id),
      groupPath: pathOf(p, groupIds),
      // Unlike GitHub there is no per-pipeline opt-in to parse; the only gate is
      // permission, and GitLab reports it when it reports it at all.
      triggerable: access < 0 ? true : access >= ACCESS_DEVELOPER
    }
  }

  const toRun = (pipelineRef: string, p: GlPipeline): CicdRun => ({
    connectionId: opts.connectionId,
    pipelineRef,
    id: String(p.id),
    // GitLab does not re-run a pipeline in place — a retry is a new pipeline
    // with a new id — so the attempt axis GitHub needs is always 1 here.
    attempt: 1,
    label: `#${p.iid ?? p.id}`,
    outcome: gitlabOutcome(p.status ?? ''),
    startedAt: ms(p.started_at) ?? ms(p.created_at),
    durationMs: spanMs(p.duration, p.started_at, p.finished_at),
    branch: p.ref,
    title: p.name ?? undefined,
    actor: p.user?.username ?? p.user?.name ?? undefined,
    webUrl: p.web_url
  })

  const jobsOf = async (pipelineRef: string, runId: string): Promise<GlJob[]> =>
    paged<GlJob>(`/projects/${enc(pipelineRef)}/pipelines/${enc(runId)}/jobs`, {})

  return {
    provider: 'gitlab',

    apiRoot(baseUrl: string): string {
      const trimmed = baseUrl.trim().replace(/\/+$/, '')
      return trimmed.endsWith('/api/v4') ? trimmed : `${trimmed}/api/v4`
    },

    capabilities(): CicdCapabilities {
      return { logMode: 'reread', triggerReturnsRun: true, resume: 'play' }
    },

    /**
     * `/user` proves the credential and names the human. `/personal_access_tokens/self`
     * is the only place the granted scopes and the expiry date appear — and GitLab
     * expiry is mandatory, so a connection that works today has a date on which it
     * stops. Surface it rather than discovering it as a 401 one morning.
     *
     * No 365-day ceiling is assumed: the maximum has been admin-configurable since
     * 17.6 and self-managed instances may issue non-expiring tokens. Whatever
     * `expires_at` says (including nothing) is the answer.
     */
    async verify() {
      const res = await get('/user')
      expectOk(res, 'GET /user')
      const user = parseJson<{ username?: string; name?: string; id?: number }>(res, '/user')
      const identity = user.username ?? user.name ?? (user.id !== undefined ? String(user.id) : 'unknown')

      // Not every credential can introspect itself (older self-managed, OAuth,
      // job tokens). That is not a failed verification — identity already proved
      // the credential works.
      const meta = await get('/personal_access_tokens/self')
      if (meta.status < 200 || meta.status >= 300) return { identity }
      let token: { scopes?: unknown; expires_at?: unknown }
      try {
        token = JSON.parse(meta.body)
      } catch {
        return { identity }
      }
      const scopes = Array.isArray(token.scopes) ? token.scopes.filter((s): s is string => typeof s === 'string') : undefined
      const expiresAt = typeof token.expires_at === 'string' ? ms(token.expires_at) : undefined
      return { identity, scopes, expiresAt }
    },

    async listPipelines(): Promise<CicdPipeline[]> {
      // Groups the token can actually open. Anything in a project's path that is
      // NOT in here is a ghost segment — see `pathOf`.
      const groupIds = new Map<string, string>()
      try {
        for (const g of await paged<GlGroup>('/groups', { all_available: 'false', order_by: 'id', sort: 'asc' })) {
          if (g.full_path) groupIds.set(g.full_path, String(g.id))
        }
      } catch {
        // A token without group visibility still lists projects fine; every
        // ancestor simply renders as a ghost.
      }

      if (opts.projectIds?.length) {
        const out: CicdPipeline[] = []
        for (const id of opts.projectIds) {
          const res = await get(`/projects/${enc(id)}`)
          expectOk(res, `GET /projects/${id}`)
          out.push(toPipeline(parseJson<GlProject>(res, 'project'), groupIds))
        }
        return out
      }

      // Keyset where it is documented: `/projects` supports it ordered by id, and
      // it is the endpoint most likely to run past the 10,000-record line where
      // offset pagination stops reporting totals.
      const projects = await paged<GlProject>('/projects', {
        membership: 'true',
        pagination: 'keyset',
        order_by: 'id',
        sort: 'asc'
      })
      return projects.map((p) => toPipeline(p, groupIds))
    },

    async listRuns(pipelineRef: string, limit: number): Promise<CicdRun[]> {
      const rows = await paged<GlPipeline>(`/projects/${enc(pipelineRef)}/pipelines`, {}, limit)
      return rows.map((p) => toRun(pipelineRef, p))
    },

    async getRun(pipelineRef: string, runId: string): Promise<{ run: CicdRun; steps: CicdStep[] }> {
      const res = await get(`/projects/${enc(pipelineRef)}/pipelines/${enc(runId)}`)
      expectOk(res, `GET pipeline ${runId}`)
      const run = toRun(pipelineRef, parseJson<GlPipeline>(res, 'pipeline'))
      const steps = (await jobsOf(pipelineRef, runId)).map((j) => ({
        name: j.name ?? String(j.id),
        outcome: gitlabOutcome(j.status ?? ''),
        durationMs: spanMs(j.duration, j.started_at, j.finished_at)
      }))
      return { run, steps }
    },

    /**
     * There is no tail here, and the mode says so.
     *
     * `/trace` serves the whole trace, every time: GitLab supports no `Range`
     * header and has no incremental log API (both are long-open feature
     * requests). So this REFETCHES everything and uses `cursor` — the byte
     * length already handed to the caller — to slice off what is new. That is a
     * client-side simulation of tailing, not a server feature, and the caller
     * pays full bandwidth for every poll.
     */
    async getLog(
      pipelineRef: string,
      runId: string,
      stepName: string | undefined,
      cursor?: string
    ): Promise<CicdLogChunk> {
      const jobs = await jobsOf(pipelineRef, runId)
      const job = stepName ? jobs.find((j) => j.name === stepName) : jobs[jobs.length - 1]
      if (!job) {
        throw new GitlabApiError(
          stepName ? `Pipeline ${runId} has no job named ${stepName}` : `Pipeline ${runId} has no jobs yet`,
          404
        )
      }
      const more = !TERMINAL.has(job.status ?? '')

      const res = await get(`/projects/${enc(pipelineRef)}/jobs/${enc(String(job.id))}/trace`, {
        Accept: 'text/plain'
      })
      // 404 is "nothing has been written yet", not a failure. Treating it as an
      // error would make the poller back off on exactly the jobs being watched.
      if (res.status === 404) return { mode: 'reread', text: '', cursor: cursor ?? '0', more }
      expectOk(res, `GET job ${job.id} trace`)

      const whole = Buffer.from(res.body, 'utf8')
      const seen = Number(cursor ?? 0)
      // A retried job can shorten the trace; a stale cursor then means "start over".
      const from = Number.isFinite(seen) && seen >= 0 && seen <= whole.length ? seen : 0
      const fresh = whole.subarray(from)
      const withheld = Math.max(fresh.length - MAX_TRACE_BYTES, 0)
      return {
        mode: 'reread',
        text: fresh.subarray(withheld).toString('utf8'),
        cursor: String(whole.length),
        more,
        ...(withheld > 0 ? { withheldBytes: withheld } : {})
      }
    },

    listParams: (pipelineRef: string): Promise<CicdParam[]> => listGitlabParams(http, pipelineRef)
  }
}

// ---------------------------------------------------------------------------
// Trigger path — deliberately not on the adapter
// ---------------------------------------------------------------------------

export interface GitlabTriggerInput {
  projectId: string
  /** Branch or tag. GitLab resolves it; a bad ref is a 400 naming the ref. */
  ref: string
  /** Free key/value. Anything not pre-defined on the project is created for this run only. */
  variables?: Record<string, string>
  /** `spec:inputs` declared by the pipeline's YAML. */
  inputs?: Record<string, unknown>
}

/**
 * The limit that actually bites, and the reason this message is specific.
 *
 * Pipeline creation is capped at 25 requests per minute per project, per user
 * AND per commit — separately from the 2,000/min global budget. An agent
 * retrying, or a user clicking Run on a template, reaches 25 long before
 * anything else. A generic "rate limited, backing off" hides which of three
 * budgets was spent and how long it takes to refill.
 */
const PIPELINE_LIMIT_NOTE =
  'GitLab caps pipeline creation at 25 per minute, counted per project, per user and per commit — separate from the 2,000/min overall limit.'

const throttleError = (res: CicdResponse, lead: string): GitlabApiError => {
  const wait = retryAfterMs(res)
  const when = wait === undefined ? 'Retry in about a minute.' : `Retry in ${Math.ceil(wait / 1000)}s.`
  return new GitlabApiError(`${lead} ${when}`, 429, wait)
}

/**
 * `POST /projects/:id/pipeline` answers `201` with the whole pipeline object, so
 * unlike Jenkins and GHES there is a real run to hand back — `run` is populated
 * and the UI can navigate straight to it.
 */
export async function triggerGitlab(http: CicdHttp, input: GitlabTriggerInput): Promise<CicdTriggerResult> {
  const body: Record<string, unknown> = { ref: input.ref }
  if (input.variables && Object.keys(input.variables).length) {
    body.variables = Object.entries(input.variables).map(([key, value]) => ({
      key,
      value,
      variable_type: 'env_var'
    }))
  }
  if (input.inputs && Object.keys(input.inputs).length) body.inputs = input.inputs

  const res = await http({
    method: 'POST',
    path: `/projects/${enc(input.projectId)}/pipeline`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

  if (res.status === 429) throw throttleError(res, `${PIPELINE_LIMIT_NOTE} ${reasonOf(res)}`.trim())
  expectOk(res, 'pipeline creation')

  const p = parseJson<GlPipeline>(res, 'pipeline')
  return {
    run: { id: String(p.id), attempt: 1 },
    ...(p.web_url ? { webUrl: p.web_url } : {}),
    note: `GitLab created pipeline #${p.iid ?? p.id} on ${input.ref}.`
  }
}

export interface GitlabPlayInput {
  projectId: string
  jobId: string
  /** Job variables, which `play` accepts as `{key, value}` rather than the trigger's shape. */
  variables?: Record<string, string>
}

/**
 * Resume a `manual` job. This is GitLab's `play` and nothing else's: GitHub's
 * `action_required` is a deployment approval on a different endpoint and Jenkins
 * has no equivalent at all.
 */
export async function playGitlabJob(http: CicdHttp, input: GitlabPlayInput): Promise<CicdStep> {
  const body =
    input.variables && Object.keys(input.variables).length
      ? JSON.stringify({ job_variables_attributes: Object.entries(input.variables).map(([key, value]) => ({ key, value })) })
      : undefined

  const res = await http({
    method: 'POST',
    path: `/projects/${enc(input.projectId)}/jobs/${enc(input.jobId)}/play`,
    headers: { 'Content-Type': 'application/json' },
    body
  })
  // Playing a job is not pipeline creation, so it is the general budget that ran
  // out here, not the 25/min one. Saying the wrong limit is worse than saying none.
  if (res.status === 429) throw throttleError(res, "GitLab's general API rate limit was reached playing this job.")
  expectOk(res, `play job ${input.jobId}`)

  const job = parseJson<GlJob>(res, 'job')
  return {
    name: job.name ?? String(job.id),
    outcome: gitlabOutcome(job.status ?? ''),
    durationMs: spanMs(job.duration, job.started_at, job.finished_at)
  }
}

/**
 * Variables a project pre-defines, as form fields.
 *
 * GitLab has no parameter schema — a pipeline accepts arbitrary key/value pairs
 * — so this is the known subset and the form stays open-ended. Reading them
 * needs Maintainer; a Developer who can trigger perfectly well gets a 403 here,
 * which means "no pre-defined list", not "no trigger".
 */
export async function listGitlabParams(http: CicdHttp, projectId: string): Promise<CicdParam[]> {
  const res = await http({ method: 'GET', path: `/projects/${enc(projectId)}/variables?per_page=${MAX_PER_PAGE}` })
  if (res.status === 403 || res.status === 404) return []
  expectOk(res, 'GET project variables')
  const rows = parseJson<{ key?: string; value?: string; masked?: boolean }[]>(res, 'variables')
  if (!Array.isArray(rows)) return []
  return rows
    .filter((v): v is { key: string; value?: string; masked?: boolean } => typeof v.key === 'string')
    .map((v) => ({
      key: v.key,
      label: v.key,
      type: v.masked ? ('password' as const) : ('string' as const),
      required: false,
      default: v.masked ? undefined : v.value
    }))
}

/**
 * Cancel a pipeline.
 *
 * GitLab answers with the pipeline, whose status is then `canceling` — a
 * transient that `gitlabOutcome` folds into `canceled`. The note says
 * "cancelling" rather than "cancelled" because that is what the status
 * actually means until the runners notice.
 */
export async function cancelGitlab(
  http: CicdHttp,
  input: { projectId: string; pipelineId: string }
): Promise<CicdTriggerResult> {
  const res = await http({
    method: 'POST',
    path: `/projects/${encodeURIComponent(input.projectId)}/pipelines/${encodeURIComponent(input.pipelineId)}/cancel`
  })
  expectOk(res, 'pipeline cancellation')
  const p = parseJson<{ id?: unknown; web_url?: unknown }>(res, 'pipeline')
  return {
    run: { id: String(p.id ?? input.pipelineId), attempt: 1 },
    ...(typeof p.web_url === 'string' ? { webUrl: p.web_url } : {}),
    note: 'GitLab is cancelling the pipeline. Jobs already running stop when their runner notices.'
  }
}
