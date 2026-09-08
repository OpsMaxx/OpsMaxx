// Chaining cordon → patch → reboot → uncordon into one confirmable job.
//
// Every one of these four is already a thing this app can do, and each is a
// separate click. That is not a small inconvenience: the sequence is only safe
// AS a sequence, and a human doing it by hand at 2am gets it wrong in one
// specific way -- they patch and reboot, the node comes back, and they forget
// the uncordon. The cluster then has a node that is Ready, healthy, running
// nothing, and reporting no problem to anybody.
//
// ---------------------------------------------------------------------------
// WHERE THE kubectl RUNS, AND WHY THIS REFUSES INSTEAD OF GUESSING
// ---------------------------------------------------------------------------
//
// A job step runs on the TARGET HOST. So the `cordon` and `uncordon` steps run
// on the node being maintained, which works only if that node can talk to its
// own API server: a k3s node and a kubeadm control-plane node can, and a
// typical kubeadm WORKER cannot -- it has a kubelet and no kubeconfig.
//
// The tempting alternative is to run the kubectl somewhere else. That needs the
// job to carry which host answers for the cluster, which is a new field on the
// spec and therefore inside the approval record, and it is a real design with a
// real UI question attached. It is NOT something to infer.
//
// So this REFUSES to plan for a node that cannot run kubectl itself, and says
// which of the two it is. A chain that cordoned and then could not uncordon
// would leave the node exactly in the state the whole feature exists to
// prevent, and it would do it having been confirmed by somebody who was told it
// would work.
//
// ---------------------------------------------------------------------------
// WHAT THIS DOES NOT DO: DRAIN
// ---------------------------------------------------------------------------
//
// A cordon evicts nothing -- kubernetes.ts is explicit about that, and this
// plan says it out loud rather than letting "cordon" imply "emptied". The pods
// already running on the node are still running when the reboot kills them.
//
// Drain is the module's dangerous verb, with seven refusals of its own and a
// timeout that can leave a node half-empty. Folding it silently into a
// four-step chain would smuggle the most destructive operation in the module
// into a button labelled "patch". If an operator wants the pods moved first,
// drain stays the separate, heavily graded thing it already is.
//
// ---------------------------------------------------------------------------
// ONE NODE PER JOB, AND WHY THAT IS A REAL LIMIT
// ---------------------------------------------------------------------------
//
// `kubectl cordon <node>` names its node, and a `JobSpec` carries ONE list of
// steps run against every target. So a chain built here is a job for exactly
// one node, and patching three of them is three jobs.
//
// That matters because it is precisely what waves are for, and it means a
// staged multi-node maintenance CANNOT be expressed as one chain today: nothing
// sequences the three jobs or holds the second until the first node is Ready
// again. Making it possible needs per-target step templating in the job engine
// -- a spec whose commands differ per host -- which changes what an approval
// record covers and is not a thing to bolt on.
//
// It is written here rather than discovered later. A caller that hands this a
// list of nodes and expects one job is going to be surprised, and the surprise
// would arrive as a cordon command naming the wrong machine.
//
// ---------------------------------------------------------------------------
// THE HALF-FINISHED CHAIN
// ---------------------------------------------------------------------------
//
// A run that fails after the cordon leaves the node cordoned. That is the
// correct outcome and not a gap: a node whose patch failed should NOT be taking
// work. The plan therefore ships an `uncordon` as the job's ROLLBACK, which
// item 44 already established is never run automatically -- a human presses it
// and answers a second confirmation. "Put it back into service" is a decision,
// and a machine that made it on its own would be returning a half-patched node
// to production because a script decided the failure looked recoverable.

import type { JobStep } from './jobs'
import { buildK8sCordonCommand, validateNodeName } from './kubernetes'

/**
 * Whether the node can run `kubectl` against its own cluster.
 *
 * Supplied by the caller from something it actually observed -- the Kubernetes
 * module's own reachability probe -- rather than assumed. `null` is "we do not
 * know", and it refuses like a `false` does: planning a cordon on a maybe is
 * how a node ends up cordoned by a chain that then cannot uncordon it.
 */
