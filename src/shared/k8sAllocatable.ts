// What each node can hold, against what has been booked on it.
//
// ======================================================================
// MEASURED ON A THREE-NODE kind CLUSTER, v1.33, AND CHECKED AGAINST THE
// SCHEDULER'S OWN ARITHMETIC
// ======================================================================
//
// `kubectl describe node` prints an "Allocated resources" block, which is what
// the scheduler actually booked. Every rule below was checked against it rather
// than against the documentation, and the fixtures are in
// `tests/fixtures/k8s/alloc/`. On `sp-alloc-worker2` the numbers this file
// computes are 940m and 514Mi, which is what the node reported to the byte.
//
// FOUR FINDINGS, three of which change the shape.
//
//  1. `<none>` IS NOT ZERO. A container with no `requests` block prints
//     `<none>` in the column, and a pod of them is not a pod requesting
//     nothing -- it is a pod nobody sized, which is the thing an operator is
//     looking for. It contributes 0 to the sum AND counts in the unbounded
//     bucket, and the two facts are reported separately.
//
//  2. THE COLUMN CANNOT TELL YOU A POD IS FULLY SIZED. `mixed` has two
//     containers, one with `cpu: 40m` and one with no requests at all, and
//     `.spec.containers[*].resources.requests.cpu` prints `40m` -- ONE value,
//     with no placeholder for the container that has none. So a pod showing one
//     value might have one sized container or five unsized ones beside it.
//     Comparing the count of values against the count of NAMES is the only way
//     to see it, which is why the container names are read at all.
//
//  3. AN initContainer CAN BE THE WHOLE REQUEST. Kubernetes schedules a pod on
//     `max(sum(containers), max(initContainers))` per resource, and `withinit`
//     requests 10m in its container and 500m in its init. Summing only the
//     containers would have under-counted that node by 490m -- which the
//     describe block caught, because 340m + kube-system did not add up to 940m.
//
//  4. A PENDING POD IS BOOKED NOWHERE. `toobig` requests 64 cores and sits
//     Pending with `.spec.nodeName` empty. It must not be summed into any node,
//     and it must not vanish either: an operator whose deployment is stuck
//     wants it named.
//
// AND A CORDONED NODE'S FREE SPACE IS NOT HEADROOM. It still reports its full
// allocatable, and it accepts nothing new. Adding it to a cluster total would
// answer "can this cluster take another pod" with capacity that is closed.

/** The columns, exactly as measured. Read as a constant rather than built, for
 *  the reason every other command in this codebase is: a column set assembled
 *  from parts is a column set nobody has run. */
export const ALLOC_POD_COLS =
  'NS:.metadata.namespace,NAME:.metadata.name,NODE:.spec.nodeName,PHASE:.status.phase,' +
  'NAMES:.spec.containers[*].name,CPU:.spec.containers[*].resources.requests.cpu,' +
  'MEM:.spec.containers[*].resources.requests.memory,' +
  'INAMES:.spec.initContainers[*].name,ICPU:.spec.initContainers[*].resources.requests.cpu,' +
  'IMEM:.spec.initContainers[*].resources.requests.memory'

export const ALLOC_NODE_COLS =
  'NAME:.metadata.name,CPU:.status.allocatable.cpu,MEM:.status.allocatable.memory,' +
  'PODS:.status.allocatable.pods,SCHED:.spec.unschedulable'

/** kubectl's placeholder for a field that is not set. */
const NONE = '<none>'

/**
 * CPU as millicores.
 *
 * `150m` is 150; a bare `12` is twelve CORES, which is 12000. Getting that
 * backwards is a factor of a thousand in the direction that reports a full
 * node as empty.
 */
export function parseCpuMilli(v: string): number | null {
  const s = v.trim()
  if (s === '' || s === NONE) return null
  const m = s.match(/^(\d+(?:\.\d+)?)(m?)$/)
  if (m === null) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  return m[2] === 'm' ? Math.round(n) : Math.round(n * 1000)
}

// THE SUFFIX IS MATCHED WHOLE, and the order below is a second line of defence
// whose exact value was measured rather than assumed.
//
// Mutating this four ways: with the exact match here, the order carries no
// meaning and reordering changes nothing. Swapping the match to `endsWith` is
// also safe in either order, because `Mi` ends with `i` and never with `M`.
// Swapping it to `startsWith` is safe ONLY in this order -- and `startsWith`
// with the decimal units first reads every `96Mi` request as 96 million bytes,
// a 10% under-count on every memory figure in the report, which the tests do
// catch. So the exact match is the rule, binary-first is kept because
// `startsWith` is the obvious "simplification" someone will reach for, and this
// paragraph is here because a reordering that looks harmless is not.
const MEM_UNITS: [string, number][] = [
  ['Ki', 1024],
  ['Mi', 1024 ** 2],
  ['Gi', 1024 ** 3],
  ['Ti', 1024 ** 4],
  ['Pi', 1024 ** 5],
  ['k', 1000],
  ['K', 1000],
  ['M', 1000 ** 2],
  ['G', 1000 ** 3],
  ['T', 1000 ** 4],
  ['P', 1000 ** 5]
]

