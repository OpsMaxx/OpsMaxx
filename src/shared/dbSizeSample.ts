// Item 47: which number out of a `db:ops` sizes read may be recorded as a
// growth series, and which may not.
//
// The row said "record on every `db:ops` read first". What it does not say, and
// what reading the two parsers settles, is that only ONE of the engines
// produces a number that can be plotted at all.
//
// POSTGRES CAN. `parsePgSizes` reads `pg_database_size` per database: a true
// total for a named database, whatever it contains.
//
// MYSQL CANNOT, and this is the trap. `parseMysqlSizes` sums `data_bytes` and
// `index_bytes` over the rows the sizes query returned -- and that query is
// asked with a LIMIT. On a server with more tables than the limit, `totalBytes`
// is the sum of the biggest twenty, not the size of the schema. Plotting it
// produces a line that steps whenever the table ordering changes and looks like
// growth. So a capped read is REFUSED rather than recorded, and the refusal
// says which.
//
// AND THE SERIES MUST NOT CHANGE ITS MIND ABOUT WHAT IT MEASURES. A connection
// names one database; a Postgres sizes read lists every database on the
// cluster. Recording the sum on the reads where the named one cannot be found
// would give a series that silently switches between "this database" and "this
// whole server", and every rate computed across that switch would be fiction.
// So the named database is matched or nothing is recorded.

export type DbSizeRefusal =
  /** The engine's total is a sum over a capped table read. */
  | 'capped'
  /** The connection's database was not among those the read returned. */
  | 'not-listed'
  /** The engine reports no per-database total this can use. */
  | 'unsupported'
  /** The read did not produce a number. */
  | 'no-number'

export const DB_SIZE_REFUSAL_WORDS: Record<DbSizeRefusal, string> = {
  capped:
    'this engine reports a total summed over a capped list of tables, so it is the size of the biggest few rather than of the database',
  'not-listed': 'the database this connection names was not among the ones the read returned',
  unsupported: 'this engine reports no per-database total that can be plotted',
  'no-number': 'the read returned no size'
}

export type DbSizeSample =
  | { ok: true; bytes: number }
  | { ok: false; reason: DbSizeRefusal; detail: string }

/** The shape `parsePgSizes` produces, structurally. Named here rather than
 *  imported so this module has no dependency on the 3,000-line ops file. */
export interface PgSizesLike {
  databases: { name: string; totalBytes: number | null }[]
}

/** The shape `parseMysqlSizes` produces, structurally. */
export interface MysqlSizesLike {
  tables: unknown[]
  totalBytes: number
}

/**
 * Postgres: the named database's own total.
 *
 * `pg_database_size` is a real total, so the only question is which row. A
 * connection with no database name is refused rather than being given the
 * first row -- "the first database the server listed" is not this connection's
 * database and a series built from it would be about whichever one sorted
 * first that day.
 */
export function pgSizeSample(sizes: PgSizesLike, database: string): DbSizeSample {
  // No separate guard for an empty name: no database is called "", so the
  // lookup below refuses it for the same reason it refuses any other name that
  // is not there. A guard here would read as though it were keeping an
  // invariant the lookup already keeps -- a mutation removing one changed
  // nothing, which is how that was settled.
  const name = database.trim()
  const row = sizes.databases.find((d) => d.name === name)
  if (row === undefined) {
    return { ok: false, reason: 'not-listed', detail: DB_SIZE_REFUSAL_WORDS['not-listed'] }
  }
  if (row.totalBytes === null || !Number.isFinite(row.totalBytes)) {
    return { ok: false, reason: 'no-number', detail: DB_SIZE_REFUSAL_WORDS['no-number'] }
  }
  return { ok: true, bytes: row.totalBytes }
}

/**
 * MySQL: refused, and the reason is the point.
 *
 * `rowLimit` is what the sizes query was asked for. A read that returned fewer
 * rows than the limit saw every table and its total is real; one that returned
 * exactly the limit almost certainly did not, and there is no way from here to
 * tell "exactly twenty tables" from "the biggest twenty of two hundred". The
 * ambiguous case is refused, because a series that is sometimes a whole schema
 * and sometimes its biggest twenty tables has a growth rate that means nothing.
 */
export function mysqlSizeSample(sizes: MysqlSizesLike, rowLimit: number): DbSizeSample {
  if (sizes.tables.length >= rowLimit) {
    return { ok: false, reason: 'capped', detail: DB_SIZE_REFUSAL_WORDS.capped }
  }
  if (!Number.isFinite(sizes.totalBytes)) {
    return { ok: false, reason: 'no-number', detail: DB_SIZE_REFUSAL_WORDS['no-number'] }
  }
  return { ok: true, bytes: sizes.totalBytes }
}

/** Engines with no per-database total this can plot. Stated rather than left as
 *  a fall-through, so adding one is a decision. */
export function unsupportedSizeSample(engine: string): DbSizeSample {
  return {
    ok: false,
    reason: 'unsupported',
    detail: `${engine}: ${DB_SIZE_REFUSAL_WORDS.unsupported}`
  }
}

/**
 * The sample a whole `db:ops` report yields, or the reason it yields none.
 *
 * Takes the report's shape structurally rather than importing `DbOpsReport`:
 * this module deliberately has no dependency on the three-thousand-line ops
 * file, and the two fields it needs are the two it names.
 *
 * A report that FAILED yields nothing. A size series with a row for every
 * attempt would be a series whose gaps are invisible, and gaps are the whole
 * reason `bytesForecast` has `stale` and `too-few-points`.
 */
export function reportSizeSample(
  report: { ok: boolean; engine: string; answers: { id: string; value?: unknown }[] },
  database: string,
  rowLimit: number
): DbSizeSample {
  if (!report.ok) return { ok: false, reason: 'no-number', detail: DB_SIZE_REFUSAL_WORDS['no-number'] }
  const sizes = report.answers.find((a) => a.id === 'sizes')
  if (sizes === undefined || sizes.value === undefined || sizes.value === null) {
    return { ok: false, reason: 'no-number', detail: DB_SIZE_REFUSAL_WORDS['no-number'] }
  }
  if (report.engine === 'postgres') {
    return pgSizeSample(sizes.value as PgSizesLike, database)
  }
  if (report.engine === 'mysql') {
    return mysqlSizeSample(sizes.value as MysqlSizesLike, rowLimit)
  }
  return unsupportedSizeSample(report.engine)
}
