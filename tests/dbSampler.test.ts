import { describe, it, expect, vi } from 'vitest'

import {
  DB_SAMPLE_MIN_INTERVAL_MS,
  DbSampler,
  type DbSamplerConfig,
  type DbSamplerDeps
} from '../src/main/services/dbSampler'

// Item 47's `dbSampler`. Modelled on `fleetSampler` and deliberately smaller,
// because what it costs is different in kind: a metrics sweep is an SSH exec
// channel, and this takes a CONNECTION on somebody's database server.

const T0 = Date.UTC(2026, 5, 1)

/** A hand-driven clock and timer, so nothing here waits on real time. */
function harness(over: Partial<DbSamplerDeps> = {}): {
  sampler: DbSampler
  fire: () => Promise<void>
  pending: () => boolean
  probed: string[]
  recorded: { id: string; bytes: number }[]
  setUnlocked: (v: boolean) => void
  lastDelay: () => number | null
} {
  let queued: (() => void) | null = null
  let delay: number | null = null
  let unlocked = true
  const probed: string[] = []
  const recorded: { id: string; bytes: number }[] = []
  const deps: DbSamplerDeps = {
    probe: async (t) => {
      probed.push(t.connectionId)
      return 1024
    },
    record: (id, _at, bytes) => recorded.push({ id, bytes }),
    vaultUnlocked: () => unlocked,
    now: () => T0,
    setTimer: (fn, ms) => {
      queued = fn
      delay = ms
      return 1 as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: () => {
      queued = null
    },
    ...over
  }
  const sampler = new DbSampler(deps)
  return {
    sampler,
    fire: async () => {
      const f = queued
      queued = null
      f?.()
      // Let the sweep's awaits settle.
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    },
    pending: () => queued !== null,
    probed,
    recorded,
    setUnlocked: (v) => {
      unlocked = v
    },
    lastDelay: () => delay
  }
}

const cfg = (over: Partial<DbSamplerConfig> = {}): DbSamplerConfig => ({
  enabled: true,
  targets: [{ connectionId: 'db-1', cfg: {} }],
  intervalMs: DB_SAMPLE_MIN_INTERVAL_MS,
  ...over
})

describe('what it will not do', () => {
  // Opening a database connection unattended is a different act from reading
  // /proc over a channel the operator opened.
  it('is off until somebody turns it on', () => {
    const h = harness()
    h.sampler.configure(cfg({ enabled: false }))
    expect(h.pending()).toBe(false)
    expect(h.sampler.status()).toMatchObject({ running: false, idleReason: 'disabled' })
  })

  it('does nothing with no targets', () => {
    const h = harness()
    h.sampler.configure(cfg({ targets: [] }))
    expect(h.sampler.status().idleReason).toBe('no-targets')
  })

  // A loop that errors every interval forever is noise that trains people to
  // ignore it.
  it('stops rather than retrying while the vault is locked', () => {
    const h = harness()
    h.setUnlocked(false)
    h.sampler.configure(cfg())
    expect(h.pending()).toBe(false)
    expect(h.sampler.status().idleReason).toBe('vault-locked')
  })

  // The vault can lock while a timer is pending. A sweep that ran anyway would
  // fail on every target and write nothing while looking like it worked.
  it('re-checks the lock when the timer fires, not only when it was set', async () => {
    const h = harness()
    h.sampler.configure(cfg())
    h.setUnlocked(false)
    await h.fire()
    expect(h.probed).toEqual([])
    expect(h.pending()).toBe(false)
  })

  // This costs a connection and the number moves on the scale of days. A
  // tighter cadence buys nothing and spends something real -- and a settings
  // blob is not a promise.
  it('clamps a cadence a settings blob asked for', async () => {
    const h = harness()
    h.sampler.configure(cfg({ intervalMs: 5_000 }))
    await h.fire()
    // Observed on the timer the sweep set, not asserted about the constant.
    expect(h.lastDelay()).toBe(DB_SAMPLE_MIN_INTERVAL_MS)
  })

  it('honours a cadence longer than the floor', async () => {
    const h = harness()
    h.sampler.configure(cfg({ intervalMs: 6 * 3_600_000 }))
    await h.fire()
    expect(h.lastDelay()).toBe(6 * 3_600_000)
  })
})

describe('one sweep', () => {
  it('reads every target and records what came back', async () => {
    const h = harness()
    h.sampler.configure(
      cfg({
        targets: [
          { connectionId: 'db-1', cfg: {} },
          { connectionId: 'db-2', cfg: {} }
        ]
      })
    )
    await h.fire()
    expect(h.probed).toEqual(['db-1', 'db-2'])
    expect(h.recorded).toEqual([
      { id: 'db-1', bytes: 1024 },
      { id: 'db-2', bytes: 1024 }
    ])
  })

  // Null is "nothing that may be recorded" -- a capped MySQL total, a database
  // the read did not list. A zero would put a cliff in the series.
  it('writes nothing for a read that produced no usable number', async () => {
    const h = harness({ probe: async () => null })
    h.sampler.configure(cfg())
    await h.fire()
    expect(h.recorded).toEqual([])
    expect(h.sampler.status().lastRecorded).toBe(0)
  })

  it('counts what it recorded, not what it attempted', async () => {
    let n = 0
    const h = harness({
      probe: async () => {
        n += 1
        return n === 1 ? 2048 : null
      }
    })
    h.sampler.configure(
      cfg({
        targets: [
          { connectionId: 'db-1', cfg: {} },
          { connectionId: 'db-2', cfg: {} }
        ]
      })
    )
    await h.fire()
    expect(h.sampler.status()).toMatchObject({ targetCount: 2, lastRecorded: 1 })
  })

  // The next one is a different server with a different problem.
  it('carries on past a database that refused', async () => {
    const h = harness({
      probe: async (t) => {
        if (t.connectionId === 'db-1') throw new Error('too many connections')
        return 4096
      }
    })
    h.sampler.configure(
      cfg({
        targets: [
          { connectionId: 'db-1', cfg: {} },
          { connectionId: 'db-2', cfg: {} }
        ]
      })
    )
    await h.fire()
    expect(h.recorded).toEqual([{ id: 'db-2', bytes: 4096 }])
  })

  it('schedules the next sweep from the end of this one', async () => {
    const h = harness()
    h.sampler.configure(cfg())
    await h.fire()
    expect(h.pending()).toBe(true)
  })

  it('stops scheduling once disposed', async () => {
    const h = harness()
    h.sampler.configure(cfg())
    h.sampler.dispose()
    await h.fire()
    expect(h.probed).toEqual([])
    expect(h.pending()).toBe(false)
  })
})

describe('the status is derived from the loop', () => {
  // Settings that say "on" beside a sampler that stalled hours ago is exactly
  // how a stall goes unnoticed -- the correction `fleetSampler` documents.
  it('does not call itself running on the strength of the config alone', () => {
    const h = harness()
    h.sampler.configure(cfg())
    expect(h.sampler.status().running).toBe(true)
    h.sampler.dispose()
    expect(h.sampler.status().running).toBe(false)
  })

  it('reports the sweep it last finished', async () => {
    const h = harness()
    h.sampler.configure(cfg())
    expect(h.sampler.status().lastSweepAt).toBeNull()
    await h.fire()
    expect(h.sampler.status().lastSweepAt).toBe(T0)
  })

  it('resumes after an unlock without needing a reconfigure', async () => {
    const h = harness()
    h.setUnlocked(false)
    h.sampler.configure(cfg())
    expect(h.pending()).toBe(false)
    h.setUnlocked(true)
    h.sampler.resume()
    expect(h.pending()).toBe(true)
    await h.fire()
    expect(h.probed).toEqual(['db-1'])
  })

  it('is idempotent about resuming, so every unlock path may call it', () => {
    const h = harness()
    h.sampler.configure(cfg())
    h.sampler.resume()
    h.sampler.resume()
    expect(h.pending()).toBe(true)
  })
})

describe('one connection at a time', () => {
  // Sequential, and the gap to the next sweep is measured from the END, so
  // five databases are never five connections at once. What this class canNOT
  // do is prevent a collision with `db:ops`, which opens a connection of its
  // own when somebody presses the button -- it does not mediate that path, and
  // a flag here would only look as though it did.
  it('never has two probes outstanding', async () => {
    let live = 0
    let worst = 0
    const h = harness({
      probe: async () => {
        live += 1
        worst = Math.max(worst, live)
        await Promise.resolve()
        live -= 1
        return 1
      }
    })
    h.sampler.configure(
      cfg({
        targets: [
          { connectionId: 'db-1', cfg: {} },
          { connectionId: 'db-2', cfg: {} },
          { connectionId: 'db-3', cfg: {} }
        ]
      })
    )
    await h.fire()
    expect(worst).toBe(1)
  })

  it('will not start a sweep while one is running', async () => {
    let resolve: ((v: number | null) => void) | null = null
    const probe = vi.fn(
      () =>
        new Promise<number | null>((r) => {
          resolve = r
        })
    )
    const h = harness({ probe })
    h.sampler.configure(cfg())
    await h.fire()
    expect(probe).toHaveBeenCalledTimes(1)
    await h.sampler.sweep()
    expect(probe).toHaveBeenCalledTimes(1)
    ;(resolve as ((v: number | null) => void) | null)?.(1)
  })
})
