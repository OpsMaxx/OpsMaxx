// Teaching the wave gate that a host might be a Kubernetes node.
//
// ---------------------------------------------------------------------------
// THE BUG THIS EXISTS TO CLOSE
// ---------------------------------------------------------------------------
//
// The health gate between patch waves reads systemd and nothing else: a host
// passes when it answers SSH and has no failed units. That is the right check
// for a server and it is a DANGEROUS one for a Kubernetes node, because the two
// disagree exactly when it matters.
//
// A node that reboots into a broken kubelet answers SSH perfectly, runs no
// failed units -- `k3s.service` can be active while the node is NotReady, and
// on a kubeadm cluster the kubelet unit is active while it fails to register --
// and reports itself in fine health. The gate passes it, the run starts the
// next wave, and a three-node cluster is taken out one wave at a time by a
// mechanism whose entire purpose was to stop that. A staged rollout with a
// gate that cannot see the thing being rolled is worse than no gate: it looks
// like one.
//
// So the gate gains a second question -- is this host a node, and if so what
// does the CONTROL PLANE say about it -- answered by `judgeNodes`, which is
// already the app's one derivation of what a node's conditions mean and was
// measured against a real k3s node before and after `kubectl cordon`.
//
// ---------------------------------------------------------------------------
// MATCHING A SERVER TO A NODE, AND WHY IT IS EXACT
// ---------------------------------------------------------------------------
//
// A node name is usually the machine's hostname and is not required to be. The
// tempting thing is a fuzzy match -- strip the domain, compare prefixes, try
// the server's friendly name -- and it is the wrong thing, because the failure
// mode is not "no match". It is GATING THE WRONG MACHINE: passing wave 1
// because a different node is Ready, which is a false all-clear produced by our
// own guesswork.
//
// So the match is EXACT on the hostname the host reported about itself, with
// one normalisation that is not a guess: case, which DNS and Kubernetes both
// treat as insignificant and which kubelet lowercases on registration anyway.
// A short hostname is also compared against the node name's first label, since
// `web-1` and `web-1.internal` are the same machine under any reading -- but
// `web-1` and `web-11` are not, and a prefix match would have said they were.
//
// Anything that does not match exactly is NOT a node as far as the gate is
// concerned, and that is safe in the direction that matters: it falls back to
// the systemd rules that have always applied.

import type { K8sNodeHealth, NodeFinding } from './k8sNodes'
import { judgeNodes, parseNodeHealth } from './k8sNodes'

/**
 * What the gate knows about one host's role in a cluster.
 *
 * FOUR states, and the two that look alike are the point. "This host is not a
 * node" and "this host is a node whose state we could not read" are opposite
 * facts: the first is permission to fall back to the systemd rules, and the
 * second is a reason to wait. Collapsing them is the same class of mistake as
 * reading an unreadable journal as a quiet one.
 */
export type GateNode =
  /** The cluster was read and this host is not in it. Systemd rules alone. */
  | { role: 'not-a-node' }
  /**
   * The cluster was read and this host is one of its nodes.
   *
   * `finding` is NULL for a node with nothing wrong with it. That is
   * `judgeNodes`' shape and not an accident: it reports PROBLEMS, so a node it
   * says nothing about is a node it judged and found fine. Reading a missing
   * finding as "could not be read" -- which the first version of this file did
   * -- turns every healthy node into a gate that waits forever.
   */
  | { role: 'node'; nodeName: string; finding: NodeFinding | null }
  /**
   * This host IS a node and its current state could not be read. Never a pass:
   * the gate waits, and the runner halts if it is still unread at the timeout.
   */
  | { role: 'node-unread'; nodeName: string; why: string }
  /**
   * Nobody asked. No cluster read was attempted for this run -- the ordinary
   * case for an estate with no Kubernetes in it -- so this cannot block, and
   * the gate's note says the question was not asked rather than answered.
   */
  | { role: 'unknown' }

