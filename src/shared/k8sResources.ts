// Item 39: requests and limits against what a node can actually give, and the
// storage claims underneath.
//
// `CPU_RE` and `MEM_RE` in shared/kubernetes.ts VALIDATE a quantity and do not
// convert it, which is right for a value being passed through. Comparing a
// workload's requests to a node's allocatable needs the conversion, and it is
// here rather than there because a converted number is a different thing from
// a validated string: `100m` is a quantity, `0.1` is an answer.

/**
 * Kubernetes CPU, in millicores.
 *
 * `100m` is a hundred millicores; a bare `12` is twelve CORES, which is twelve
 * thousand of them. Getting that backwards understates a node by a factor of a
 * thousand, which would report every cluster as wildly overcommitted.
 */
export function cpuToMillis(q: string): number | null {
  const t = q.trim()
  if (t === '' || t === '<none>') return null
  const m = /^(\d+(?:\.\d+)?)(m?)$/.exec(t)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  return m[2] === 'm' ? n : n * 1000
}

/** The binary suffixes Kubernetes actually uses, and the decimal ones it also
 *  accepts. `Ki` is 1024 and `K` is 1000, and both appear -- a node reports
 *  `24571576Ki` and a manifest may say `64Mi` or `64M`. */
const MEM_UNITS: Record<string, number> = {
  '': 1,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  K: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
  P: 1000 ** 5,
  k: 1000
}

export function memToBytes(q: string): number | null {
  const t = q.trim()
  if (t === '' || t === '<none>') return null
  const m = /^(\d+(?:\.\d+)?)([A-Za-z]*)$/.exec(t)
  if (!m) return null
  const unit = MEM_UNITS[m[2]]
  if (unit === undefined) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n * unit : null
}

export interface WorkloadResources {
  namespace: string
  name: string
  replicas: number
  /** Null when the workload sets none. NOT zero: a container with no request
   *  is not a container that needs nothing, it is one the scheduler places
   *  blind and the kubelet evicts first. */
  cpuRequestMillis: number | null
  memRequestBytes: number | null
  cpuLimitMillis: number | null
  memLimitBytes: number | null
}

const NONE = (v: string): string => (v === '<none>' || v === undefined ? '' : v)

/** Containers are comma-separated in one column, so a pod with a sidecar
 *  prints two values. Summed, because the pod asks for both. */
function sumField(v: string, conv: (s: string) => number | null): number | null {
  const parts = NONE(v).split(',').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return null
  const nums = parts.map(conv).filter((n): n is number => n !== null)
  return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0)
}

export function parseWorkloadResources(text: string): WorkloadResources[] {
  const out: WorkloadResources[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const f = line.split(/\s+/)
    if (f.length < 7) continue
    const replicas = Number(f[2])
    out.push({
      namespace: f[0],
      name: f[1],
      replicas: Number.isFinite(replicas) ? replicas : 0,
      cpuRequestMillis: sumField(f[3], cpuToMillis),
      memRequestBytes: sumField(f[4], memToBytes),
      cpuLimitMillis: sumField(f[5], cpuToMillis),
      memLimitBytes: sumField(f[6], memToBytes)
    })
  }
  return out
}

export interface CommitmentReading {
  cpuRequestedMillis: number
  memRequestedBytes: number
  cpuAllocatableMillis: number | null
  memAllocatableBytes: number | null
  /** Workloads that set NO cpu or memory request. Reported as a COUNT and a
   *  list, never folded into the totals as zero. */
  unbounded: { namespace: string; name: string; replicas: number }[]
  because: string
}

/**
 * What the cluster has asked for, against what it has.
 *
 * THE UNBOUNDED WORKLOADS ARE THE POINT. Measured on a stock k3s: of five
 * deployments, two set no requests at all. Summing what the rest asked for and
 * calling that the cluster's commitment would report a comfortable margin on a
 * cluster whose real usage is unknown -- because a container with no request
 * is not a container that needs nothing. It is one the scheduler places blind
 * and the kubelet evicts first under pressure.
 */
