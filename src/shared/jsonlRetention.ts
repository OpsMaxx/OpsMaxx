/**
 * How long the four append-only JSON-lines logs keep a line.
 *
 * `auditLog`, `approvalLog` and `localSessionLog` had no horizon at all: they
 * grew for as long as the app was used. In practice that is slow -- one line
 * per approval or per agent call, never per line of output -- but slow is not
 * bounded, and "it will be fine" is not a retention policy. The history store
 * has had a horizon per event kind since item 32; these are the files that were
 * left out of it.
 *
 * The credential proxy's audit log is the fourth, and it was left out of THIS
 * in turn -- see the prune list in main/index.ts. It is also the one the "slow"
 * argument above does not cover: a row per forwarded REQUEST rather than per
 * approval, so an agent looping against an API writes them as fast as it can
 * send. The count bound below is what actually holds it.
 *
 * A YEAR, deliberately generous. These answer "who did what, and who approved
 * it", which is a question asked long after the fact -- during an incident
 * review, or when somebody wants to know when a credential was last used. A
 * thirty-day window would be tidier and would have thrown away the answer.
 */
export const JSONL_RETENTION_DAYS = 365

/**
 * A second bound, on count rather than age.
 *
 * Age alone does not protect against a pathological run -- an agent in a retry
 * loop can write a great many lines inside the horizon. This caps the file
 * regardless, and is high enough that a normal year never reaches it.
 */
export const JSONL_RETENTION_MAX_LINES = 50_000

/**
 * Lines that survive, oldest first, and how many were dropped.
 *
 * Pure, so the policy can be tested without a filesystem -- which matters more
 * than usual here, because the failure mode of getting it wrong is silently
 * destroying audit records and nobody noticing until they are wanted.
 *
 * Three rules, and each exists because the obvious implementation gets it
 * wrong:
 *
 *  1. **A line whose timestamp cannot be read is KEPT.** Dropping it would mean
 *     a corrupt or future-format line is deleted precisely because we could not
 *     understand it, which is the worst possible reason to destroy an audit
 *     record. The read paths already skip unparseable lines rather than failing;
 *     this must not go further and remove them.
 *  2. **The newest `minKeep` lines survive regardless of age.** A vault used
 *     once and left alone for two years should still be able to say what
 *     happened that once, rather than opening on an empty log.
 *  3. **The count bound drops the OLDEST**, not the newest.
 */
export function retainedLines(
  lines: readonly string[],
  opts: { now: number; days?: number; maxLines?: number; minKeep?: number }
): { kept: string[]; dropped: number } {
  const days = opts.days ?? JSONL_RETENTION_DAYS
  const maxLines = opts.maxLines ?? JSONL_RETENTION_MAX_LINES
  const minKeep = opts.minKeep ?? 100
  const cutoff = opts.now - days * 24 * 60 * 60 * 1000

  const floor = lines.length > minKeep ? lines.length - minKeep : 0
  const byAge = lines.filter((line, i) => {
    if (i >= floor) return true
    const at = timestampOf(line)
    // Unreadable timestamp: keep. See rule 1.
    if (at === null) return true
    return at >= cutoff
  })

  const kept = byAge.length > maxLines ? byAge.slice(byAge.length - maxLines) : byAge
  return { kept, dropped: lines.length - kept.length }
}

/**
 * When an entry was written, or null if that cannot be read.
 *
 * TWO FIELD NAMES, BECAUSE THE FOUR LOGS DO NOT AGREE. `AuditEntry`
 * (shared/mcp.ts), `LocalSessionEntry` (main/services/localSessionLog.ts) and
 * `JobApprovalEntry` (shared/jobs.ts) all write `timestamp`. `CredProxyCall`
 * (shared/credproxy.ts) writes **`at`**, and it was the fourth log added to the
 * prune sweep.
 *
 * Reading only `timestamp` therefore returned null for every credproxy row,
 * which rule 1 above correctly reads as "unreadable: keep" — so the 365-day
 * horizon silently never fired on the one file that grows per forwarded REQUEST
 * rather than per approval, and only the 50,000-line cap ever bit it. A
 * retention policy that is a no-op on its fastest-growing input is not a
 * retention policy. Those two are the only spellings in the app; a third log
 * with a third name is a third line here, not a new mechanism.
 */
export function timestampOf(line: string): number | null {
  try {
    const row = JSON.parse(line) as { timestamp?: unknown; at?: unknown }
    const v = typeof row.timestamp === 'string' ? row.timestamp : row.at
    if (typeof v !== 'string') return null
    const ms = Date.parse(v)
    return Number.isFinite(ms) ? ms : null
  } catch {
    return null
  }
}
