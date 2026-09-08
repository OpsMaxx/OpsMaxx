// Item 39's PersistentVolumes, and the reclaim policy per volume.
//
// The claims half of this row shipped in `k8sResources.ts`. This is the volumes
// underneath them, and it exists for one measured reason.
//
// A RECLAIM POLICY IS NOT A PROPERTY OF THE VOLUME. It is what happens the
// moment somebody deletes the claim, and deleting a claim looks like a small,
// reversible thing. Measured on k3s v1.31.5: a statically created hostPath PV
// with `persistentVolumeReclaimPolicy: Delete` was BOUND to a claim, the claim
// was deleted, and within seconds the PV was gone from the API entirely. No
// event, no confirmation, no Released state to notice it in. The same test with
// `Retain` left the volume sitting at `Released`, still carrying the deleted
// claim's `claimRef.uid`, which is why it will never bind to anything again
// without somebody editing it by hand.
//
// So the sentence worth printing next to a BOUND volume is not its status --
// which is `Bound`, and fine -- but what deleting its claim would do to it.

/**
 * The read the parser below is written against.
 *
 * Exported so a test can assert the fixture was captured with THIS spec.
 * `<none>` for every absent value is what keeps the columns from shifting, and
 * that is a property of custom-columns, not of the data -- change the spec and
 * the parser's whitespace split stops being safe.
 */
export const PV_COLS =
  'custom-columns=NAME:.metadata.name,CAP:.spec.capacity.storage,' +
  'RECLAIM:.spec.persistentVolumeReclaimPolicy,STATUS:.status.phase,' +
  'CNS:.spec.claimRef.namespace,CNAME:.spec.claimRef.name,' +
  'SC:.spec.storageClassName,REASON:.status.reason'

/** Kubernetes' five volume phases. Exhaustive on purpose: the maps below are
 *  `Record<PvPhase, T>`, so a sixth phase is a compile error rather than a
 *  volume that silently renders as nothing. */
export type PvPhase = 'Pending' | 'Available' | 'Bound' | 'Released' | 'Failed'

const PHASES = new Set<string>(['Pending', 'Available', 'Bound', 'Released', 'Failed'])

export type PvReclaim = 'Retain' | 'Delete' | 'Recycle'

export interface K8sPv {
  name: string
  capacity: string
  /** `Retain`, `Delete`, `Recycle`, or whatever else the cluster said. Kept as
   *  read: an unrecognised policy has to render as unrecognised, not as one of
   *  the three we know. */
  reclaim: string
  /** The phase, or null when it was not one of the five. */
  phase: PvPhase | null
  /** `namespace/name` of the claim, or empty. Empty for `Available`, and
   *  PRESENT on `Released` -- a released volume still names the claim that is
   *  already gone. */
  claim: string
  storageClass: string
  /** `.status.reason`. Empty in every healthy case; the only place a failed
   *  reclaim explains itself. */
  reason: string
}

const NONE = (v: string | undefined): string => {
  const t = (v ?? '').trim()
  return t === '<none>' ? '' : t
}

/**
 * The eight fixed columns of the `custom-columns` read.
 *
 * Fixed-width by construction, so this splits on whitespace: every absent value
 * prints as `<none>` rather than as nothing, which is exactly what stops a row
 * with no claim from shifting its remaining columns left.
 */
export function parsePvs(text: string): K8sPv[] {
  const out: K8sPv[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const f = line.split(/\s+/)
    if (f.length < 8) continue
    const ns = NONE(f[4])
    const cn = NONE(f[5])
    const phase = NONE(f[3])
    out.push({
      name: f[0],
      capacity: NONE(f[1]),
      reclaim: NONE(f[2]),
      phase: PHASES.has(phase) ? (phase as PvPhase) : null,
      claim: ns !== '' && cn !== '' ? `${ns}/${cn}` : cn,
      storageClass: NONE(f[6]),
      reason: NONE(f[7])
    })
  }
  return out
}

export interface PvVerdict {
  level: 'ok' | 'watch' | 'alarm' | 'unknown'
  because: string
}

/**
 * What deleting this volume's claim would do.
 *
 * Only meaningful while the volume is bound, and it is the whole point of the
 * module: `Delete` on a bound volume means the claim's deletion destroys it,
 * and nothing on the claim says so.
 */
export function reclaimFate(pv: K8sPv): string {
  if (pv.phase !== 'Bound') return ''
  if (pv.reclaim === 'Delete') {
    return `Deleting ${pv.claim} destroys this volume and the data on it.`
  }
  if (pv.reclaim === 'Retain') {
    return `Deleting ${pv.claim} leaves this volume Released, holding ${pv.capacity} and needing a hand before anything can use it again.`
  }
  if (pv.reclaim === 'Recycle') {
    // Deprecated since 1.11 and removed from the in-tree provisioners, but a
    // cluster can still carry the field on an old static volume.
    return `Deleting ${pv.claim} wipes this volume's contents and returns it to the pool. Recycle is deprecated; treat this as unverified.`
  }
  return `Its reclaim policy reads ${pv.reclaim === '' ? 'as nothing' : `"${pv.reclaim}"`}, which is not one this build knows, so what deleting ${pv.claim} would do was not determined.`
}

export function pvVerdict(pv: K8sPv): PvVerdict {
  if (pv.phase === null) {
    return { level: 'unknown', because: `${pv.name} reported a phase this build does not know.` }
  }
  const by: Record<PvPhase, () => PvVerdict> = {
    Bound: () => ({ level: 'ok', because: `${pv.name} is bound to ${pv.claim}.` }),
    Available: () => ({ level: 'ok', because: `${pv.name} is free for a claim to take.` }),
    // Held, not broken -- so `watch`, not `alarm`. A Retain volume ends up here
    // by design, and it stays here: the deleted claim's uid is still on it, so
    // it will not bind to a new claim of the same name either.
    Released: () => ({
      level: 'watch',
      because:
        pv.reclaim === 'Retain'
          ? `${pv.name} still holds ${pv.capacity} for ${pv.claim}, which no longer exists, and will not rebind on its own.`
          : `${pv.name} was released from ${pv.claim} and its ${pv.reclaim} policy has not finished.`
    }),
    Failed: () => ({
      level: 'alarm',
      because: `${pv.name} failed to reclaim${pv.reason === '' ? '' : `: ${pv.reason}`}. Whether the data is still there was not determined.`
    }),
    Pending: () => ({ level: 'watch', because: `${pv.name} is not usable yet.` })
  }
  return by[pv.phase]()
}

/** Capacity a Released volume is holding: real space that no claim can reach.
 *  Reported separately because it does not appear in any claim's numbers. */
export function heldCapacity(pvs: K8sPv[]): K8sPv[] {
  return pvs.filter((p) => p.phase === 'Released')
}
