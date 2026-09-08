// Item 46: a bastion as an access object.
//
// `topology.ts` already answers "who routes through this host" and turns that
// into a REBOOT refusal. This is the same graph asked the access question: what
// does a key on this machine actually reach, and what goes dark if it is
// revoked.
//
// THE TRANSITIVE STEP IS THE FEATURE. `dependentsOf` is one hop deep, so a
// bastion in front of a bastion looks like it guards two machines when it
// guards five. An operator revoking a key there is told about the two.
//
// TWO THINGS IT REFUSES TO CLAIM, both inherited from the module underneath.
//
//  * An ADDRESS match is weaker than a saved reference, and that weakness
//    survives into the sentence. `topology.ts` keeps them apart precisely so a
//    refusal does not assert a route entry that does not exist, and flattening
//    them here would undo that one layer up.
//
//  * "No dependents" IS NOT "safe to revoke". A route hop that named no saved
//    server is a hole in this graph -- `unmatchedHopNote` exists for it -- and
//    a host can be someone's bastion through a hop this app has never seen.
//    Every answer here carries that, rather than the caller having to remember.

import { dependentsOf, unmatchedHopNote, type Dependent, type Topology } from './topology'

export interface BehindBastion {
  id: string
  name: string
  /** Hops from the bastion. 1 is directly behind it. */
  depth: number
  /**
   * How the FIRST link in this chain was tied to the bastion. `address` is the
   * weaker claim and is carried all the way out for that reason; a chain whose
   * first link is an address match is only as good as that match.
   */
  matchedBy: Dependent['matchedBy']
  /** The `host:port` behind an address match, for the sentence. */
  address: string | null
}

/**
 * Everything reachable through this host, at any depth.
 *
 * Breadth-first from the bastion, and a server already seen is not revisited:
 * a route loop -- A through B through A -- is a configuration mistake somebody
 * made, and it must not become an infinite walk here.
 *
 * The first link's `matchedBy` propagates down the chain rather than the last
 * one's: what ties `deep-db` to the bastion is the whole path, and a path is
 * exactly as strong as its weakest claim about the bastion itself.
 */
export function behindBastion(topo: Topology, serverId: string): BehindBastion[] {
  const out: BehindBastion[] = []
  const seen = new Set<string>([serverId])
  let frontier: { dep: Dependent; root: Dependent }[] = dependentsOf(topo, serverId).map((d) => ({
    dep: d,
    root: d
  }))
  let depth = 1
  // A SECOND bound, and deliberately redundant with `seen` above. Either one
  // alone stops a route loop; together they stop it in different ways, and the
  // difference matters: `seen` makes the walk correct, and this makes a bug in
  // `seen` produce a wrong answer instead of a process that never returns. A
  // hang reads as broken infrastructure rather than as a defect, which is the
  // most expensive way for this to fail.
  const ceiling = topo.servers.size + 1
  while (frontier.length > 0 && depth <= ceiling) {
    const next: { dep: Dependent; root: Dependent }[] = []
    for (const { dep, root } of frontier) {
      if (seen.has(dep.id)) continue
      seen.add(dep.id)
      out.push({
        id: dep.id,
        name: dep.name,
        depth,
        matchedBy: root.matchedBy,
        address: root.address
      })
      for (const further of dependentsOf(topo, dep.id)) next.push({ dep: further, root })
    }
    frontier = next
    depth += 1
  }
  return out
}

