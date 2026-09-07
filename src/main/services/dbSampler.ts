// Item 47's `dbSampler`: the database size series on a cadence, rather than
// only when somebody opens a panel.
//
// Modelled on `fleetSampler.ts` and deliberately smaller. What it copies is the
// discipline, and what it does NOT copy is the frequency: a metrics sweep runs
// every two minutes over SSH, and this opens a DATABASE CONNECTION. Postgres
// counts one against `max_connections`, MySQL against `max_connections` too,
// and a background loop that takes one every two minutes on a server already
// near its ceiling is this app causing the incident it exists to report.
//
// FOUR RULES, three of them borrowed and one new.
//
//  1. OFF BY DEFAULT, and its own setting. Opening a database connection
//     unattended is a different act from reading `/proc` over an SSH channel
//     the operator opened, and "we now connect to your production database
//     every hour" is a thing a person switches on, not one they discover in a
//     connection log.
//  2. IT NEVER RESOLVES A CREDENTIAL. It is handed resolved configs, exactly as
//     the fleet sampler is handed targets, so the vault-shaped decisions stay
//     in one place.
//  3. VAULT LOCKED MEANS STOP, not retry. A loop that errors every interval
//     forever is noise that trains people to ignore it.
//  4. NEW HERE: A SWEEP IS ONE CONNECTION AT A TIME. Sequential, and the gap
//     to the next sweep is measured from the END, so five databases are never
//     five connections at once.
//
//     What this canNOT do is prevent a collision with `db:ops`, which opens a
//     transient connection of its own when an operator presses the button. This
//     class does not mediate that path and a flag here would only look as
//     though it did. The protection that exists is the cadence: an hour between
//     sweeps, against a button somebody presses.

export interface DbSampleTarget {
  connectionId: string
  /** Resolved by the caller. Never built here -- see rule 2. */
  cfg: unknown
}

/** Returns the size in bytes, or null when this read produced nothing that may
 *  be recorded. The reasons live in `shared/dbSizeSample.ts`; this only has to
 *  know that null means "write nothing". */
export type DbSizeProbe = (target: DbSampleTarget) => Promise<number | null>

export interface DbSamplerDeps {
  probe: DbSizeProbe
  record: (connectionId: string, at: number, bytes: number) => void
  vaultUnlocked: () => boolean
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void
}

export interface DbSamplerConfig {
  enabled: boolean
  targets: DbSampleTarget[]
  intervalMs: number
}

/**
 * The floor.
 *
 * An hour, and not the two minutes the metrics sweep uses. See the header: this
 * costs a connection on somebody's database server, and the number it produces
 * moves on the scale of days. A tighter cadence would buy nothing and spend
 * something real.
 */
export const DB_SAMPLE_MIN_INTERVAL_MS = 3_600_000

export type DbSamplerIdle = 'disabled' | 'no-targets' | 'vault-locked'

export interface DbSamplerStatus {
  running: boolean
  idleReason?: DbSamplerIdle
  targetCount: number
  lastSweepAt: number | null
  /** How many targets produced a number on the last sweep. Not the same as the
   *  target count: a refused read writes nothing and says so here. */
  lastRecorded: number | null
}

export class DbSampler {
  private cfg: DbSamplerConfig = { enabled: false, targets: [], intervalMs: DB_SAMPLE_MIN_INTERVAL_MS }
  private timer: ReturnType<typeof setTimeout> | null = null
  private sweeping = false
  private disposed = false
  private generation = 0
  private lastSweepAt: number | null = null
  private lastRecorded: number | null = null
  constructor(private readonly deps: DbSamplerDeps) {}

  configure(cfg: DbSamplerConfig): void {
    // The interval is clamped rather than trusted: a settings blob is not a
    // promise, and a five-second cadence here is a connection every five
    // seconds on somebody's database.
    this.cfg = {
      enabled: cfg.enabled,
      targets: cfg.targets,
      intervalMs: Math.max(DB_SAMPLE_MIN_INTERVAL_MS, Math.floor(cfg.intervalMs))
    }
    this.generation += 1
    this.stopTimer()
    if (this.shouldRun()) this.schedule(0)
  }

  private shouldRun(): boolean {
    return (
      !this.disposed &&
      this.cfg.enabled &&
      this.cfg.targets.length > 0 &&
      this.deps.vaultUnlocked()
    )
  }

  status(): DbSamplerStatus {
    const base = {
      targetCount: this.cfg.targets.length,
      lastSweepAt: this.lastSweepAt,
      lastRecorded: this.lastRecorded
    }
    if (!this.cfg.enabled) return { running: false, idleReason: 'disabled', ...base }
    if (this.cfg.targets.length === 0) return { running: false, idleReason: 'no-targets', ...base }
    if (!this.deps.vaultUnlocked()) return { running: false, idleReason: 'vault-locked', ...base }
    // Derived from the loop rather than from the config, the same correction
    // `fleetSampler.status()` documents: settings that say "on" beside a
    // sampler that stalled hours ago is exactly how a stall goes unnoticed.
    return { running: this.timer !== null || this.sweeping, ...base }
  }

  /** Resume after an unlock. Idempotent, so every unlock path can call it. */
  resume(): void {
    if (this.disposed || this.sweeping || this.timer !== null) return
    if (this.shouldRun()) this.schedule(0)
  }

  dispose(): void {
    this.disposed = true
    this.generation += 1
    this.stopTimer()
  }

  private stopTimer(): void {
    if (this.timer === null) return
    ;(this.deps.clearTimer ?? clearTimeout)(this.timer)
    this.timer = null
  }

  private schedule(delayMs: number): void {
    this.stopTimer()
    const gen = this.generation
    this.timer = (this.deps.setTimer ?? setTimeout)(() => {
      this.timer = null
      if (gen !== this.generation) return
      void this.sweep()
    }, delayMs)
  }

  /**
   * One pass over the targets.
   *
   * Sequential, and the gap to the next sweep is measured from the END: five
   * databases read in parallel is five connections at once, which is the thing
   * rule 4 exists to avoid a smaller version of.
   */
  async sweep(): Promise<void> {
    // `sweeping` is what serialises sweeps; `disposed` is covered by the
    // `shouldRun()` below and is not repeated here, because a second guard
    // reads as though it were the one keeping the invariant.
    if (this.sweeping) return
    // Re-checked HERE and not only at schedule time. The vault can lock while a
    // timer is pending, and a sweep that ran anyway would fail on every target
    // and write nothing while looking like it worked.
    if (!this.shouldRun()) {
      this.stopTimer()
      return
    }
    this.sweeping = true
    const gen = this.generation
    const now = (this.deps.now ?? Date.now)()
    let recorded = 0
    try {
      for (const t of this.cfg.targets) {
        if (gen !== this.generation || this.disposed) return
        try {
          const bytes = await this.deps.probe(t)
          // Null is "nothing that may be recorded" -- a capped MySQL total, a
          // database the read did not list, an engine with no total. Writing a
          // zero would put a cliff in the series.
          if (bytes !== null && Number.isFinite(bytes)) {
            this.deps.record(t.connectionId, now, bytes)
            recorded += 1
          }
        } catch {
          // One database refusing must not end the sweep: the next one is a
          // different server with a different problem.
        }
      }
      this.lastSweepAt = now
      this.lastRecorded = recorded
    } finally {
      this.sweeping = false
      if (gen === this.generation && this.shouldRun()) this.schedule(this.cfg.intervalMs)
    }
  }
}
