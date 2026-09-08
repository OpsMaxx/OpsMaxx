import type { DbVerdictLevel } from './dbOps'

// Item 37's ride-along reads for PostgreSQL: the blocking TREE, and
// replication slots.
//
// THE BLOCKING TREE. The existing read returns rows that ARE blocked, and the
// roadmap names the consequence: the blocker's own row is not fetched unless it
// is itself blocked. Measured against a real PostgreSQL 16 with a three-deep
// chain, that means the session actually holding the lock -- the one an
// operator would terminate -- is the ONE ROW MISSING from the answer. The
// screen shows two waiting queries and nothing to do about them.
//
// So this takes every session and builds the tree, and the thing it reports
// first is the ROOT: the session that is blocking others and is not itself
// blocked.

export interface PgActivityRow {
  pid: number
  /** `Lock`, `Timeout`, or empty when the session is not waiting. */
  waitEventType: string
  /** The pids blocking THIS one, from `pg_blocking_pids()`. Empty when none. */
  blockedBy: number[]
  query: string
  state: string
  user: string
  /** Seconds in the current state. */
  stateAgeSeconds: number | null
}

/** `pid|waitEventType|blockedBy|query|state|user|ageSeconds`, pipe-separated,
 *  as `psql -At -F'|'` prints it. Blank fields are empty, never absent. */
export function parsePgActivity(text: string): PgActivityRow[] {
  const out: PgActivityRow[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const f = line.split('|')
    if (f.length < 5) continue
    const pid = Number(f[0])
    if (!Number.isInteger(pid)) continue
    const age = Number(f[6])
    out.push({
      pid,
      waitEventType: f[1] ?? '',
      // TWO GUARDS FOR ONE BUG, and they are redundant on purpose.
      // `''.split(',')` is `['']`, `Number('')` is 0, and `Number.isInteger(0)`
      // is true -- so without either of these a session blocked by NOBODY
      // parses as blocked by pid 0, and every unblocked session in the
      // snapshot claims a blocker. The first was written and the second added
      // when a mutation showed the first alone was not being exercised;
      // removing either still passes, removing both does not, and that is
      // recorded here so a later reader does not delete one as dead.
      blockedBy: (f[2] ?? '')
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p !== '')
        .map((p) => Number(p))
        .filter((p) => Number.isInteger(p) && p > 0),
      query: f[3] ?? '',
      state: f[4] ?? '',
      user: f[5] ?? '',
      stateAgeSeconds: Number.isFinite(age) ? age : null
    })
  }
  return out
}

export interface PgBlockNode {
  pid: number
  user: string
  query: string
  state: string
  stateAgeSeconds: number | null
  /** How many sessions are waiting on this one, directly and through others. */
  blocking: number
  /** How deep below the root this sits. 0 is the root. */
  depth: number
  /** True when this session blocks others and is not itself blocked -- the one
   *  an operator would act on. */
  isRoot: boolean
}

/**
 * The chain, from the session holding the lock downwards.
 *
 * Only sessions involved in blocking are returned: an idle connection is not
 * part of the answer to "what is stuck". A session that is neither blocked nor
 * blocking is left out entirely.
 *
 * Cycles are possible in principle -- PostgreSQL detects and breaks real
 * deadlocks, but `pg_blocking_pids` is sampled per row and a snapshot taken
 * across a deadlock's resolution can contain one. Walking that naively hangs,
 * so every walk carries a seen-set.
 */
export function pgBlockingTree(rows: PgActivityRow[]): PgBlockNode[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const blockedBy = new Map(rows.map((r) => [r.pid, r.blockedBy.filter((b) => byPid.has(b))]))

  // Who waits on whom, inverted.
  const waiters = new Map<number, number[]>()
  for (const [pid, blockers] of blockedBy) {
    for (const b of blockers) waiters.set(b, [...(waiters.get(b) ?? []), pid])
  }

  const involved = new Set<number>()
  for (const [pid, blockers] of blockedBy) {
    if (blockers.length > 0) {
      involved.add(pid)
      for (const b of blockers) involved.add(b)
    }
  }

  const descendants = (pid: number): number => {
    const seen = new Set<number>([pid])
    const stack = [...(waiters.get(pid) ?? [])]
    while (stack.length > 0) {
      const n = stack.pop()!
      if (seen.has(n)) continue
      seen.add(n)
      stack.push(...(waiters.get(n) ?? []))
    }
    return seen.size - 1
  }

  const depthOf = (pid: number): number => {
    let d = 0
    let cur = pid
    const seen = new Set<number>([pid])
    for (;;) {
      const up = (blockedBy.get(cur) ?? [])[0]
      if (up === undefined || seen.has(up)) break
      seen.add(up)
      cur = up
      d += 1
    }
    return d
  }

  return [...involved]
    .map((pid) => {
      const r = byPid.get(pid)!
      const blockers = blockedBy.get(pid) ?? []
      return {
        pid,
        user: r.user,
        query: r.query,
        state: r.state,
        stateAgeSeconds: r.stateAgeSeconds,
        blocking: descendants(pid),
        depth: depthOf(pid),
        isRoot: blockers.length === 0 && (waiters.get(pid) ?? []).length > 0
      }
    })
    .sort((a, b) => a.depth - b.depth || b.blocking - a.blocking || a.pid - b.pid)
}

