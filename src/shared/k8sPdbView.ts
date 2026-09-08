import type { K8sPdb } from './kubernetes'

// Item 39's "PDBs as a view".
//
// Everything needed already exists inside the drain preflight; what is missing
// is the answer to a question asked outside a drain: "is this workload
// protected, and by how much". A budget that covers nothing protects nothing,
// and a workload covered by no budget is one a drain will evict all of at
// once -- neither is visible anywhere until somebody drains a node and finds
// out.
//
// `matchExpressions` STAYS "CANNOT EVALUATE", never skipped. The drain
// preflight already refuses to guess at one, in those words: "an unknown
// budget is not a permission". A view that quietly ignored such a budget would
// report a workload as unprotected when it may be the best protected thing on
// the cluster -- and the operator would go and add a second budget.

export interface WorkloadRef {
  namespace: string
  name: string
  /** The labels its pods carry. */
  labels: Record<string, string>
  replicas: number
}

export type CoverageVerdict =
  /** At least one budget selects this workload and allows disruptions. */
  | 'protected'
  /** Covered, but the budget currently allows none -- a drain will WAIT. */
  | 'blocking'
  /** No budget selects it. A drain takes every replica at once. */
  | 'uncovered'
  /** A budget in the namespace uses matchExpressions, so coverage cannot be
   *  decided either way. */
  | 'cannot-evaluate'

export interface PdbCoverage {
  namespace: string
  name: string
  verdict: CoverageVerdict
  /** Budgets that definitely select it, by matchLabels. */
  covering: string[]
  /** The smallest `disruptionsAllowed` across those, or null when none had a
   *  number -- which is not zero. */
  allowed: number | null
  because: string
}

/** Every label in the selector must match. An EMPTY matchLabels selects
 *  everything in the namespace, which is legal and is how a "protect the whole
 *  namespace" budget is written -- so it is not treated as "selects nothing". */
function selects(pdb: K8sPdb, w: WorkloadRef): boolean {
  if (pdb.namespace !== w.namespace) return false
  return Object.entries(pdb.matchLabels).every(([k, v]) => w.labels[k] === v)
}

export function pdbCoverage(workloads: WorkloadRef[], pdbs: K8sPdb[]): PdbCoverage[] {
  return workloads.map((w) => {
    // A budget we cannot evaluate is scoped to its namespace, so it only
    // clouds workloads there.
    const unevaluable = pdbs.filter((p) => p.hasMatchExpressions && p.namespace === w.namespace)
    const covering = pdbs.filter((p) => !p.hasMatchExpressions && selects(p, w))
    const numbers = covering
      .map((p) => p.disruptionsAllowed)
      .filter((n): n is number => n !== null)
    const allowed = numbers.length > 0 ? Math.min(...numbers) : null

    if (covering.length === 0 && unevaluable.length > 0) {
      return {
        namespace: w.namespace,
        name: w.name,
        verdict: 'cannot-evaluate',
        covering: [],
        allowed: null,
        because: `${unevaluable.length} budget(s) in ${w.namespace} select pods with matchExpressions, which a list read cannot evaluate — so whether ${w.name} is protected is unknown, not no.`
      }
    }
    if (covering.length === 0) {
      return {
        namespace: w.namespace,
        name: w.name,
        verdict: 'uncovered',
        covering: [],
        allowed: null,
        because: `No budget selects ${w.name}, so draining a node takes every one of its ${w.replicas} replica(s) that lives there, at once.`
      }
    }
    if (allowed === 0) {
      return {
        namespace: w.namespace,
        name: w.name,
        verdict: 'blocking',
        covering: covering.map((p) => p.name),
        allowed: 0,
        because: `${covering.map((p) => p.name).join(', ')} currently allows no disruptions, so a drain touching ${w.name} will wait rather than proceed.`
      }
    }
    return {
      namespace: w.namespace,
      name: w.name,
      verdict: 'protected',
      covering: covering.map((p) => p.name),
      allowed,
      because:
        allowed === null
          ? `${w.name} is covered by ${covering.length} budget(s), none of which reported how many disruptions it allows.`
          : `${w.name} is covered by ${covering.length} budget(s), allowing ${allowed}.`
    }
  })
}

/**
 * Budgets that select nothing at all.
 *
 * ASKED OF THE API, not re-derived from the labels. `expectedPods` is the
 * count the controller itself arrived at, and it is 0 exactly when the
 * selector matches nothing -- measured on a real cluster, where a budget
 * pointing at a label no deployment carries reports `expectedPods: 0`.
 * Recomputing that from matchLabels would be a second implementation of the
 * controller's own matching, and it would be wrong for every budget using
 * matchExpressions.
 *
 * WHY IT MATTERS: an orphaned budget reports `disruptionsAllowed: 0`, which is
 * byte-for-byte what a budget protecting something at its limit reports. On
 * the fixture, `orphan-pdb` and `web-pdb` both say 0. Without `expectedPods`
 * they are indistinguishable, and the operator is told a drain will wait on a
 * budget that is guarding nothing at all.
 */
export function orphanedPdbs(pdbs: K8sPdb[]): K8sPdb[] {
  return pdbs.filter((p) => p.expectedPods === 0)
}
