import {
  appendResult,
  evaluate,
  isCheckableUrl,
  type CheckResult,
  type CheckState,
  type HttpCheck
} from '../../shared/httpMonitor'

/**
 * Service checks, run by the main process.
 *
 * They used to run inside the panel that displays them: a `setInterval` in a
 * React component, with the history in `useState`. That worked exactly as long
 * as somebody was looking at it. Navigating to another view unmounted the
 * component, which stopped every check and discarded every result — so the
 * feature answered "is this service up right now, while I watch" rather than
 * "has this service been up", which is the entire question a monitor exists to
 * answer. A monitor that only runs while observed is a very expensive status
 * button.
 *
 * Here it runs for as long as the app does, and the panel became a view of
 * state rather than the thing producing it.
 *
 * ── What this deliberately does NOT do ─────────────────────────────────────
 *
 * Survive a restart. History is in memory and starts empty, like the fleet
 * sampler's own reachability map. Persisting it means a retention policy and a
 * store migration for data whose value decays in minutes; the checks
 * themselves are persisted, so a restart resumes monitoring immediately and
 * loses only the chart behind it.
 */

export interface ServiceCheckEvent {
  checkId: string
  result: CheckResult
}

/** Raised on a transition, never on every failing run. */
export interface ServiceCheckAlert {
  checkId: string
  /** The friendly name, never the URL. See the note in the alert deps below. */
  name: string
  state: CheckState
  error?: string
  at: number
}

export interface ServiceCheckDeps {
  /** The transport. Injected so tests never open a socket. */
  probe: (
    check: HttpCheck
  ) => Promise<{ ok: true; status: number; durationMs: number } | { ok: false; error: string }>
  emit: (event: ServiceCheckEvent) => void
  /**
   * Raised when a check changes state, and only then.
   *
   * The payload carries the check's NAME and not its URL, matching the rule
   * AlertPayload states for servers: a webhook is the easiest way to leak
   * addressing out of this app, and the name is both what a person needs in
   * order to act and a string they chose themselves.
   */
  alert?: (alert: ServiceCheckAlert) => void
  now?: () => number
}

/** How often the loop asks which checks are due. */
const TICK_MS = 1_000

export class ServiceCheckRunner {
  private checks: HttpCheck[] = []
  private history = new Map<string, CheckResult[]>()
  /** Checks with a request in flight, so a slow endpoint is not asked twice. */
  private inFlight = new Set<string>()
  /**
   * The last state each check reported.
   *
   * Separate from `history` because history is trimmed and can be empty, while
   * this is the one question alerting asks: did the state just change? Without
   * it a check that is down stays down and would raise an alert every interval
   * forever, which is how an alert channel becomes something people mute.
   */
  private lastState = new Map<string, CheckState>()
  private timer: ReturnType<typeof setInterval> | null = null
  private disposed = false

  constructor(private readonly deps: ServiceCheckDeps) {}

  private get now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  /**
   * Replace the set of checks.
   *
   * `isCheckableUrl` is applied HERE and not only in the renderer that sends
   * them. The renderer's copy is there to explain the refusal while somebody
   * types; this one is the one that decides what the main process will open a
   * connection to, and a rule enforced only on the side that is easiest to
   * bypass is not a rule.
   */
  configure(checks: readonly HttpCheck[]): void {
    if (this.disposed) return
    this.checks = checks.filter((c) => isCheckableUrl(c.url))

    // Forget everything about checks that no longer exist, so the maps stay
    // bounded by the configured set rather than by everything ever configured.
    const ids = new Set(this.checks.map((c) => c.id))
    for (const m of [this.history, this.lastState]) {
      for (const key of [...m.keys()]) if (!ids.has(key)) m.delete(key)
    }

    if (this.checks.some((c) => c.enabled)) this.start()
    else this.stop()
  }

  private start(): void {
    if (this.timer || this.disposed) return
    this.timer = setInterval(() => this.tick(), TICK_MS)
    // Never a reason to hold the process open: this is a background poller,
    // and an app that will not quit because a monitor is due is a worse bug
    // than a missed check.
    if (typeof this.timer.unref === 'function') this.timer.unref()
    this.tick()
  }

  private stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  private tick(): void {
    const now = this.now
    for (const check of this.checks) {
      if (!check.enabled || this.inFlight.has(check.id)) continue
      const h = this.history.get(check.id)
      const last = h?.[h.length - 1]
      // No history means due now, so adding a check answers immediately
      // rather than showing an empty row for a minute.
      if (!last || now - last.at >= check.intervalSec * 1000) void this.run(check)
    }
  }

  private async run(check: HttpCheck): Promise<void> {
    this.inFlight.add(check.id)
    try {
      const outcome = await this.deps.probe(check).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : 'The check could not be run.'
      }))
      if (this.disposed) return
      const result = evaluate(check, outcome, this.now)
      this.history.set(check.id, appendResult(this.history.get(check.id) ?? [], result))

      const previous = this.lastState.get(check.id)
      this.lastState.set(check.id, result.state)
      // Only a real change, and never the first result of a healthy check:
      // "this service you just added is up" is not an alert.
      if (previous !== undefined && previous !== result.state && this.deps.alert) {
        if (result.state === 'down' || previous === 'down') {
          this.deps.alert({
            checkId: check.id,
            name: check.name,
            state: result.state,
            error: result.error,
            at: result.at
          })
        }
      } else if (previous === undefined && result.state === 'down' && this.deps.alert) {
        // A check whose very first run fails IS worth saying out loud — that is
        // a service that is down, not a transition nobody saw.
        this.deps.alert({
          checkId: check.id,
          name: check.name,
          state: result.state,
          error: result.error,
          at: result.at
        })
      }

      this.deps.emit({ checkId: check.id, result })
    } finally {
      this.inFlight.delete(check.id)
    }
  }

  /** Everything known so far, for a panel that has just mounted. */
  snapshot(): Record<string, CheckResult[]> {
    const out: Record<string, CheckResult[]> = {}
    for (const [id, results] of this.history) out[id] = results
    return out
  }

  dispose(): void {
    this.disposed = true
    this.stop()
    this.checks = []
    this.history.clear()
    this.lastState.clear()
  }
}
