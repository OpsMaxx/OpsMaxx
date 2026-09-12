import { describe, expect, it } from 'vitest'
import { createJenkinsAdapter, jenkinsParams, triggerJenkins } from '../src/main/services/cicd/jenkins'
import type { CicdHttp, CicdResponse } from '../src/shared/cicd'

/**
 * The Jenkins adapter, with no socket anywhere.
 *
 * `CicdHttp` is injected for exactly this reason, so the fake below is the
 * whole test harness: it records what the adapter asked for and answers from a
 * table. Most of what can go wrong with Jenkins is a property of the *request*
 * — a missing `tree=`, a folder walk that never ends, a log fetch that
 * re-reads from zero — so the recorded calls are asserted as hard as the
 * returned objects are.
 */

interface Call {
  method: string
  path: string
  headers?: Record<string, string>
  body?: string
}

type Reply = Partial<CicdResponse>

function fake(route: (req: Call) => Reply | undefined): { http: CicdHttp; calls: Call[] } {
  const calls: Call[] = []
  const http: CicdHttp = async (req) => {
    calls.push(req as Call)
    const r = route(req as Call) ?? { status: 404, body: 'not found' }
    return { status: r.status ?? 200, headers: r.headers ?? {}, body: r.body ?? '' }
  }
  return { http, calls }
}

const json = (value: unknown): Reply => ({ status: 200, body: JSON.stringify(value) })

const adapter = (http: CicdHttp, over: Record<string, number> = {}) =>
  createJenkinsAdapter(http, { connectionId: 'c1', ...over })

/** A build as `/api/json` returns it. */
const build = (number: number, over: Record<string, unknown> = {}) => ({
  number,
  timestamp: 1_700_000_000_000 + number,
  duration: 1500,
  building: false,
  result: 'SUCCESS',
  url: `https://ci.example.com/job/app/${number}/`,
  ...over
})

// ---------------------------------------------------------------------------

describe('every read carries a field selector', () => {
  /**
   * A bare `/api/json` on a controller with a few thousand jobs serialises the
   * whole object graph, and Jenkins has no rate limiting to stop you doing it
   * every poll tick. This is the one Jenkins rule that is a production hazard
   * rather than a preference, so it is asserted over every request the adapter
   * makes rather than per call site — a new read added without a `tree=` fails
   * here even if its own test passes.
   */
  it('puts tree= on every /api/json request, and only skips it where Jenkins has no selector', async () => {
    const { http, calls } = fake((req) => {
      if (req.path.includes('/api/json')) return json({ jobs: [], builds: [], property: [] })
      if (req.path.includes('wfapi')) return json({ stages: [] })
      if (req.path.includes('progressiveText')) return { status: 200, body: '' }
      return json({})
    })
    const a = adapter(http)
    await a.listPipelines()
    await a.listRuns('job/app', 10)
    await a.getRun('job/app', '7', 1)
    await a.getLog('job/app', '7', undefined)
    await a.listParams('job/app')

    expect(calls.length).toBeGreaterThan(4)
    for (const c of calls) {
      if (c.path.includes('/api/json')) expect(c.path).toContain('tree=')
      // The only two reads without one, both because the endpoint does not
      // implement the selector at all.
      else expect(c.path).toMatch(/wfapi\/describe|logText\/progressiveText/)
    }
  })

  it('bounds a build list with the range specifier, because Jenkins has no pagination', async () => {
    const { http, calls } = fake(() => json({ builds: [build(2), build(1)] }))
    await adapter(http).listRuns('job/app', 25)
    expect(calls[0].path).toContain('{0,25}')
  })
})

// ---------------------------------------------------------------------------