/** Memory as bytes. A bare number is already bytes. */
export function parseMemBytes(v: string): number | null {
  const s = v.trim()
  if (s === '' || s === NONE) return null
  const m = s.match(/^(\d+(?:\.\d+)?)([A-Za-z]*)$/)
  if (m === null) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  const unit = m[2]
  if (unit === '') return Math.round(n)
  const found = MEM_UNITS.find(([u]) => u === unit)
  return found ? Math.round(n * found[1]) : null
}

/** `<none>` is one absent list, not a list containing "<none>". */
function splitList(v: string): string[] {
  const s = v.trim()
  if (s === '' || s === NONE) return []
  return s.split(',').map((x) => x.trim()).filter((x) => x !== '')
}

export interface PodRequestRow {
  namespace: string
  name: string
  /** Empty for a pod the scheduler has not placed. */
  node: string | null
  phase: string
  containers: number
  cpu: string[]
  mem: string[]
  initContainers: number
  initCpu: string[]
  initMem: string[]
}

/** Whitespace-split on a fixed column count, from the right where possible.
 *  kubectl pads with spaces and no field measured here contains one. */
export function parsePodRequests(text: string): PodRequestRow[] {
  const out: PodRequestRow[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t === '' || t.startsWith('NS ')) continue
    const f = t.split(/\s+/)
    // Ten columns exactly. A line with fewer is a message, not a row -- and a
    // message read as a row would invent a pod.
    if (f.length !== 10) continue
    out.push({
      namespace: f[0],
      name: f[1],
      node: f[2] === NONE ? null : f[2],
      phase: f[3],
      containers: splitList(f[4]).length,
      cpu: splitList(f[5]),
      mem: splitList(f[6]),
      initContainers: splitList(f[7]).length,
      initCpu: splitList(f[8]),
      initMem: splitList(f[9])
    })
  }
  return out
}

export interface PodEffective {
  cpuMilli: number
  memBytes: number
  /** No container on this pod declares a request for that resource. */
  cpuUnset: boolean
  memUnset: boolean
  /** SOME containers declare one and some do not. Finding 2: the read cannot
   *  say which, only that the counts disagree. */
  cpuPartial: boolean
  memPartial: boolean
}

/**
 * What the scheduler books for one pod.
 *
 * `max(sum(containers), max(initContainers))`, per resource, which is finding 3
 * and is the formula the describe block confirmed.
 */
export function podEffective(p: PodRequestRow): PodEffective {
  const sum = (xs: string[], f: (v: string) => number | null): number =>
    xs.reduce((a, v) => a + (f(v) ?? 0), 0)
  const max = (xs: string[], f: (v: string) => number | null): number =>
    xs.reduce((a, v) => Math.max(a, f(v) ?? 0), 0)
  return {
    cpuMilli: Math.max(sum(p.cpu, parseCpuMilli), max(p.initCpu, parseCpuMilli)),
    memBytes: Math.max(sum(p.mem, parseMemBytes), max(p.initMem, parseMemBytes)),
    cpuUnset: p.cpu.length === 0,
    memUnset: p.mem.length === 0,
    cpuPartial: p.cpu.length > 0 && p.cpu.length < p.containers,
    memPartial: p.mem.length > 0 && p.mem.length < p.containers
  }
}

export interface NodeRow {
  name: string
  cpu: string
  mem: string
  pods: string
  unschedulable: boolean
}

export function parseNodeAllocatable(text: string): NodeRow[] {
  const out: NodeRow[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t === '' || t.startsWith('NAME ')) continue
    const f = t.split(/\s+/)
    if (f.length !== 5) continue
    out.push({
      name: f[0],
      cpu: f[1],
      mem: f[2],
      pods: f[3],
      // Measured: `true` when cordoned, `<none>` when not. Anything else is
      // read as schedulable, because `.spec.unschedulable` is a boolean and an
      // unexpected word there is not evidence that it is closed.
      unschedulable: f[4] === 'true'
    })
  }
  return out
}

export interface NodeAllocation {
  node: string
  cordoned: boolean
  /** Null when the node did not report a parseable allocatable. NOT zero: a
   *  node whose capacity could not be read has unknown headroom, and zero
   *  would render it as full. */
  cpuAllocatableMilli: number | null
  memAllocatableBytes: number | null
  cpuRequestedMilli: number
  memRequestedBytes: number
  podCount: number
  /** Pods on this node with no CPU/memory request on any container. */
  cpuUnsetPods: number
  memUnsetPods: number
  /** Pods where only SOME containers declare one. */
  partialPods: number
  cpuPct: number | null
  memPct: number | null
}

