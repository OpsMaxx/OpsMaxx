import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import {
  assessPgSlots,
  describePgBlocking,
  parsePgActivity,
  parsePgSlots,
  pgBlockingTree
} from '../src/shared/pgBlocking'

// Item 37's ride-along PostgreSQL reads.
//
// Both fixtures were produced by a real PostgreSQL 16.15 in Docker: a
// three-deep blocking chain made with three concurrent transactions on one
// row, and a physical replication slot whose standby never connected. See
// tests/fixtures/dbops/pg/VERSION.txt.

const DIR = fileURLToPath(new URL('./fixtures/dbops/pg', import.meta.url))
const fixture = (n: string): string => readFileSync(join(DIR, n), 'utf8')

describe('the session that is actually holding the lock', () => {
  const rows = parsePgActivity(fixture('blocking-chain.txt'))

  it('reads the three sessions the server reported', () => {
    expect(rows.map((r) => r.pid)).toEqual([122, 129, 136])
    // 122 is waiting on a Timeout (its own pg_sleep) and on NOBODY. It is the
    // one holding the row lock.
    expect(rows[0].blockedBy).toEqual([])
    expect(rows[1].blockedBy).toEqual([122])
    expect(rows[2].blockedBy).toEqual([129])
  })

  // THE finding. The existing read returns rows that ARE blocked, so 122 --
  // the only session an operator could do anything about -- is the one row
  // missing from the answer.
  it('puts the root first and says it is the root', () => {
    const tree = pgBlockingTree(rows)
    expect(tree[0].pid).toBe(122)
    expect(tree[0].isRoot).toBe(true)
    expect(tree[0].depth).toBe(0)
    // Two sessions are stuck behind it, not one: 136 waits on 129 which waits
    // on 122, and a count of DIRECT waiters would say one.
    expect(tree[0].blocking).toBe(2)
  })

  it('gives each waiter its depth in the chain', () => {
    const tree = pgBlockingTree(rows)
    expect(tree.map((n) => [n.pid, n.depth])).toEqual([
      [122, 0],
      [129, 1],
      [136, 2]
    ])
  })

  it('names the pid somebody would act on', () => {
    const d = describePgBlocking(pgBlockingTree(rows))
    expect(d.level).toBe('alarm')
    expect(d.because).toContain('pid 122')
    expect(d.because).toContain('not itself waiting')
  })

  it('leaves sessions that are neither blocked nor blocking out entirely', () => {
    const withIdle = parsePgActivity(
      `${fixture('blocking-chain.txt')}\n200|||select 1|idle|postgres|3\n`
    )
    expect(pgBlockingTree(withIdle).map((n) => n.pid)).not.toContain(200)
  })

  it('says nothing is stuck when nothing is', () => {
    const d = describePgBlocking(pgBlockingTree(parsePgActivity('200|||select 1|idle|postgres|3\n')))
    expect(d.level).toBe('ok')
  })

  // pg_blocking_pids is sampled per row, so a snapshot taken across a
  // deadlock's resolution can contain a cycle. Walking that naively hangs.
  it('does not hang on a cycle, and reports it as one', () => {
    const cyclic = parsePgActivity('1|Lock|2|a|active|u|1\n2|Lock|1|b|active|u|1\n')
    const tree = pgBlockingTree(cyclic)
    expect(tree.every((n) => !n.isRoot)).toBe(true)
    expect(describePgBlocking(tree).because).toContain('deadlock')
  })
})

describe('replication slots, and the answer that is two answers', () => {
  it('reads the inactive slot a standby never connected to', () => {
    const slots = parsePgSlots(fixture('slots-inactive.txt'))
    expect(slots).toHaveLength(1)
    expect(slots[0]).toMatchObject({ name: 'sp_standby', type: 'physical', active: false })
    // No restart_lsn yet, so the retained size is UNKNOWN rather than zero.
    expect(slots[0].retainedBytes).toBeNull()
  })

  it('calls an inactive slot what it is: the thing that fills the disk', () => {
    const a = assessPgSlots(parsePgSlots(fixture('slots-inactive.txt')))
    expect(a.level).toBe('alarm')
    expect(a.because).toContain('full disk')
  })

  // Measured: a server with no replication and a server whose slots were all
  // dropped both return zero rows. The same trap mssqlAlwaysOnStatus exists
  // for.
  it('does not call an empty list healthy', () => {
    const a = assessPgSlots([])
    expect(a.level).toBe('unknown')
    expect(a.level).not.toBe('ok')
    expect(a.because).toContain('the same answer')
  })

  it('is ok only when every slot is connected', () => {
    const a = assessPgSlots([
      { name: 's1', type: 'physical', active: true, restartLsn: '0/1', retainedBytes: 1024 }
    ])
    expect(a.level).toBe('ok')
  })

  it('warns about a connected slot holding back a lot of WAL', () => {
    const a = assessPgSlots([
      { name: 's1', type: 'physical', active: true, restartLsn: '0/1', retainedBytes: 5e9 }
    ])
    expect(a.level).toBe('watch')
  })
})
