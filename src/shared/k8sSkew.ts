// Item 41's recommended alternative: the skew and readiness report.
//
// The item itself -- cordon, patch, reboot, uncordon as one job -- is seven
// things the job engine cannot express, and its own closing paragraph argues
// against building the upgrade at all: "leave the upgrade to the
// distribution's tooling, refused in the header the way apply is". What it
// asks for instead is the READ that tells an operator whether an upgrade is
// safe to start, and that is this file.
//
// Nothing here runs anything. It takes version strings the cluster reported
// and answers the question kubeadm will refuse on: is any node too far behind
// the API server, and is any node AHEAD of it.

export interface ParsedVersion {
  major: number
  minor: number
  patch: number | null
  /** Everything after the patch, verbatim: `+k3s1`, `-eks-a1b2c3`, `-gke.100`.
   *  Kept because "1.29.4+k3s1 and 1.29.4 are the same version" is true of the
   *  skew rule and false of almost every other question. */
  suffix: string
}

/**
 * `v1.29.4+k3s1` and friends.
 *
 * Null rather than a guess when it does not parse. A version this cannot read
 * is a version whose skew cannot be judged, and reporting a node as compliant
 * because its version string was unfamiliar is the failure this whole codebase
 * keeps refusing.
 */
export function parseK8sVersion(raw: string | null | undefined): ParsedVersion | null {
  if (!raw) return null
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?(.*)$/.exec(raw.trim())
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] === undefined ? null : Number(m[3]),
    suffix: m[4] ?? ''
  }
}

export type SkewVerdict =
  /** Same minor as the API server, or one behind. Nothing to do. */
  | 'ok'
  /** Behind, but inside the supported window. An upgrade is due, not urgent. */
  | 'behind'
  /** Outside the supported window. kubeadm will refuse, and the kubelet is not
   *  guaranteed to work against this API server at all. */
  | 'unsupported'
  /** NEWER than the API server. Never supported, in any version of the policy,
   *  and the usual cause is a control plane that failed halfway through an
   *  upgrade. */
  | 'ahead'
  /** A version string that could not be read, on either side. */
  | 'unknown'

/**
 * How far a kubelet may lag its API server.
 *
 * Three minor versions since Kubernetes 1.28; two before it. The wider number
 * is used because reporting a supported node as unsupported sends somebody to
 * do an upgrade they did not need, and the narrower case is still visible as
 * `behind`.
 */
export const KUBELET_SKEW_MINORS = 3

export interface NodeSkew {
  node: string
  version: string | null
  verdict: SkewVerdict
  /** Minor versions behind the API server. Negative when ahead, null when
   *  either side could not be read. */
  minorsBehind: number | null
  because: string
}

export function assessNodeSkew(
  serverVersion: string | null,
  nodes: { name: string; kubeletVersion: string | null }[]
): NodeSkew[] {
  const server = parseK8sVersion(serverVersion)
  return nodes.map((n) => {
    const k = parseK8sVersion(n.kubeletVersion)
    if (server === null || k === null) {
      return {
        node: n.name,
        version: n.kubeletVersion,
        verdict: 'unknown',
        minorsBehind: null,
        because:
          server === null
            ? 'The API server did not report a version this could read, so no node can be judged against it.'
            : `${n.name} reported a version this could not read (${n.kubeletVersion ?? 'nothing'}), so its skew is unknown rather than fine.`
      }
    }
    // Major is part of the comparison rather than assumed to be 1. It has been
    // 1 for a decade and this is not the file to bet on that.
    const behind = (server.major - k.major) * 1000 + (server.minor - k.minor)
    if (behind < 0) {
      return {
        node: n.name,
        version: n.kubeletVersion,
        verdict: 'ahead',
        minorsBehind: behind,
        because: `${n.name} is NEWER than the API server (${n.kubeletVersion} against ${serverVersion}). That is not supported in any version of the skew policy, and usually means a control-plane upgrade stopped halfway.`
      }
    }
    if (behind > KUBELET_SKEW_MINORS) {
      return {
        node: n.name,
        version: n.kubeletVersion,
        verdict: 'unsupported',
        minorsBehind: behind,
        because: `${n.name} is ${behind} minor versions behind the API server, which is outside the supported window of ${KUBELET_SKEW_MINORS}. An upgrade will refuse to proceed from here.`
      }
    }
    if (behind === 0) {
      return { node: n.name, version: n.kubeletVersion, verdict: 'ok', minorsBehind: 0, because: `${n.name} matches the API server.` }
    }
    return {
      node: n.name,
      version: n.kubeletVersion,
      verdict: behind === 1 ? 'ok' : 'behind',
      minorsBehind: behind,
      because: `${n.name} is ${behind} minor version(s) behind the API server.`
    }
  })
}