/** Case-insensitive, and the first DNS label only. See the header: this is a
 *  normalisation, not a guess. `web-1` and `web-1.internal` are one machine;
 *  `web-1` and `web-11` are two, which a prefix match would have got wrong. */
function sameHost(a: string, b: string): boolean {
  const norm = (v: string): string => v.trim().toLowerCase().replace(/\.$/, '')
  const x = norm(a)
  const y = norm(b)
  if (x === '' || y === '') return false
  if (x === y) return true
  const head = (v: string): string => v.split('.')[0]
  return head(x) === head(y)
}

export interface NodeMatchInput {
  serverId: string
  /**
   * The hostname the HOST reported about itself, not the friendly name.
   *
   * The friendly name is a label a person typed and can be anything; matching
   * on it would let a rename silently change which node a gate watches.
   */
  hostname: string | null
}

/**
 * Which of these servers are nodes of this cluster.
 *
 * `nodes === null` means the cluster was not read, and every host comes back
 * `unknown` rather than `not-a-node` -- the difference between "we asked and
 * you are not one" and "nobody asked".
 */
export function matchNodes(
  servers: NodeMatchInput[],
  nodes: K8sNodeHealth[] | null,
  o: { readFailure?: string; knownNodes?: string[] } = {}
): Map<string, GateNode> {
  const out = new Map<string, GateNode>()
  const known = o.knownNodes ?? []
  if (nodes === null) {
    // A FAILED READ IS NOT AN ANSWER, and for a host already established to be
    // a node it is not "unknown" either. Once a run knows a machine is a node
    // -- it read the cluster a wave ago, or it cordoned the thing itself -- a
    // later read that fails must not downgrade it to a host nobody asked about,
    // because `unknown` does not block and this does.
    for (const s of servers) {
      const hit = known.find((k) => s.hostname !== null && sameHost(k, s.hostname))
      out.set(
        s.serverId,
        hit === undefined
          ? { role: 'unknown' }
          : {
              role: 'node-unread',
              nodeName: hit,
              why: o.readFailure ?? 'the cluster could not be read on this attempt'
            }
      )
    }
    return out
  }
  const findings = new Map(judgeNodes(nodes).map((f) => [f.node, f]))
  for (const s of servers) {
    // A host that cannot say what it is called cannot be matched to a node, and
    // guessing from the friendly name is exactly the wrong-machine failure.
    if (s.hostname === null || s.hostname.trim() === '') {
      out.set(s.serverId, { role: 'not-a-node' })
      continue
    }
    const hit = nodes.find((n) => sameHost(n.name, s.hostname as string))
    if (hit === undefined) {
      out.set(s.serverId, { role: 'not-a-node' })
      continue
    }
    // `judgeNodes` reports problems, so no finding means it judged this node
    // and found nothing to say.
    out.set(s.serverId, {
      role: 'node',
      nodeName: hit.name,
      finding: findings.get(hit.name) ?? null
    })
  }
  return out
}

/** Verdicts that stop a staged run from starting the next wave. */
export const NODE_BLOCKING_VERDICTS = ['not-ready', 'unreported', 'unschedulable'] as const

/**
 * Why each blocking verdict blocks, in the words an operator reads.
 *
 * `unschedulable` is in the list and is the one worth defending. A cordoned
 * node is not broken -- `judgeNodes` is explicit that calling it unhealthy
 * would send somebody to investigate their own change -- but a node still
 * cordoned AFTER its wave finished is a machine this run took out of service
 * and did not put back, and rolling on to cordon the next one is how an
 * operator ends up with a cluster of empty nodes and a gate that said yes every
 * time.
 *
 * `pressure` is deliberately NOT here. Memory or disk pressure is usually a
 * property the node already had, so halting a whole estate's patch run on it
 * would stop legitimate work on a condition the run did not cause. It is
 * reported in the gate's note instead, by name, every time.
 */
