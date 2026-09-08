// Item 39's stale objects, second half: ConfigMaps and PVCs that no pod
// references. Report only, like the jobs and pods half -- and this half needs
// its blind spot stated louder, because the question it can answer is narrower
// than the question people will read it as answering.
//
// "NO POD REFERENCES THIS" IS NOT "THIS IS UNUSED". Measured on k3s v1.31.5,
// with a Deployment scaled to zero replicas mounting a ConfigMap: the ConfigMap
// is referenced by nothing that exists, and scaling that Deployment back up
// breaks immediately. A pod scan cannot see a workload with no pods, an Ingress
// annotation, a CRD, a Helm hook, or an operator that reads it at runtime.
//
// AND THE OBVIOUS SCAN IS WRONG IN THE OTHER DIRECTION TOO. `kube-root-ca.crt`
// exists in EVERY namespace and is referenced by every pod -- but only from
// inside a `projected` volume's `sources[]`, in a volume the API server injects
// and that appears in nobody's manifest. A scan walking `.spec.volumes[*]
// .configMap.name`, which is the path anybody writes first, misses it and
// reports it as unreferenced in every namespace on every cluster. Deleting it
// breaks the service-account CA for every pod. In the measured fixture it is
// also present in `kube-public` and `kube-node-lease`, which contain no pods at
// all, so there it is unreferenced by construction and forever.
//
// So: the projected path is walked, cluster-owned names are never proposed, and
// the result is called a candidate list with the blind spot printed next to it.

export interface PodReferences {
  namespace: string
  pod: string
  configMaps: string[]
  pvcs: string[]
}

/**
 * The read this parser is written against.
 *
 * `jsonpath`, not `custom-columns`: the reference sites are four different
 * paths and two of them are nested ranges. The `projected.sources[*]` term is
 * the one that must not be dropped -- see the header.
 */
export const UNUSED_REFS_JSONPATH =
  `{range .items[*]}{.metadata.namespace}{"|"}{.metadata.name}{"|cm:"}` +
  `{range .spec.volumes[*]}{.configMap.name}{";"}` +
  `{range .projected.sources[*]}{.configMap.name}{";"}{end}{end}` +
  `{"|env:"}{range .spec.containers[*]}` +
  `{range .envFrom[*]}{.configMapRef.name}{";"}{end}` +
  `{range .env[*]}{.valueFrom.configMapKeyRef.name}{";"}{end}{end}` +
  `{"|pvc:"}{range .spec.volumes[*]}{.persistentVolumeClaim.claimName}{";"}{end}` +
  `{"\\n"}{end}`

const names = (segment: string): string[] => {
  const out: string[] = []
  for (const part of segment.split(';')) {
    const t = part.trim()
    // Every volume without a configMap emits an empty term, so most of them are
    // empty. `mounted-claim` in the fixture arrives as `;mounted-claim;;`.
    if (t !== '' && !out.includes(t)) out.push(t)
  }
  return out
}

export function parsePodReferences(text: string): PodReferences[] {
  const out: PodReferences[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const parts = line.split('|')
    if (parts.length < 5) continue
    const cm = parts[2].startsWith('cm:') ? parts[2].slice(3) : ''
    const env = parts[3].startsWith('env:') ? parts[3].slice(4) : ''
    const pvc = parts[4].startsWith('pvc:') ? parts[4].slice(4) : ''
    const configMaps = names(cm)
    for (const n of names(env)) if (!configMaps.includes(n)) configMaps.push(n)
    out.push({ namespace: parts[0], pod: parts[1], configMaps, pvcs: names(pvc) })
  }
  return out
}

export interface K8sNamedObject {
  namespace: string
  name: string
  /** RFC3339 from `.metadata.creationTimestamp`. */
  created: string
}

export function parseNamedObjects(text: string): K8sNamedObject[] {
  const out: K8sNamedObject[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const f = line.split(/\s+/)
    if (f.length < 3) continue
    out.push({ namespace: f[0], name: f[1], created: f[f.length - 1] })
  }
  return out
}

/** Created and maintained by the cluster, in every namespace, referenced only
 *  through an injected volume. Never a deletion candidate. */
export const CLUSTER_OWNED_CONFIGMAPS: ReadonlySet<string> = new Set([
  'kube-root-ca.crt',
  'extension-apiserver-authentication',
  'kube-apiserver-legacy-service-account-token-tracking'
])

/** Namespaces whose contents belong to whoever installed the cluster. Their
 *  objects are still listed, and never proposed. */
export const SYSTEM_NAMESPACES: ReadonlySet<string> = new Set([
  'kube-system',
  'kube-public',
  'kube-node-lease'
])

export interface UnusedCandidate {
  namespace: string
  name: string
  created: string
  /** True when at least one pod names it. */
  referenced: boolean
  /** Why this is not a candidate even though nothing references it, or null. */
  keptBecause: string | null
}

function keepReason(namespace: string, name: string, kind: 'configmap' | 'pvc'): string | null {
  if (kind === 'configmap' && CLUSTER_OWNED_CONFIGMAPS.has(name)) {
    return 'the cluster creates and maintains this one; every pod reads it through a volume the API server injects'
  }
  if (SYSTEM_NAMESPACES.has(namespace)) {
    return 'it belongs to whoever installed the cluster, not to this workspace'
  }
  return null
}

/**
 * Objects no pod names, with the ones that must never be proposed marked.
 *
 * Everything is returned, including the referenced and the kept: a row
 * disappearing between the cluster and the screen is how somebody stops
 * trusting the screen. The caller decides what to show.
 */
export function unusedCandidates(
  objects: K8sNamedObject[],
  refs: PodReferences[],
  kind: 'configmap' | 'pvc'
): UnusedCandidate[] {
  const used = new Set<string>()
  for (const r of refs) {
    const list = kind === 'configmap' ? r.configMaps : r.pvcs
    for (const n of list) used.add(`${r.namespace}/${n}`)
  }
  return objects.map((o) => ({
    namespace: o.namespace,
    name: o.name,
    created: o.created,
    referenced: used.has(`${o.namespace}/${o.name}`),
    keptBecause: keepReason(o.namespace, o.name, kind)
  }))
}

/** The rows worth showing: unreferenced, and not one of the ones that must
 *  never be proposed. */
export function proposable(candidates: UnusedCandidate[]): UnusedCandidate[] {
  return candidates.filter((c) => !c.referenced && c.keptBecause === null)
}

/**
 * The sentence that goes with the list, and it is not optional.
 *
 * It names what was not looked at, because the list is a set of things to check
 * and reading it as a set of things to delete is the failure mode. A Deployment
 * scaled to zero was measured producing exactly this: a ConfigMap that nothing
 * references and that is needed the moment anybody scales it back up.
 */
export function unusedCaveat(kind: 'configmap' | 'pvc', count: number): string {
  const what = kind === 'configmap' ? 'ConfigMap' : 'PersistentVolumeClaim'
  if (count === 0) return `Every ${what} here is named by a running pod.`
  return (
    `${count} ${what}${count === 1 ? ' is' : 's are'} named by no pod that exists right now. ` +
    'That is not the same as unused: a workload scaled to zero has no pods, and nothing here ' +
    'looked at Deployments, StatefulSets, CronJobs, Helm hooks, operators or anything outside ' +
    'the cluster. Check each one before acting on it.'
  )
}
