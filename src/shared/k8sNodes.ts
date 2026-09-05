// Item 39's node conditions, allocatable and taints.
//
// ---------------------------------------------------------------------------
// THE CONDITION VALUES ARE INVERTED, AND THERE ARE THREE OF THEM
// ---------------------------------------------------------------------------
// Measured on k3s v1.31.5. A healthy node reports:
//
//   MemoryPressure False   DiskPressure False   PIDPressure False   Ready True
//
// So `False` is GOOD for the three pressures and BAD for Ready, which is the
// opposite way round from every other boolean in this codebase and the reason
// they are not read as booleans here at all.
//
// The third value is the one that matters. A Kubernetes node condition is
// `True`, `False` or `Unknown`, and `Unknown` is what the control plane writes
// when the kubelet has STOPPED REPORTING -- which is the state an operator
// most needs to see and the one a boolean cannot hold. A node whose kubelet is
// dead reports `Ready: Unknown`, not `Ready: False`.

export type ConditionValue = 'True' | 'False' | 'Unknown'

export interface K8sNodeHealth {
  name: string
  memoryPressure: ConditionValue
  diskPressure: ConditionValue
  pidPressure: ConditionValue
  ready: ConditionValue
  /** As Kubernetes prints them: `12`, `500m`. Not converted -- see below. */
  allocatableCpu: string
  /** `24571576Ki`, `16Gi`. Not converted. */
  allocatableMemory: string
  allocatablePods: string
  /** Taint KEYS only. The values and effects are not read: a key is enough to
   *  say why nothing schedules here, and the values carry free text. */
  taints: string[]
}

const COND = (v: string): ConditionValue =>
  v === 'True' ? 'True' : v === 'False' ? 'False' : 'Unknown'

/** `<none>` is how kubectl prints an empty list in custom-columns, and it is
 *  not a taint called "none". */
const NONE = (v: string): string[] =>
  v === '<none>' || v === '' ? [] : v.split(',').map((t) => t.trim()).filter(Boolean)

export function parseNodeHealth(text: string): K8sNodeHealth[] {
  const out: K8sNodeHealth[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const f = line.split(/\s+/)
    if (f.length < 9) continue
    out.push({
      name: f[0],
      memoryPressure: COND(f[1]),
      diskPressure: COND(f[2]),
      pidPressure: COND(f[3]),
      ready: COND(f[4]),
      allocatableCpu: f[5],
      allocatableMemory: f[6],
      allocatablePods: f[7],
      taints: NONE(f[8])
    })
  }
  return out
}

export type NodeVerdict = 'ok' | 'pressure' | 'not-ready' | 'unreported' | 'unschedulable'

export interface NodeFinding {
  node: string
  verdict: NodeVerdict
  because: string
}

/** The taint the API server adds for a cordon. Reported as its own verdict:
 *  a cordoned node is not broken, it is deliberately empty, and calling it
 *  unhealthy would have somebody investigating their own change. */
const CORDON_TAINT = 'node.kubernetes.io/unschedulable'

/**
 * What each node's conditions mean, in the order they matter.
 *
 * `Unknown` outranks everything else. A node whose kubelet has stopped
 * reporting has conditions that are simply STALE -- the last values it sent,
 * which may say `MemoryPressure: False` about a machine that has since run out
 * of memory. Reporting that as healthy is worse than reporting nothing.
 */
export function judgeNodes(nodes: K8sNodeHealth[]): NodeFinding[] {
  return nodes
    .map((n): NodeFinding | null => {
      if (n.ready === 'Unknown') {
        return {
          node: n.name,
          verdict: 'unreported',
          because: `${n.name}'s kubelet has stopped reporting. Its other conditions are the last ones it sent and may describe a machine that has since changed.`
        }
      }
      if (n.ready === 'False') {
        return { node: n.name, verdict: 'not-ready', because: `${n.name} is reporting NotReady.` }
      }
      // The pressures, and `Unknown` counts: a pressure nobody could read is
      // not a pressure that is absent.
      const pressures = [
        ['memory', n.memoryPressure],
        ['disk', n.diskPressure],
        ['PID', n.pidPressure]
      ].filter(([, v]) => v !== 'False') as [string, ConditionValue][]
      if (pressures.length > 0) {
        return {
          node: n.name,
          verdict: 'pressure',
          because: `${n.name} reports ${pressures
            .map(([k, v]) => (v === 'Unknown' ? `${k} pressure unknown` : `${k} pressure`))
            .join(', ')}. The kubelet evicts pods under pressure, so this is why they move.`
        }
      }
      if (n.taints.includes(CORDON_TAINT)) {
        return {
          node: n.name,
          verdict: 'unschedulable',
          because: `${n.name} is cordoned. It is not broken — nothing new will schedule on it until it is uncordoned.`
        }
      }
      return null
    })
    .filter((f): f is NodeFinding => f !== null)
}

/**
 * The headline.
 *
 * A node nobody can hear from is counted FIRST and separately, because it is
 * the only category where the numbers beside it cannot be trusted either.
 */
export function summariseNodes(
  nodes: K8sNodeHealth[],
  findings: NodeFinding[]
): { ready: boolean; headline: string } {
  if (nodes.length === 0) {
    return { ready: false, headline: 'No node answered, which is not a cluster with no nodes.' }
  }
  const unreported = findings.filter((f) => f.verdict === 'unreported').length
  const notReady = findings.filter((f) => f.verdict === 'not-ready').length
  const pressure = findings.filter((f) => f.verdict === 'pressure').length
  const cordoned = findings.filter((f) => f.verdict === 'unschedulable').length
  const parts: string[] = []
  if (unreported > 0) parts.push(`${unreported} not reporting`)
  if (notReady > 0) parts.push(`${notReady} NotReady`)
  if (pressure > 0) parts.push(`${pressure} under pressure`)
  // Said, but not counted as a problem: somebody cordoned it on purpose.
  if (cordoned > 0) parts.push(`${cordoned} cordoned`)
  return parts.length === 0
    ? { ready: true, headline: `All ${nodes.length} node(s) ready, no pressure reported.` }
    : {
        ready: unreported === 0 && notReady === 0 && pressure === 0,
        headline: `${nodes.length} node(s): ${parts.join(', ')}.`
      }
}
