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
import { judgeNodes } from './k8sNodes'

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
