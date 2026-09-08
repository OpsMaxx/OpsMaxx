// Item 39's HPA row. The row asks that "`<unknown>` renders as unmeasured,
// never 0 %", and measuring a real one showed the trap is sharper than that.
//
// ---------------------------------------------------------------------------
// TWO STATES THAT BOTH LOOK LIKE ZERO
// ---------------------------------------------------------------------------
// The same HPA, on the same k3s v1.31.5, a minute apart:
//
//   MIN MAX CUR DES TARGET CURUTIL
//   2   10  2   0   80     <none>     <- metrics not available yet
//   2   10  2   2   80     0          <- measuring, and the load really is 0%
//
// So a `0` in `desiredReplicas` does NOT mean "this autoscaler wants to scale
// to zero". It means the HPA could not compute a desired count at all --
// kubectl's own summary says `cpu: <unknown>/80%` -- and on a cluster whose
// metrics API is not serving it stays 0 for ever. Reading it as a number would
// report every such HPA as trying to scale a production deployment to nothing.
//
// The pair that separates them is `currentUtilization`: absent means
// unmeasured, and a literal `0` means measured at zero.

export interface K8sHpa {
  namespace: string
  name: string
  /** The workload it scales. */
  target: string
  minReplicas: number | null
  maxReplicas: number | null
  currentReplicas: number | null
  /**
   * What the HPA has decided to run, or NULL when it has not decided.
   *
   * Null rather than 0 whenever the utilisation is unmeasured -- see the note
   * above. The API really does report 0 in that case and the zero is not a
   * decision.
   */
  desiredReplicas: number | null
  targetUtilization: number | null
  /** Null when the metrics API did not answer. Never 0 for that case. */
  currentUtilization: number | null
}

const num = (v: string): number | null => {
  // None of these four is strictly load-bearing TODAY, and that is worth
  // saying rather than implying otherwise. `Number('<none>')` and
  // `Number('<unknown>')` are NaN, which `isFinite` rejects anyway; the parser
  // never passes `''` because it requires nine fields after trimming. They are
  // kept because `Number('')` is ZERO rather than NaN -- so the day this is
  // called from anywhere that can hand it an empty string, an unmeasured
  // utilisation silently becomes a measured 0%, and `isFinite` will not catch
  // it. A mutation confirmed the redundancy; it is deliberate, not dead.
  if (v === undefined || v === '<none>' || v === '<unknown>' || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function parseHpas(text: string): K8sHpa[] {
  const out: K8sHpa[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const f = line.split(/\s+/)
    if (f.length < 9) continue
    const currentUtilization = num(f[8])
    const desiredRaw = num(f[6])
    out.push({
      namespace: f[0],
      name: f[1],
      target: f[2],
      minReplicas: num(f[3]),
      maxReplicas: num(f[4]),
      currentReplicas: num(f[5]),
      // THE line this file exists for. An unmeasured HPA reports desired 0,
      // and that 0 is not a decision to scale to zero.
      desiredReplicas: currentUtilization === null ? null : desiredRaw,
      targetUtilization: num(f[7]),
      currentUtilization
    })
  }
  return out
}

export type HpaVerdict = 'ok' | 'unmeasured' | 'at-ceiling' | 'pinned'

export interface HpaFinding {
  namespace: string
  name: string
  verdict: HpaVerdict
  because: string
}

export function judgeHpas(hpas: K8sHpa[]): HpaFinding[] {
  return hpas
    .map((h): HpaFinding | null => {
      const where = `${h.namespace}/${h.name}`
      if (h.currentUtilization === null) {
        return {
          namespace: h.namespace,
          name: h.name,
          verdict: 'unmeasured',
          because: `${where} has no utilisation reading, so it cannot scale ${h.target} at all — it is holding at ${h.currentReplicas ?? 'an unknown number of'} replicas whatever the load. Usually the metrics API is not serving.`
        }
      }
      // At the ceiling AND under load is the one worth saying: the autoscaler
      // has done everything it can and the answer is a bigger maximum.
      if (
        h.maxReplicas !== null &&
        h.currentReplicas === h.maxReplicas &&
        h.targetUtilization !== null &&
        h.currentUtilization >= h.targetUtilization
      ) {
        return {
          namespace: h.namespace,
          name: h.name,
          verdict: 'at-ceiling',
          because: `${where} is at its maximum of ${h.maxReplicas} and still at ${h.currentUtilization}% against a target of ${h.targetUtilization}%. It has nothing left to do.`
        }
      }
      // min === max is an autoscaler that cannot autoscale. Not broken, but
      // somebody probably meant otherwise, and it is invisible otherwise.
      if (h.minReplicas !== null && h.minReplicas === h.maxReplicas) {
        return {
          namespace: h.namespace,
          name: h.name,
          verdict: 'pinned',
          because: `${where} has its minimum and maximum both at ${h.minReplicas}, so it can never scale anything.`
        }
      }
      return null
    })
    .filter((f): f is HpaFinding => f !== null)
}

/** How to render the utilisation, which is the whole point of the row. */
export function hpaUtilisationText(h: K8sHpa): string {
  return h.currentUtilization === null
    ? 'not measured'
    : `${h.currentUtilization}%${h.targetUtilization === null ? '' : ` of ${h.targetUtilization}%`}`
}
