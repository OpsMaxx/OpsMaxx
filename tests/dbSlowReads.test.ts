import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import {
  examinedPerRow,
  mongoIndexVerdict,
  mysqlScanFindings,
  parseMongoCollStats,
  parseMysqlDigests,
  parseRedisPersistence
} from '../src/shared/dbSlowReads'

// Item 37's remaining ride-along reads. Every fixture came off a real server in
// Docker -- MySQL 8.4.11, MongoDB 7, Redis 7.4.11 -- and two of the three
// thresholds here changed because of what those servers actually returned.

const DIR = fileURLToPath(new URL('./fixtures/dbops', import.meta.url))
const fixture = (n: string): string => readFileSync(join(DIR, n), 'utf8')

describe('MySQL: which statement is scanning', () => {
  const rows = parseMysqlDigests(fixture('mysql/digest-top.txt'))

  it('reads what performance_schema actually returned', () => {
    expect(rows).toHaveLength(4)
    const scan = rows.find((r) => r.digest.includes('WHERE `v` = ?'))!
    expect(scan.count).toBe(2)
    expect(scan.rowsExamined).toBe(4)
    expect(scan.rowsSent).toBe(2)
    // MySQL's own count, not inferred from the row numbers.
    expect(scan.noIndexUsed).toBe(2)
  })

  it('leaves the literals MySQL already removed removed', () => {
    // The digest is normalised before this sees it, so a user's data value
    // cannot arrive here. Table and column names still can.
    expect(rows.every((r) => !/'\w+'/.test(r.digest))).toBe(true)
  })

  // THREE of the four real digests returned no rows at all. Dividing by zero
  // to get Infinity would sort every INSERT and every empty SELECT above the
  // query that is actually scanning.
  it('has no ratio for a statement that returned nothing, rather than an infinite one', () => {
    const insert = rows.find((r) => r.digest.startsWith('INSERT'))!
    expect(insert.rowsSent).toBe(0)
    expect(examinedPerRow(insert)).toBeNull()
  })

  it('finds the scanning statement and says which it is', () => {
    const f = mysqlScanFindings(rows)
    expect(f).toHaveLength(1)
    expect(f[0].digest).toContain('WHERE `v` = ?')
    expect(f[0].neverUsedAnIndex).toBe(true)
    expect(f[0].because).toContain('without an index')
  })

  it('uses no_index_used rather than the ratio, because it is true on a small table', () => {
    // 4 examined for 2 sent is a ratio of 2 -- far under any sane threshold --
    // and the statement still read the whole table every time.
    const scan = parseMysqlDigests(fixture('mysql/digest-top.txt')).find((r) =>
      r.digest.includes('WHERE')
    )!
    expect(examinedPerRow(scan)).toBe(2)
    expect(mysqlScanFindings([scan], 1000)).toHaveLength(1)
  })
})

describe('Mongo: indexes against the data they index', () => {
  const s = parseMongoCollStats(fixture('mongo/collstats.json'))!

  it('reads the sizes the collector never passed', () => {
    expect(s.ns).toBe('spt.t')
    expect(s.size).toBe(58)
    expect(s.totalIndexSize).toBe(24576)
    expect(Object.keys(s.indexSizes).sort()).toEqual(['_id_', 'a_1'])
  })

  // The measurement that changed the threshold. Two documents hold 58 bytes
  // and 24,576 bytes of index -- a ratio over 400 -- because an index has a
  // minimum size. A ratio alone would put every small collection on screen.
  it('does not report a tiny collection whose ratio is enormous', () => {
    expect(s.totalIndexSize / s.size).toBeGreaterThan(400)
    expect(mongoIndexVerdict(s).level).toBe('ok')
    expect(mongoIndexVerdict(s).because).toContain('too little data')
  })

  it('reports a big collection whose indexes outweigh it', () => {
    const big = { ...s, size: 200e6, totalIndexSize: 600e6 }
    const v = mongoIndexVerdict(big)
    expect(v.level).toBe('watch')
    expect(v.because).toContain('3.0x')
  })

  it('returns null for something that is not collection stats', () => {
    expect(parseMongoCollStats('not json')).toBeNull()
    expect(parseMongoCollStats('{"count":1}')).toBeNull()
  })
})

describe('Redis: where the RDB file is', () => {
  const p = parseRedisPersistence(fixture('redis/persistence.txt'))

  it('reads the default image exactly as it is configured', () => {
    expect(p).toEqual({
      dir: '/data',
      dbfilename: 'dump.rdb',
      appendonly: false,
      save: '3600 1 300 100 60 10000'
    })
  })

  // NO VERDICT is asserted here, and that is the point. `judgeRedisPersistence`
  // in dbOps.ts already answers "what would a restart cost", from RUNTIME
  // state -- last BGSAVE status, last AOF write status, save age, changes
  // since. This parse answers a different question, the one item 38 needs:
  // where the file to copy actually is.
  it('gives item 38 the path it needs to fetch a snapshot', () => {
    expect(`${p.dir}/${p.dbfilename}`).toBe('/data/dump.rdb')
  })

  it('says whether an AOF exists, which decides whether the RDB is the whole backup', () => {
    expect(p.appendonly).toBe(false)
  })
})