export interface BastionKeyFinding {
  /** The key's fingerprint, as the access collector read it. */
  fingerprint: string
  /** The account it sits on, on the bastion. */
  user: string
  bastionId: string
  bastionName: string
  behind: BehindBastion[]
  /** The sentence, ready to print. */
  reason: string
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function addressCaveat(behind: BehindBastion[]): string {
  const byAddress = behind.filter((b) => b.matchedBy === 'address')
  if (byAddress.length === 0) return ''
  const where = [...new Set(byAddress.map((b) => b.address).filter((a): a is string => a !== null))]
  return (
    ` ${plural(byAddress.length, 'of them')} ${byAddress.length === 1 ? 'is' : 'are'} tied to this host only because a hop in ` +
    `${byAddress.length === 1 ? 'its' : 'their'} route dials ${where.join(' or ') || 'the same address'}, ` +
    'which is this host’s saved address — not because anything names this server.'
  )
}

/**
 * What a key on a bastion is a key to.
 *
 * One finding per key on the bastion, and NOT one per key-and-host pair: the
 * operator's question is "what does this key open", and a hundred rows for one
 * key answers a different one.
 */
export function bastionKeyFindings(
  topo: Topology,
  bastionId: string,
  keys: { fingerprint: string | null; user: string }[]
): BastionKeyFinding[] {
  const behind = behindBastion(topo, bastionId)
  if (behind.length === 0) return []
  const bastionName = topo.servers.get(bastionId) ?? bastionId
  const names = behind.map((b) => b.name).join(', ')
  return keys
    .filter((k): k is { fingerprint: string; user: string } => k.fingerprint !== null)
    .map((k) => ({
      fingerprint: k.fingerprint,
      user: k.user,
      bastionId,
      bastionName,
      behind,
      reason:
        `This key opens ${k.user}@${bastionName}, and ${bastionName} is the way in to ` +
        `${plural(behind.length, 'other server')}: ${names}.${addressCaveat(behind)}`
    }))
}

export interface RevokeBlock {
  serverId: string
  serverName: string
  behind: BehindBastion[]
  /** The whole sentence, ready to print. */
  reason: string
  /** What this graph could not see. Never empty-means-fine. */
  blindSpot: string | null
}

/**
 * May this key be revoked here?
 *
 * A CONFIRMATION, not a hard refusal, and that is the difference from
 * `rebootBlockFor` rather than an inconsistency. Rebooting a bastion mid-run
 * cuts every connection through it and is a thing a staged run must not
 * contain. Revoking a key ON a bastion is frequently exactly the right thing to
 * do -- somebody left -- and refusing it outright would send people to edit
 * `authorized_keys` by hand, where nothing checks anything. So it names what
 * else that key was reaching and asks.
 *
 * `null` is NOT "safe". It means this graph knows of nothing behind this host,
 * and `blindSpot` on the returned value -- or `unmatchedHopNote` when there is
 * no value -- is where the reason that is not the same thing is written.
 */
export function revokeBlockFor(topo: Topology, serverId: string): RevokeBlock | null {
  const behind = behindBastion(topo, serverId)
  if (behind.length === 0) return null
  const serverName = topo.servers.get(serverId) ?? serverId
  const direct = behind.filter((b) => b.depth === 1).length
  const further = behind.length - direct
  const reach =
    further === 0
      ? plural(direct, 'server')
      : `${plural(direct, 'server')} directly and ${further} further behind ${direct === 1 ? 'it' : 'them'}`
  return {
    serverId,
    serverName,
    behind,
    reason:
      `${serverName} is the way in to ${reach}: ${behind.map((b) => b.name).join(', ')}. ` +
      `Revoking a key here removes that path for whoever holds it.${addressCaveat(behind)}`,
    blindSpot: unmatchedHopNote(topo)
  }
}

/**
 * The line for a host this graph found nothing behind.
 *
 * Exists so a caller cannot render silence. "No dependents" and "no route hop
 * in this workspace mentioned it" are the same observation, and only the second
 * is true.
 */
export function noBastionNote(topo: Topology, serverId: string): string {
  const name = topo.servers.get(serverId) ?? serverId
  const hole = unmatchedHopNote(topo)
  const base = `No saved server routes through ${name}.`
  return hole === null
    ? base
    : `${base} That is what this workspace's routes say, and they are not the whole picture: ${hole}`
}
