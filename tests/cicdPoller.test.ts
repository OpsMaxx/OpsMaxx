import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  CicdPoller,
  POLL_INTERVAL_MS,
  pollCacheKey,
  type CicdPollRequest,
  type CicdPollResponse,
  type CicdPollTarget
} from '../src/main/services/cicd/poller'
import type { CicdConnection, CicdRun } from '../src/shared/cicd'

/**
 * The poller, with no socket anywhere.
 *
 * `ServiceCheckRunner`'s tests ask "does it keep running when nobody is
 * looking". These ask the questions that one has no vocabulary for: does a
 * conditional request stay conditional, does a busy provider get asked less
 * often, does an expected 404 get mistaken for a broken endpoint, and does a
 * row that could not be read say so rather than quietly turning green.
 */

const connection = (over: Partial<CicdConnection> = {}): CicdConnection => ({
  id: 'c1',
  workspaceId: 'w1',
  name: 'Build',
  provider: 'github',
  baseUrl: 'https://github.com',
  vaultEntryId: 'v1',
  route: { kind: 'direct' },
  enabled: true,
  ...over
})

const target = (over: Partial<CicdPollTarget> = {}): CicdPollTarget => ({
  id: 't1',
  connectionId: 'c1',
  pipelineRef: 'acme/app#.github/workflows/ci.yml',
  kind: 'runs',
  ...over
})

const run = (id: string): CicdRun => ({
  connectionId: 'c1',
  pipelineRef: 'acme/app#.github/workflows/ci.yml',
  id,
  attempt: 1,
  label: `#${id}`,
  outcome: { status: 'success' }
})

let poller: CicdPoller | null = null

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  poller?.dispose()
  poller = null
  vi.useRealTimers()
})

/** Let the read promise settle as well as the timer fire. */
const settle = async (ms = 1): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
}

const GH = POLL_INTERVAL_MS.github

// ---------------------------------------------------------------------------

describe('scheduling', () => {
  it('reads as soon as it is configured, rather than after one interval', async () => {
    const emit = vi.fn()
    poller = new CicdPoller({ read: async () => ({ status: 200, runs: [run('1')] }), emit })
    poller.configure([connection()], [target()])
    await settle()
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0][0].target.state).toBe('ok')
  })

  it('gives each provider its own budget', async () => {
    // Not a preference. GitHub has a hard 5,000/hr ceiling and secondary limits
    // that bite first; Jenkins publishes none at all.
    expect(POLL_INTERVAL_MS.jenkins).toBeLessThan(POLL_INTERVAL_MS.gitlab)
    expect(POLL_INTERVAL_MS.gitlab).toBeLessThan(POLL_INTERVAL_MS.github)

    const reads: string[] = []
    poller = new CicdPoller({
      read: async (req) => {
        reads.push(req.connection.provider)
        return { status: 200, runs: [] }
      },
      emit: vi.fn()
    })
    poller.configure(
      [connection({ id: 'c1', provider: 'jenkins' }), connection({ id: 'c2', provider: 'github' })],
      [target({ id: 't1', connectionId: 'c1' }), target({ id: 't2', connectionId: 'c2' })]
    )
    await settle()
    await settle(POLL_INTERVAL_MS.jenkins * 3)
    expect(reads.filter((p) => p === 'jenkins').length).toBeGreaterThan(
      reads.filter((p) => p === 'github').length
    )
  })

  it('does not ask a connection twice at once', async () => {
    let concurrent = 0
    let peak = 0
    // A box rather than a bare `let`: TypeScript narrows a `let` assigned only
    // inside a callback to its initialiser at every later use, so `release?.()`
    // below reads as a call on `null`. The property access defeats that without
    // a cast that would also hide a real mistake.
    const gate: { release?: () => void } = {}
    poller = new CicdPoller({
      read: async () => {
        concurrent++
        peak = Math.max(peak, concurrent)
        await new Promise<void>((r) => (gate.release = r))
        concurrent--
        return { status: 200, runs: [] }
      },
      emit: vi.fn()
    })
    // Two targets on ONE connection. Serial per account is the rule: GitHub's
    // secondary limits (≤100 concurrent, 900 points/min) trip long before its
    // primary one, and a Promise.all across repos is how that happens.
    poller.configure([connection()], [target({ id: 't1' }), target({ id: 't2' })])
    await settle()
    await settle(GH * 2)
    expect(peak).toBe(1)
    gate.release?.()
    await settle()
  })
})

// ---------------------------------------------------------------------------

