import type { DbVerdictLevel } from './dbOps'

// Item 37's remaining ride-along reads: MySQL's statement digests, Mongo's
// index sizes, and Redis's persistence configuration.
//
// Every threshold and every shape here came off a real server -- MySQL 8.4.11,
// MongoDB 7 and Redis 7.4.11 in Docker -- and two of the three changed as a
// result. The fixtures are in tests/fixtures/dbops/.

// ---------------------------------------------------------------------------
// MySQL: which statement is scanning
// ---------------------------------------------------------------------------

export interface MysqlDigestRow {
  schema: string
  /** NORMALISED by MySQL: literals are already `?` before this sees them, so a
   *  digest never carries a user's data value. It CAN carry table and column
   *  names, which is why it is still treated as remote text. */
  digest: string
  count: number
  totalMs: number
  maxMs: number
  rowsExamined: number
  rowsSent: number
  /** Executions that used no index at all. MySQL counts these itself; it is
   *  not inferred from the row counts. */
  noIndexUsed: number
}

export function parseMysqlDigests(text: string): MysqlDigestRow[] {
  const out: MysqlDigestRow[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (line.trim() === '') continue
    const f = line.split('|')
    if (f.length < 8) continue
    const n = (i: number): number => {
      const v = Number(f[i])
      return Number.isFinite(v) ? v : 0
    }
    out.push({
      schema: f[0],
      digest: f[1],
      count: n(2),
      totalMs: n(3),
      maxMs: n(4),
      rowsExamined: n(5),
      rowsSent: n(6),
      noIndexUsed: n(7)
    })
  }
  return out
}

/**
 * How many rows this statement reads for each row it returns.
 *
 * `null` when it returned none, and that is the point: a statement with
 * `rows_sent = 0` has no ratio, and dividing by zero to get Infinity would
 * sort every `INSERT` and every empty `SELECT` above the query that is
 * actually scanning the table. Measured on the real server, three of the four
 * digests captured had `rows_sent = 0`.
 */
export function examinedPerRow(row: MysqlDigestRow): number | null {
  if (row.rowsSent <= 0) return null
  return row.rowsExamined / row.rowsSent
}

export interface MysqlDigestFinding {
  digest: string
  count: number
  totalMs: number
  examinedPerRow: number | null
  neverUsedAnIndex: boolean
  because: string
}

/**
 * The statements worth looking at, and why.
 *
 * `noIndexUsed` is MySQL's own count and is the stronger signal: it says the
 * server read the whole table, whatever the row counts happened to be on the
 * data that was there. A ratio needs a table big enough for the ratio to mean
 * something; `no_index_used` is true on an empty one.
 */
export function mysqlScanFindings(
  rows: MysqlDigestRow[],
  examinedRatioWarn = 100
): MysqlDigestFinding[] {
  return rows
    .filter((r) => r.noIndexUsed > 0 || (examinedPerRow(r) ?? 0) >= examinedRatioWarn)
    .map((r) => {
      const ratio = examinedPerRow(r)
      return {
        digest: r.digest,
        count: r.count,
        totalMs: r.totalMs,
        examinedPerRow: ratio,
        neverUsedAnIndex: r.noIndexUsed >= r.count && r.count > 0,
        because:
          r.noIndexUsed >= r.count && r.count > 0
            ? `every one of its ${r.count} execution(s) read the table without an index`
            : r.noIndexUsed > 0
              ? `${r.noIndexUsed} of its ${r.count} execution(s) read the table without an index`
              : `it reads about ${Math.round(ratio ?? 0)} rows for each row it returns`
      }
    })
    .sort((a, b) => b.totalMs - a.totalMs)
}

// ---------------------------------------------------------------------------
// Mongo: indexes against the data they index
// ---------------------------------------------------------------------------

export interface MongoCollStats {
  ns: string
  count: number
  /** Uncompressed size of the documents. */
  size: number
  totalIndexSize: number
  indexSizes: Record<string, number>
}

export function parseMongoCollStats(json: string): MongoCollStats | null {
  try {
    const j = JSON.parse(json) as Partial<MongoCollStats>
    if (typeof j.ns !== 'string') return null
    return {
      ns: j.ns,
      count: typeof j.count === 'number' ? j.count : 0,
      size: typeof j.size === 'number' ? j.size : 0,
      totalIndexSize: typeof j.totalIndexSize === 'number' ? j.totalIndexSize : 0,
      indexSizes: typeof j.indexSizes === 'object' && j.indexSizes !== null ? j.indexSizes : {}
    }
  } catch {
    return null
  }
}

/**
 * Whether a collection's indexes are worth mentioning.
 *
 * NOT a ratio alone. The real server made that obvious: a collection of two
 * documents holds 58 bytes of data and 24,576 bytes of index, a ratio of over
 * 400 — because an index has a minimum size and two documents are nothing.
 * Reporting that would put every small collection in an estate on screen.
 * So a floor comes first, and the ratio is only asked about collections large
 * enough for it to mean something.
 */
export function mongoIndexVerdict(
  s: MongoCollStats,
  o: { floorBytes?: number; ratioWarn?: number } = {}
): { level: DbVerdictLevel; because: string } {
  const floor = o.floorBytes ?? 64 * 1024 * 1024
  const ratioWarn = o.ratioWarn ?? 2
  if (s.size < floor) {
    return {
      level: 'ok',
      because: `${s.ns} holds too little data for its index size to mean anything.`
    }
  }
  const ratio = s.totalIndexSize / s.size
  if (ratio >= ratioWarn) {
    return {
      level: 'watch',
      because: `${s.ns}'s indexes are ${ratio.toFixed(1)}x the size of its documents (${Object.keys(s.indexSizes).length} indexes).`
    }
  }
  return { level: 'ok', because: `${s.ns}'s indexes are ${ratio.toFixed(1)}x its documents.` }
}

// ---------------------------------------------------------------------------
// Redis: what a restart would lose
// ---------------------------------------------------------------------------

export interface RedisPersistence {
  dir: string
  dbfilename: string
  appendonly: boolean
  /** The `save` directive, verbatim. Empty means RDB snapshots are OFF. */
  save: string
}

/** `key|value` per line, as `redis-cli config get` prints once paired up. */
export function parseRedisPersistence(text: string): RedisPersistence {
  const by = new Map<string, string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const i = line.indexOf('|')
    if (i === -1) continue
    by.set(line.slice(0, i).trim(), line.slice(i + 1).trim())
  }
  return {
    dir: by.get('dir') ?? '',
    dbfilename: by.get('dbfilename') ?? '',
    appendonly: (by.get('appendonly') ?? '').toLowerCase() === 'yes',
    save: by.get('save') ?? ''
  }
}

/**
 * NO VERDICT HERE, deliberately.
 *
 * `judgeRedisPersistence` in dbOps.ts already answers "what would a restart
 * cost", and it answers it BETTER: it reads runtime state --
 * `rdb_last_bgsave_status`, `aof_last_write_status`, the age of the last save
 * and the changes since it -- where this reads only configuration. A server
 * configured with save points whose last BGSAVE FAILED is healthy by the
 * config and broken in fact, and only the existing answer can tell.
 *
 * I wrote a second verdict here before finding that one. Two judgements of one
 * question is two things to keep in step, and the weaker of them would have
 * been the one on screen half the time. What survives is the parse, because
 * item 38 needs `dir` and `dbfilename` to know where the RDB file IS -- a
 * different question, and one nothing else answers.
 */