export interface PdbHeadroom {
  namespace: string
  name: string
  /** `disruptionsAllowed` from the PDB's status. Null when it could not be
   *  read -- which is NOT zero, and not "fine" either. */
  allowed: number | null
  /** True when a drain would block on this budget right now. */
  blocksDrain: boolean
  because: string
}

/**
 * Which budgets would stop a drain.
 *
 * `disruptionsAllowed: 0` is the number that turns a routine node drain into a
 * command that hangs until its timeout, and it is invisible until somebody
 * tries. A cluster where every node is inside the skew window and three
 * budgets are at zero is a cluster that cannot be upgraded, and the second
 * fact is the one nobody has.
 */
export function pdbHeadroom(
  pdbs: { namespace: string; name: string; disruptionsAllowed: number | null }[]
): PdbHeadroom[] {
  return pdbs.map((p) => ({
    namespace: p.namespace,
    name: p.name,
    allowed: p.disruptionsAllowed,
    // Null is not zero and is not headroom. A budget nobody could read is
    // reported as unreadable and does NOT claim a drain would block, because
    // saying so would be a measurement nobody took.
    blocksDrain: p.disruptionsAllowed === 0,
    because:
      p.disruptionsAllowed === null
        ? `${p.namespace}/${p.name} did not report how many disruptions it allows, so whether it would block a drain is unknown.`
        : p.disruptionsAllowed === 0
          ? `${p.namespace}/${p.name} allows no disruptions right now, so draining a node running its pods will wait rather than proceed.`
          : `${p.namespace}/${p.name} allows ${p.disruptionsAllowed}.`
  }))
}

/** The one line an operator reads before deciding to start. */
export function summariseUpgradeReadiness(
  skews: NodeSkew[],
  /** `null` when the budget read itself was refused or failed. NOT `[]`, which
   *  would say the cluster has no budgets and therefore nothing that could
   *  block a drain -- a claim nobody measured. */
  budgets: PdbHeadroom[] | null
): { ready: boolean; headline: string } {
  const ahead = skews.filter((s) => s.verdict === 'ahead').length
  const unsupported = skews.filter((s) => s.verdict === 'unsupported').length
  const unknown = skews.filter((s) => s.verdict === 'unknown').length
  const blocking = (budgets ?? []).filter((b) => b.blocksDrain).length
  const unreadable =
    budgets === null ? -1 : budgets.filter((b) => b.allowed === null).length

  const problems: string[] = []
  if (ahead > 0) problems.push(`${ahead} node(s) newer than the API server`)
  if (unsupported > 0) problems.push(`${unsupported} node(s) outside the skew window`)
  if (blocking > 0) problems.push(`${blocking} budget(s) allowing no disruptions`)
  // Carried into the headline rather than dropped, for the reason the stale
  // account summary carries its unknowns: a readiness number that improves as
  // the cluster gets harder to read is pointing the wrong way.
  if (unknown > 0) problems.push(`${unknown} node(s) whose version could not be read`)
  if (unreadable === -1) problems.push('the disruption budgets could not be read at all')
  else if (unreadable > 0) problems.push(`${unreadable} budget(s) that could not be read`)

  return problems.length === 0
    ? { ready: true, headline: 'Every node is inside the skew window and no budget would block a drain.' }
    : { ready: false, headline: `Not ready: ${problems.join(', ')}.` }
}
