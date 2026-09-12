// GitHub Actions, read path plus the two writes that are deliberately not on
// `CicdAdapter` (see the header of `src/shared/cicd.ts` for why triggering is
// three named functions instead of an interface member).
//
// The four things this file exists to get right, all of which a straightforward
// reading of the API docs gets wrong:
//
//  1. `apiRoot` branches on HOST, not path. github.com is `api.github.com`;
//     GitHub Enterprise Server is `https://HOSTNAME/api/v3`. Every other
//     provider appends a path, so the one shared URL builder is the bug.
//  2. A job's log endpoint 302s to a signed blob that lives for one minute and
//     REJECTS an `Authorization` header — hence `followRedirect`, which drops
//     credentials on origin change. The redirect target is never cached.
//     An in-progress job 404s there (a recent unannounced regression; the API
//     used to hand back partials). That 404 is an expected state, not a failing
//     endpoint, or §7's backoff quietly stops polling every running build.
//  3. Nothing in the API says whether a workflow accepts `workflow_dispatch`.
//     It takes fetching and scanning the YAML, so it is cached per workflow
//     revision rather than paid on every poll.
//  4. A re-run REUSES the run id and bumps `run_attempt`. Runs are keyed on the
//     pair.
//
// NOT IMPLEMENTED ON PURPOSE: `repository_dispatch`. The plan cut it, and it is
// not an oversight to fix — it is gated by **Contents: Write**, not Actions, so
// a token scoped for CI 403s on it, and it answers `204` with no guarantee that
// anything matched. Adding it means asking users for a write scope on their
// source, for a trigger that cannot report what it started.
//
// Scopes: fine-grained PAT, `Actions: Read` for runs and logs, `Actions: Write`
// for dispatch and re-run. `Metadata: Read` is NOT required for these endpoints
// and its absence must never fail validation.

import { remoteText } from '../../../shared/remoteText'
import {
  githubOutcome,
  type CicdAdapter,
  type CicdCapabilities,
  type CicdHttp,
  type CicdLogChunk,
  type CicdParam,
  type CicdPipeline,
  type CicdResponse,
  type CicdRun,
  type CicdStep,
  type CicdTriggerResult
} from '../../../shared/cicd'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GithubOptions {
  connectionId: string
  /** As the user typed it — the web URL. `apiRoot()` derives the rest. */
  baseUrl: string
  /**
   * `owner/repo` handles to scan, in order.
   *
   * Empty means "whatever the token can see", via `/user/repos`. Discovery is a
   * join and not a tree walk: GitHub has no endpoint that hands back workflows
   * across repos, so it is list-repos then list-workflows-per-repo, serially,
   * because the secondary rate limit (900 points/min, ≤100 concurrent) bites
   * long before the 5,000/hr primary one does.
   */
  repos?: string[]
  /** How many repos discovery will walk before stopping. */
  maxRepos?: number
  /**
   * Declared `workflow_dispatch` input used to correlate a GHES dispatch back
   * to its run. Only injected when the workflow actually declares it — an
   * undeclared input is a 422, which would break the dispatch we are trying to
   * track.
   */
  correlationInput?: string
  /** Cap on one log fetch. The tail is kept; the head is what gets withheld. */
  maxLogBytes?: number
}

const DEFAULT_MAX_LOG_BYTES = 512 * 1024
const DEFAULT_CORRELATION_INPUT = 'opsmaxx_correlation'

// ---------------------------------------------------------------------------
// JSON without `any`
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>

const obj = (v: unknown): Json => (v !== null && typeof v === 'object' ? (v as Json) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown
  } catch {
    return {}
  }
}

/** Epoch ms from an ISO timestamp, or undefined. GitHub reports ISO everywhere. */
function at(v: unknown): number | undefined {
  const s = str(v)
  if (!s) return undefined
  const t = Date.parse(s)
  return Number.isNaN(t) ? undefined : t
}