export const NODE_BLOCK_REASON: Record<(typeof NODE_BLOCKING_VERDICTS)[number], string> = {
  'not-ready': 'is reporting NotReady to the control plane, so it is running nothing',
  unreported:
    'has stopped reporting to the control plane altogether, so nothing here knows what state it is in',
  unschedulable:
    'is still cordoned after its wave finished, so this run has taken it out of service and not put it back'
}

export interface NodeGateSummary {
  /** Node problems that stop the next wave. Empty is a pass. */
  blocking: { serverName: string; nodeName: string; because: string }[]
  /** Nodes whose state could not be read. A WAIT, not a failure. */
  unread: { serverName: string; nodeName: string; why: string }[]
  /** Said out loud every time rather than folded into the pass. */
  pressure: string[]
  /** Hosts the cluster was never asked about. */
  unasked: string[]
  /** Hosts the cluster was asked about and does not have. */
  notNodes: string[]
}

export function summariseNodeGate(
  hosts: { serverName: string; node?: GateNode }[]
): NodeGateSummary {
  const s: NodeGateSummary = { blocking: [], unread: [], pressure: [], unasked: [], notNodes: [] }
  for (const h of hosts) {
    const n = h.node
    // An absent reading is the same as nobody having asked. It is what every
    // caller written before this existed supplies, and it must keep meaning
    // "the systemd rules alone" rather than quietly becoming a node check that
    // always passes.
    if (n === undefined || n.role === 'unknown') {
      s.unasked.push(h.serverName)
      continue
    }
    if (n.role === 'not-a-node') {
      s.notNodes.push(h.serverName)
      continue
    }
    if (n.role === 'node-unread') {
      s.unread.push({ serverName: h.serverName, nodeName: n.nodeName, why: n.why })
      continue
    }
    // A node with nothing wrong with it. Nothing to report and nothing to stop.
    if (n.finding === null) continue
    const v = n.finding.verdict
    if (v === 'pressure') {
      s.pressure.push(`${h.serverName} (${n.finding.node}): ${n.finding.because}`)
      continue
    }
    const blocking = NODE_BLOCKING_VERDICTS.find((b) => b === v)
    if (blocking !== undefined) {
      s.blocking.push({
        serverName: h.serverName,
        nodeName: n.finding.node,
        because: `${h.serverName} ${NODE_BLOCK_REASON[blocking]}`
      })
    }
  }
  return s
}

// ---------------------------------------------------------------------------
// ASKING THE WAVE'S OWN HOSTS
// ---------------------------------------------------------------------------
//
// The gate needs two things per host: what this machine is CALLED, and what the
// control plane says about the node of that name. Both come from one command
// run on the host itself, and that choice removes the hardest part of the
// problem rather than solving it.
//
// THE HOSTNAME COMES FROM THE HOST. There is no cached "hostname this machine
// reported" to match against, and the alternatives were worse: the friendly
// name is a label somebody typed, and the SSH host is frequently an IP or a
// jump alias. A machine asked what it is called answers definitively, and it is
// the same string the kubelet registered with.
//
// THE NODE LIST COMES FROM WHOEVER CAN GIVE IT. Every host in the wave is
// asked; the ones with a kubeconfig answer with the whole cluster, and the ones
// without say so. They are all in the same wave of the same run, so any single
// answer describes every node in it. A wave where NOBODY can run kubectl yields
// no node list at all, and every host in it comes back `unknown` -- which does
// not block, and is exactly today's behaviour for an estate with no Kubernetes
// in it.
//
// This is why a plain kubeadm worker gets no protection from this: it has a
// kubelet and no kubeconfig, so unless something else in its wave can reach the
// API server, nothing here can tell whether it came back Ready. That is a
// stated limit, not a silent one.

export const GATE_NODE_MARKERS = {
  host: '===SP-GATE-HOST===',
  kubectl: '===SP-GATE-KUBECTL===',
  nodes: '===SP-GATE-NODES==='
} as const

