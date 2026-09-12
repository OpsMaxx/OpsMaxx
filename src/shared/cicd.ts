// CI/CD: what a connection, a pipeline and a run are, and what a status means.
//
// Pure. The transport is `httpRequest`, which already knows about private CAs,
// SSH chains and VPN forwards; the credential comes from `credentialResolver`
// in main. This file decides only what the three providers have in common —
// and, just as importantly, where they do not.
//
// ---------------------------------------------------------------------------
// WHY THE READ PATH IS AN INTERFACE AND THE TRIGGER PATH IS NOT
// ---------------------------------------------------------------------------
//
// Listing pipelines, listing runs and fetching a log are the same question
// asked three ways, so they get one interface. Starting a build is not: Jenkins
// returns a queue item that may never become a build, GitLab returns the
// pipeline, GitHub returns the run id only if asked and only on github.com.
// Jenkins has no `manual` state at all; GitLab's `manual` is a job you play and
// GitHub's `action_required` is a run you approve through a different endpoint.
// A single "resume" is not implementable, and an interface whose capability
// flags outnumber its members has stopped being an abstraction.
//
// So `CicdAdapter` covers reads. Triggering is three named functions with three
// confirm UIs, sharing exactly one thing: the approval and audit call site.

/** Providers this module speaks. Adding a fourth is a new adapter, not a flag. */
export type CicdProvider = 'jenkins' | 'gitlab' | 'github'

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

/**
 * Where a connection's requests leave from.
 *
 * `direct` covers SaaS and anything already reachable — including a host behind
 * a local tunnel the user opened themselves, which is just `127.0.0.1:<port>`
 * and needs nothing from this module.
 *
 * `server` routes through a saved server's SSH connection, which resolves the
 * hostname on the FAR end. That is what reaches a Jenkins on a private DNS name
 * or bound to a bastion's loopback, and it carries an optional VPN profile with
 * it — `acquire()` already handles the whole chain.
 *
 * `vpn` is the case with no server in front: a GitLab on a VPN subnet. Userspace
 * VPN mode changes no route table, so a direct request does not traverse it.
 */
export type CicdRoute =
  | { kind: 'direct' }
  | { kind: 'server'; serverId: string }
  | { kind: 'vpn'; vpnProfileId: string }

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/**
 * A saved CI/CD account.
 *
 * Workspace-scoped, not server-scoped: a connection is its own entity and does
 * not require an SSH server to exist. `github.com` has no server to attach to.
 *
 * NO SECRET LIVES HERE. `vaultEntryId` is a pointer; main merges the token at
 * request time through `credentialResolver`, exactly as SSH and databases do.
 * This record is persisted into `opsmaxx-data.json`, which SECURITY.md
 * documents as plaintext containing no credentials, and that has to stay true.
 */
