// Item 39's "stale objects": what has finished and is still there.
//
// REPORT ONLY. Deletion stays refused, which `shared/kubernetes.ts` argues at
// its head and this file does not reopen. A list of what has finished is a
// list somebody can act on with kubectl in one command; a delete button here
// would be this app deciding which of a cluster's records are worth keeping.
//
// ---------------------------------------------------------------------------
// TWO VOCABULARIES FOR ONE POD, MEASURED
// ---------------------------------------------------------------------------
// The same two pods on k3s v1.31.5:
//
//   kubectl get pods         STATUS:   Completed   Error
//   .status.phase                      Succeeded   Failed
//
// The column a human reads and the field the API stores use different words.
// A parser keying on one and a comment describing the other is how somebody
// later "fixes" the parser to match the docs and breaks it.
//
// A FAILED JOB HAS NO completionTime. `ok-job` carries one; `bad-job` reports
// `<none>`. Age computed from completionTime is therefore null for exactly the
// jobs most worth noticing, so it comes from startTime.

export type PodPhase = 'Succeeded' | 'Failed' | 'Running' | 'Pending' | 'Unknown'

export interface StalePod {
  namespace: string
  name: string
  phase: PodPhase
  /** `Evicted`, or empty. The phase of an evicted pod is `Failed`, so the
   *  reason is the only thing that separates it from a crash. */
  reason: string
  startedAt: number | null
  /** `Job`, `ReplicaSet`, or empty for a bare pod. A pod owned by a Job is
   *  expected to finish; a bare one that finished was probably somebody's
   *  `kubectl run`. */
  ownerKind: string
}

const NONE = (v: string): string => (v === '<none>' || v === undefined ? '' : v)
const time = (v: string): number | null => {
  const t = NONE(v)
  if (t === '') return null
  const n = Date.parse(t)
  return Number.isFinite(n) ? n : null
}

export function parseStalePods(text: string): StalePod[] {
  const out: StalePod[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const f = line.split(/\s+/)
    if (f.length < 5) continue
    const phase = f[2]
    out.push({
      namespace: f[0],
      name: f[1],
      phase: (['Succeeded', 'Failed', 'Running', 'Pending'].includes(phase)
        ? phase
        : 'Unknown') as PodPhase,
      reason: NONE(f[3]),
      startedAt: time(f[4]),
      ownerKind: NONE(f[5])
    })
  }
  return out
}

export interface StaleJob {
  namespace: string
  name: string
  succeeded: number
  failed: number
  startedAt: number | null
  completedAt: number | null
}

export function parseStaleJobs(text: string): StaleJob[] {
  const out: StaleJob[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const f = line.split(/\s+/)
    if (f.length < 5) continue
    const n = (v: string): number => {
      const x = Number(NONE(v))
      return Number.isFinite(x) ? x : 0
    }
    out.push({
      namespace: f[0],
      name: f[1],
      succeeded: n(f[2]),
      failed: n(f[3]),
      startedAt: time(f[4]),
      completedAt: time(f[5] ?? '')
    })
  }
  return out
}

export interface StaleFinding {
  kind: 'pod' | 'job'
  namespace: string
  name: string
  /** Whole days since it finished, or null when nothing could be dated. */
  ageDays: number | null
  because: string
}

const DAY = 86_400_000

/**
 * What has finished and is still on the cluster.
 *
 * A pod owned by a Job is NOT reported on its own: the Job that owns it is
 * reported instead, and listing both is one thing said twice. Deleting the Job
 * removes its pods, so the Job is the actionable row.
 */
export function staleFindings(
  pods: StalePod[],
  jobs: StaleJob[],
  olderThanDays: number,
  now = Date.now()
): StaleFinding[] {
  const cutoff = Math.max(0, olderThanDays) * DAY
  const out: StaleFinding[] = []

  for (const j of jobs) {
    // A running job is not stale, however long it has been going -- that is a
    // different finding and not this one's.
    if (j.succeeded === 0 && j.failed === 0) continue
    // From startTime, because a FAILED job has no completionTime at all and
    // those are the ones most worth noticing.
    const finished = j.completedAt ?? j.startedAt
    const age = finished === null ? null : now - finished
    if (age !== null && age < cutoff) continue
    out.push({
      kind: 'job',
      namespace: j.namespace,
      name: j.name,
      ageDays: age === null ? null : Math.floor(age / DAY),
      because:
        j.failed > 0
          ? `${j.name} failed and is still on the cluster${j.completedAt === null ? ' (a failed job records no completion time, so this is measured from when it started)' : ''}.`
          : `${j.name} completed and is still on the cluster.`
    })
  }

  for (const p of pods) {
    if (p.phase !== 'Succeeded' && p.phase !== 'Failed') continue
    // Its Job is the row worth acting on; both would be one thing said twice.
    if (p.ownerKind === 'Job') continue
    const age = p.startedAt === null ? null : now - p.startedAt
    if (age !== null && age < cutoff) continue
    out.push({
      kind: 'pod',
      namespace: p.namespace,
      name: p.name,
      ageDays: age === null ? null : Math.floor(age / DAY),
      because:
        // An evicted pod is `Failed` too, and the difference matters: it did
        // not crash, the node pushed it off.
        p.reason === 'Evicted'
          ? `${p.name} was evicted — the node it was on ran short and pushed it off — and the record is still here.`
          : `${p.name} is ${p.phase} and is still here, owned by ${p.ownerKind || 'nothing'}.`
    })
  }
  return out.sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1))
}
