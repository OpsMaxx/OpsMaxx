// Item 39's reads, in one round trip and one ranked list.
//
// Eleven modules shipped as parsers with nothing calling them. This is the
// thing that calls them: one command with a marker per section, one parse that
// hands each section to the module that understands it, and one list of
// findings the panel renders worst-first.
//
// TWO PROPERTIES IT HAS TO KEEP, and both are about absence.
//
//  1. A SECTION THAT DID NOT ARRIVE IS NOT AN EMPTY SECTION. Every read is a
//     `K8sRead`, so "the cluster has no PodDisruptionBudgets" and "we were not
//     allowed to list them" are different answers all the way to the screen.
//     Each read is `|| true`-free and carries its own text, so one denial does
//     not cost the other ten.
//
//  2. A FINDING IS NEVER SYNTHESISED FROM A MISSING READ. `reviewFindings`
//     iterates only over sections that came back ok. A read that failed
//     produces a `blind` entry naming what was not looked at -- which is the
//     line that stops a short list of findings reading as a clean cluster.

import {
  crashloopReading,
  type CrashPodMinimal,
  type CrashReadState
} from './k8sCrashloop'
import { daemonSetVerdict, groupWarnings, parseAddonDaemonSets, parseWarnings } from './k8sAddon'
import { judgeHpas, parseHpas } from './k8sHpa'
import { judgeNodes, parseNodeHealth } from './k8sNodes'
import { parsePvs, pvVerdict, type K8sPv } from './k8sPv'
import { parseStaleJobs, parseStalePods, staleFindings } from './k8sStale'
import { parseWorkloadResources, type WorkloadResources } from './k8sResources'
import { orphanedPdbs, pdbCoverage, type WorkloadRef } from './k8sPdbView'
import { parseDrainPdbs } from './kubernetes'
import {
  parseNamedObjects,
  parsePodReferences,
  proposable,
  unusedCandidates,
  unusedCaveat
} from './k8sUnused'

export type ReviewLevel = 'alarm' | 'watch' | 'ok'

export interface ReviewFinding {
  /** Which read it came from, so the panel can group without re-deriving. */
  section: ReviewSection
  level: ReviewLevel
  /** The object it is about: `default/web`, `node-1`. */
  subject: string
  because: string
}

export type ReviewSection =
  | 'nodes'
  | 'workloads'
  | 'hpa'
  | 'pdb'
  | 'stale'
  | 'pv'
  | 'addons'
  | 'warnings'
  | 'unused'

export const REVIEW_SECTIONS: readonly ReviewSection[] = [
  'nodes',
  'workloads',
  'hpa',
  'pdb',
  'stale',
  'pv',
  'addons',
  'warnings',
  'unused'
]

/** The marker each section's output sits under. */
export const REVIEW_MARKERS = {
  nodes: 'NODES',
  workloadRes: 'WORKLOADRES',
  workloadLabels: 'WORKLOADLABELS',
  hpa: 'HPA',
  pdb: 'PDB',
  stalePods: 'STALEPODS',
  staleJobs: 'STALEJOBS',
  pv: 'PV',
  ds: 'DS',
  warn: 'WARN',
  cm: 'CM',
  pvc: 'PVCX',
  refs: 'REFS'
} as const

/**
 * The section a marker's text belongs to, keyed by marker.
 *
 * `Record<keyof typeof REVIEW_MARKERS, ...>` on purpose: adding a marker
 * without saying which section it feeds is a compile error rather than a block
 * of output nothing reads.
 */
export const MARKER_SECTION: Record<keyof typeof REVIEW_MARKERS, ReviewSection> = {
  nodes: 'nodes',
  workloadRes: 'workloads',
  workloadLabels: 'pdb',
  hpa: 'hpa',
  pdb: 'pdb',
  stalePods: 'stale',
  staleJobs: 'stale',
  pv: 'pv',
  ds: 'addons',
  warn: 'warnings',
  cm: 'unused',
  pvc: 'unused',
  refs: 'unused'
}

/**
 * The kubectl arguments behind each marker.
 *
 * Exported so a test can assert the recorded fixture was captured with THESE
 * reads. Every column order here is the one its module's parser indexes by, and
 * two of them are not custom-columns for a measured reason:
 *
 *  - PDB uses the drain preflight's `|`-separated jsonpath, because a selector
 *    is a MAP and custom-columns prints `map[a:1 b:2]` with a space in it,
 *    which shifts every column after it. Reading it wrong was not theoretical:
 *    an early version of this file did, `parseDrainPdbs` returned nothing, and
 *    every workload was then reported as having no budget at all.
 *  - WORKLOADLABELS is a go-template, because jsonpath cannot enumerate a map's
 *    KEYS and the selector labels are exactly that.
 */