describe('folders', () => {
  /**
   * Jenkins folders nest arbitrarily, so the tree is walked one folder per
   * request and each folder becomes one `CicdPathSegment`. The path is display
   * grouping, and the ref is the thing every later call is built from, so both
   * are asserted.
   */
  it('emits one path segment per folder and a ref that retraces them', async () => {
    const tree: Record<string, unknown> = {
      '/api/json': { jobs: [{ name: 'team', _class: 'com.cloudbees.hudson.plugins.folder.Folder' }] },
      '/job/team/api/json': {
        jobs: [{ name: 'web app', _class: 'com.cloudbees.hudson.plugins.folder.Folder' }]
      },
      '/job/team/job/web%20app/api/json': {
        jobs: [
          { name: 'deploy', _class: 'hudson.model.FreeStyleProject', buildable: true },
          { name: 'retired', _class: 'hudson.model.FreeStyleProject', buildable: false }
        ]
      }
    }
    const { http } = fake((req) => {
      const body = tree[req.path.split('?')[0]]
      return body ? json(body) : undefined
    })

    const pipelines = await adapter(http).listPipelines()
    expect(pipelines.map((p) => p.ref)).toEqual([
      'job/team/job/web%20app/job/deploy',
      'job/team/job/web%20app/job/retired'
    ])
    expect(pipelines[0].groupPath).toEqual([
      { id: 'job/team', label: 'team' },
      { id: 'job/team/job/web%20app', label: 'web app' }
    ])
    // `buildable: false` is a disabled job. Jenkins says so plainly, unlike
    // GitHub, so the Run button can be honestly absent.
    expect(pipelines.map((p) => p.triggerable)).toEqual([true, false])
  })

  it('treats a multibranch project as a folder, so branches land one level down', async () => {
    const { http } = fake((req) =>
      req.path.startsWith('/api/json')
        ? json({
            jobs: [{ name: 'svc', _class: 'org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject' }]
          })
        : json({ jobs: [{ name: 'main', _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob', buildable: true }] })
    )
    const pipelines = await adapter(http).listPipelines()
    expect(pipelines).toHaveLength(1)
    expect(pipelines[0].name).toBe('main')
    expect(pipelines[0].groupPath.map((s) => s.label)).toEqual(['svc'])
  })

  /**
   * The walk must not depend on the tree being finite. This controller answers
   * every folder with a folder of the same name, which is what a misconfigured
   * org folder — or a hostile response — looks like from here.
   */
  it('terminates on a folder tree that contains itself', async () => {
    const { http, calls } = fake(() =>
      json({ jobs: [{ name: 'loop', _class: 'com.cloudbees.hudson.plugins.folder.Folder' }] })
    )
    const pipelines = await adapter(http, { maxDepth: 4 }).listPipelines()
    expect(pipelines).toEqual([])
    // Root plus one request per level, and no more.
    expect(calls.length).toBe(4)
  })

  it('stops at the job cap rather than walking a whole controller', async () => {
    const { http } = fake(() =>
      json({ jobs: Array.from({ length: 50 }, (_, i) => ({ name: `j${i}`, buildable: true })) })
    )
    expect(await adapter(http, { maxJobs: 12 }).listPipelines()).toHaveLength(12)
  })
})

// ---------------------------------------------------------------------------

describe('runs', () => {
  it.each([
    ['a finished pass', { building: false, result: 'SUCCESS' }, 'success', undefined],
    // UNSTABLE is neither pass nor fail; folding it into failed misreports a lot
    // of builds, hence the warning flag rather than a ninth status.
    ['an unstable build', { building: false, result: 'UNSTABLE' }, 'success', true],
    ['a failure', { building: false, result: 'FAILURE' }, 'failed', undefined],
    ['an abort', { building: false, result: 'ABORTED' }, 'canceled', undefined],
    ['a skipped build', { building: false, result: 'NOT_BUILT' }, 'skipped', undefined],
    // `result` is null while building, which is why the two fields are read
    // together rather than one being derived from the other.
    ['work in progress', { building: true, result: null }, 'running', undefined],
    ['a job that never ran', { building: false, result: null }, 'unknown', undefined]
  ])('maps %s', async (_label, over, status, warning) => {
    const { http } = fake(() => json({ builds: [build(9, over)] }))
    const [run] = await adapter(http).listRuns('job/app', 5)
    expect(run.outcome.status).toBe(status)
    expect(run.outcome.warning).toBe(warning)
  })

  it('reports the plain build number as the id, with the job path on pipelineRef', async () => {
    const { http } = fake(() => json({ builds: [build(41), build(40, { building: true, result: null, duration: 0 })] }))
    const runs = await adapter(http).listRuns('job/team/job/app', 5)
    expect(runs.map((r) => r.id)).toEqual(['41', '40'])
    expect(runs.every((r) => r.pipelineRef === 'job/team/job/app')).toBe(true)
    expect(runs.map((r) => r.label)).toEqual(['#41', '#40'])
    // Jenkins reports 0 for a build still running; 0ms is not a duration.
    expect(runs[1].durationMs).toBeUndefined()
    // There is no re-run-in-place: a rebuild is a new number.
    expect(runs.every((r) => r.attempt === 1)).toBe(true)
  })

  it('addresses a build as the job path plus the build number', async () => {
    const seen: string[] = []
    const { http } = fake((req) => {
      seen.push(req.path.split('?')[0])
      return req.path.includes('wfapi') ? json({ stages: [] }) : json(build(7))
    })
    const { run } = await adapter(http).getRun('job/app', '7', 1)
    expect(seen.filter((p) => p.endsWith('/api/json'))).toEqual(['/job/app/7/api/json'])
    expect(run.id).toBe('7')
  })

  it('reads stages when workflow-api answers, and survives a freestyle job that has none', async () => {
    const withStages = fake((req) =>
      req.path.includes('wfapi')
        ? json({
            stages: [
              { name: 'Build', status: 'SUCCESS', durationMillis: 900 },
              { name: 'Test', status: 'FAILED', durationMillis: 120 },
              { name: 'Deploy', status: 'IN_PROGRESS' }
            ]
          })
        : json(build(3))
    )
    const { steps } = await adapter(withStages.http).getRun('job/app', '3', 1)
    expect(steps.map((s) => [s.name, s.outcome.status])).toEqual([
      ['Build', 'success'],
      ['Test', 'failed'],
      ['Deploy', 'running']
    ])

    // A freestyle job has no stages and the plugin may not be installed at all.
    // Neither is an error worth surfacing.
    const without = fake((req) => (req.path.includes('wfapi') ? { status: 404 } : json(build(3))))
    expect((await adapter(without.http).getRun('job/app', '3', 1)).steps).toEqual([])
  })
})

// ---------------------------------------------------------------------------

describe('progressive log', () => {
  /**
   * The one real live tail among the three providers. The cursor is a byte
   * offset the server hands back, so the test follows two fetches in sequence:
   * getting this wrong means either re-reading the whole log every tick or
   * silently dropping the middle of it.
   */
  it('advances the cursor and stops when X-More-Data goes away', async () => {
    const pages: Reply[] = [
      { status: 200, headers: { 'X-Text-Size': '120', 'X-More-Data': 'true' }, body: 'first half' },
      { status: 200, headers: { 'X-Text-Size': '260' }, body: 'second half' }
    ]
    const { http, calls } = fake(() => pages.shift())
    const a = adapter(http)

    const one = await a.getLog('job/app', '12', undefined)
    expect(calls[0].path).toBe('/job/app/12/logText/progressiveText?start=0')
    expect(one).toMatchObject({ mode: 'live', text: 'first half', cursor: '120', more: true })

    const two = await a.getLog('job/app', '12', undefined, one.cursor)
    expect(calls[1].path).toBe('/job/app/12/logText/progressiveText?start=120')
    // Absent header means the build is done: nothing more is coming.
    expect(two).toMatchObject({ text: 'second half', cursor: '260', more: false })
  })

  /**
   * JENKINS-75081 was Jetty's gzip handler buffering the whole response, so
   * `start` is not the mitigation — and the first fetch of a finished build is
   * `start=0` by definition. `identity` is the mitigation, and the cap is the
   * rest of it.
   */
  it('asks for an unencoded body', async () => {
    const { http, calls } = fake(() => ({ status: 200, body: '' }))
    await adapter(http).getLog('job/app', '1', undefined)
    expect(calls[0].headers?.['Accept-Encoding']).toBe('identity')
  })

  it('caps the fetch, keeps the end, and says how much it dropped', async () => {
    const { http } = fake(() => ({ status: 200, headers: { 'x-text-size': '5000' }, body: 'x'.repeat(300) + 'TAIL' }))
    const chunk = await adapter(http, { maxLogBytes: 100 }).getLog('job/app', '1', undefined)
    expect(chunk.text).toHaveLength(100)
    expect(chunk.text.endsWith('TAIL')).toBe(true)
    expect(chunk.withheldBytes).toBe(204)
    // The cursor is still the server's, so the next fetch resumes rather than
    // re-reading what was withheld.
    expect(chunk.cursor).toBe('5000')
  })
})

// ---------------------------------------------------------------------------

describe('parameters', () => {
  it.each([
    ['hudson.model.StringParameterDefinition', 'string'],
    ['hudson.model.TextParameterDefinition', 'string'],
    ['hudson.model.BooleanParameterDefinition', 'boolean'],
    ['hudson.model.ChoiceParameterDefinition', 'choice'],
    ['hudson.model.PasswordParameterDefinition', 'password']
  ])('maps %s', async (cls, type) => {
    const { http } = fake(() =>
      json({ property: [{ parameterDefinitions: [{ _class: cls, name: 'p', choices: ['a', 'b'] }] }] })
    )
    const [param] = await jenkinsParams(http, 'job/app')
    expect(param.type).toBe(type)
  })

  // The loose export stays, but the adapter member is the supported path.
  it('is reachable through the adapter', async () => {
    const { http } = fake(() =>
      json({ property: [{ parameterDefinitions: [{ _class: 'hudson.model.StringParameterDefinition', name: 'BRANCH' }] }] })
    )
    expect((await adapter(http).listParams('job/app')).map((p) => p.key)).toEqual(['BRANCH'])
  })

  /**
   * A password parameter's `defaultParameterValue` is an encrypted blob. It has
   * no business leaving this function: the form renders an empty secret field,
   * and the user retypes it or does not trigger.
   */
  it('never carries a password default back out, and always asks for one', async () => {
    const { http } = fake(() =>
      json({
        property: [
          {
            parameterDefinitions: [
              {
                _class: 'hudson.model.PasswordParameterDefinition',
                name: 'DEPLOY_KEY',
                defaultParameterValue: { value: '{AQAAABAAAAAQhunter2}' }
              },
              {
                _class: 'hudson.model.StringParameterDefinition',
                name: 'BRANCH',
                defaultParameterValue: { value: 'main' }
              },
              {
                _class: 'hudson.model.BooleanParameterDefinition',
                name: 'DRY_RUN',
                defaultParameterValue: { value: false }
              },
              {
                _class: 'hudson.model.ChoiceParameterDefinition',
                name: 'ENV',
                choices: ['staging', 'prod']
              }
            ]
          }
        ]
      })
    )
    const params = await jenkinsParams(http, 'job/app')
    expect(params).toEqual([
      { key: 'DEPLOY_KEY', label: 'DEPLOY_KEY', type: 'password', required: true, default: undefined, choices: undefined },
      { key: 'BRANCH', label: 'BRANCH', type: 'string', required: false, default: 'main', choices: undefined },
      // A boolean default of `false` is a default, not an absent one.
      { key: 'DRY_RUN', label: 'DRY_RUN', type: 'boolean', required: false, default: 'false', choices: undefined },
      { key: 'ENV', label: 'ENV', type: 'choice', required: true, default: undefined, choices: ['staging', 'prod'] }
    ])
    expect(JSON.stringify(params)).not.toContain('hunter2')
  })
})

// ---------------------------------------------------------------------------

describe('triggering', () => {
  /**
   * Jenkins answers a trigger with a queue item, which may wait indefinitely
   * for an executor and may be cancelled before it is ever a build. Returning a
   * `run` here would be inventing one.
   */
  it('returns a queue item and no run', async () => {
    const { http, calls } = fake(() => ({
      status: 201,
      headers: { Location: 'https://ci.example.com/queue/item/47/' }
    }))
    const result = await triggerJenkins(http, 'job/team/job/app')
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/job/team/job/app/build' })
    // No crumb round trip: API-token requests are exempt, and fetching one
    // costs a request per write and breaks behind some proxies.
    expect(calls).toHaveLength(1)
    expect(result.run).toBeUndefined()
    expect(result.queueRef).toBe('queue/item/47')
    expect(result.note).toMatch(/build number appears when an executor picks it up/)
  })

  it('says so honestly when there is no queue item to follow', async () => {
    const { http } = fake(() => ({ status: 201, headers: {} }))
    const result = await triggerJenkins(http, 'job/app')
    expect(result.queueRef).toBeUndefined()
    expect(result.run).toBeUndefined()
    expect(result.note).toMatch(/no queue item/)
  })

  it('posts parameters as a form, to the other endpoint', async () => {
    const { http, calls } = fake(() => ({ status: 201, headers: { location: '/queue/item/9/' } }))
    await triggerJenkins(http, 'job/app', { BRANCH: 'release/1.2', DRY_RUN: 'true' })
    expect(calls[0].path).toBe('/job/app/buildWithParameters')
    expect(calls[0].headers?.['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(calls[0].body).toBe('BRANCH=release%2F1.2&DRY_RUN=true')
  })
})

// ---------------------------------------------------------------------------

describe('verify, and the 403 that means nothing in particular', () => {
  const whoAmI = (over: Record<string, unknown> = {}) => json({ name: 'zeeshan', authenticated: true, ...over })

  it('accepts an API token: reads work and the write probe is not refused for a crumb', async () => {
    const { http, calls } = fake((req) => (req.method === 'POST' ? { status: 405 } : whoAmI()))
    expect(await adapter(http).verify()).toEqual({ identity: 'zeeshan' })
    // The POST is the whole point of the second request — it runs the CSRF
    // filter, which a GET never touches.
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST'])
    expect(calls[0].path).toContain('tree=')
  })

  /**
   * The failure this exists for. Jenkins accepts an account password over Basic
   * and a password is not crumb-exempt, so a pasted password reads every
   * endpoint fine and then 403s on the user's first trigger, hours after the
   * connect wizard said everything was fine.
   */
  it.each([
    ['the body', { status: 403, body: 'No valid crumb was included in the request' }],
    ['the X-Error header', { status: 403, headers: { 'X-Error': 'No valid crumb was included in the request' } }]
  ])('catches a password at connect time from %s', async (_where, refusal) => {
    const { http } = fake((req) => (req.method === 'POST' ? refusal : whoAmI()))
    await expect(adapter(http).verify()).rejects.toThrow(/looks like a password, not an API token/)
  })

  /**
   * A 403 without a crumb in it says nothing: Jenkins returns 403 for a
   * rejected credential, a missing permission and a missing crumb alike. Reads
   * worked, so the connection is usable read-only — which the UX calls a
   * legitimate partial success, not a failed verify.
   */
  it('does not read a plain 403 on the write probe as a bad credential', async () => {
    const { http } = fake((req) => (req.method === 'POST' ? { status: 403, body: 'Forbidden' } : whoAmI()))
    expect(await adapter(http).verify()).toEqual({ identity: 'zeeshan' })
  })

  it('names the proxy case rather than reporting a bad token', async () => {
    const { http } = fake(() => whoAmI({ name: 'anonymous', authenticated: false }))
    await expect(adapter(http).verify()).rejects.toThrow(/anonymous/)
  })

  it('refuses to guess which of the three things a 403 was', async () => {
    const { http } = fake(() => ({ status: 403, body: 'Forbidden' }))
    await expect(adapter(http).listPipelines()).rejects.toThrow(
      /rejected credential, a missing permission and a missing CSRF crumb alike/
    )
  })

  it('names an SSO login page for what it is instead of throwing a parse error', async () => {
    const { http } = fake(() => ({ status: 200, body: '<html><body>Sign in</body></html>' }))
    await expect(adapter(http).listPipelines()).rejects.toThrow(/not JSON/)
  })
})

// ---------------------------------------------------------------------------

describe('apiRoot', () => {
  // Jenkins sits at whatever context path its admin chose. Assuming the host
  // root is the single most common way to get this wrong.
  it.each([
    ['https://ci.example.com', 'https://ci.example.com'],
    ['https://ci.example.com/', 'https://ci.example.com'],
    ['https://ci.example.com/jenkins/', 'https://ci.example.com/jenkins'],
    ['  https://ci.example.com/build/jenkins//  ', 'https://ci.example.com/build/jenkins']
  ])('keeps the context path in %s', (input, expected) => {
    const { http } = fake(() => undefined)
    expect(adapter(http).apiRoot(input)).toBe(expected)
  })
})