/** The same nine columns `parseNodeHealth` reads, and deliberately the same
 *  string the review module already uses: two spellings of one read is two
 *  parsers waiting to disagree. */
export const GATE_NODE_COLUMNS =
  'custom-columns=NAME:.metadata.name,MEM:.status.conditions[?(@.type=="MemoryPressure")].status,DISK:.status.conditions[?(@.type=="DiskPressure")].status,PID:.status.conditions[?(@.type=="PIDPressure")].status,READY:.status.conditions[?(@.type=="Ready")].status,CPU:.status.allocatable.cpu,MEM2:.status.allocatable.memory,PODS:.status.allocatable.pods,TAINTS:.spec.taints[*].key'

/**
 * One read, run on a host in the finished wave.
 *
 * Never `sudo`. This is a read of a cluster an operator's own kubeconfig can
 * already see, and escalating to root to answer a health question would be a
 * larger privilege than the question needs.
 */
export function buildGateNodeCommand(context?: string): string {
  const ctx = context !== undefined && context !== '' ? ` --context=${context}` : ''
  return [
    `echo "${GATE_NODE_MARKERS.host}"`,
    'hostname 2>/dev/null || echo',
    `echo "${GATE_NODE_MARKERS.kubectl}"`,
    'command -v kubectl >/dev/null 2>&1 || { echo absent; exit 0; }',
    'echo present',
    `echo "${GATE_NODE_MARKERS.nodes}"`,
    // Stderr discarded, so an API server that refuses does not put an error
    // message where a node table goes -- the journal lesson, in another module.
    `kubectl get nodes --no-headers -o '${GATE_NODE_COLUMNS}'${ctx} 2>/dev/null || true`
  ].join('; ')
}

export interface GateNodeRead {
  /** What the machine says it is called, or null if it would not say. */
  hostname: string | null
  /** The cluster as this host sees it, or null when it could not look. */
  nodes: K8sNodeHealth[] | null
  kubectl: 'present' | 'absent' | 'unknown'
}

function section(output: string, marker: string): string {
  const i = output.indexOf(marker)
  if (i === -1) return ''
  const rest = output.slice(i + marker.length)
  const next = rest.search(/^===SP-GATE-/m)
  return (next === -1 ? rest : rest.slice(0, next)).trim()
}

export function parseGateNodeRead(output: string): GateNodeRead {
  const hostname = section(output, GATE_NODE_MARKERS.host).split('\n')[0]?.trim() ?? ''
  const k = section(output, GATE_NODE_MARKERS.kubectl).split('\n')[0]?.trim()
  const table = section(output, GATE_NODE_MARKERS.nodes)
  const nodes = table === '' ? null : parseNodeHealth(table)
  return {
    hostname: hostname === '' ? null : hostname,
    // An EMPTY table is not an empty cluster. `kubectl` printing nothing here
    // means it could not answer -- the command swallows its stderr -- and a
    // cluster with no nodes is not a thing that happens to a wave running on
    // one. Null, so every host in the wave stays unread rather than becoming
    // "not a node".
    nodes: nodes !== null && nodes.length === 0 ? null : nodes,
    kubectl: k === 'present' ? 'present' : k === 'absent' ? 'absent' : 'unknown'
  }
}

/**
 * Fold the wave's answers into one verdict per host.
 *
 * The node list is taken from whichever host could produce one; the hostname is
 * always the host's OWN answer. A host that did not answer at all keeps a null
 * hostname and therefore matches nothing, which is the safe direction: it falls
 * back to the systemd rules rather than being matched to a node by guesswork.
 */
export function gateNodesFromWave(
  answers: { serverId: string; read: GateNodeRead | null }[]
): Map<string, GateNode> {
  const cluster = answers.find((a) => a.read?.nodes != null)?.read?.nodes ?? null
  return matchNodes(
    answers.map((a) => ({ serverId: a.serverId, hostname: a.read?.hostname ?? null })),
    cluster
  )
}