export type NodeKubectlReach = boolean | null

export type NodeMaintenanceRefusal =
  | 'invalid-node'
  | 'no-patch-steps'
  | 'no-kubectl'
  | 'kubectl-unknown'
  | 'no-reboot-step'

export interface NodeMaintenancePlan {
  steps: JobStep[]
  /** `kubectl uncordon`. NEVER run automatically — see the header. */
  rollback: JobStep[]
  /** Sentences the confirmation must show. Not optional, not a tooltip. */
  cautions: string[]
}

export type NodeMaintenanceResult =
  | { ok: true; plan: NodeMaintenancePlan }
  | { ok: false; refusal: NodeMaintenanceRefusal; reason: string }

export interface NodeMaintenanceRequest {
  node: string
  /** The patch commands, as the patch module already builds them. */
  patch: JobStep[]
  /** The reboot step, which must DECLARE that it restarts the machine. */
  reboot: JobStep
  context?: string
  kubectl: NodeKubectlReach
}

export function planNodeMaintenance(req: NodeMaintenanceRequest): NodeMaintenanceResult {
  if (!validateNodeName(req.node)) {
    return {
      ok: false,
      refusal: 'invalid-node',
      reason: 'that is not a node name this will write into a kubectl command'
    }
  }
  if (req.patch.length === 0) {
    return {
      ok: false,
      refusal: 'no-patch-steps',
      reason:
        'there is nothing to patch, so this would cordon a node and reboot it for no reason. A reboot with no change is still an outage.'
    }
  }
  // Declared, not sniffed. `jobs.ts` is explicit that a step which restarts the
  // machine and does not say so is treated as an ordinary one -- which here
  // would mean the runner calling the reboot's disconnect a failure and the
  // chain halting with the node cordoned.
  if (req.reboot.reboot !== true) {
    return {
      ok: false,
      refusal: 'no-reboot-step',
      reason:
        'the reboot step does not declare that it restarts the machine, so the runner would read the disconnect as a failure and stop the chain with the node still cordoned'
    }
  }
  if (req.kubectl === null) {
    return {
      ok: false,
      refusal: 'kubectl-unknown',
      reason:
        'whether this node can run kubectl against its own cluster was not established. This will not cordon a node on a maybe: if the uncordon then cannot run, the chain leaves the node out of service.'
    }
  }
  if (req.kubectl === false) {
    return {
      ok: false,
      refusal: 'no-kubectl',
      reason:
        'this node cannot run kubectl against its own cluster, which is normal for a worker node — it has a kubelet and no kubeconfig. The cordon and uncordon steps run ON the node, so this chain cannot manage it. Patch it as an ordinary server, and cordon it from wherever you already run kubectl.'
    }
  }

  const cordon: JobStep = { command: buildK8sCordonCommand(req.node, 'cordon', req.context) }
  const uncordon: JobStep = { command: buildK8sCordonCommand(req.node, 'uncordon', req.context) }

  return {
    ok: true,
    plan: {
      // The order IS the feature. Cordon first so nothing new schedules onto a
      // machine about to go down; uncordon last so the node only takes work
      // again after it has actually come back.
      steps: [cordon, ...req.patch, req.reboot, uncordon],
      rollback: [uncordon],
      cautions: [
        `A cordon evicts nothing. The pods already running on ${req.node} keep running until the reboot kills them — this does not drain the node, and if you want them moved first that is a separate, heavier decision.`,
        `If this run fails partway, ${req.node} stays cordoned. That is deliberate: a node whose patch did not finish should not be taking work. Putting it back is the rollback, and nothing runs that for you.`,
        'The cordon and uncordon run on the node itself, so they need its own kubeconfig.'
      ]
    }
  }
}

/** The one-line description the confirmation leads with. */
export function nodeMaintenanceSummary(node: string, plan: NodeMaintenancePlan): string {
  return `${plan.steps.length} steps on ${node}: cordon it, patch it, reboot it, then uncordon it. It stops taking new work at the first step and starts again at the last.`
}