export const REVIEW_READS: Record<keyof typeof REVIEW_MARKERS, string> = {
  nodes:
    'get nodes --no-headers -o \'custom-columns=NAME:.metadata.name,MEM:.status.conditions[?(@.type=="MemoryPressure")].status,DISK:.status.conditions[?(@.type=="DiskPressure")].status,PID:.status.conditions[?(@.type=="PIDPressure")].status,READY:.status.conditions[?(@.type=="Ready")].status,CPU:.status.allocatable.cpu,MEM2:.status.allocatable.memory,PODS:.status.allocatable.pods,TAINTS:.spec.taints[*].key\'',
  workloadRes:
    "get deployments -A --no-headers -o 'custom-columns=NS:.metadata.namespace,NAME:.metadata.name,REPLICAS:.spec.replicas,CPUREQ:.spec.template.spec.containers[*].resources.requests.cpu,MEMREQ:.spec.template.spec.containers[*].resources.requests.memory,CPULIM:.spec.template.spec.containers[*].resources.limits.cpu,MEMLIM:.spec.template.spec.containers[*].resources.limits.memory'",
  workloadLabels:
    'get deployments -A -o go-template=\'{{range .items}}{{.metadata.namespace}}|{{.metadata.name}}|{{.spec.replicas}}|{{range $k,$v := .spec.selector.matchLabels}}{{$k}}={{$v}};{{end}}{{"\\n"}}{{end}}\'',
  hpa:
    "get hpa -A --no-headers -o 'custom-columns=NS:.metadata.namespace,NAME:.metadata.name,TARGET:.spec.scaleTargetRef.name,MIN:.spec.minReplicas,MAX:.spec.maxReplicas,CUR:.status.currentReplicas,DES:.status.desiredReplicas,TU:.spec.metrics[0].resource.target.averageUtilization,CU:.status.currentMetrics[0].resource.current.averageUtilization'",
  pdb:
    'get poddisruptionbudgets --all-namespaces -o \'jsonpath={range .items[*]}{.metadata.namespace}{"|"}{.metadata.name}{"|"}{.status.disruptionsAllowed}{"|"}{.status.currentHealthy}{"|"}{.status.desiredHealthy}{"|"}{.status.expectedPods}{"|"}{.spec.selector.matchLabels}{"|"}{.spec.selector.matchExpressions}{"\\n"}{end}\'',
  stalePods:
    "get pods -A --no-headers -o 'custom-columns=NS:.metadata.namespace,NAME:.metadata.name,PHASE:.status.phase,REASON:.status.reason,START:.status.startTime,OWNER:.metadata.ownerReferences[0].kind'",
  staleJobs:
    "get jobs -A --no-headers -o 'custom-columns=NS:.metadata.namespace,NAME:.metadata.name,SUCCEEDED:.status.succeeded,FAILED:.status.failed,START:.status.startTime,DONE:.status.completionTime'",
  pv:
    "get pv --no-headers -o 'custom-columns=NAME:.metadata.name,CAP:.spec.capacity.storage,RECLAIM:.spec.persistentVolumeReclaimPolicy,STATUS:.status.phase,CNS:.spec.claimRef.namespace,CNAME:.spec.claimRef.name,SC:.spec.storageClassName,REASON:.status.reason'",
  ds:
    "get ds -A --no-headers -o 'custom-columns=NS:.metadata.namespace,NAME:.metadata.name,DESIRED:.status.desiredNumberScheduled,CURRENT:.status.currentNumberScheduled,READY:.status.numberReady,UPTODATE:.status.updatedNumberScheduled,AVAIL:.status.numberAvailable,UNAVAIL:.status.numberUnavailable,MISSCHED:.status.numberMisscheduled,GEN:.metadata.generation,OBSGEN:.status.observedGeneration'",
  warn:
    "get events -A --field-selector type=Warning --no-headers -o 'custom-columns=NS:.metadata.namespace,REASON:.reason,KIND:.involvedObject.kind,NAME:.involvedObject.name,COUNT:.count,LAST:.lastTimestamp,MSG:.message'",
  cm:
    "get cm -A --no-headers -o 'custom-columns=NS:.metadata.namespace,NAME:.metadata.name,AGE:.metadata.creationTimestamp'",
  pvc:
    "get pvc -A --no-headers -o 'custom-columns=NS:.metadata.namespace,NAME:.metadata.name,PHASE:.status.phase,AGE:.metadata.creationTimestamp'",
  refs:
    'get pods -A -o \'jsonpath={range .items[*]}{.metadata.namespace}{"|"}{.metadata.name}{"|cm:"}{range .spec.volumes[*]}{.configMap.name}{";"}{range .projected.sources[*]}{.configMap.name}{";"}{end}{end}{"|env:"}{range .spec.containers[*]}{range .envFrom[*]}{.configMapRef.name}{";"}{end}{range .env[*]}{.valueFrom.configMapKeyRef.name}{";"}{end}{end}{"|pvc:"}{range .spec.volumes[*]}{.persistentVolumeClaim.claimName}{";"}{end}{"\\n"}{end}\''
}