export interface CicdConnection {
  id: string
  workspaceId: string
  /** What the user calls it. The only identifier an AI agent ever sees. */
  name: string
  provider: CicdProvider
  /**
   * As the user typed it — the web URL, not the API root.
   *
   * The API path is derived, because the three shapes are genuinely different:
   * GitLab appends `/api/v4`, GitHub Enterprise appends `/api/v3` while
   * github.com uses a different HOST (`api.github.com`), and Jenkins sits at
   * whatever context path its admin chose. Asking the user for an API root
   * means asking them to know this.
   */
  baseUrl: string
  /** Jenkins authenticates as a user; the other two carry identity in the token. */
  username?: string
  /** Pointer into the vault. Never a token. */
  vaultEntryId: string
  route: CicdRoute
  /** PEM for an internal CA. The alternative is `insecureTls`, which is worse. */
  caPem?: string
  /** Skip TLS verification. Never implicit; the UI must show it whenever set. */
  insecureTls?: boolean
  enabled: boolean
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

/**
 * One level of nesting above a pipeline.
 *
 * Jenkins has folders at arbitrary depth, GitLab has groups and subgroups,
 * GitHub has exactly org/repo. Rather than model three hierarchies, a pipeline
 * carries the path it was found at, and the sidebar groups by prefix.
 *
 * This is display and search only. It is deliberately NOT a fetch tree: the
 * three providers traverse incompatibly (Jenkins recurses per folder, GitLab
 * paginates groups, GitHub has no tree API at all and needs a repos-then-
 * workflows join), and one lazy loader over three traversals is a week of bugs.
 */
export interface CicdPathSegment {
  /** Opaque, provider-defined. Never parsed here. */
  id: string
  label: string
  /**
   * A level the user can see the name of but cannot open.
   *
   * GitLab is why: a member of `acme/platform` who is not a member of `acme`
   * gets a path rooted mid-tree. Rendering the parent as absent would be a
   * lie about the hierarchy; rendering it as navigable would be a link to a
   * 403. It renders as a dimmed, non-navigable segment.
   */
  ghost?: boolean
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * The normalized status of a run.
 *
 * `unknown` is load-bearing and is NOT a failure: a provider we could not reach
 * must render as neither green nor red. CI natively has four outcomes including
 * "we did not read it", which is exactly the collision `panel-audit.md` calls
 * consequential — hence `--state-unknown` being the achromatic one.
 */
export type CicdStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'canceled'
  | 'skipped'
  | 'manual'
  | 'unknown'

/**
 * Jenkins `UNSTABLE` and GitHub `neutral` are neither pass nor fail. Folding
 * them into `failed` misreports a lot of builds, so they are `success` with
 * this flag set and the UI shows a third shape.
 */
export interface CicdOutcome {
  status: CicdStatus
  warning?: boolean
}

/** Jenkins: `building` and `result` are two fields, and `result` is null while building. */
export function jenkinsOutcome(building: boolean, result: string | null): CicdOutcome {
  if (building) return { status: 'running' }
  switch (result) {
    case 'SUCCESS':
      return { status: 'success' }
    case 'UNSTABLE':
      return { status: 'success', warning: true }
    case 'FAILURE':
      return { status: 'failed' }
    case 'ABORTED':
      return { status: 'canceled' }
    case 'NOT_BUILT':
      return { status: 'skipped' }
    default:
      // Includes `null` on a job that has never run, and `disabled`.
      return { status: 'unknown' }
  }
}

/** GitLab: one field, and the same vocabulary for pipelines and jobs. */
export function gitlabOutcome(status: string): CicdOutcome {
  switch (status) {
    case 'created':
    case 'pending':
    case 'preparing':
    case 'waiting_for_resource':
    case 'waiting_for_callback':
    case 'scheduled':
      return { status: 'queued' }
    case 'running':
      return { status: 'running' }
    case 'success':
      return { status: 'success' }
    case 'failed':
      return { status: 'failed' }
    // `canceling` is transient. It renders as canceled with a sublabel rather
    // than becoming a ninth member nobody else has.
    case 'canceling':
    case 'canceled':
      return { status: 'canceled' }
    case 'skipped':
      return { status: 'skipped' }
    case 'manual':
      return { status: 'manual' }
    default:
      return { status: 'unknown' }
  }
}

/**
 * GitHub: `status` until complete, then `conclusion`.
 *
 * `startup_failure` is absent from GitHub's documented enum and emitted in
 * production whenever a workflow's YAML fails to parse or references a
 * disallowed action. Leaving it unmapped is the worst outcome available — the
 * user breaks their workflow file and the panel says "unknown". Such a run also
 * has ZERO jobs, which the run-detail path has to survive.
 */
export function githubOutcome(status: string, conclusion: string | null): CicdOutcome {
  if (status !== 'completed') {
    switch (status) {
      case 'in_progress':
        return { status: 'running' }
      case 'queued':
      case 'requested':
      case 'pending':
      case 'waiting':
        return { status: 'queued' }
      default:
        return { status: 'unknown' }
    }
  }
  switch (conclusion) {
    case 'success':
      return { status: 'success' }
    case 'neutral':
      return { status: 'success', warning: true }
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return { status: 'failed' }
    case 'cancelled':
      return { status: 'canceled' }
    case 'skipped':
    case 'stale':
      return { status: 'skipped' }
    case 'action_required':
      // Displayed as `manual`, but resuming it is a deployment approval on a
      // different endpoint — not GitLab's `play`. See the trigger functions.
      return { status: 'manual' }
    default:
      return { status: 'unknown' }
  }
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface CicdPipeline {
  connectionId: string
  /** Opaque provider handle used to refetch. Never parsed by the UI. */
  ref: string
  name: string
  /** Display grouping only. See `CicdPathSegment`. */
  groupPath: CicdPathSegment[]
  /**
   * Whether this pipeline can be started at all.
   *
   * GitHub is the reason this exists: `workflow_dispatch` works only if the
   * YAML declares it, and no API field says so — it takes fetching and parsing
   * the workflow file. A Run button that 422s on half the workflows is worse
   * than one that is honestly absent.
   */
  triggerable: boolean
  /** Absent until a run has been read. */
  last?: CicdRun
}

export interface CicdRun {
  connectionId: string
  pipelineRef: string
  /**
   * Identity is (id, attempt), not id.
   *
   * A GitHub re-run REUSES the run id and bumps `run_attempt`. Keying on id
   * alone silently overwrites attempt 1 with attempt 2.
   */
  id: string
  attempt: number
  /** What the provider calls it — `#4821`, a build number, a short sha. */
  label: string
  outcome: CicdOutcome
  /** Epoch ms. Jenkins reports ms already; the other two report ISO strings. */
  startedAt?: number
  durationMs?: number
  branch?: string
  /**
   * Author, PR title, commit subject.
   *
   * ATTACKER-AUTHORED. Anyone who can open a pull request writes these. They
   * are display text and nothing else: every one of them goes through
   * `remoteName` before reaching an approval dialog or an AI tool result.
   */
  title?: string
  actor?: string
  /** Deep link into the provider's own UI. Always offered; sometimes the only honest answer. */
  webUrl?: string
}

export interface CicdStep {
  name: string
  outcome: CicdOutcome
  durationMs?: number
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

/**
 * How fresh a log pane's contents actually are.
 *
 * The UI shows this permanently rather than guessing, because the three
 * providers genuinely differ and a shared "Tail" affordance would be a lie:
 *
 *  - `live`    Jenkins. `progressiveText?start=N` with `X-Text-Size` and
 *              `X-More-Data`. A real incremental tail.
 *  - `reread`  GitLab. The whole trace, refetched. No `Range`, no incremental
 *              API — so "live" means re-read every few seconds and say so.
 *  - `snapshot` GitHub, run finished. A zip published at the end.
 *  - `pending` GitHub, run in progress. Logs DO NOT EXIST YET and the endpoint
 *              404s. Step statuses are available; the log is not. This is not
 *              an error state and the poller must not back off on it.
 */
export type CicdLogMode = 'live' | 'reread' | 'snapshot' | 'pending'

export interface CicdLogChunk {
  mode: CicdLogMode
  text: string
  /** Opaque resume token. Jenkins' byte offset; a length elsewhere. */
  cursor?: string
  /** False once the provider says there is no more coming. */
  more: boolean
  /** Set when a cap truncated the response, so the UI can say how much is missing. */
  withheldBytes?: number
}

// ---------------------------------------------------------------------------
// The read interface
// ---------------------------------------------------------------------------

/** What a connection can actually do, so callers stop guessing. */
export interface CicdCapabilities {
  logMode: Exclude<CicdLogMode, 'pending'>
  /** Whether a trigger hands back the run it created. Jenkins never does. */
  triggerReturnsRun: boolean
  /** `play` (GitLab), `approve` (GitHub), or neither (Jenkins). */
  resume: 'play' | 'approve' | 'none'
}

/**
 * The transport an adapter is handed.
 *
 * Injected rather than imported, for the reason `ServiceCheckRunner` injects
 * its `probe`: a test must not open a socket. It also keeps an adapter from
 * knowing about credentials — main has already merged the token into the
 * headers by the time this is called, and an adapter never sees the vault.
 */
export interface CicdResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export interface CicdHttp {
  (req: {
    method: string
    /** Relative to the connection's API root. */
    path: string
    headers?: Record<string, string>
    body?: string
    /** Follow a 3xx, dropping credentials if the origin changes. GitHub's log blob needs this. */
    followRedirect?: boolean
  }): Promise<CicdResponse>
}

export interface CicdAdapter {
  readonly provider: CicdProvider
  /** Derive the API root from the user's typed web URL. */
  apiRoot(baseUrl: string): string
  capabilities(): CicdCapabilities
  /** One request that proves the credential AND says who we are. */
  verify(): Promise<{ identity: string; scopes?: string[]; expiresAt?: number }>
  listPipelines(): Promise<CicdPipeline[]>
  listRuns(pipelineRef: string, limit: number): Promise<CicdRun[]>
  getRun(pipelineRef: string, runId: string, attempt: number): Promise<{ run: CicdRun; steps: CicdStep[] }>
  /** `cursor` resumes an incremental tail where the provider supports one. */
  /**
   * `pipelineRef` is REQUIRED and is not redundant with `runId`.
   *
   * All three providers need it and none can recover it from a run id alone:
   * Jenkins' log path is the job path plus the build number, GitLab has no
   * endpoint that finds a job without its project, and GitHub's needs
   * `owner/repo`. Without it each adapter has to memoize run → parent and
   * fail confusingly when a log is asked for before a list — which is exactly
   * what all three independently built before this argument existed.
   */
  getLog(
    pipelineRef: string,
    runId: string,
    stepName: string | undefined,
    cursor?: string
  ): Promise<CicdLogChunk>
  /**
   * Parameters this pipeline accepts, for the trigger form.
   *
   * On the adapter rather than a loose per-provider export because it is a
   * pure read and every provider needs one: Jenkins' ParametersDefinitionProperty,
   * GitHub's workflow_dispatch.inputs, GitLab's project variables.
   */
  listParams(pipelineRef: string): Promise<CicdParam[]>
}

/**
 * Parameters a pipeline accepts, normalized far enough to render a form.
 *
 * The three metadata shapes (Jenkins ParametersDefinitionProperty, GitHub
 * workflow_dispatch.inputs, GitLab variables) agree on roughly this much and
 * nothing more. A pipeline with no parameters gets a short confirm and no
 * manufactured empty form.
 */
export interface CicdParam {
  key: string
  label: string
  type: 'string' | 'boolean' | 'choice' | 'password'
  required: boolean
  default?: string
  choices?: string[]
}

/**
 * The outcome of asking a provider to start something.
 *
 * `run` is absent on Jenkins (a queue item, which may never become a build) and
 * on GitHub Enterprise (`204` with no body). The UI renders that as REQUESTED
 * in the unknown state — never green, and never a fabricated run number.
 */
export interface CicdTriggerResult {
  run?: { id: string; attempt: number }
  /** Deep link to the created run where the provider returns one. Often the most useful thing to show. */
  webUrl?: string
  /** Jenkins queue item, polled until an `executable` appears. */
  queueRef?: string
  /** Shown verbatim. "Jenkins has queued it; a build number appears when an executor picks it up." */
  note: string
}

// ---------------------------------------------------------------------------
// The renderer <-> main contract
// ---------------------------------------------------------------------------

/**
 * What the panel sees for one connection, every time the poller reports.
 *
 * Freshness is carried EXPLICITLY rather than implied by the arrival of a
 * message. A panel that mounts mid-outage, or one whose last update was an
 * hour ago, has to be able to say so — the rule from `panel-audit.md` is that
 * the UI must never silently claim data is current. So `readAt` is when we
 * last SUCCEEDED, not when this object was built, and `error` survives
 * alongside the last good rows rather than replacing them.
 */
export interface CicdPanelState {
  connectionId: string
  /** Epoch ms of the last SUCCESSFUL read. Undefined means never read. */
  readAt?: number
  /** Set while the last attempt failed. Rows below are then stale, not gone. */
  error?: string
  /** Consecutive failures, so the UI can escalate its language rather than its colour. */
  failures: number
  /** Provider rate budget, when the provider reports one. GitHub does. */
  budget?: { remaining: number; limit: number; resetAt?: number }
  /**
   * Seconds between scheduled reads for THIS connection.
   *
   * Sent because the panel cannot know it: the interval is per provider
   * (GitHub is 60s against its 5,000/hour budget, Jenkins 15s), and a panel
   * that assumed one number flagged a perfectly healthy GitHub account as
   * stale on every single cycle — its staleness threshold was three times a
   * guess, not three times the real cadence.
   */
  intervalSec: number
  pipelines: CicdPipeline[]
}

/**
 * An agent-started run that may still be going.
 *
 * Read by STOP ALL AI ACCESS so it can name what it cannot stop. `unknown`
 * means the provider returned no run id — Jenkins hands back a queue item and
 * GitHub Enterprise answers 204 — so nothing has been able to check on it.
 * That is a different sentence from "it is still going" and has to read as one.
 */
export interface AgentRunReport {
  connectionName: string
  pipeline: string
  run?: string
  startedAt: number
  state: 'running' | 'queued' | 'unknown'
}

/**
 * The preload surface. Named here so the renderer, the preload bridge and main
 * cannot drift: all three import this one declaration.
 */
export interface CicdBridge {
  /**
   * Tell main the saved connections changed.
   *
   * Carries NOTHING. Main re-reads the file it already persists and discovers
   * each account's pipelines itself. The renderer naming a `vaultEntryId` and a
   * `baseUrl` would be naming which stored credential goes to which host, which
   * is the power `shared/httpClient.ts` refuses for SSH in the same words.
   */
  configure(): Promise<void>
  /** Everything known right now — for a panel that just mounted. */
  snapshot(): Promise<CicdPanelState[]>
  /** What an agent started that may still be going. See `AgentRunReport`. */
  agentRuns(): Promise<AgentRunReport[]>
  /** Read now, ignoring the interval AND any backoff. The panel's one primary action. */
  refresh(connectionId?: string): Promise<void>
  /** A run's detail and its steps. `list_runs` gives the summary; this gives the jobs. */
  getRun(
    connectionId: string,
    pipelineRef: string,
    runId: string,
    attempt?: number
  ): Promise<{ run: unknown; steps: unknown[] }>
  /**
   * Store a token, get back the id that points at it.
   *
   * The one call that carries a secret toward main. The connect modal is where
   * a token briefly exists in the renderer; this is where it stops existing
   * there. Nothing hands it back.
   */
  createSecret(label: string, token: string): Promise<string>
  /** Dial a connection without saving it. Verify in the connect modal. */
  verify(
    connection: CicdConnection,
    secret: string
  ): Promise<{ ok: true; identity: string; scopes?: string[]; expiresAt?: number } | { ok: false; error: string }>
  listParams(connectionId: string, pipelineRef: string): Promise<CicdParam[]>
  getLog(
    connectionId: string,
    pipelineRef: string,
    runId: string,
    stepName?: string,
    cursor?: string
  ): Promise<CicdLogChunk>
  /** Gated in main, not here: a renderer that could start a build unchecked is the bug. */
  trigger(
    connectionId: string,
    pipelineRef: string,
    ref: string,
    params?: Record<string, string>
  ): Promise<CicdTriggerResult>
  cancel(connectionId: string, pipelineRef: string, runId: string): Promise<CicdTriggerResult>
  rerun(connectionId: string, pipelineRef: string, runId: string): Promise<CicdTriggerResult>
  /** Drop a vault entry a deleted connection owned. See releaseCicdSecrets. */
  deleteSecrets(vaultEntryId: string): Promise<void>
  /** Push updates. Returns its own unsubscribe, like every other namespace here. */
  onState(handler: (state: CicdPanelState) => void): () => void
}
