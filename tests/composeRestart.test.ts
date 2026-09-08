import { describe, it, expect } from 'vitest'

import {
  joinComposeState,
  parseComposeConfigJson,
  planComposeServiceRestart,
  type ComposeServiceState
} from '../src/shared/compose'
import { DOCKER_ACTION_MAX_REFS, type DockerContainer } from '../src/shared/docker'

// Item 42's "restart one service" row. Every claim below was measured against a
// real compose project before it was written: one service with an environment
// variable, one with `replicas: 2`.

const CONFIG = JSON.stringify({
  name: 'edge',
  services: {
    cache: { image: 'redis:7.2-alpine' },
    worker: { image: 'busybox:1.36' }
  }
})

const container = (over: Partial<DockerContainer>): DockerContainer => ({
  id: 'a'.repeat(64),
  shortId: 'a'.repeat(12),
  name: 'edge-cache-1',
  image: 'redis:7.2-alpine',
  state: 'running',
  status: 'Up 2 minutes',
  ports: '',
  createdAt: '2026-09-03 12:56:42 +0400 +04',
  composeProject: 'edge',
  composeService: 'cache',
  ...over
})

const config = parseComposeConfigJson(CONFIG)!
const svc = (name: string, containers: DockerContainer[]): ComposeServiceState =>
  joinComposeState('edge', config, containers).services.find((s) => s.declared.name === name)!

describe('restarting a service means restarting its containers', () => {
  it('names the containers rather than the service', () => {
    // The point of routing through the container path: the fan-out is visible
    // before it happens.
    const plan = planComposeServiceRestart(svc('cache', [container({})]))
    expect(plan.targets).toEqual(['edge-cache-1'])
    expect(plan.plan?.action).toBe('restart')
  })

  // Measured: a service declared `replicas: 2` had BOTH containers restarted by
  // `docker compose restart`, named one at a time in its output.
  it('carries every replica, and inherits the escalation that comes with two', () => {
    const plan = planComposeServiceRestart(
      svc('cache', [container({}), container({ name: 'edge-cache-2' })])
    )
    expect(plan.targets).toEqual(['edge-cache-1', 'edge-cache-2'])
    // planDockerAction escalates past one container to a typed phrase. Two
    // replicas restarting at once is exactly what that exists for.
    expect(plan.plan?.confirmation).toEqual({ kind: 'type-to-confirm', phrase: 'RESTART' })
    expect(plan.caveats.some((c) => c.includes('all of them restart'))).toBe(true)
  })

  it('still confirms for a single container, because a restart drops connections', () => {
    const plan = planComposeServiceRestart(svc('cache', [container({})]))
    expect(plan.plan?.risk).toBe('elevated')
    expect(plan.plan?.confirmation).toEqual({ kind: 'confirm' })
  })
})

describe('what a restart will not do', () => {
  // THE finding. With the file changed from `V: one` to `V: two` and
  // `docker compose restart a` run, the container came back still carrying
  // `V=one`; `up -d` recreated it and it became `V=two`.
  it('always says that an edited compose file is not applied by a restart', () => {
    for (const containers of [[container({})], [container({}), container({ name: 'edge-cache-2' })]]) {
      const plan = planComposeServiceRestart(svc('cache', containers))
      expect(plan.caveats[0]).toContain('not applied by a restart')
      expect(plan.caveats[0]).toContain('`up` is what applies the file')
    }
  })

  it('never offers a plan without that caveat attached', () => {
    const plan = planComposeServiceRestart(svc('cache', [container({})]))
    expect(plan.plan).not.toBeNull()
    expect(plan.caveats.length).toBeGreaterThan(0)
  })
})

describe('services it will not restart', () => {
  // `restart` is a lifecycle verb over containers that exist. It does not
  // create one, so offering it for a service that has never been created is
  // offering a button that cannot do what it says.
  it('refuses a declared service with no container, and points at up', () => {
    const plan = planComposeServiceRestart(svc('worker', [container({})]))
    expect(plan.targets).toEqual([])
    expect(plan.plan).toBeNull()
    expect(plan.refusal).toContain('no container to restart')
    expect(plan.refusal).toContain('`up`')
    expect(plan.caveats).toEqual([])
  })

  it('refuses past the number of containers the lifecycle path acts on at once', () => {
    const many = Array.from({ length: DOCKER_ACTION_MAX_REFS + 1 }, (_, i) =>
      container({ name: `edge-cache-${i + 1}` })
    )
    const plan = planComposeServiceRestart(svc('cache', many))
    expect(plan.plan).toBeNull()
    expect(plan.refusal).toContain(String(DOCKER_ACTION_MAX_REFS))
  })

  it('acts on exactly the limit rather than one short of it', () => {
    const many = Array.from({ length: DOCKER_ACTION_MAX_REFS }, (_, i) =>
      container({ name: `edge-cache-${i + 1}` })
    )
    expect(planComposeServiceRestart(svc('cache', many)).plan).not.toBeNull()
  })
})