/**
 * One round trip.
 *
 * Every block ends `2>&1` and NOT `|| true`. A denial has to arrive as that
 * section's text so it becomes a blind spot for that section alone -- swallowing
 * it would make one RBAC refusal look like a clean read of an empty cluster,
 * and `|| true` on the last block would additionally erase the exit status the
 * caller classifies the whole failure by.
 */
export function buildK8sReviewCommand(kubectl = 'kubectl', context?: string): string {
  const ctx = context === undefined || context === '' ? '' : ` --context=${context}`
  const keys = Object.keys(REVIEW_MARKERS) as (keyof typeof REVIEW_MARKERS)[]
  return keys
    .map(
      (k) =>
        `echo "===SHELLPILOT-${REVIEW_MARKERS[k]}==="; ${kubectl} ${REVIEW_READS[k]}${ctx} 2>&1`
    )
    .join('; ')
}

/** The raw text of every section, or the reason it is missing. */
export type SectionText = { ok: true; text: string } | { ok: false; detail: string }

export type ReviewBlocks = Record<keyof typeof REVIEW_MARKERS, SectionText>

/**
 * Split one round trip into its sections.
 *
 * A marker that is not in the output at all means the command stopped before
 * reaching it -- the connection dropped, kubectl is not installed, the shell
 * died. That is `ok: false` with the last thing the host said, never an empty
 * string, because an empty string renders as a clean cluster.
 */
export function splitReview(output: string): ReviewBlocks {
  const keys = Object.keys(REVIEW_MARKERS) as (keyof typeof REVIEW_MARKERS)[]
  const tail = output.trim().split('\n').filter((l) => l.trim() !== '').slice(-1)[0] ?? 'kubectl did not run'
  const out = {} as ReviewBlocks
  for (const key of keys) {
    const marker = `===SHELLPILOT-${REVIEW_MARKERS[key]}===`
    const at = output.indexOf(marker)
    if (at < 0) {
      out[key] = { ok: false, detail: tail }
      continue
    }
    const from = at + marker.length
    // The next marker of ANY kind, not the next one in key order: the command
    // may be reordered later and this must not silently swallow a section.
    let end = output.length
    for (const other of keys) {
      const m = `===SHELLPILOT-${REVIEW_MARKERS[other]}===`
      const i = output.indexOf(m, from)
      if (i >= 0 && i < end) end = i
    }
    out[key] = { ok: true, text: output.slice(from, end).trim() }
  }
  return out
}

/** kubectl's own denials, which arrive as ordinary text on a section. */
const DENIED_RE = /^(error|Error from server|The connection to the server)/m

/** A section whose text is a kubectl error rather than rows. */
export function sectionFailed(block: SectionText): string | null {
  if (!block.ok) return block.detail
  if (block.text === '') return null
  if (DENIED_RE.test(block.text)) return block.text.split('\n')[0]
  return null
}

export interface ReviewResult {
  findings: ReviewFinding[]
  /** What was not looked at, and why. Never empty when a read failed. */
  blind: { section: ReviewSection; detail: string }[]
  /** Sentences that belong to a whole section rather than to one object. */
  notes: string[]
}

const rank: Record<ReviewLevel, number> = { alarm: 0, watch: 1, ok: 2 }

/**
 * Every module's verdict, in one ranked list.
 *
 * `ok` findings are produced and kept. A review that shows only problems cannot
 * be told from a review that did not run, and the count of things checked is
 * the difference.
 */
