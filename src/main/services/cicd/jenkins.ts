// Jenkins adapter: reads through `CicdAdapter`, triggering through its own
// function, for the reason stated at the top of `src/shared/cicd.ts`.
//
// Four things about Jenkins shape almost every line here:
//
//  1. `tree=` is mandatory. A bare `/api/json` on a controller with a few
//     thousand jobs serialises the entire object graph; CloudBees names it as a
//     high-CPU hazard and says the API should never be used without a field
//     selector. Every JSON read below carries one, and build lists carry the
//     range specifier `{0,N}` as well, because Jenkins has no pagination.
//  2. Jenkins answers 403 for everything. A rejected credential, a missing
//     permission and a missing CSRF crumb are indistinguishable at the HTTP
//     layer -- "Jenkins does not do any authorization negotiation ... it
//     immediately returns a 403 instead of a 401". So the error text says what
//     happened and refuses to say why.
//  3. No crumb is fetched. Requests authenticating with an API token are exempt
//     from CSRF protection and have been since 2.96, and Strict Crumb Issuer
//     does not revoke the exemption. A crumb round trip per write buys nothing
//     and breaks behind some reverse proxies. What it does cost is a story for
//     the user who pasted their *password* -- which Jenkins also accepts over
//     Basic, and which is NOT exempt -- so `verify()` buys that story instead,
//     with one harmless POST at connect time.
//  4. Nothing here is the trigger's problem. `triggerJenkins` returns a queue
//     item and stops. Turning a queue item into a build number is a poll that
//     may never terminate (`why: "Waiting for next available executor"`), and
//     an approval dialog must not sit on it.

