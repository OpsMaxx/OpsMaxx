// Item 39's `rollout history`, as a read.
//
// ---------------------------------------------------------------------------
// CHANGE-CAUSE IS NOT A PER-REVISION FACT
// ---------------------------------------------------------------------------
// Measured on k3s v1.31.5. Three revisions of one deployment:
//
//   REVISION  CHANGE-CAUSE
//   1         <none>
//   2         bump to 1.37
//   3         bump to 1.37
//
// and the ReplicaSets underneath:
//
//   rev 2  busybox:1.37
//   rev 3  busybox:1.36.1     <- change-cause still says "bump to 1.37"
//
// `kubernetes.io/change-cause` is an ANNOTATION on the deployment, copied onto
// every new ReplicaSet until somebody changes it. So it describes whichever
// rollout last set it, and gets carried onto later ones that have nothing to
// do with it. Revision 3 above is a DIFFERENT IMAGE wearing revision 2's
// label.
//
// Showing it without saying that would have an operator roll back to "the one
// before the 1.37 bump" and land somewhere else entirely. So the image is read
// from the ReplicaSet, which is a fact, and the change-cause is shown as what
// it is: a note somebody left, possibly about a different revision.

export interface RolloutRevision {
  revision: number
  /** The annotation, verbatim. Empty for `<none>`. NOT to be trusted as a
   *  description of THIS revision -- see the note above. */
  changeCause: string
  /** From the ReplicaSet, when one was matched. This is the fact. */
  images: string[]
  /** True when an earlier revision carries the identical change-cause, which
   *  means at least one of them is wearing the other's label. */
  causeRepeated: boolean
}

/** `kubectl rollout history deployment/x`: a name line, a header, then rows. */
export function parseRolloutHistory(text: string): { revision: number; changeCause: string }[] {
  const out: { revision: number; changeCause: string }[] = []
  let seenHeader = false
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (line.trim() === '') continue
    if (/^REVISION\s+CHANGE-CAUSE/.test(line.trim())) {
      seenHeader = true
      continue
    }
    if (!seenHeader) continue
    const m = /^(\d+)\s*(.*)$/.exec(line.trim())
    if (!m) continue
    const cause = m[2].trim()
    out.push({ revision: Number(m[1]), changeCause: cause === '<none>' ? '' : cause })
  }
  return out
}

/** `NAME REVISION IMAGE CAUSE` from the ReplicaSets. The images are the only
 *  per-revision fact available without fetching each one. */
export function parseReplicaSetRevisions(
  text: string
): { revision: number; images: string[] }[] {
  const out: { revision: number; images: string[] }[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const f = line.split(/\s+/)
    if (f.length < 3) continue
    const rev = Number(f[1])
    if (!Number.isInteger(rev)) continue
    out.push({
      revision: rev,
      images: f[2] === '<none>' ? [] : f[2].split(',').map((i) => i.trim()).filter(Boolean)
    })
  }
  return out
}

export function joinRollout(
  history: { revision: number; changeCause: string }[],
  replicaSets: { revision: number; images: string[] }[]
): RolloutRevision[] {
  const byRev = new Map(replicaSets.map((r) => [r.revision, r.images]))
  return history
    .map((h) => ({
      revision: h.revision,
      changeCause: h.changeCause,
      images: byRev.get(h.revision) ?? [],
      causeRepeated:
        h.changeCause !== '' &&
        history.some((o) => o.revision < h.revision && o.changeCause === h.changeCause)
    }))
    .sort((a, b) => b.revision - a.revision)
}

/** What to put beside a revision, given that its label may belong to another. */
export function describeRevision(r: RolloutRevision): string {
  const what = r.images.length > 0 ? r.images.join(', ') : 'image not read'
  if (r.changeCause === '') return what
  return r.causeRepeated
    ? `${what} — labelled “${r.changeCause}”, which an earlier revision also carries, so it was probably left over from that one`
    : `${what} — “${r.changeCause}”`
}