describe('conditional requests', () => {
  it('has no way to put a clock in the cache key', () => {
    // The defence against `created=>${now}` is structural: the key is derived
    // from the target, and the target type has nowhere to put a timestamp. Two
    // reads of the same target are the same query, always.
    expect(pollCacheKey(target())).toBe(pollCacheKey(target()))
    expect(pollCacheKey(target({ limit: 5 }))).not.toBe(pollCacheKey(target({ limit: 20 })))
    expect(pollCacheKey(target({ kind: 'log', runId: '9' }))).not.toBe(pollCacheKey(target()))
  })

  it('replays the ETag it was given, against the same key', async () => {
    const seen: CicdPollRequest[] = []
    poller = new CicdPoller({
      read: async (req) => {
        seen.push(req)
        return { status: 200, runs: [run('1')], etag: 'W/"abc"' }
      },
      emit: vi.fn()
    })
    poller.configure([connection()], [target()])
    await settle()
    await settle(GH)
    expect(seen.length).toBeGreaterThan(1)
    expect(seen[0].etag).toBeUndefined()
    expect(seen[1].etag).toBe('W/"abc"')
    expect(seen[1].cacheKey).toBe(seen[0].cacheKey)
  })

  it('treats a 304 as a successful read and leaves the runs standing', async () => {
    let first = true
    poller = new CicdPoller({
      read: async () =>
        first ? ((first = false), { status: 200, runs: [run('1')], etag: 'W/"a"' }) : { status: 304 },
      emit: vi.fn()
    })
    poller.configure([connection()], [target()])
    await settle()
    const before = poller.snapshot().targets[0].readAt
    await settle(GH)
    const after = poller.snapshot().targets[0]
    // A 304 is free on GitHub and it is not a stale read: the cached answer is
    // current by definition, so freshness moves and the rows do not.
    expect(after.state).toBe('ok')
    expect(after.runs.map((r) => r.id)).toEqual(['1'])
    expect(after.readAt).toBeGreaterThan(before ?? 0)
  })
})

// ---------------------------------------------------------------------------

describe('backing off', () => {
  it('honours Retry-After on a 429', async () => {
    const at: number[] = []
    poller = new CicdPoller({
      read: async () => {
        at.push(Date.now())
        return { status: 429, retryAfterMs: 90_000, error: 'rate limited' }
      },
      emit: vi.fn()
    })
    poller.configure([connection()], [target()])
    await settle()
    expect(at.length).toBe(1)

    // The provider's own number wins over anything computed: it knows when it
    // will answer and we do not. A full provider interval is not enough.
    await settle(GH)
    expect(at.length).toBe(1)
    await settle(30_000)
    expect(at.length).toBe(2)
  })

  it('grows exponentially on 5xx and stops at five minutes', async () => {
    let calls = 0
    poller = new CicdPoller({
      read: async () => {
        calls++
        return { status: 503 }
      },
      emit: vi.fn()
    })
    poller.configure([connection()], [target()])
    await settle()
    expect(calls).toBe(1)

    // 60s, then 120s, then 240s, then capped.
    await settle(GH)
    expect(calls).toBe(2)
    await settle(GH)
    expect(calls).toBe(2)
    await settle(GH)
    expect(calls).toBe(3)

    // Whatever it climbed to, it is never more than five minutes away.
    for (let i = 0; i < 20; i++) await settle(5 * 60_000)
    const before = calls
    await settle(5 * 60_000 + 1_000)
    expect(calls).toBeGreaterThan(before)
  })

  it('recovers immediately once the provider answers', async () => {
    let status = 503
    const at: number[] = []
    poller = new CicdPoller({
      read: async () => {
        at.push(Date.now())
        return status === 503 ? { status: 503 } : { status: 200, runs: [] }
      },
      emit: vi.fn()
    })
    poller.configure([connection()], [target()])
    await settle()
    status = 200
    await settle(GH * 2)
    const recovered = at.length
    await settle(GH)
    expect(at.length).toBe(recovered + 1)
  })

  it('does NOT back off on a 404 for an in-progress job log', async () => {
    // The single most consequential branch in this file. A running job's log
    // does not exist yet and the endpoint 404s rather than returning partials.
    // Reading that as a failing endpoint would back off every RUNNING build in
    // the estate — the poller would go quiet on exactly the builds somebody is
    // watching.
    const at: number[] = []
    poller = new CicdPoller({
      read: async () => {
        at.push(Date.now())
        return { status: 404 }
      },
      emit: vi.fn()
    })
    poller.configure([connection()], [target({ kind: 'log', runId: '42' })])
    await settle()
    await settle(GH)
    await settle(GH)
    expect(at.length).toBe(3)

    const state = poller.snapshot().targets[0]
    expect(state.state).toBe('pending')
    expect(state.error).toBeUndefined()
    // Nothing was read, so it must not claim to have been.
    expect(state.readAt).toBeUndefined()
  })

  it('still treats a 404 on a run list as a failure', async () => {
    poller = new CicdPoller({ read: async () => ({ status: 404 }), emit: vi.fn() })
    poller.configure([connection()], [target({ kind: 'runs' })])
    await settle()
    expect(poller.snapshot().targets[0].state).toBe('stale')
  })
})

// ---------------------------------------------------------------------------

