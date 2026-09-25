import { describe, it, expect, beforeEach } from 'vitest'
import { listGroups, resetPolicyCacheForTests } from '../src/main/services/policyStore'
import {
  classifyStatement,
  evaluateDatabaseStatement,
  evaluateTunnelOpen
} from '../src/main/services/policyEngine'
import type { AccessGroup } from '../src/shared/mcp'

let readOnly: AccessGroup
let readWrite: AccessGroup
let full: AccessGroup

// A group saved before Confirm risky actions existed. Absent is ON.
const withoutSwitch = (g: AccessGroup): AccessGroup => {
  const copy = { ...g }
  delete copy.confirmRisky
  return copy
}

beforeEach(() => {
  resetPolicyCacheForTests()
  readOnly = listGroups().find((g) => g.id === 'grp-read-only')!
  readWrite = listGroups().find((g) => g.id === 'grp-read-write')!
  full = listGroups().find((g) => g.id === 'grp-full')!
})

describe('statement classification', () => {
  it('recognises reads across dialects', () => {
    for (const s of ['SELECT 1', 'show tables', 'EXPLAIN SELECT * FROM t', 'WITH x AS (SELECT 1) SELECT * FROM x', 'GET mykey', 'db.users.find({})']) {
      expect(classifyStatement(s), s).toBe('read')
    }
  })

  it('reads mongo shell syntax, where the verb is not first', () => {
    expect(classifyStatement('db.users.find({})')).toBe('read')
    expect(classifyStatement('db.orders.aggregate([])')).toBe('read')
    expect(classifyStatement('db.users.insertOne({})')).toBe('mutating')
    expect(classifyStatement('db.users.deleteMany({})')).toBe('mutating')
    expect(classifyStatement('db.users.drop()')).toBe('destructive')
    expect(classifyStatement('db.dropDatabase()')).toBe('destructive')
  })

  it('recognises writes', () => {
    for (const s of ['INSERT INTO t VALUES (1)', 'update t set a=1', 'DELETE FROM t', 'SET k v']) {
      expect(classifyStatement(s), s).toBe('mutating')
    }
  })

  it('recognises schema and permission changes as destructive', () => {
    for (const s of ['DROP TABLE t', 'truncate t', 'ALTER TABLE t ADD c int', 'GRANT ALL ON t TO x', 'FLUSHALL']) {
      expect(classifyStatement(s), s).toBe('destructive')
    }
  })

  it('cannot be smuggled past by chaining a write onto a read', () => {
    expect(classifyStatement('SELECT 1; DROP TABLE users')).toBe('destructive')
    expect(classifyStatement('SELECT 1; DELETE FROM users')).toBe('mutating')
  })

  it('sees through comments used to hide the verb', () => {
    expect(classifyStatement('/* SELECT */ DROP TABLE t')).toBe('destructive')
    expect(classifyStatement('-- harmless\nDELETE FROM t')).toBe('mutating')
  })

  it('treats an unrecognised verb as a write, not a read', () => {
    // Guessing "harmless" is the expensive direction to be wrong in.
    expect(classifyStatement('pg_terminate_backend(1)')).toBe('mutating')
  })

  // The test above asserts the bare form, which nobody types. An operator --
  // or an agent helping one -- types the SELECT, and until this was fixed the
  // SELECT graded `read`, which is `low`, which is no prompt, on every
  // built-in group.
  it('does not let a SELECT wrapper hide a function that changes the server', () => {
    for (const s of [
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = $1',
      'select pg_cancel_backend(4242)',
      'SELECT pg_switch_wal()',
      'SELECT pg_stat_statements_reset()',
      'SELECT pg_stat_reset()',
      'SELECT pg_promote()',
      'SELECT pg_drop_replication_slot($1)'
    ]) {
      expect(classifyStatement(s), s).toBe('mutating')
    }
  })

  it('still calls an ordinary function call a read, or the gate prompts on everything', () => {
    for (const s of [
      'SELECT 1',
      'SELECT count(*) FROM orders',
      'SELECT now(), coalesce(a, b) FROM t',
      'SELECT * FROM pg_stat_activity'
    ]) {
      expect(classifyStatement(s), s).toBe('read')
    }
  })

  it('grades EXPLAIN ANALYZE by the statement it actually runs', () => {
    // EXPLAIN ANALYZE DELETE deletes the rows. Every word before `delete`
    // says read.
    expect(classifyStatement('EXPLAIN ANALYZE DELETE FROM users')).toBe('mutating')
    expect(classifyStatement('EXPLAIN (ANALYZE, BUFFERS) INSERT INTO t VALUES (1)')).toBe('mutating')
    expect(classifyStatement('explain analyse update t set a = 1')).toBe('mutating')
    // Planning only. Both of these execute nothing.
    expect(classifyStatement('EXPLAIN SELECT * FROM t')).toBe('read')
    expect(classifyStatement('EXPLAIN (ANALYZE FALSE) DELETE FROM users')).toBe('read')
    expect(classifyStatement('EXPLAIN (COSTS OFF) SELECT 1')).toBe('read')
  })

  it('treats ANALYZE and the other maintenance verbs as writes', () => {
    // ANALYZE writes statistics into the catalogue. It was in the READ list.
    for (const s of ['ANALYZE users', 'analyze', 'VACUUM FULL t', 'REINDEX TABLE t']) {
      expect(classifyStatement(s), s).toBe('mutating')
    }
  })

  it('sees the relation a SELECT INTO creates', () => {
    expect(classifyStatement('SELECT * INTO backup_users FROM users')).toBe('mutating')
    expect(classifyStatement('select a, b into #tmp from t')).toBe('mutating')
  })
})