/** The sentence. Names the ROOT, because that is the session somebody would
 *  act on and it is the one the old read never returned. */
export function describePgBlocking(nodes: PgBlockNode[]): { level: DbVerdictLevel; because: string } {
  const roots = nodes.filter((n) => n.isRoot)
  if (nodes.length === 0) return { level: 'ok', because: 'Nothing is waiting on a lock.' }
  const worst = roots.sort((a, b) => b.blocking - a.blocking)[0]
  if (!worst) {
    // Every involved session is itself blocked, which means the snapshot
    // caught a cycle. Reported as what it is rather than picking one.
    return {
      level: 'alarm',
      because: `${nodes.length} sessions are waiting on each other and none of them is at the head of the chain, which is what a snapshot of a deadlock looks like.`
    }
  }
  return {
    level: worst.blocking > 1 ? 'alarm' : 'watch',
    because: `pid ${worst.pid} (${worst.user || 'unknown user'}) is holding a lock ${worst.blocking} other session(s) are waiting on, and is not itself waiting on anything.`
  }
}

export interface PgSlot {
  name: string
  type: string
  active: boolean
  restartLsn: string
  /** Bytes of WAL the server is keeping FOR this slot. Null when the slot has
   *  no restart_lsn yet -- a slot created for a standby that has never
   *  connected. */
  retainedBytes: number | null
}

export function parsePgSlots(text: string): PgSlot[] {
  const out: PgSlot[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const f = line.split('|')
    if (f.length < 3) continue
    const bytes = Number(f[4])
    out.push({
      name: f[0],
      type: f[1] ?? '',
      active: (f[2] ?? '').toLowerCase() === 't',
      restartLsn: f[3] ?? '',
      retainedBytes: Number.isFinite(bytes) && (f[4] ?? '') !== '' ? bytes : null
    })
  }
  return out
}

/**
 * What the slots mean, and the asymmetry that makes this worth a function.
 *
 * ZERO ROWS IS NOT HEALTH. `pg_replication_slots` returns nothing on a server
 * with no replication configured AND on a server whose slots have all been
 * dropped -- measured on a real PostgreSQL 16, they are the same empty result.
 * So an empty list is `absent`, never `ok`. This is the same trap
 * `mssqlAlwaysOnStatus` was written for.
 *
 * An INACTIVE slot is the one that matters. The server keeps every WAL segment
 * that slot might still need, for ever, and the first symptom is a full disk
 * on a server nobody was worried about.
 */
export function assessPgSlots(
  slots: PgSlot[],
  warnBytes = 1024 * 1024 * 1024
): { level: DbVerdictLevel; because: string } {
  if (slots.length === 0) {
    return {
      level: 'unknown',
      because:
        'This server reports no replication slots. That is what a server with no replication looks like, and also what one whose slots have been dropped looks like — they are the same answer.'
    }
  }
  const inactive = slots.filter((s) => !s.active)
  const hoarding = slots.filter((s) => s.retainedBytes !== null && s.retainedBytes >= warnBytes)
  if (inactive.length > 0) {
    return {
      level: 'alarm',
      because: `${inactive.map((s) => s.name).join(', ')} ${inactive.length === 1 ? 'is' : 'are'} inactive. The server keeps every WAL segment such a slot might still need, for as long as it exists, and the first symptom is a full disk.`
    }
  }
  if (hoarding.length > 0) {
    return {
      level: 'watch',
      because: `${hoarding.map((s) => s.name).join(', ')} ${hoarding.length === 1 ? 'is' : 'are'} holding back more than ${Math.round(warnBytes / 1024 / 1024)} MB of WAL.`
    }
  }
  return { level: 'ok', because: `${slots.length} slot(s), all connected.` }
}