describe('what a failed read does to a row', () => {
  it('ages it rather than clearing it', async () => {
    let res: CicdPollResponse = { status: 200, runs: [run('1'), run('2')] }
    poller = new CicdPoller({ read: async () => res, emit: vi.fn(), change: vi.fn() })
    poller.configure([connection()], [target()])
    await settle()
    const fresh = poller.snapshot().targets[0]
    expect(fresh.runs).toHaveLength(2)

    res = { status: 0, error: 'getaddrinfo ENOTFOUND github.com' }
    await settle(GH)
    const aged = poller.snapshot().targets[0]
    // The rows survive, the freshness does not, and the reason is on the row.
    // A pipeline that vanished or went blank because one request timed out is a
    // lie the user cannot see.
    expect(aged.runs.map((r) => r.id)).toEqual(['1', '2'])
    expect(aged.state).toBe('stale')
    expect(aged.readAt).toBe(fresh.readAt)
    expect(aged.attemptedAt).toBeGreaterThan(fresh.attemptedAt ?? 0)
    expect(aged.error).toContain('ENOTFOUND')
  })

  it('survives a thrown read the same way', async () => {
    let boom = false
    poller = new CicdPoller({
      read: async () => {
        if (boom) throw new Error('socket hang up')
        return { status: 200, runs: [run('1')] }
      },
      emit: vi.fn()
    })
    poller.configure([connection()], [target()])
    await settle()
    boom = true
    await settle(GH)
    const aged = poller.snapshot().targets[0]
    expect(aged.runs).toHaveLength(1)
    expect(aged.error).toContain('socket hang up')
  })

  it('reports a change once, not every interval', async () => {
    let status = 200
    const change = vi.fn()
    poller = new CicdPoller({
      read: async () => (status === 200 ? { status, runs: [] } : { status }),
      emit: vi.fn(),
      change
    })
    poller.configure([connection()], [target()])
    await settle()
    status = 500
    await settle(GH)
    await settle(5 * 60_000)
    await settle(5 * 60_000)
    // ok → stale is one transition, however many failing reads follow it.
    expect(change).toHaveBeenCalledTimes(1)
    expect(change.mock.calls[0][0].target.state).toBe('stale')
  })
})

// ---------------------------------------------------------------------------

describe('what a panel can ask it', () => {
  it('surfaces the rate budget and the last successful read', async () => {
    poller = new CicdPoller({
      read: async () => ({
        status: 200,
        runs: [],
        rate: { remaining: 4812, limit: 5000, resetAt: 1_700_000_000_000 }
      }),
      emit: vi.fn()
    })
    poller.configure([connection()], [target()])
    await settle()
    expect(poller.budget('c1')).toEqual({
      remaining: 4812,
      limit: 5000,
      resetAt: 1_700_000_000_000
    })
    expect(poller.snapshot().connections[0].lastReadAt).toBeGreaterThan(0)
  })

  it('keeps a bounded history a freshly mounted panel can read', async () => {
    poller = new CicdPoller({ read: async () => ({ status: 200, runs: [] }), emit: vi.fn() })
    poller.configure([connection()], [target()])
    await settle()
    for (let i = 0; i < 60; i++) await settle(GH)
    const rows = poller.snapshot().history.t1
    expect(rows.length).toBeGreaterThan(1)
    expect(rows.length).toBeLessThanOrEqual(50)
    expect(rows[rows.length - 1].status).toBe(200)
  })

  it('forgets a target that is no longer configured', async () => {
    poller = new CicdPoller({ read: async () => ({ status: 200, runs: [] }), emit: vi.fn() })
    poller.configure([connection()], [target({ id: 't1' }), target({ id: 't2' })])
    await settle()
    await settle(GH)
    poller.configure([connection()], [target({ id: 't1' })])
    expect(poller.snapshot().targets.map((t) => t.targetId)).toEqual(['t1'])
  })

  it('stops polling a disabled connection', async () => {
    const read = vi.fn(async () => ({ status: 200, runs: [] }))
    poller = new CicdPoller({ read, emit: vi.fn() })
    poller.configure([connection()], [target()])
    await settle()
    const before = read.mock.calls.length
    poller.configure([connection({ enabled: false })], [target()])
    await settle(GH * 3)
    expect(read.mock.calls.length).toBe(before)
  })
})

describe('a target dropped while its read was in flight', () => {
  // `disposed` covers teardown. This covers the far more common case: the
  // connection list simply changed. Applying a late result re-inserted three
  // map entries for a target nobody polls any more, and emitted an event for
  // it — zombies that survived until the next reconfigure happened to run.
  it('does not resurrect itself in the snapshot', async () => {
    const gate: { release?: () => void } = {}
    const emit = vi.fn()
    poller = new CicdPoller({
      read: async () => {
        await new Promise<void>((r) => (gate.release = r))
        return { status: 200, runs: [] }
      },
      emit
    })
    poller.configure([connection()], [target({ id: 't1' })])
    await settle()

    // Drop it mid-flight, then let the read land.
    poller.configure([connection()], [])
    gate.release?.()
    await settle()

    expect(poller.snapshot().targets.map((t) => t.targetId)).not.toContain('t1')
    expect(emit.mock.calls.flat()).toEqual([])
  })
})