function header(res: CicdResponse, name: string): string | undefined {
  const want = name.toLowerCase()
  for (const [k, v] of Object.entries(res.headers ?? {})) {
    if (k.toLowerCase() === want) return v
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Host, not path
// ---------------------------------------------------------------------------

/** True for github.com (and the API host itself). Everything else is GHES. */
export function isGithubCloud(baseUrl: string): boolean {
  const host = hostOf(baseUrl)
  return host === 'github.com' || host === 'www.github.com' || host === 'api.github.com'
}

function hostOf(baseUrl: string): string {
  const raw = baseUrl.trim()
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    return new URL(withScheme).host.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * github.com lives on a DIFFERENT HOST; GHES appends a path to the one the user
 * typed. This is the branch the plan says one URL builder always gets wrong.
 */
export function githubApiRoot(baseUrl: string): string {
  const raw = baseUrl.trim()
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return 'https://api.github.com'
  }
  if (isGithubCloud(baseUrl)) return 'https://api.github.com'
  // GHES serves the API at the instance root regardless of where the user was
  // browsing when they copied the URL, so the path is discarded rather than
  // appended to.
  return `${url.protocol}//${url.host}/api/v3`
}

// ---------------------------------------------------------------------------
// Pipeline refs
// ---------------------------------------------------------------------------

/**
 * `owner/repo#.github/workflows/ci.yml`.
 *
 * Opaque to the UI, and it carries the FILE PATH rather than the numeric
 * workflow id: dispatching by filename survives someone editing the workflow,
 * where the numeric id does not always.
 */
interface WorkflowRef {
  owner: string
  repo: string
  path: string
  /** `ci.yml` — what `dispatches` is addressed by. */
  file: string
}

export function parsePipelineRef(ref: string): WorkflowRef {
  const hash = ref.indexOf('#')
  const slug = hash < 0 ? ref : ref.slice(0, hash)
  const path = hash < 0 ? '' : ref.slice(hash + 1)
  const slash = slug.indexOf('/')
  if (slash < 0) throw new Error(`not a GitHub pipeline reference: ${ref}`)
  return {
    owner: slug.slice(0, slash),
    repo: slug.slice(slash + 1),
    path,
    file: path.slice(path.lastIndexOf('/') + 1)
  }
}

const pipelineRef = (owner: string, repo: string, path: string): string =>
  `${owner}/${repo}#${path}`

// ---------------------------------------------------------------------------
// The workflow file scan
// ---------------------------------------------------------------------------

/**
 * What a workflow's YAML says about being started by hand.
 *
 * There is no API field for this. `workflow_dispatch` 422s unless the file
 * declares it, and a Run button that fails on half the workflows is worse than
 * one that is honestly absent — so `declared: false` is what we report whenever
 * we could not read or make sense of the file.
 */
export interface WorkflowDispatchSpec {
  declared: boolean
  inputs: CicdParam[]
}

const NOT_DECLARED: WorkflowDispatchSpec = { declared: false, inputs: [] }

interface YNode {
  key: string
  value: string
  children: YNode[]
}

function unquote(s: string): string {
  const t = s.trim()
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    return t.slice(1, -1)
  }
  return t
}

/** Drop an unquoted trailing comment. Enough for a workflow file. */
function stripComment(line: string): string {
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

const indentOf = (line: string): number => line.length - line.trimStart().length

/**
 * A block-mapping reader, not a YAML parser.
 *
 * `js-yaml` is a devDependency (`compose.ts:683` makes the same point), and the
 * question being asked here is narrow enough not to need one: which top-level
 * triggers are declared, and what inputs sit under `workflow_dispatch`. Shapes
 * it does not understand produce no node, which lands on `declared: false` —
 * the safe answer.
 */
function parseBlock(lines: string[], from: number, to: number): YNode[] {
  const out: YNode[] = []
  let i = from
  let base = -1
  while (i < to) {
    const line = stripComment(lines[i])
    if (!line.trim()) {
      i++
      continue
    }
    const ind = indentOf(line)
    if (base < 0) base = ind
    if (ind < base) break
    if (ind > base) {
      i++
      continue
    }
    // Where this node's children end: the next line at or left of our indent.
    let end = i + 1
    while (end < to) {
      const next = stripComment(lines[end])
      if (next.trim() && indentOf(next) <= base) break
      end++
    }
    const kv = /^\s*([^:#]+?)\s*:\s*(.*)$/.exec(line)
    if (kv) {
      out.push({ key: unquote(kv[1]), value: kv[2].trim(), children: parseBlock(lines, i + 1, end) })
    } else {
      const item = /^\s*-\s*(.*)$/.exec(line)
      if (item) out.push({ key: '-', value: item[1].trim(), children: [] })
    }
    i = end
  }
  return out
}

const find = (nodes: YNode[], key: string): YNode | undefined => nodes.find((n) => n.key === key)

/** `[a, b]` or `- a` children, unquoted. */
function seq(node: YNode | undefined): string[] {
  if (!node) return []
  const flow = node.value.trim()
  if (flow.startsWith('[') && flow.endsWith(']')) {
    return flow
      .slice(1, -1)
      .split(',')
      .map((p) => unquote(p))
      .filter((p) => p.length > 0)
  }
  return node.children.filter((c) => c.key === '-').map((c) => unquote(c.value))
}

function paramOf(node: YNode): CicdParam {
  const type = unquote(find(node.children, 'type')?.value ?? '')
  const choices = seq(find(node.children, 'options'))
  const declared = find(node.children, 'default')?.value
  return {
    key: node.key,
    label: unquote(find(node.children, 'description')?.value ?? '') || node.key,
    // GitHub's set is string | boolean | choice | number | environment. There
    // is no secret input type, so `password` never appears from this provider.
    type: type === 'boolean' ? 'boolean' : type === 'choice' ? 'choice' : 'string',
    required: unquote(find(node.children, 'required')?.value ?? '') === 'true',
    ...(declared !== undefined && declared !== '' ? { default: unquote(declared) } : {}),
    ...(choices.length ? { choices } : {})
  }
}

export function parseWorkflowDispatch(yaml: string): WorkflowDispatchSpec {
  const lines = yaml.split(/\r?\n/)
  // Tabs are not legal YAML indentation; if one is in play we are guessing.
  if (lines.some((l) => /^\t/.test(l))) return NOT_DECLARED
  const top = parseBlock(lines, 0, lines.length)
  // `on` is a YAML 1.1 boolean, so it is frequently written `"on":`. `unquote`
  // has already flattened both spellings by here.
  const on = find(top, 'on')
  if (!on) return NOT_DECLARED

  const inline = on.value.trim()
  if (inline) {
    // `on: workflow_dispatch`, `on: [push, workflow_dispatch]`, or a flow map.
    const listed = inline.startsWith('[')
      ? seq(on)
      : inline.startsWith('{')
        ? inline
            .slice(1, -1)
            .split(',')
            .map((p) => unquote(p.split(':')[0]))
        : [unquote(inline)]
    // A flow form carries no readable inputs block; declared with no inputs is
    // still correct — dispatching a workflow whose inputs we missed sends none,
    // and GitHub applies its own defaults.
    return listed.includes('workflow_dispatch') ? { declared: true, inputs: [] } : NOT_DECLARED
  }

  const dispatch = find(on.children, 'workflow_dispatch')
  if (!dispatch) return NOT_DECLARED
  const inputs = find(dispatch.children, 'inputs')
  return { declared: true, inputs: (inputs?.children ?? []).map(paramOf) }
}

// ---------------------------------------------------------------------------
// Shared request helpers
// ---------------------------------------------------------------------------

const ACCEPT = 'application/vnd.github+json'
const API_VERSION = '2022-11-28'

const baseHeaders = (): Record<string, string> => ({
  Accept: ACCEPT,
  'X-GitHub-Api-Version': API_VERSION
})

// Remote response text goes through `remoteText` before it reaches an Error.
// A CI server's error body is not ours: a self-hosted instance (or anything
// answering in front of one) chooses it, and these messages surface in the UI,
// in a failed-trigger note, and in MCP tool results. `remoteText` flattens
// newlines and strips C0/C1, bidi overrides and zero-width characters, so a
// crafted `message` cannot reverse the sentence it lands in or forge a line
// break into something that reads as OpsMaxx's own words.
function fail(what: string, res: CicdResponse): Error {
  const raw = str(obj(parseJson(res.body)).message) ?? res.body
  const message = remoteText(raw, 200)
  return new Error(`GitHub ${what} failed (${res.status})${message ? `: ${message}` : ''}`)
}

// ---------------------------------------------------------------------------
// Run and step mapping
// ---------------------------------------------------------------------------

function runOf(connectionId: string, ref: string, raw: Json): CicdRun {
  const started = at(raw.run_started_at) ?? at(raw.created_at)
  const ended = str(raw.status) === 'completed' ? at(raw.updated_at) : undefined
  const commitTitle = str(obj(raw.head_commit).message)?.split('\n')[0]
  return {
    connectionId,
    pipelineRef: ref,
    id: String(num(raw.id) ?? str(raw.id) ?? ''),
    // A re-run reuses the id, so the attempt is half the key. Absent on GHES
    // versions that predate attempts, where 1 is the only value there is.
    attempt: num(raw.run_attempt) ?? 1,
    label: `#${num(raw.run_number) ?? ''}`,
    outcome: githubOutcome(str(raw.status) ?? '', str(raw.conclusion) ?? null),
    ...(started !== undefined ? { startedAt: started } : {}),
    ...(started !== undefined && ended !== undefined ? { durationMs: Math.max(0, ended - started) } : {}),
    ...(str(raw.head_branch) ? { branch: str(raw.head_branch) } : {}),
    // Attacker-authored: `display_title` is a PR title. Display text only;
    // `remoteName` is applied before this reaches an approval or a tool result.
    ...(str(raw.display_title) ?? commitTitle ? { title: str(raw.display_title) ?? commitTitle } : {}),
    ...(str(obj(raw.actor).login) ? { actor: str(obj(raw.actor).login) } : {}),
    ...(str(raw.html_url) ? { webUrl: str(raw.html_url) } : {})
  }
}

const JOB_STEP_SEP = ' / '

function stepsOf(jobs: Json[]): CicdStep[] {
  const out: CicdStep[] = []
  for (const job of jobs) {
    const jobName = str(job.name) ?? 'job'
    const steps = arr(job.steps).map(obj)
    if (steps.length === 0) {
      // A job that has not started yet has no steps. So does a whole run that
      // never started — see `startup_failure`, which reports ZERO jobs and
      // reaches here as an empty list rather than an error.
      const started = at(job.started_at)
      const ended = at(job.completed_at)
      out.push({
        name: jobName,
        outcome: githubOutcome(str(job.status) ?? '', str(job.conclusion) ?? null),
        ...(started !== undefined && ended !== undefined ? { durationMs: Math.max(0, ended - started) } : {})
      })
      continue
    }
    for (const step of steps) {
      const started = at(step.started_at)
      const ended = at(step.completed_at)
      out.push({
        // Prefixed with the job, because the log endpoint is addressed by JOB
        // and `getLog` has to be able to get back from a step name to one.
        name: `${jobName}${JOB_STEP_SEP}${str(step.name) ?? ''}`,
        outcome: githubOutcome(str(step.status) ?? '', str(step.conclusion) ?? null),
        ...(started !== undefined && ended !== undefined ? { durationMs: Math.max(0, ended - started) } : {})
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface GithubAdapter extends CicdAdapter {
  /**
   * Request path → ETag.
   *
   * GitHub is the only one of the three where a conditional request is free: a
   * 304 does not count against the rate limit. That only holds if the cache key
   * is a STABLE query string, so nothing here interpolates a clock — a loop
   * that varies `created=>{now}` every tick never sees a 304. Exposed so the
   * poller can see which of its queries are actually conditional.
   */
  readonly etags: ReadonlyMap<string, string>
  /** Cached YAML scan. `listPipelines` uses it; the trigger form needs its inputs. */
  dispatchSpec(ref: string): Promise<WorkflowDispatchSpec>
}

export function createGithubAdapter(http: CicdHttp, opts: GithubOptions): GithubAdapter {
  const cloud = isGithubCloud(opts.baseUrl)
  const etags = new Map<string, string>()
  const conditional = new Map<string, unknown>()
  /** ref + workflow revision → scan. Keyed on the revision so an edit re-reads. */
  const dispatchCache = new Map<string, WorkflowDispatchSpec>()

  /** A GET whose response we are willing to re-serve on a 304. */
  async function getCached(path: string, what: string): Promise<unknown> {
    const known = etags.get(path)
    const res = await http({
      method: 'GET',
      path,
      headers: { ...baseHeaders(), ...(known ? { 'If-None-Match': known } : {}) }
    })
    if (res.status === 304 && conditional.has(path)) return conditional.get(path)
    if (res.status < 200 || res.status >= 300) throw fail(what, res)
    const tag = header(res, 'etag')
    const data = parseJson(res.body)
    if (tag) {
      etags.set(path, tag)
      conditional.set(path, data)
    }
    return data
  }

  async function get(path: string, what: string): Promise<unknown> {
    const res = await http({ method: 'GET', path, headers: baseHeaders() })
    if (res.status < 200 || res.status >= 300) throw fail(what, res)
    return parseJson(res.body)
  }

  /** Serial, never `Promise.all`: concurrency trips a secondary limit first. */
  async function listRepos(): Promise<Array<{ owner: string; repo: string }>> {
    const cap = opts.maxRepos ?? 200
    if (opts.repos?.length) {
      return opts.repos.slice(0, cap).map((slug) => {
        const cut = slug.indexOf('/')
        return { owner: slug.slice(0, cut), repo: slug.slice(cut + 1) }
      })
    }
    const out: Array<{ owner: string; repo: string }> = []
    for (let page = 1; out.length < cap && page <= 10; page++) {
      const data = arr(await getCached(`/user/repos?per_page=100&page=${page}&sort=full_name`, 'repo list'))
      for (const entry of data.map(obj)) {
        const owner = str(obj(entry.owner).login)
        const repo = str(entry.name)
        if (owner && repo) out.push({ owner, repo })
      }
      if (data.length < 100) break
    }
    return out.slice(0, cap)
  }

  async function dispatchSpec(ref: string, revision?: string): Promise<WorkflowDispatchSpec> {
    const key = `${ref}@${revision ?? ''}`
    const hit = dispatchCache.get(key)
    if (hit) return hit
    const { owner, repo, path } = parsePipelineRef(ref)
    let spec = NOT_DECLARED
    try {
      const res = await http({
        method: 'GET',
        path: `/repos/${owner}/${repo}/contents/${path}`,
        // `.raw` avoids base64 and the JSON envelope; the file is text.
        headers: { ...baseHeaders(), Accept: 'application/vnd.github.raw+json' }
      })
      if (res.status >= 200 && res.status < 300) spec = parseWorkflowDispatch(res.body)
    } catch {
      // Unreadable file, no Contents permission, a shape this scanner does not
      // understand: all of them mean we do not know, and `false` is the safe
      // answer to "should there be a Run button".
      spec = NOT_DECLARED
    }
    dispatchCache.set(key, spec)
    return spec
  }

  async function jobsOf(ref: string, runId: string, attempt: number): Promise<Json[]> {
    const { owner, repo } = parsePipelineRef(ref)
    const data = obj(
      await get(
        `/repos/${owner}/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
        'job list'
      )
    )
    return arr(data.jobs).map(obj)
  }

  return {
    provider: 'github',
    etags,
    apiRoot: githubApiRoot,

    capabilities(): CicdCapabilities {
      return {
        logMode: 'snapshot',
        // `return_run_details` shipped 2026-02-19 on github.com only; GHES 3.19
        // still documents a bare 204, so Enterprise honestly reports false and
        // the UI renders REQUESTED rather than a fabricated run number.
        triggerReturnsRun: cloud,
        resume: 'approve'
      }
    },

    async verify() {
      // `GET /user` returns 200 for a fine-grained PAT with ZERO repository
      // permissions. It proves the token is live and says who it is; it proves
      // NOTHING about Actions, so it cannot be the only probe.
      const res = await http({ method: 'GET', path: '/user', headers: baseHeaders() })
      if (res.status < 200 || res.status >= 300) throw fail('sign-in', res)
      const me = obj(parseJson(res.body))
      const identity = str(me.login) ?? str(me.name) ?? 'unknown'
      // Classic tokens list scopes here; fine-grained ones send an empty header
      // or none at all, which is not a failure.
      const scopes = (header(res, 'x-oauth-scopes') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      const expiresAt = at(header(res, 'github-authentication-token-expiration'))

      // The probe that actually answers the question the user asked. Note it
      // does NOT require `Metadata: Read` — absence of that permission is not
      // an error and must not fail this.
      const [first] = await listRepos()
      if (first) {
        const probe = await http({
          method: 'GET',
          path: `/repos/${first.owner}/${first.repo}/actions/runs?per_page=1&exclude_pull_requests=true`,
          headers: baseHeaders()
        })
        if (probe.status === 403 || probe.status === 404) {
          throw new Error(
            `Signed in as ${identity}, but this token cannot read Actions on ${first.owner}/${first.repo}. ` +
              'A fine-grained token needs the "Actions" repository permission set to Read.'
          )
        }
        if (probe.status < 200 || probe.status >= 300) throw fail('Actions check', probe)
      }
      return {
        identity,
        ...(scopes.length ? { scopes } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {})
      }
    },

    dispatchSpec: (ref: string) => dispatchSpec(ref),

    /** Just the inputs; whether dispatch is declared at all is `dispatchSpec`'s question. */
    listParams: async (ref: string): Promise<CicdParam[]> => (await dispatchSpec(ref)).inputs,

    async listPipelines(): Promise<CicdPipeline[]> {
      const out: CicdPipeline[] = []
      for (const { owner, repo } of await listRepos()) {
        let data: Json
        try {
          data = obj(await getCached(`/repos/${owner}/${repo}/actions/workflows?per_page=100`, 'workflow list'))
        } catch {
          // One repo the token cannot see must not empty the sidebar.
          continue
        }
        for (const wf of arr(data.workflows).map(obj)) {
          const path = str(wf.path)
          if (!path) continue
          const ref = pipelineRef(owner, repo, path)
          // A disabled workflow cannot be dispatched whatever its YAML says,
          // so it costs no contents request at all.
          const active = (str(wf.state) ?? 'active') === 'active'
          const spec = active ? await dispatchSpec(ref, str(wf.updated_at)) : NOT_DECLARED
          out.push({
            connectionId: opts.connectionId,
            ref,
            name: str(wf.name) ?? path,
            // GitHub is exactly org/repo. No tree API, no arbitrary depth.
            groupPath: [
              { id: owner, label: owner },
              { id: `${owner}/${repo}`, label: repo }
            ],
            triggerable: spec.declared
          })
        }
      }
      return out
    },

    async listRuns(ref: string, limit: number): Promise<CicdRun[]> {
      const { owner, repo, file } = parsePipelineRef(ref)
      const perPage = Math.min(Math.max(Math.trunc(limit) || 1, 1), 100)
      // `exclude_pull_requests=true` is the real payload cut here — the
      // `pull_requests` array is routinely most of the object. The query string
      // is fixed for a given (pipeline, limit), which is what makes the ETag
      // above worth having.
      const data = obj(
        await getCached(
          `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(file)}/runs` +
            `?per_page=${perPage}&exclude_pull_requests=true`,
          'run list'
        )
      )
      return arr(data.workflow_runs)
        .map(obj)
        .map((raw) => runOf(opts.connectionId, ref, raw))
    },

    async getRun(ref: string, runId: string, attempt: number) {
      const { owner, repo } = parsePipelineRef(ref)
      const raw = obj(
        await get(
          `/repos/${owner}/${repo}/actions/runs/${runId}/attempts/${attempt}?exclude_pull_requests=true`,
          'run'
        )
      )
      const run = runOf(opts.connectionId, ref, raw)
      // A `startup_failure` run has zero jobs. An empty list is data, not a
      // reason to throw, and the run's own outcome still says `failed`.
      const steps = stepsOf(await jobsOf(ref, runId, attempt))
      return { run, steps }
    },

    /** The log endpoint is addressed by owner/repo, which `ref` carries. */
    async getLog(
      ref: string,
      runId: string,
      stepName?: string,
      cursor?: string
    ): Promise<CicdLogChunk> {
      const { owner, repo } = parsePipelineRef(ref)

      const listed = obj(await get(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100`, 'job list'))
      const jobs = arr(listed.jobs).map(obj)
      // A step name is `job / step`; the log is published per JOB.
      const wantedJob = stepName ? stepName.split(JOB_STEP_SEP)[0] : undefined
      const job = wantedJob ? jobs.find((j) => str(j.name) === wantedJob) : jobs[0]
      if (!job) {
        // No jobs at all — a `startup_failure`, most often. Not an error, and
        // not a log that is on its way either.
        return { mode: 'snapshot', text: '', more: false }
      }
      const jobId = num(job.id) ?? str(job.id)
      const done = str(job.status) === 'completed'

      const res = await http({
        method: 'GET',
        path: `/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`,
        headers: baseHeaders(),
        // The 302 goes to a signed blob on another origin that expires in one
        // minute and 401s if an Authorization header is present. This option
        // exists for exactly this; the target is fetched now and never stored.
        followRedirect: true
      })

      if (res.status === 404) {
        // EXPECTED. A job that is still running has no log yet — the endpoint
        // 404s rather than returning partials, and treating that as a failing
        // endpoint makes the poller back off every running build in the estate.
        return { mode: 'pending', text: '', more: true }
      }
      if (res.status < 200 || res.status >= 300) throw fail('log fetch', res)

      const whole = res.body
      const from = cursor ? Number(cursor) : 0
      const resumed = Number.isFinite(from) && from > 0 && from <= whole.length ? whole.slice(from) : whole
      const cap = opts.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES
      // Keep the tail: the end of a failing build is what anybody is looking
      // for. This bounds tokens, not risk — see §9.4.
      const text = resumed.length > cap ? resumed.slice(resumed.length - cap) : resumed
      const withheld = resumed.length - text.length
      return {
        mode: 'snapshot',
        text,
        cursor: String(whole.length),
        // A completed job's log is final. There is no streaming API and none is
        // coming, so "more" only ever means "ask again later".
        more: !done,
        ...(withheld > 0 ? { withheldBytes: withheld } : {})
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Writes — deliberately not on the adapter
// ---------------------------------------------------------------------------

export interface GithubTriggerRequest {
  pipelineRef: string
  /** Branch or tag. `workflow_dispatch` requires one. */
  ref: string
  inputs?: Record<string, string>
}

/**
 * `POST .../workflows/{file}/dispatches`.
 *
 * Addressed by FILENAME rather than numeric id, which survives the workflow
 * being edited. On github.com `return_run_details: true` turns the bare 204
 * into a 200 carrying `workflow_run_id`. GHES has no such parameter, so it gets
 * the one fallback path that exists: query recent dispatch runs and correlate.
 */
export async function triggerGithub(
  http: CicdHttp,
  opts: GithubOptions,
  req: GithubTriggerRequest
): Promise<CicdTriggerResult> {
  const { owner, repo, file } = parsePipelineRef(req.pipelineRef)
  const cloud = isGithubCloud(opts.baseUrl)
  const correlationKey = opts.correlationInput ?? DEFAULT_CORRELATION_INPUT
  const inputs: Record<string, string> = { ...(req.inputs ?? {}) }

  // Correlation is only possible where the workflow declares somewhere to put
  // it: an input GitHub has never heard of is a 422, which would break the very
  // dispatch we are trying to follow.
  const correlation = !cloud && correlationKey in inputs ? inputs[correlationKey] : undefined

  const body: Json = { ref: req.ref }
  if (Object.keys(inputs).length) body.inputs = inputs
  if (cloud) body.return_run_details = true

  const res = await http({
    method: 'POST',
    path: `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(file)}/dispatches`,
    headers: { ...baseHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (res.status < 200 || res.status >= 300) throw fail('dispatch', res)

  if (res.status === 200) {
    const data = obj(parseJson(res.body))
    const id = num(data.workflow_run_id) ?? str(data.workflow_run_id)
    if (id !== undefined && id !== '') {
      const webUrl = str(data.html_url)
      return {
        run: { id: String(id), attempt: 1 },
        ...(webUrl ? { webUrl } : {}),
        note: `Started run ${id}.`
      }
    }
  }

  if (cloud) {
    // A 204 here means the instance predates `return_run_details`. The polling
    // fallback below is Enterprise-only dead code on github.com and must not be
    // reached from it — say REQUESTED instead of inventing a run.
    return { note: 'GitHub accepted the dispatch. The run will appear in the list shortly.' }
  }

  // GHES: one correlation attempt, no sleeping. The caller's poller is already
  // asking again in a few seconds and is the right place to keep trying.
  // ponytail: single attempt; add a bounded retry if users report it missing
  // the run on slow instances.
  const since = new Date(Date.now() - 60_000).toISOString().slice(0, 19) + 'Z'
  let candidates: Json[] = []
  try {
    const listed = await http({
      method: 'GET',
      path:
        `/repos/${owner}/${repo}/actions/runs` +
        `?event=workflow_dispatch&exclude_pull_requests=true&per_page=20` +
        `&branch=${encodeURIComponent(req.ref)}&created=%3E${encodeURIComponent(since)}`,
      headers: baseHeaders()
    })
    if (listed.status >= 200 && listed.status < 300) {
      candidates = arr(obj(parseJson(listed.body)).workflow_runs).map(obj)
    }
  } catch {
    candidates = []
  }

  const matched = correlation
    ? candidates.find((r) => (str(r.display_title) ?? '').includes(correlation))
    : candidates[0]
  const id = matched ? (num(matched.id) ?? str(matched.id)) : undefined
  if (id !== undefined && id !== '') {
    return {
      run: { id: String(id), attempt: num(matched?.run_attempt) ?? 1 },
      // The matched run carries its own link, and it is the most useful thing
      // to offer on the one path where we are least sure we found the right
      // run: the operator can check.
      ...(str(matched?.html_url) ? { webUrl: str(matched?.html_url) } : {}),
      note: correlation
        ? `Started run ${id}.`
        : `Started run ${id} — matched by time and branch, so it could be another dispatch if two landed together.`
    }
  }
  return {
    note:
      'GitHub Enterprise accepted the dispatch but does not return the run it created. ' +
      'The run will appear in the list shortly.'
  }
}

export interface GithubRerunRequest {
  pipelineRef: string
  runId: string
  /** Re-run only the jobs that failed, rather than the whole run. */
  failedOnly?: boolean
}

/**
 * A re-run REUSES the run id and bumps `run_attempt` — it creates no new run,
 * which is the whole reason `CicdRun` is keyed on the pair. The POST answers
 * `201` with an empty body, so the new attempt number is read back rather than
 * assumed.
 */
export async function rerunGithub(
  http: CicdHttp,
  _opts: GithubOptions,
  req: GithubRerunRequest
): Promise<CicdTriggerResult> {
  const { owner, repo } = parsePipelineRef(req.pipelineRef)
  const endpoint = req.failedOnly ? 'rerun-failed-jobs' : 'rerun'
  const res = await http({
    method: 'POST',
    path: `/repos/${owner}/${repo}/actions/runs/${req.runId}/${endpoint}`,
    headers: { ...baseHeaders(), 'Content-Type': 'application/json' },
    body: '{}'
  })
  if (res.status < 200 || res.status >= 300) throw fail('re-run', res)

  const read = await http({
    method: 'GET',
    path: `/repos/${owner}/${repo}/actions/runs/${req.runId}?exclude_pull_requests=true`,
    headers: baseHeaders()
  })
  if (read.status < 200 || read.status >= 300) {
    return { note: `GitHub started a new attempt of run ${req.runId}.` }
  }
  const attempt = num(obj(parseJson(read.body)).run_attempt) ?? 1
  return {
    run: { id: req.runId, attempt },
    note: `Re-running ${req.runId} as attempt ${attempt}.`
  }
}

/**
 * Cancel a workflow run.
 *
 * Answers `202 Accepted` — GitHub has taken the request, not finished acting on
 * it. The run keeps its id and its attempt; cancelling does not create a new
 * one, which is why this reports the id it was given rather than reading one
 * back.
 */
export async function cancelGithub(
  http: CicdHttp,
  opts: GithubOptions,
  input: { pipelineRef: string; runId: string }
): Promise<CicdTriggerResult> {
  const { owner, repo } = parsePipelineRef(input.pipelineRef)
  const res = await http({
    method: 'POST',
    path: `/repos/${owner}/${repo}/actions/runs/${encodeURIComponent(input.runId)}/cancel`,
    headers: baseHeaders()
  })
  // 409 is "already finished", which is not a failure of the request.
  if (res.status === 409) {
    return {
      run: { id: input.runId, attempt: 1 },
      note: 'That run had already finished, so there was nothing to cancel.'
    }
  }
  if (res.status < 200 || res.status >= 300) throw fail('cancelling a run', res)
  void opts
  return {
    run: { id: input.runId, attempt: 1 },
    note: 'GitHub accepted the cancellation. Jobs stop as their runners notice.'
  }
}