export interface AllocationReport {
  nodes: NodeAllocation[]
  /** Pods the scheduler has not placed, named rather than dropped. */
  unplaced: { namespace: string; name: string; phase: string; cpuMilli: number; memBytes: number }[]
  /** Every node that could not be sized, so a total can say what it excludes. */
  unreadableNodes: string[]
}

/** A pod that is finished is not holding anything. Succeeded and Failed pods
 *  keep a `nodeName` long after their resources are back. */
const HOLDS_RESOURCES = (phase: string): boolean => phase !== 'Succeeded' && phase !== 'Failed'

export function allocationReport(nodes: NodeRow[], pods: PodRequestRow[]): AllocationReport {
  const byNode = new Map<string, PodRequestRow[]>()
  const unplaced: AllocationReport['unplaced'] = []
  for (const p of pods) {
    if (!HOLDS_RESOURCES(p.phase)) continue
    if (p.node === null) {
      const e = podEffective(p)
      unplaced.push({
        namespace: p.namespace,
        name: p.name,
        phase: p.phase,
        cpuMilli: e.cpuMilli,
        memBytes: e.memBytes
      })
      continue
    }
    byNode.set(p.node, [...(byNode.get(p.node) ?? []), p])
  }

  const unreadableNodes: string[] = []
  const rows: NodeAllocation[] = nodes.map((n) => {
    const mine = byNode.get(n.name) ?? []
    let cpuRequestedMilli = 0
    let memRequestedBytes = 0
    let cpuUnsetPods = 0
    let memUnsetPods = 0
    let partialPods = 0
    for (const p of mine) {
      const e = podEffective(p)
      cpuRequestedMilli += e.cpuMilli
      memRequestedBytes += e.memBytes
      if (e.cpuUnset) cpuUnsetPods += 1
      if (e.memUnset) memUnsetPods += 1
      if (e.cpuPartial || e.memPartial) partialPods += 1
    }
    const cpuAllocatableMilli = parseCpuMilli(n.cpu)
    const memAllocatableBytes = parseMemBytes(n.mem)
    if (cpuAllocatableMilli === null || memAllocatableBytes === null) unreadableNodes.push(n.name)
    return {
      node: n.name,
      cordoned: n.unschedulable,
      cpuAllocatableMilli,
      memAllocatableBytes,
      cpuRequestedMilli,
      memRequestedBytes,
      podCount: mine.length,
      cpuUnsetPods,
      memUnsetPods,
      partialPods,
      cpuPct:
        cpuAllocatableMilli !== null && cpuAllocatableMilli > 0
          ? (cpuRequestedMilli / cpuAllocatableMilli) * 100
          : null,
      memPct:
        memAllocatableBytes !== null && memAllocatableBytes > 0
          ? (memRequestedBytes / memAllocatableBytes) * 100
          : null
    }
  })
  return { nodes: rows, unplaced, unreadableNodes }
}

/**
 * The one line.
 *
 * IT NEVER REPORTS A PERCENTAGE AS THE WHOLE STORY. A cluster at 8% whose pods
 * are mostly unsized is not a cluster with headroom -- it is a cluster whose
 * headroom nobody can compute, because an unsized pod can grow into whatever is
 * left. So the count of unsized pods is in the sentence whenever there is one,
 * and a cordoned node's capacity is excluded from the total with the exclusion
 * said out loud.
 */
export function allocationHeadline(r: AllocationReport): string {
  const open = r.nodes.filter((n) => !n.cordoned && n.cpuAllocatableMilli !== null)
  if (open.length === 0) {
    return r.nodes.length === 0
      ? 'No nodes were read, so nothing can be said about capacity.'
      : 'Every node is cordoned or could not be sized, so there is no schedulable capacity to report.'
  }
  const cpuAlloc = open.reduce((a, n) => a + (n.cpuAllocatableMilli ?? 0), 0)
  const cpuReq = open.reduce((a, n) => a + n.cpuRequestedMilli, 0)
  const pct = cpuAlloc > 0 ? Math.round((cpuReq / cpuAlloc) * 100) : 0
  const unsized = r.nodes.reduce((a, n) => a + n.cpuUnsetPods, 0)
  const partial = r.nodes.reduce((a, n) => a + n.partialPods, 0)
  const cordoned = r.nodes.filter((n) => n.cordoned).length

  const parts = [`${pct}% of CPU is requested across ${open.length} schedulable node(s)`]
  if (unsized > 0) {
    parts.push(
      `${unsized} pod(s) request no CPU at all, so what they will actually use is not in that number`
    )
  }
  if (partial > 0) parts.push(`${partial} pod(s) size only some of their containers`)
  if (cordoned > 0) parts.push(`${cordoned} cordoned node(s) are excluded`)
  if (r.unreadableNodes.length > 0) {
    parts.push(`${r.unreadableNodes.length} node(s) could not be sized and are excluded`)
  }
  if (r.unplaced.length > 0) parts.push(`${r.unplaced.length} pod(s) are not scheduled anywhere`)
  return `${parts.join('. ')}.`
}
