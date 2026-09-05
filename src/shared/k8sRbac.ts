// Item 39's RBAC row: what a token can actually do.
//
// The row's own argument is that this "makes the not-exposed argument
// sharper, not weaker" -- knowing precisely what a kubeconfig grants is the
// thing that lets an operator decide whether it should be on that server at
// all, and `forbidden`'s help text already sends people here.
//
// ---------------------------------------------------------------------------
// WHAT `kubectl auth can-i --list` ACTUALLY PRINTS
// ---------------------------------------------------------------------------
// Measured against k3s v1.31.5, for a service account bound to a Role granting
// get/list/watch on pods:
//
//   Resources                                       Non-Resource URLs      ... Verbs
//   selfsubjectreviews.authentication.k8s.io        []                     ... [create]
//   selfsubjectaccessreviews.authorization.k8s.io   []                     ... [create]
//   selfsubjectrulesreviews.authorization.k8s.io    []                     ... [create]
//   pods/log                                        []                     ... [get list watch]
//   pods                                            []                     ... [get list watch]
//                                                   [/api/*]               ... [get]
//
// Three things follow:
//
//  1. THE FIRST THREE ROWS ARE NOISE, and they are there for EVERY identity --
//     `system:basic-user` grants them to every authenticated principal,
//     including the most restricted account on the cluster. Listing them as
//     permissions reports five for an account that has two, and buries the two.
//
//  2. A ROW CAN HAVE AN EMPTY FIRST COLUMN. Non-resource URL rules print with
//     no resource, so a parser splitting on whitespace reads `[/api/*]` as the
//     resource name and every column after it shifts.
//
//  3. IT IS COLUMN-ALIGNED, not delimited. The columns are found by the header
//     positions rather than by counting spaces.

export interface RbacRule {
  /** `pods`, `pods/log`, `*.*`, or empty for a non-resource rule. */
  resource: string
  /** `/api/*` and friends. Empty for a resource rule. */
  nonResourceUrl: string
  resourceNames: string[]
  verbs: string[]
}

/** Granted to every authenticated identity by `system:basic-user`, so their
 *  presence says nothing about an account. Excluded from findings, never from
 *  the raw list -- see `parseCanIList`. */
export const RBAC_UNIVERSAL = new Set([
  'selfsubjectreviews.authentication.k8s.io',
  'selfsubjectaccessreviews.authorization.k8s.io',
  'selfsubjectrulesreviews.authorization.k8s.io'
])

const list = (v: string): string[] => {
  const t = v.trim()
  if (t === '' || t === '[]') return []
  return t.replace(/^\[|\]$/g, '').split(/\s+/).filter(Boolean)
}

/**
 * Everything the list said, including the noise.
 *
 * The noise is filtered where findings are made rather than here, because a
 * reader asking "what does this token have" should be able to see the whole
 * answer -- and because a row disappearing between the cluster and the screen
 * is the kind of thing that makes somebody distrust the screen.
 */
export function parseCanIList(text: string): RbacRule[] {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  const header = lines.find((l) => /^Resources\s+Non-Resource URLs/.test(l))
  if (header === undefined) return []
  // Column starts, from the header. Not a split: a row with no resource has
  // leading spaces where the first column would be, and counting fields there
  // shifts every column left by one.
  const at = (label: string): number => header.indexOf(label)
  const cols = [at('Resources'), at('Non-Resource URLs'), at('Resource Names'), at('Verbs')]
  if (cols.some((c) => c < 0)) return []

  const out: RbacRule[] = []
  for (const line of lines) {
    if (line === header) continue
    const cell = (i: number): string =>
      line.slice(cols[i], i + 1 < cols.length ? cols[i + 1] : undefined).trim()
    const verbs = list(cell(3))
    if (verbs.length === 0) continue
    out.push({
      resource: cell(0),
      nonResourceUrl: cell(1).replace(/^\[|\]$/g, '').trim(),
      resourceNames: list(cell(2)),
      verbs
    })
  }
  return out
}

export interface RbacSummary {
  /** True when the token can do anything to anything. */
  clusterAdmin: boolean
  /** Rules that say something about THIS account -- the universal ones
   *  removed. */
  meaningful: RbacRule[]
  /** Verbs that change or destroy, across every rule. */
  writes: string[]
  headline: string
}

const WRITE_VERBS = new Set(['create', 'update', 'patch', 'delete', 'deletecollection', '*'])

export function summariseRbac(rules: RbacRule[]): RbacSummary {
  const meaningful = rules.filter(
    (r) => !(r.nonResourceUrl === '' && RBAC_UNIVERSAL.has(r.resource))
  )
  // `*.*` with verb `*` is cluster-admin however it was granted.
  const clusterAdmin = meaningful.some((r) => r.resource === '*.*' && r.verbs.includes('*'))
  const writes = [
    ...new Set(
      meaningful.filter((r) => r.resource !== '').flatMap((r) => r.verbs.filter((v) => WRITE_VERBS.has(v)))
    )
  ].sort()

  if (rules.length === 0) {
    return {
      clusterAdmin: false,
      meaningful: [],
      writes: [],
      // Not "this token can do nothing": a list that could not be read is not
      // an empty list of permissions.
      headline: 'No permission list was returned, so what this token can do is unknown.'
    }
  }
  if (clusterAdmin) {
    return {
      clusterAdmin: true,
      meaningful,
      writes,
      headline: 'This token is cluster-admin: it can do anything to anything, in every namespace.'
    }
  }
  const resources = meaningful.filter((r) => r.resource !== '').length
  return {
    clusterAdmin: false,
    meaningful,
    writes,
    headline:
      writes.length === 0
        ? `Read-only: ${resources} resource rule(s), no verb that changes anything.`
        : `${resources} resource rule(s), and it can ${writes.join(', ')}.`
  }
}