import {
  jenkinsOutcome,
  type CicdAdapter,
  type CicdAgent,
  type CicdCapacity,
  type CicdQueueItem,
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

export interface JenkinsAdapterOptions {
  connectionId: string
  /**
   * How deep the folder walk goes. Folders nest arbitrarily and a folder tree
   * can be made to appear to contain itself, so the walk is bounded by depth
   * rather than by trusting the tree to be finite.
   */
  maxDepth?: number
  /** Total pipelines returned, so one walk cannot become an unbounded sweep. */
  maxJobs?: number
  /** Children read per folder. */
  maxChildren?: number
  /**
   * Bytes kept from a single log fetch.
   *
   * JENKINS-75081 -- progressiveText exhausting heap on a large completed build
   * -- was fixed 2025-05-02, but the cause was Jetty's gzip handler buffering
   * the whole response, not the offset. So `start` is not the mitigation,
   * `Accept-Encoding: identity` is, and the first fetch of a finished build is
   * `start=0` by definition. This cap is the second half of that defence.
   */
  maxLogBytes?: number
}

const DEFAULTS = { maxDepth: 8, maxJobs: 2000, maxChildren: 500, maxLogBytes: 256 * 1024 }

/**
 * Jenkins returns 403 for a rejected credential, a missing permission and a
 * missing crumb alike. This sentence is deliberately vague because the protocol
 * is.
 */
const FORBIDDEN =
  'Jenkins returned 403. It answers 403 for a rejected credential, a missing permission and a missing CSRF crumb alike, so this does not say which.'

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

/** Node lowercases response headers; a fake in a test might not. */
function header(res: CicdResponse, name: string): string | undefined {
  const want = name.toLowerCase()
  for (const [k, v] of Object.entries(res.headers)) if (k.toLowerCase() === want) return v
  return undefined
}

/**
 * A redirect to somewhere that is plainly a login.
 *
 * Jenkins under an SSO security realm does NOT answer 401 to a credential it will
 * not take -- it answers 302 to the realm's login entry point, because that is
 * what it would do for a browser. The bare status is useless to the reader: an
 * instance whose anonymous reads return 200 and whose token-authenticated reads
 * return 302 looks like an OpsMaxx fault and is not one.
 *
 * Matched on the Location, not on the status alone, because a redirect to a
 * canonical URL is a different and harmless thing.
 */
const LOGIN_REDIRECT = /commenceLogin|securityRealm|\/login\b|oauth|saml|openid|adfs/i

function expectOk(res: CicdResponse, what: string): CicdResponse {
  if (res.status >= 200 && res.status < 300) return res
  if (res.status === 403) throw new Error(`${what}: ${FORBIDDEN}`)
  if (res.status === 404) throw new Error(`${what}: Jenkins returned 404 — nothing at that path.`)
  if (res.status >= 300 && res.status < 400) {
    const to = header(res, 'location') ?? ''
    if (LOGIN_REDIRECT.test(to)) {
      throw new Error(
        `${what}: Jenkins redirected to a login page, so it did not accept the API token for this request. That is what an instance behind SSO does instead of answering 401 — the realm has to be configured to accept API tokens, or the token belongs to an account the realm does not know.`
      )
    }
    // Still worth distinguishing from a 4xx: a redirect means Jenkins is there
    // and answering, and OpsMaxx does not follow one because the target does not
    // inherit the credential.
    throw new Error(
      `${what}: Jenkins redirected (${res.status})${to ? ` to ${to}` : ''}, and a redirect target does not inherit the credential, so it was not followed.`
    )
  }
  throw new Error(`${what}: Jenkins returned ${res.status}.`)
}

/**
 * A 200 carrying HTML is the SSO-proxy case, and it is worth naming: the user
 * sees a login page's markup, not a parse error from a file they never opened.
 */
function asJson(res: CicdResponse, what: string): any {
  try {
    return JSON.parse(res.body) as any
  } catch {
    throw new Error(
      `${what}: Jenkins answered ${res.status} but the body was not JSON — something in front of it (an SSO proxy?) replied instead.`
    )
  }
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** `job/a/job/b` — one `job/` segment per level, which is Jenkins' own URL shape. */
const childRef = (parent: string, name: string): string =>
  `${parent ? `${parent}/` : ''}job/${encodeURIComponent(name)}`

/** A folder, a multibranch project, an org folder: anything that contains jobs. */
const isContainer = (j: any): boolean =>
  Array.isArray(j?.jobs) || /Folder$|MultiBranch/.test(String(j?._class ?? ''))

const buildOutcome = (b: any) =>
  jenkinsOutcome(b?.building === true, typeof b?.result === 'string' ? b.result : null)

/** Jenkins addresses a build as the job path plus the number, and never otherwise. */
const buildPath = (pipelineRef: string, runId: string): string => `${pipelineRef}/${runId}`

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export function createJenkinsAdapter(http: CicdHttp, opts: JenkinsAdapterOptions): CicdAdapter {
  const cfg = { ...DEFAULTS, ...opts }
  const connectionId = opts.connectionId

  const getJson = async (path: string, what: string): Promise<any> =>
    asJson(expectOk(await http({ method: 'GET', path }), what), what)

  /** One folder level. `ref` is '' for the controller root. */
  const children = async (ref: string): Promise<any[]> => {
    const tree = `jobs[name,buildable]{0,${cfg.maxChildren}}`
    const body = await getJson(`/${ref ? `${ref}/` : ''}api/json?tree=${tree}`, 'Listing jobs')
    return Array.isArray(body?.jobs) ? body.jobs : []
  }

  return {
    provider: 'jenkins',

    /**
     * Jenkins sits at whatever context path its admin chose, and the API lives
     * at that path — not at the host root. So this trims and otherwise keeps
     * what the user typed.
     */
    apiRoot: (baseUrl) => baseUrl.trim().replace(/\/+$/, ''),

    capabilities: () => ({ logMode: 'live', triggerReturnsRun: false, resume: 'none' }),

    /**
     * Two requests, and the second one is the point.
     *
     * A GET proves the credential is accepted — including by a proxy that
     * strips `Authorization` for SSO and hands back the anonymous view rather
     * than a 401, which is why the answer is checked and not just the status.
     *
     * The POST proves it is an API *token*. Jenkins takes an account password
     * over Basic too, password auth is not crumb-exempt, and the two are the
     * same shape. Without this, the most common connect-time mistake surfaces
     * as a 403 on the user's first trigger, hours later.
     */
    async verify() {
      const me = await getJson('/whoAmI/api/json?tree=name,authenticated', 'Checking the credential')
      const identity = typeof me?.name === 'string' ? me.name : ''
      if (me?.authenticated !== true || !identity || identity === 'anonymous') {
        throw new Error(
          'Jenkins answered as `anonymous`. The credential did not reach it — a reverse proxy in front of Jenkins may be stripping the Authorization header for SSO.'
        )
      }
      // Harmless: whoAmI is read-only, and a POST to it changes nothing. It
      // exists only to run the CSRF filter, which sits in front of every POST.
      const probe = await http({ method: 'POST', path: '/whoAmI/api/json?tree=name' })
      if (probe.status === 403 && /crumb/i.test(`${header(probe, 'x-error') ?? ''} ${probe.body}`)) {
        throw new Error(
          'Jenkins refused a write for want of a CSRF crumb: that looks like a password, not an API token. API tokens are crumb-exempt; passwords are not. Generate a token under your user → Security → API Token.'
        )
      }
      // Any other 403 is left alone on purpose. Reads work, so the connection
      // is usable; a read-only account is a legitimate outcome, not a failure.
      return { identity }
    },

    /**
     * Breadth-first across folders, one request per folder, bounded three ways:
     * depth, total jobs, and children per folder. A folder tree that appears to
     * contain itself is not a hypothetical — it is what a misconfigured
     * OrganizationFolder or a crafted response looks like — and none of the
     * bounds depend on the tree being finite.
     */
    async listPipelines() {
      const out: CicdPipeline[] = []
      const seen = new Set<string>()
      const queue: { ref: string; path: CicdPathSegment[] }[] = [{ ref: '', path: [] }]
      while (queue.length > 0 && out.length < cfg.maxJobs) {
        const node = queue.shift()!
        for (const j of await children(node.ref)) {
          if (out.length >= cfg.maxJobs) break
          const name = typeof j?.name === 'string' ? j.name : ''
          if (!name) continue
          const ref = childRef(node.ref, name)
          if (seen.has(ref)) continue
          seen.add(ref)
          if (isContainer(j)) {
            if (node.path.length + 1 < cfg.maxDepth) {
              queue.push({ ref, path: [...node.path, { id: ref, label: name }] })
            }
            continue
          }
          out.push({
            connectionId,
            ref,
            name,
            groupPath: node.path,
            // Jenkins has no equivalent of GitHub's undeclared-dispatch
            // problem: `buildable` is authoritative and always present on a
            // project. A disabled job says so.
            triggerable: j?.buildable !== false
          })
        }
      }
      return out
    },

    /** `{0,N}` is the only paging Jenkins has. */
    async listRuns(pipelineRef, limit) {
      const n = Math.max(1, Math.min(Math.trunc(limit) || 1, 200))
      const tree = `builds[number,timestamp,duration,building,result,displayName,url]{0,${n}}`
      const body = await getJson(`/${pipelineRef}/api/json?tree=${tree}`, 'Listing builds')
      const builds = Array.isArray(body?.builds) ? body.builds : []
      return builds.map((b: any): CicdRun => {
        const number = num(b?.number) ?? 0
        return {
          connectionId,
          pipelineRef,
          id: String(number),
          // Jenkins has no re-run-in-place: a rebuild is a new build number.
          attempt: 1,
          label: typeof b?.displayName === 'string' && b.displayName ? b.displayName : `#${number}`,
          outcome: buildOutcome(b),
          startedAt: num(b?.timestamp),
          // 0 while building, which is not a duration.
          durationMs: num(b?.duration) || undefined,
          webUrl: typeof b?.url === 'string' ? b.url : undefined
        }
      })
    },

    async getRun(pipelineRef, runId, attempt) {
      const base = buildPath(pipelineRef, runId)
      const tree =
        'number,timestamp,duration,building,result,displayName,description,url,actions[causes[userName,shortDescription],lastBuiltRevision[branch[name]]]'
      const b = await getJson(`/${base}/api/json?tree=${tree}`, 'Reading a build')
      const actions: any[] = Array.isArray(b?.actions) ? b.actions : []
      const cause = actions.flatMap((a) => (Array.isArray(a?.causes) ? a.causes : []))[0]
      const branch = actions
        .map((a) => a?.lastBuiltRevision?.branch)
        .filter(Array.isArray)
        .flat()
        .map((x: any) => (typeof x?.name === 'string' ? x.name : undefined))
        .find(Boolean)

      const run: CicdRun = {
        connectionId,
        pipelineRef,
        id: String(num(b?.number) ?? runId),
        attempt: attempt > 0 ? attempt : 1,
        label: typeof b?.displayName === 'string' && b.displayName ? b.displayName : `#${num(b?.number) ?? runId}`,
        outcome: buildOutcome(b),
        startedAt: num(b?.timestamp),
        durationMs: num(b?.duration) || undefined,
        branch,
        title: typeof b?.description === 'string' ? b.description : undefined,
        actor: typeof cause?.userName === 'string' ? cause.userName : cause?.shortDescription,
        webUrl: typeof b?.url === 'string' ? b.url : undefined
      }
      return { run, steps: await stages(http, base) }
    },

    /**
     * The one real live tail among the three providers: a byte offset in,
     * `X-Text-Size` back as the next offset, `X-More-Data` saying whether to
     * ask again.
     *
     * `stepName` is ignored. Per-stage logs are a workflow-api endpoint keyed
     * by flow-node id, not by stage name, and the whole-build log is what core
     * Jenkins offers. Pretending otherwise would return the same bytes under a
     * label that says they were filtered.
     */
    async getLog(pipelineRef, runId, _stepName, cursor): Promise<CicdLogChunk> {
      const base = buildPath(pipelineRef, runId)
      const parsed = Number.parseInt(cursor ?? '0', 10)
      const start = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
      const res = expectOk(
        await http({
          method: 'GET',
          path: `/${base}/logText/progressiveText?start=${start}`,
          // See `maxLogBytes`: the heap bug is gzip buffering on the controller.
          headers: { 'Accept-Encoding': 'identity' }
        }),
        'Reading the build log'
      )

      let text = res.body ?? ''
      let withheldBytes: number | undefined
      if (text.length > cfg.maxLogBytes) {
        // Keep the tail: on a finished build the first fetch is start=0 and the
        // end is the part anyone wants. The cursor still comes from the server,
        // so the next fetch resumes correctly rather than re-reading.
        withheldBytes = text.length - cfg.maxLogBytes
        text = text.slice(text.length - cfg.maxLogBytes)
      }
      const size = Number.parseInt(header(res, 'x-text-size') ?? '', 10)
      return {
        mode: 'live',
        text,
        cursor: String(Number.isFinite(size) ? size : start + (res.body?.length ?? 0)),
        more: header(res, 'x-more-data') === 'true',
        withheldBytes
      }
    },

    listParams: (pipelineRef) => jenkinsParams(http, pipelineRef),

    /**
     * The job's own definition, as Jenkins stores it.
     *
     * `config.xml`, not `wfapi` or an inline script field: it is the one endpoint
     * every job kind answers -- freestyle, pipeline and multibranch alike -- and
     * it is what an admin would open in the Jenkins UI. A declarative pipeline's
     * script sits inside it, which is the common case and the reason this is
     * worth showing at all.
     *
     * Deliberately NOT parsed. It is a file from somebody else's controller, its
     * dialect changes with every plugin version, and the panel's job is to show
     * it rather than to have an opinion about it. This is also the one read here
     * with no `tree=` and no JSON: the endpoint serves XML and the selector does
     * not apply, so it is capped by bytes instead -- the same figure and the same
     * reason as the log reader, because nothing here decides how many bytes this
     * process accepts on a stranger's say-so.
     */
    async getConfig(pipelineRef) {
      const res = expectOk(
        await http({ method: 'GET', path: `/${pipelineRef}/config.xml` }),
        'Reading the job configuration'
      )
      const text = res.body ?? ''
      const capped = text.length > cfg.maxLogBytes
      return {
        kind: 'xml' as const,
        text: capped ? text.slice(0, cfg.maxLogBytes) : text,
        path: `${pipelineRef}/config.xml`,
        ...(capped ? { truncated: true } : {})
      }
    }
  }
}

/**
 * Stages, when the build is a Pipeline and workflow-api is installed.
 *
 * Neither is guaranteed — a freestyle job has no stages at all — so anything
 * other than a readable answer is an empty step list, not an error. This is the
 * only read here without `tree=`; `wfapi` does not implement the selector, and
 * it returns one build's stages rather than a job graph.
 */
async function stages(http: CicdHttp, base: string): Promise<CicdStep[]> {
  const res = await http({ method: 'GET', path: `/${base}/wfapi/describe` })
  if (res.status < 200 || res.status >= 300) return []
  let body: any
  try {
    body = JSON.parse(res.body)
  } catch {
    return []
  }
  const list = Array.isArray(body?.stages) ? body.stages : []
  return list.map((s: any): CicdStep => {
    // wfapi spells the same outcomes differently from `result`. Rather than
    // grow a second status mapping, translate into the pair `jenkinsOutcome`
    // already takes.
    const [building, result] = STAGE_RESULT[String(s?.status ?? '')] ?? [false, null]
    return {
      name: typeof s?.name === 'string' ? s.name : '(unnamed stage)',
      outcome: jenkinsOutcome(building, result),
      durationMs: num(s?.durationMillis)
    }
  })
}

const STAGE_RESULT: Record<string, [boolean, string | null]> = {
  IN_PROGRESS: [true, null],
  PAUSED_PENDING_INPUT: [true, null],
  SUCCESS: [false, 'SUCCESS'],
  UNSTABLE: [false, 'UNSTABLE'],
  FAILED: [false, 'FAILURE'],
  ABORTED: [false, 'ABORTED'],
  NOT_EXECUTED: [false, 'NOT_BUILT']
}

// ---------------------------------------------------------------------------
// Parameters and triggering
// ---------------------------------------------------------------------------

/**
 * `ParametersDefinitionProperty`, flattened into something a form can render.
 *
 * Jenkins has no required flag — every parameter has a default or does not —
 * so "required" means "the user has to supply it". A password parameter is
 * always in that set, because its default is an encrypted blob that must never
 * be carried back out of here.
 */
export async function jenkinsParams(http: CicdHttp, pipelineRef: string): Promise<CicdParam[]> {
  const tree = 'property[parameterDefinitions[name,type,description,choices,defaultParameterValue[value]]]'
  const res = await http({ method: 'GET', path: `/${pipelineRef}/api/json?tree=${tree}` })
  const body = asJson(expectOk(res, 'Reading build parameters'), 'Reading build parameters')
  const props: any[] = Array.isArray(body?.property) ? body.property : []
  const defs = props.flatMap((p) => (Array.isArray(p?.parameterDefinitions) ? p.parameterDefinitions : []))
  return defs
    .filter((d) => typeof d?.name === 'string' && d.name)
    .map((d: any): CicdParam => {
      const kind = String(d._class ?? d.type ?? '')
      const type: CicdParam['type'] = /password/i.test(kind)
        ? 'password'
        : /boolean/i.test(kind)
          ? 'boolean'
          : /choice/i.test(kind)
            ? 'choice'
            : 'string'
      // Never read the default of a secret, let alone hand it back.
      const fallback = type === 'password' ? undefined : d?.defaultParameterValue?.value
      return {
        key: d.name,
        label: d.name,
        type,
        required: fallback === undefined || fallback === null,
        default: fallback === undefined || fallback === null ? undefined : String(fallback),
        choices: type === 'choice' ? (Array.isArray(d?.choices) ? d.choices.map(String) : []) : undefined
      }
    })
}

/**
 * Start a build.
 *
 * Deliberately not on `CicdAdapter`: what comes back is a queue item, not a
 * build. `201` plus `Location: …/queue/item/N/` means Jenkins accepted the
 * request, nothing more — the item may wait indefinitely for an executor and
 * may be cancelled before it ever becomes a build. So `run` is absent and the
 * note says so in words, because the alternative is a row that reads as a build
 * number the user can look up and cannot.
 *
 * Turning the queue item into a build number is the poller's job. Doing it here
 * would make an approval dialog sit on a wait with no upper bound.
 *
 * No crumb is fetched: see the file header.
 */
export async function triggerJenkins(
  http: CicdHttp,
  pipelineRef: string,
  params?: Record<string, string>
): Promise<CicdTriggerResult> {
  const entries = Object.entries(params ?? {})
  const res = await http({
    method: 'POST',
    path: `/${pipelineRef}/${entries.length > 0 ? 'buildWithParameters' : 'build'}`,
    headers: entries.length > 0 ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined,
    // Values may include a password parameter. They go in the body and nowhere
    // else — not into a log line, not into an error message below.
    body: entries.length > 0 ? new URLSearchParams(entries).toString() : undefined
  })
  expectOk(res, 'Starting a build')
  const queueRef = /queue\/item\/\d+/.exec(header(res, 'location') ?? '')?.[0]
  return {
    queueRef,
    note: queueRef
      ? 'Jenkins has queued it; a build number appears when an executor picks it up. The queue item can also be cancelled before it ever becomes a build.'
      : 'Jenkins accepted the request but returned no queue item, so there is nothing to follow. Check the job in Jenkins.'
  }
}

/**
 * Stop a running build.
 *
 * `/stop` asks the build to end and is what the Stop button in Jenkins does.
 * Jenkins answers 302 to the build page on success, so a redirect is a success
 * here rather than something to follow — hence no `followRedirect`.
 *
 * A build that has already finished still answers 302, so this reports what it
 * asked for rather than what happened: Jenkins gives no way to tell "stopped
 * it" from "it was already over", and claiming the first would be a guess.
 */
export async function cancelJenkins(
  http: CicdHttp,
  pipelineRef: string,
  runId: string
): Promise<CicdTriggerResult> {
  const res = await http({ method: 'POST', path: `/${pipelineRef}/${runId}/stop` })
  // 302 is the normal answer; 200 happens behind some proxies.
  if (res.status !== 302 && (res.status < 200 || res.status >= 300)) {
    expectOk(res, 'Stopping a build')
  }
  return {
    run: { id: runId, attempt: 1 },
    note: 'Asked Jenkins to stop the build. Jenkins does not report whether it was still running, so check the run.'
  }
}

// ---------------------------------------------------------------------------
// Queue and capacity — deliberately not on the adapter
// ---------------------------------------------------------------------------
//
// Same reasoning as the trigger functions above. A build queue and a pool of
// executors are Jenkins concepts: GitHub exposes no queue a token can read, and
// GitLab's pending jobs are a different subject with different semantics. The
// header of shared/cicd.ts refuses an interface whose capability flags outnumber
// its members, so these stay named functions that only Jenkins has.

/**
 * What is waiting, and why.
 *
 * `why` is the reason this is worth reading at all. "Waiting for next available
 * executor" and "is offline" and a label expression matching no agent are three
 * different mornings, and until now the Jenkins UI was the only place to tell
 * them apart.
 *
 * `/queue/api/json` takes a `tree=` like everything else here. `task[name,url]`
 * rather than the whole task: the task object carries the job's entire
 * configuration on some plugin combinations.
 */
export async function jenkinsQueue(http: CicdHttp): Promise<CicdQueueItem[]> {
  const tree = 'items[id,why,stuck,blocked,inQueueSince,task[name,url]]{0,200}'
  const body = asJson(
    expectOk(await http({ method: 'GET', path: `/queue/api/json?tree=${tree}` }), 'Reading the queue'),
    'Reading the queue'
  )
  const items = Array.isArray(body?.items) ? body.items : []
  return items.map((i: any): CicdQueueItem => ({
    id: num(i?.id) ?? 0,
    name: typeof i?.task?.name === 'string' ? i.task.name : 'unnamed',
    ...(typeof i?.why === 'string' && i.why ? { why: i.why } : {}),
    stuck: i?.stuck === true,
    blocked: i?.blocked === true,
    ...(num(i?.inQueueSince) !== undefined ? { since: num(i.inQueueSince) } : {})
  }))
}

/**
 * The executors, and the agents they live on.
 *
 * `monitorData[*]` rather than a named monitor: which monitors are installed
 * depends on the controller, and asking for one that is absent is not an error
 * Jenkins reports -- it simply is not in the answer. So the whole map comes back
 * and the disk figure is picked out of it if it happens to be there.
 */
export async function jenkinsCapacity(http: CicdHttp): Promise<CicdCapacity> {
  const tree =
    'busyExecutors,totalExecutors,computer[displayName,offline,temporarilyOffline,offlineCauseReason,numExecutors,idle,monitorData[*]]'
  const body = asJson(
    expectOk(
      await http({ method: 'GET', path: `/computer/api/json?tree=${tree}` }),
      'Reading the executors'
    ),
    'Reading the executors'
  )
  const computers = Array.isArray(body?.computer) ? body.computer : []
  return {
    busyExecutors: num(body?.busyExecutors) ?? 0,
    totalExecutors: num(body?.totalExecutors) ?? 0,
    agents: computers.map((c: any): CicdAgent => {
      const disk = c?.monitorData?.['hudson.node_monitors.DiskSpaceMonitor']
      const reason = typeof c?.offlineCauseReason === 'string' ? c.offlineCauseReason.trim() : ''
      return {
        name: typeof c?.displayName === 'string' ? c.displayName : 'unnamed',
        offline: c?.offline === true,
        temporarilyOffline: c?.temporarilyOffline === true,
        ...(reason ? { offlineReason: reason } : {}),
        executors: num(c?.numExecutors) ?? 0,
        idle: c?.idle === true,
        ...(num(disk?.size) !== undefined ? { diskFreeBytes: num(disk.size) } : {}),
        ...(num(disk?.totalSize) !== undefined ? { diskTotalBytes: num(disk.totalSize) } : {})
      }
    })
  }
}

/**
 * Enable or disable a job.
 *
 * A WRITE, and a quiet one. Cancelling a run is visible within the minute;
 * disabling a job produces no failure and no alert -- the next commit simply
 * never builds, and it stays that way until somebody notices. The confirm this
 * sits behind has to say that, because the API will not.
 *
 * Jenkins answers these with a 302 back to the job page on success, the same as
 * the build endpoint, so a redirect is not treated as a failure here. That is
 * also why the login-redirect check in `expectOk` matches on the Location and
 * not on the status: a 302 to the job page and a 302 to an SSO realm are
 * opposite outcomes.
 */
export async function setJenkinsJobEnabled(
  http: CicdHttp,
  pipelineRef: string,
  enabled: boolean
): Promise<CicdTriggerResult> {
  const res = await http({
    method: 'POST',
    path: `/${pipelineRef}/${enabled ? 'enable' : 'disable'}`
  })
  if (res.status !== 302 && (res.status < 200 || res.status >= 300)) {
    expectOk(res, enabled ? 'Enabling the job' : 'Disabling the job')
  }
  return {
    note: enabled
      ? 'Asked Jenkins to enable the job. It will build again on its next trigger.'
      : 'Asked Jenkins to disable the job. Nothing will build it until it is enabled again.'
  }
}

/**
 * Drop one item out of the queue.
 *
 * Not the same verb as cancelling a run, and deliberately a separate function:
 * a queued item has no build number, so there is nothing for `cancelJenkins` to
 * address. Jenkins answers a successful cancel with a redirect and gives no way
 * to distinguish "removed it" from "it had already started" -- the same
 * ambiguity `cancelJenkins` documents -- so the note claims only the request.
 */
export async function cancelJenkinsQueueItem(
  http: CicdHttp,
  itemId: number
): Promise<CicdTriggerResult> {
  const res = await http({ method: 'POST', path: `/queue/cancelItem?id=${encodeURIComponent(String(itemId))}` })
  if (res.status !== 302 && res.status !== 404 && (res.status < 200 || res.status >= 300)) {
    expectOk(res, 'Cancelling a queued item')
  }
  // 404 means it is no longer in the queue, which is either already cancelled or
  // already started. Saying which would be a guess.
  return {
    note:
      res.status === 404
        ? 'That item is no longer in the queue. It has either been cancelled already or has started.'
        : 'Asked Jenkins to drop the queued item. If it had already started, it is now a running build.'
  }
}