describe('database statements against a group', () => {
  it('lets Read Only read but never write', () => {
    expect(evaluateDatabaseStatement(readOnly, 'SELECT 1').decision).toBe('allow')
    expect(evaluateDatabaseStatement(readOnly, 'DELETE FROM t').decision).toBe('deny')
    expect(evaluateDatabaseStatement(readOnly, 'DROP TABLE t').decision).toBe('deny')
  })

  it('never lets a write through silently while Confirm risky actions is on', () => {
    // databaseAccess and writeFiles are both ALLOW here, so without the clamp
    // this would be a silent DROP TABLE.
    for (const g of [{ ...full, confirmRisky: true }, withoutSwitch(full)]) {
      expect(evaluateDatabaseStatement(g, 'SELECT 1').decision).toBe('allow')
      expect(evaluateDatabaseStatement(g, 'UPDATE t SET a=1').decision).toBe('ask')
      expect(evaluateDatabaseStatement(g, 'DROP TABLE t').decision).toBe('ask')
    }
  })

  it('gives Full Access, whose switch is off, exactly what its capabilities say', () => {
    expect(full.confirmRisky).toBe(false)
    expect(evaluateDatabaseStatement(full, 'UPDATE t SET a=1').decision).toBe('allow')
    expect(evaluateDatabaseStatement(full, 'DROP TABLE t').decision).toBe('allow')
  })

  it('keeps asking on Read & Write, which already asks for writes', () => {
    expect(evaluateDatabaseStatement(readWrite, 'INSERT INTO t VALUES (1)').decision).toBe('ask')
  })

  it('denies everything when databaseAccess is denied', () => {
    const denied = { ...full, capabilities: { ...full.capabilities, databaseAccess: 'deny' as const } }
    expect(evaluateDatabaseStatement(denied, 'SELECT 1').decision).toBe('deny')
  })

  it('denies when no group is assigned at all', () => {
    expect(evaluateDatabaseStatement(null, 'SELECT 1').decision).toBe('deny')
  })
})

describe('opening a tunnel', () => {
  it('is denied for Read Only, which denies sshTunnel', () => {
    expect(evaluateTunnelOpen(readOnly).decision).toBe('deny')
  })

  it('asks, never silently binds a port, while Confirm risky actions is on', () => {
    expect(evaluateTunnelOpen(readWrite).decision).toBe('ask')
    expect(evaluateTunnelOpen({ ...full, confirmRisky: true }).decision).toBe('ask')
    expect(evaluateTunnelOpen(withoutSwitch(full)).decision).toBe('ask')
  })

  it('binds without asking on a group that allows it with the switch off', () => {
    expect(evaluateTunnelOpen(full).decision).toBe('allow')
  })
})