export function reviewFindings(
  blocks: ReviewBlocks,
  now: number,
  staleOlderThanDays = 1
): ReviewResult {
  const findings: ReviewFinding[] = []
  const blind: { section: ReviewSection; detail: string }[] = []
  const notes: string[] = []
  const seenBlind = new Set<string>()

  const check = (key: keyof typeof REVIEW_MARKERS): string | null => {
    const failed = sectionFailed(blocks[key])
    if (failed === null) return blocks[key].ok ? blocks[key].text : null
    const section = MARKER_SECTION[key]
    const at = `${section}:${failed}`
    if (!seenBlind.has(at)) {
      seenBlind.add(at)
      blind.push({ section, detail: failed })
    }
    return null
  }

  const nodes = check('nodes')
  if (nodes !== null) {
    const read = parseNodeHealth(nodes)
    // `judgeNodes` returns only what is WRONG, so the healthy nodes are added
    // from the read. A review that lists nothing about a node it looked at
    // cannot be told from one that never looked.
    const judged = new Map(judgeNodes(read).map((f) => [f.node, f]))
    for (const n of read) {
      const f = judged.get(n.name)
      if (f === undefined) {
        findings.push({ section: 'nodes', level: 'ok', subject: n.name, because: `${n.name} is Ready and under no pressure.` })
        continue
      }
      findings.push({
        section: 'nodes',
        // A cordoned node is not broken -- somebody emptied it deliberately.
        level: f.verdict === 'unschedulable' ? 'watch' : 'alarm',
        subject: n.name,
        because: f.because
      })
    }
  }

  const workloads = check('workloadRes')
  if (workloads !== null) {
    for (const w of parseWorkloadResources(workloads) as WorkloadResources[]) {
      const unbounded = w.cpuLimitMillis === null && w.memLimitBytes === null
      findings.push({
        section: 'workloads',
        level: unbounded ? 'watch' : 'ok',
        subject: `${w.namespace}/${w.name}`,
        because: unbounded
          ? `${w.namespace}/${w.name} declares no CPU or memory limit, so nothing bounds what it can take from the node.`
          : `${w.namespace}/${w.name} declares limits.`
      })
    }
  }

  // PDBs need the workloads' SELECTOR LABELS, which the resource read does not
  // carry -- a labels map prints with spaces between entries and would shift
  // every column after it. So they come from a go-template read of their own,
  // separated by `|`.
  const pdbText = check('pdb')
  const wlText = check('workloadLabels')
  if (pdbText !== null && wlText !== null) {
    const pdbs = parseDrainPdbs(pdbText)
    // TEXT THAT PARSED TO NOTHING IS NOT AN EMPTY CLUSTER. Found the hard way:
    // an early version read PDBs in the wrong format, `parseDrainPdbs` returned
    // [], and `pdbCoverage` then reported EVERY workload as uncovered -- a
    // screen full of confident findings produced by a read that failed. A
    // section with rows in it that yields no objects is a blind spot.
    if (pdbText.trim() !== '' && pdbs.length === 0) {
      blind.push({
        section: 'pdb',
        detail: 'the budget listing came back in a shape this build could not read, so coverage was not decided for anything'
      })
    } else {
    const workloads: WorkloadRef[] = []
    for (const raw of wlText.split('\n')) {
      const line = raw.trim()
      if (line === '') continue
      const f = line.split('|')
      if (f.length < 4) continue
      const labels: Record<string, string> = {}
      for (const pair of f[3].split(';')) {
        const at = pair.indexOf('=')
        if (at > 0) labels[pair.slice(0, at)] = pair.slice(at + 1)
      }
      const replicas = Number(f[2])
      workloads.push({
        namespace: f[0],
        name: f[1],
        labels,
        replicas: Number.isFinite(replicas) ? replicas : 0
      })
    }
    for (const c of pdbCoverage(workloads, pdbs)) {
      findings.push({
        section: 'pdb',
        // `blocking` is the one that stops a drain dead, and `cannot-evaluate`
        // is not an all-clear -- a matchExpressions budget in the namespace
        // means coverage was not decided either way.
        level: c.verdict === 'protected' ? 'ok' : c.verdict === 'blocking' ? 'alarm' : 'watch',
        subject: `${c.namespace}/${c.name}`,
        because: c.because
      })
    }
    for (const p of orphanedPdbs(pdbs)) {
      findings.push({
        section: 'pdb',
        level: 'watch',
        subject: `${p.namespace}/${p.name}`,
        because: `${p.namespace}/${p.name} guards no pods at all: it expects 0 and allows 0, which reads the same as a budget at its limit and is not one.`
      })
    }
    }
  }

  const hpas = check('hpa')
  if (hpas !== null) {
    const read = parseHpas(hpas)
    const judged = new Map(judgeHpas(read).map((f) => [`${f.namespace}/${f.name}`, f]))
    for (const h of read) {
      const where = `${h.namespace}/${h.name}`
      const f = judged.get(where)
      if (f === undefined) {
        findings.push({ section: 'hpa', level: 'ok', subject: where, because: `${where} is scaling on the metric it was given.` })
        continue
      }
      findings.push({
        section: 'hpa',
        // `unmeasured` is the one that matters and the one that looks fine:
        // an HPA with no metrics reports desired 0 and decides nothing.
        level: f.verdict === 'at-ceiling' || f.verdict === 'unmeasured' ? 'alarm' : 'watch',
        subject: where,
        because: f.because
      })
    }
  }

  const pods = check('stalePods')
  const jobs = check('staleJobs')
  if (pods !== null && jobs !== null) {
    for (const f of staleFindings(parseStalePods(pods), parseStaleJobs(jobs), staleOlderThanDays, now)) {
      findings.push({
        section: 'stale',
        level: 'watch',
        subject: `${f.namespace}/${f.name}`,
        because: f.because
      })
    }
  }

  const pvs = check('pv')
  if (pvs !== null) {
    for (const p of parsePvs(pvs) as K8sPv[]) {
      const v = pvVerdict(p)
      findings.push({
        section: 'pv',
        level: v.level === 'ok' ? 'ok' : v.level === 'alarm' ? 'alarm' : 'watch',
        subject: p.name,
        because: v.because
      })
    }
  }

  const ds = check('ds')
  if (ds !== null) {
    for (const d of parseAddonDaemonSets(ds)) {
      const v = daemonSetVerdict(d)
      findings.push({
        section: 'addons',
        level: v.level === 'ok' ? 'ok' : v.level === 'alarm' ? 'alarm' : 'watch',
        subject: `${d.namespace}/${d.name}`,
        because: v.because
      })
    }
  }

  const warn = check('warn')
  if (warn !== null) {
    for (const g of groupWarnings(parseWarnings(warn))) {
      findings.push({
        section: 'warnings',
        level: 'watch',
        subject: `${g.kind}/${g.name}`,
        because: `${g.reason} ×${g.count}: ${g.messages[0]}`
      })
    }
  }

  const cms = check('cm')
  const pvcs = check('pvc')
  const refs = check('refs')
  if (refs !== null) {
    const parsed = parsePodReferences(refs)
    if (cms !== null) {
      const cand = proposable(unusedCandidates(parseNamedObjects(cms), parsed, 'configmap'))
      for (const c of cand) {
        findings.push({
          section: 'unused',
          level: 'watch',
          subject: `${c.namespace}/${c.name}`,
          because: `No pod names this ConfigMap.`
        })
      }
      notes.push(unusedCaveat('configmap', cand.length))
    }
    if (pvcs !== null) {
      const cand = proposable(unusedCandidates(parseNamedObjects(pvcs), parsed, 'pvc'))
      for (const c of cand) {
        findings.push({
          section: 'unused',
          level: 'watch',
          subject: `${c.namespace}/${c.name}`,
          because: `No pod mounts this claim.`
        })
      }
      notes.push(unusedCaveat('pvc', cand.length))
    }
  }

  findings.sort(
    (a, b) => rank[a.level] - rank[b.level] || a.section.localeCompare(b.section) || a.subject.localeCompare(b.subject)
  )
  return { findings, blind, notes }
}

/**
 * Restart deltas across two reviews.
 *
 * `k8sCrashloop` needs the PREVIOUS reading to say anything -- a crashlooping
 * pod is `Running` and only sometimes `CrashLoopBackOff`, so only the delta is
 * reliable. It is therefore not part of `reviewFindings`, which sees one read.
 */
export function crashloopFindings(
  state: CrashReadState,
  pods: CrashPodMinimal[],
  previous: CrashPodMinimal[] | null
): ReviewFinding[] {
  const reading = crashloopReading(state, pods, previous)
  // No guard on `reading.bad` here, deliberately. `crashloopReading` returns an
  // EMPTY `restarting` in every case where `bad` is not true -- a failed read,
  // a partial one, and the no-previous-sample case -- so a guard would be dead
  // code that reads as the thing keeping the invariant. A mutation test on an
  // earlier version of this file removed one and no test noticed, which is what
  // that dead code costs. The tests below pin the behaviour instead.
  return reading.restarting.map((r) => ({
    section: 'stale' as const,
    level: 'alarm' as const,
    subject: `${r.namespace}/${r.name}`,
    because: `${r.namespace}/${r.name} restarted ${r.by} more time${r.by === 1 ? '' : 's'} since the last look, ${r.restarts} in total.`
  }))
}
