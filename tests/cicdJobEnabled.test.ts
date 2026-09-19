import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CicdConnection, CicdPanelState, CicdPipeline, CicdResponse } from '../src/shared/cicd'

/**
 * Enable / disable, and the reason pressing it appeared to do nothing.
 *
 * Jenkins answers `/enable` and `/disable` with a 302 and an empty body, so the
 * only evidence of what happened is `buildable` on a subsequent job read. That
 * field arrives with `listPipelines` and with nothing else -- the poller
 * re-reads RUNS -- so before this change the panel's control was rendered off a
 * value that could not move, however many times it was pressed. These pin the
 * re-read, not the POST: a test that asserted only "a POST went out" is exactly
 * the test that passed against the broken version.
 */

const CONNECTION: CicdConnection = {
  id: 'c1',
  workspaceId: 'ws-1',
  name: 'Build controller',
  provider: 'jenkins',
  baseUrl: 'https://ci.example.internal',
  username: 'zeeshan',
  vaultEntryId: 'v1',
  route: { kind: 'direct' },
  enabled: true
}

/** What the fake controller currently says about the job. Flipped by the POST. */
let buildable = true
/** Every request the Jenkins adapter made, in order. */
let sent: { method: string; path: string }[] = []
/** How many times the job list was read. */
let discoveries = 0

const pipeline = (): CicdPipeline => ({
  connectionId: 'c1',
  ref: 'job/trivy',
  name: 'trivy',
  groupPath: [],
  triggerable: buildable
})

vi.mock('../src/main/services/store', () => ({
  loadData: () => ({ cicdConnections: [CONNECTION] })
}))

vi.mock('../src/main/services/vault', () => ({
  vaultList: () => ({ ok: true, entries: [] }),
  vaultSave: () => ({ ok: true })
}))

vi.mock('../src/main/services/cicd/service', () => ({
  resolveSecret: () => 'token-abc',
  // The real Jenkins write function runs against this; it is the thing under
  // test on the provider side.
  makeCicdHttp: () => async (req: { method: string; path: string }): Promise<CicdResponse> => {
    sent.push({ method: req.method, path: req.path })
    if (/\/(enable|disable)$/.test(req.path)) {
      buildable = req.path.endsWith('/enable')
      // Exactly what Jenkins sends: a redirect back to the job page, no body.
      return { status: 302, headers: { location: '/job/trivy/' }, body: '' }
    }
    return { status: 200, headers: {}, body: '{}' }
  },
  createCicdAdapter: () => ({
    listPipelines: async () => {
      discoveries++
      return [pipeline()]
    }
  })
}))

import {
  configure,
  dispose,
  setJobEnabled,
  snapshot
} from '../src/main/services/cicd/wiring'

const settle = async (): Promise<void> => {
  // Discovery is async and self-scheduling; two macrotask turns is enough for
  // the loop in `discover` to run to completion without a fake clock.
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
}

let emitted: CicdPanelState[] = []

beforeEach(async () => {
  dispose()
  buildable = true
  sent = []
  discoveries = 0
  emitted = []
  configure((s) => emitted.push(s))
  await settle()
})

describe('setJobEnabled', () => {
  it('POSTs the verb Jenkins understands', async () => {
    await setJobEnabled('c1', 'job/trivy', false)
    expect(sent.some((r) => r.method === 'POST' && r.path === '/job/trivy/disable')).toBe(true)
  })

  it('treats the 302 Jenkins answers with as success, not as a failure', async () => {
    // `expectOk` rejects a redirect everywhere else, because a redirect target
    // does not inherit the credential. The write endpoints are the exception.
    await expect(setJobEnabled('c1', 'job/trivy', false)).resolves.toMatchObject({
      note: expect.stringContaining('disable')
    })
  })

  it('re-reads the job list afterwards, which is the only way the state can move', async () => {
    const before = discoveries
    await setJobEnabled('c1', 'job/trivy', false)
    expect(discoveries).toBe(before + 1)
  })

  it('leaves the panel holding the NEW buildable state, not the one it started with', async () => {
    expect(snapshot()[0].pipelines[0].triggerable).toBe(true)
    await setJobEnabled('c1', 'job/trivy', false)
    // The assertion the old code could not satisfy: the write landed on the
    // controller AND the state the control renders from followed it.
    expect(snapshot()[0].pipelines[0].triggerable).toBe(false)

    await setJobEnabled('c1', 'job/trivy', true)
    expect(snapshot()[0].pipelines[0].triggerable).toBe(true)
  })

  it('tells the panel without waiting for the next poll', async () => {
    emitted = []
    await setJobEnabled('c1', 'job/trivy', false)
    const last = emitted.at(-1)
    expect(last?.connectionId).toBe('c1')
    expect(last?.pipelines[0].triggerable).toBe(false)
  })

  it('refuses a provider that has no such verb, by name', async () => {
    await expect(setJobEnabled('c1', 'job/trivy', false)).resolves.toBeTruthy()
    // The same call against a GitHub connection is refused in `setJobEnabled`
    // before any request is made; proven here by the provider check's message
    // naming the provider rather than saying "unsupported".
    const github = { ...CONNECTION, provider: 'github' as const }
    const { reload } = await import('../src/main/services/cicd/wiring')
    reload({ cicdConnections: [github] })
    await expect(setJobEnabled('c1', 'job/trivy', false)).rejects.toThrow(/github/i)
  })
})

describe('the reading flag', () => {
  it('is set while a job list is being read and cleared when it lands', async () => {
    // The panel cannot know this: it does not make the request. Without it a
    // slow first GitHub discovery renders as "not read yet ... the account is
    // not being polled", which reads as a rejected token.
    const duringFirstDiscovery = emitted.find((s) => s.reading === true)
    expect(duringFirstDiscovery).toBeDefined()
    expect(duringFirstDiscovery?.readAt).toBeUndefined()
    expect(snapshot()[0].reading).toBeUndefined()
  })

  it('does not claim a read at the epoch for an account that has never answered', async () => {
    // `reading` used to be stamped alongside `at: 0`, which `panelState` then
    // reported as a successful read in January 1970.
    const first = emitted.find((s) => s.reading === true)
    expect(first?.readAt).toBeUndefined()
    expect(first?.readAt).not.toBe(0)
  })

  it('goes up again for the re-read a write triggers', async () => {
    emitted = []
    await setJobEnabled('c1', 'job/trivy', false)
    expect(emitted.some((s) => s.reading === true)).toBe(true)
    expect(emitted.at(-1)?.reading).toBeUndefined()
  })
})
