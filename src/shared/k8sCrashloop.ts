// Item 40's probe vocabulary: which pods are restarting, and whether we can
// tell.
//
// ---------------------------------------------------------------------------
// WHAT A REAL CRASHLOOPING POD LOOKS LIKE, MEASURED
// ---------------------------------------------------------------------------
// Sampled every three seconds on a k3s v1.31.5 cluster with a container that
// exits 1 after two seconds:
//
//   PHASE     WAIT               TERM     RESTARTS
//   Running   <none>             Error    3
//   Running   <none>             Error    3
//   Running   CrashLoopBackOff   <none>   3
//   Running   CrashLoopBackOff   <none>   3
//
// Three things follow, and none of them is obvious from the documentation:
//
//  1. `phase` IS ALWAYS `Running`. It never says anything. A probe that keys
//     on phase reports a crashlooping pod as healthy for ever.
//
//  2. `waiting.reason` IS NOT ALWAYS `CrashLoopBackOff`. Between restarts the
//     container is briefly up or terminating, and the reason is empty with
//     `terminated.reason: Error` instead. A probe that keys ONLY on
//     CrashLoopBackOff misses the pod on a fair share of samples -- which on
//     an alert that resolves itself means it flaps.
//
//  3. THE RESTART COUNT IS THE ONLY STABLE SIGNAL, and one sample of it is
//     not enough either: 4 restarts means "this pod restarted four times",
//     not "this pod is restarting". A pod that crashed four times an hour ago
//     and has been up since reads identically. Only the DELTA between two
//     samples separates them.
//
// So the reading takes the previous sample, and says `unknown` when it does
// not have one -- which is the first sweep after launch, and is honest.

export interface CrashPodRow {
  namespace: string
  name: string
  phase: string
  /** `state.waiting.reason`, or empty. */
  waiting: string
  /** `state.terminated.reason`, or empty. */
  terminated: string
  /** Summed across containers, because the column is per container and a pod
   *  with a sidecar prints two numbers. */
  restarts: number
  node: string
}

const NONE = new Set(['<none>', '', '-'])

/** The `custom-columns` output the overview already uses, `<none>` and all. */
export function parseCrashPods(text: string): CrashPodRow[] {
  const out: CrashPodRow[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const f = line.split(/\s+/)
    if (f.length < 7) continue
    // Per container, comma-separated by kubectl. Summed rather than taking the
    // first: a pod whose sidecar is the thing crashing is still a crashing pod.
    const restarts = (f[5] ?? '')
      .split(',')
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n))
      .reduce((a, b) => a + b, 0)
    out.push({
      namespace: f[0],
      name: f[1],
      phase: f[2],
      waiting: NONE.has(f[3]) ? '' : f[3],
      terminated: NONE.has(f[4]) ? '' : f[4],
      restarts,
      node: f[6]
    })
  }
  return out
}

/** Why a read produced no pods, when it produced none. `ok` with an empty list
 *  is a cluster with no pods; everything else is a cluster we could not see. */
export type CrashReadState = 'ok' | 'forbidden' | 'no-cluster' | 'unauthorized' | 'one-namespace'

export interface CrashloopReading {
  /**
   * `true` when something is restarting, `false` when nothing is, and NULL
   * when we cannot tell.
   *
   * Null in three cases, and the third is the one that is easy to get wrong:
   * the read failed; `--all-namespaces` fell back to one namespace, so
   * "nothing is crashlooping" is a claim about a fraction of the cluster; and
   * there is no PREVIOUS sample, so a restart count cannot be turned into a
   * rate.
   */
  bad: boolean | null
  /** Pods whose restart count went UP since the previous sample. */
  restarting: { namespace: string; name: string; by: number; restarts: number }[]
  detail: string
}

/** The least this needs to know about a pod. Structural on purpose: the
 *  existing `K8sPod` from the overview read satisfies it, so the reading works
 *  off the list the app already fetches rather than a second parse of the same
 *  objects. Naming that type here would mean importing `shared/kubernetes`,
 *  which is the one thing this module may not do. */
export interface CrashPodMinimal {
  namespace: string
  name: string
  restarts: number
}

export function crashloopReading(
  state: CrashReadState,
  now: CrashPodMinimal[],
  previous: CrashPodMinimal[] | null
): CrashloopReading {
  if (state !== 'ok') {
    const why =
      state === 'forbidden'
        ? 'this token may not list pods'
        : state === 'no-cluster'
          ? 'no cluster answered'
          : state === 'unauthorized'
            ? 'the credentials were rejected'
            : 'only one namespace could be listed, so this is not a claim about the cluster'
    return { bad: null, restarting: [], detail: `Could not tell: ${why}.` }
  }
  if (previous === null) {
    // A count is not a rate. Four restarts is "restarted four times", which a
    // pod that crashed an hour ago and has been up since also reports.
    return {
      bad: null,
      restarting: [],
      detail: 'No earlier sample to compare against, so a restart count cannot yet be told from a restart rate.'
    }
  }
  const before = new Map(previous.map((p) => [`${p.namespace}/${p.name}`, p.restarts]))
  const restarting = now
    .map((p) => {
      const key = `${p.namespace}/${p.name}`
      const was = before.get(key)
      // A pod that did not exist in the previous sample is NOT counted. It may
      // have been recreated with a fresh count, and a new pod's restarts are
      // not evidence of anything yet.
      if (was === undefined || p.restarts <= was) return null
      return { namespace: p.namespace, name: p.name, by: p.restarts - was, restarts: p.restarts }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  if (restarting.length === 0) {
    return { bad: false, restarting: [], detail: 'No pod restarted since the last check.' }
  }
  const worst = [...restarting].sort((a, b) => b.by - a.by)[0]
  return {
    bad: true,
    restarting,
    detail:
      restarting.length === 1
        ? `${worst.namespace}/${worst.name} restarted ${worst.by} time(s) since the last check (${worst.restarts} in total).`
        : `${restarting.length} pods restarted since the last check, ${worst.namespace}/${worst.name} the most (${worst.by}).`
  }
}

/** Whether a single row looks like a crashloop right now, for the LIST rather
 *  than the alert. Both spellings, because the reason field alternates. */
export function looksLikeCrashloop(p: CrashPodRow): boolean {
  return p.waiting === 'CrashLoopBackOff' || p.terminated === 'Error'
}

/**
 * The alert subject.
 *
 * NOT a server id. A cluster is visible from every host that holds a
 * kubeconfig for it, so keying on the server would raise the same crashloop
 * once per such host -- three admin boxes, three alerts, one problem. The
 * subject is the cluster context, which is the thing that is actually
 * crashlooping.
 *
 * Prefixed so it cannot collide with a server id in the same `subject:kind`
 * keyspace, following the StoredDbAlertRow precedent for a subject that is not
 * a fleet host.
 */
export const CRASHLOOP_SUBJECT_PREFIX = 'k8s:'

export function crashloopSubject(context: string): string {
  return `${CRASHLOOP_SUBJECT_PREFIX}${context || 'current-context'}`
}