export function readCommitment(
  workloads: WorkloadResources[],
  nodes: { allocatableCpu: string; allocatableMemory: string }[]
): CommitmentReading {
  const cpuRequestedMillis = workloads.reduce(
    (a, w) => a + (w.cpuRequestMillis ?? 0) * Math.max(w.replicas, 0),
    0
  )
  const memRequestedBytes = workloads.reduce(
    (a, w) => a + (w.memRequestBytes ?? 0) * Math.max(w.replicas, 0),
    0
  )
  const cpus = nodes.map((n) => cpuToMillis(n.allocatableCpu)).filter((n): n is number => n !== null)
  const mems = nodes.map((n) => memToBytes(n.allocatableMemory)).filter((n): n is number => n !== null)
  const unbounded = workloads
    .filter((w) => w.cpuRequestMillis === null || w.memRequestBytes === null)
    .map((w) => ({ namespace: w.namespace, name: w.name, replicas: w.replicas }))

  // Null rather than 0 when no node's allocatable could be read: a percentage
  // against zero capacity is not a number anybody should see.
  const cpuAllocatableMillis = cpus.length > 0 ? cpus.reduce((a, b) => a + b, 0) : null
  const memAllocatableBytes = mems.length > 0 ? mems.reduce((a, b) => a + b, 0) : null

  const pct =
    cpuAllocatableMillis === null || cpuAllocatableMillis === 0
      ? null
      : Math.round((cpuRequestedMillis / cpuAllocatableMillis) * 100)
  const head =
    pct === null
      ? 'No node reported what it can allocate, so requests cannot be compared to capacity.'
      : `Workloads request ${pct}% of the cluster's allocatable CPU.`
  return {
    cpuRequestedMillis,
    memRequestedBytes,
    cpuAllocatableMillis,
    memAllocatableBytes,
    unbounded,
    because:
      unbounded.length === 0
        ? head
        : `${head} ${unbounded.length} workload(s) set no request at all, so their usage is not in that figure — the scheduler places them blind and the kubelet evicts them first.`
  }
}

// ---------------------------------------------------------------------------
// Storage claims
// ---------------------------------------------------------------------------

export interface K8sPvc {
  namespace: string
  name: string
  phase: string
  volume: string
  capacity: string
  storageClass: string
}

export interface K8sStorageClass {
  name: string
  provisioner: string
  /** `Immediate` or `WaitForFirstConsumer`. The difference decides whether a
   *  Pending claim is a fault. */
  bindingMode: string
  reclaimPolicy: string
  isDefault: boolean
}

export function parsePvcs(text: string): K8sPvc[] {
  const out: K8sPvc[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const f = line.split(/\s+/)
    if (f.length < 6) continue
    out.push({
      namespace: f[0],
      name: f[1],
      phase: f[2],
      volume: NONE(f[3]),
      capacity: NONE(f[4]),
      storageClass: NONE(f[5])
    })
  }
  return out
}

export function parseStorageClasses(text: string): K8sStorageClass[] {
  const out: K8sStorageClass[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const f = line.split(/\s+/)
    if (f.length < 4) continue
    out.push({
      name: f[0],
      provisioner: f[1],
      bindingMode: f[2],
      reclaimPolicy: f[3],
      isDefault: NONE(f[4]) === 'true'
    })
  }
  return out
}

/**
 * Whether a Pending claim is a problem.
 *
 * IT USUALLY IS NOT, and that is the finding. A class with
 * `volumeBindingMode: WaitForFirstConsumer` -- which is k3s's default, and
 * EKS's, and GKE's -- leaves every claim Pending until a pod that mounts it is
 * scheduled. Measured on a stock k3s: a freshly created PVC sits Pending with
 * no capacity and nothing is wrong. Reporting that as a fault would fire on
 * every such cluster, for every claim, until something happened to mount it.
 *
 * A Pending claim on an `Immediate` class is a different thing entirely: the
 * provisioner should have bound it and did not.
 */
export function pvcVerdict(
  pvc: K8sPvc,
  classes: K8sStorageClass[]
): { level: 'ok' | 'watch' | 'alarm' | 'unknown'; because: string } {
  if (pvc.phase === 'Bound') {
    return { level: 'ok', because: `${pvc.namespace}/${pvc.name} is bound to ${pvc.volume}.` }
  }
  if (pvc.phase === 'Lost') {
    return {
      level: 'alarm',
      because: `${pvc.namespace}/${pvc.name} is Lost: the volume behind it is gone, and the data with it.`
    }
  }
  if (pvc.phase !== 'Pending') {
    return { level: 'unknown', because: `${pvc.namespace}/${pvc.name} reports "${pvc.phase}".` }
  }
  const sc = classes.find((c) => c.name === pvc.storageClass)
  if (sc === undefined) {
    return {
      level: 'unknown',
      because: `${pvc.namespace}/${pvc.name} is Pending and its storage class (${pvc.storageClass || 'none named'}) was not among those read, so whether that is normal cannot be said.`
    }
  }
  if (sc.bindingMode === 'WaitForFirstConsumer') {
    return {
      level: 'ok',
      because: `${pvc.namespace}/${pvc.name} is Pending, which is what ${sc.name} does: it binds when a pod that mounts it is scheduled, not before.`
    }
  }
  return {
    level: 'alarm',
    because: `${pvc.namespace}/${pvc.name} is Pending on ${sc.name}, which binds immediately — so the provisioner (${sc.provisioner}) should have given it a volume and has not.`
  }
}
