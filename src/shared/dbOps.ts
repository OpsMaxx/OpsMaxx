/**
 * Database operations — the operator's half of a database connection.
 *
 * `db.ts` can run a query. That is a client. This file is what an operator
 * actually needs from a server they are responsible for: is replication
 * running, is WAL reaching the archive, is anything about to hit transaction-ID
 * wraparound, who is blocking whom, and how big is it all getting.
 *
 * Everything here is PURE. It takes the rows a driver already handed back and
 * turns them into a status, a value and a judgement. No driver imports, no IO,
 * no `await`. That is what makes it testable against captured output from real
 * servers (tests/fixtures/dbops/) rather than against a mock of our own
 * assumptions — and the assumptions this file exists to kill were all found
 * that way, not by reasoning.
 *
 * ---------------------------------------------------------------------------
 * READ-ONLY, AND THAT IS NOT AN OVERSIGHT
 * ---------------------------------------------------------------------------
 *
 * Every statement this feature runs is a SELECT or a SHOW. There is no write,
 * no DDL, and no `KILL`/`pg_terminate_backend`, and there will not be one.
 * Following the refusal `src/shared/docker.ts` writes down for `prune`:
 *
 *  * `KILL <id>` / `pg_terminate_backend(pid)`. The lock panel below names the
 *    session blocking everything else, and the obvious next control is a button
 *    that kills it. It is not going here. Killing a backend rolls back whatever
 *    it was in the middle of, and the panel that offers the button cannot show
 *    what that was — `query` is the CURRENT statement, not the transaction, and
 *    on an unprivileged account it is `<insufficient privilege>` anyway. The
 *    operator would be terminating a transaction whose contents the UI could
 *    not display. If a session must die, that is a job: it goes through the job
 *    engine's approval model (roadmap B1), which records who asked, what was
 *    run and what came back, on a target the operator named.
 *  * `VACUUM` / `ANALYZE` / `OPTIMIZE TABLE`. The wraparound panel is the one
 *    place a "fix it" button is most tempting and most dangerous: a manual
 *    VACUUM FREEZE on a large table is hours of IO on a live server. The panel
 *    exists so the operator can schedule that themselves, in a window they
 *    chose.
 *  * `PURGE BINARY LOGS` / `pg_switch_wal()`. Deleting binlogs is deleting the
 *    only thing standing between a replica that fell behind and a rebuild.
 *  * Anything that resets a counter — `pg_stat_statements_reset()`,
 *    `FLUSH STATUS`. They are writes, they are shared, and a reset erases the
 *    history a colleague is mid-way through reading.
 *
 * The same list for MongoDB and Redis, because the temptations are different:
 *
 *  * `killOp`. The running-operations panel names the operation that has been
 *    blocking a collection for eleven minutes, and the obvious next control is
 *    a button. It is not going here for the reason `pg_terminate_backend` is
 *    not: the panel deliberately does NOT read the operation's `command`
 *    document — see mongoCurrentOpCommand — so it cannot show what it would be
 *    killing. Offering to kill a thing you have chosen not to display is worse
 *    than not offering.
 *  * `createIndex` / `dropIndex` / `compact`. The index panel is the one place
 *    a "drop this unused index" button is most tempting and most dangerous. A
 *    `$indexStats` counter is not a query plan: an index that serves one
 *    quarterly report reads identically to one nothing has ever used, and the
 *    counters reset on every restart.
 *  * `replSetStepDown` / `replSetReconfig` / `fsync`. Failing over is a
 *    decision with an audience, not a dashboard control.
 *  * `CONFIG SET`. The memory panel says an instance is at 99% under
 *    `noeviction`, and one `CONFIG SET maxmemory-policy allkeys-lru` away is
 *    "fixing" it by silently deleting the operator's data. `CONFIG GET` IS
 *    sent, once, for `slowlog-*`, because without the threshold the slow log
 *    cannot be interpreted at all; `CONFIG SET` is never built.
 *  * `FLUSHDB` / `FLUSHALL` / `DEBUG` / `SHUTDOWN` / `CLIENT KILL`.
 *  * `SLOWLOG RESET`, `CONFIG RESETSTAT`, `BGSAVE`, `BGREWRITEAOF`. The first
 *    two erase the history a colleague is reading; the second two are IO on a
 *    live server, started by a page whose contract is that it changes nothing.
 *  * `REPLICAOF` / `SLAVEOF` / `FAILOVER` / `CLUSTER FAILOVER` / `FORGET` /
 *    `RESET`.
 *  * `KEYS` and `SCAN`, which are reads and are still refused. `KEYS *` blocks
 *    Redis's single command thread for a full keyspace scan — an outage caused
 *    by a monitoring page. `DBSIZE` answers the same question in O(1) and is
 *    what is sent.
 *
 * ---------------------------------------------------------------------------
 * NOTHING IS INTERPOLATED
 * ---------------------------------------------------------------------------
 *
 * Every query is a frozen constant with `$1`/`?` placeholders, and
 * tests/dbOps.test.ts reads this file's source and fails if one of them grows a
 * `${`. There is no allowlisted-identifier path because no question here needs
 * one: every filter is a value, and a value binds.
 *
 * The two statements that genuinely CANNOT bind are the timeouts —
 * `SET statement_timeout` and `SET SESSION MAX_EXECUTION_TIME` take a literal,
 * not a parameter — so they are built by pgStatementTimeout/mysqlMaxExecutionTime
 * below, which validate an integer and throw on anything else.
 *
 * MongoDB and Redis have no text to interpolate into at all: a Mongo command is
 * a document and a Redis command is an argv array, so there is no place a value
 * could stop being a value. What replaces the hazard is the four builders that
 * take a parameter — a collection name, a row limit — and each of them
 * validates and THROWS rather than sanitising, for the same reason `safeMs`
 * does. They are enumerated in MONGO_COMMAND_BUILDERS and REDIS_COMMAND_BUILDERS
 * so the read-only assertion can see the commands the frozen maps do not hold.
 */

import { st, type MessageKey, translatedTable } from './i18n'

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

/**
 * Why a question has the answer it has.
 *
 * The same distinction `src/shared/hostFacts.ts` draws for a host, for the same
 * reason: these views need privileges an application user very often lacks, and
 * "you are not allowed to see this" rendered as an empty table is a lie told in
 * exactly the hour it matters. `pg_stat_replication` needs `pg_monitor`;
 * `SHOW REPLICA STATUS` needs `REPLICATION CLIENT`. Neither absence is a zero.
 */
export type DbAnswerStatus =
  /** Read it. A zero here really is a zero. */
  | 'ok'
  /**
   * Read it, and this account is shown LESS than the whole truth without being
   * told so. MySQL's `information_schema.PROCESSLIST` without the PROCESS
   * privilege silently returns only the caller's own connections — no error, no
   * warning, just a smaller number. Captured, not theorised: see
   * tests/fixtures/dbops/mysql/unprivileged.json.
   */
  | 'partial'
  /** The view exists and this account may not read it. */
  | 'denied'
  /** The feature is not turned on here — archiving off, binary logging off. */
  | 'absent'
  /** The question does not apply to this server's role: replica lag on a
   *  server that is not a replica. */
  | 'not-applicable'
  /** This server version cannot answer at all, whatever the privileges. */
  | 'unsupported'
  /** The statement failed for some other reason; `detail` has the words. */
  | 'error'

export const DB_ANSWER_STATUSES: DbAnswerStatus[] = [
  'ok',
  'partial',
  'denied',
  'absent',
  'not-applicable',
  'unsupported',
  'error'
]

/** One sentence per status, written for the person deciding whether to act on
 *  the number beside it. */
export const DB_ANSWER_HELP: Record<DbAnswerStatus, string> = translatedTable({
  ok: 'shared.dbOps.answerHelp.ok',
  partial: 'shared.dbOps.answerHelp.partial',
  denied: 'shared.dbOps.answerHelp.denied',
  absent: 'shared.dbOps.answerHelp.absent',
  'not-applicable': 'shared.dbOps.answerHelp.notApplicable',
  unsupported: 'shared.dbOps.answerHelp.unsupported',
  error: 'shared.dbOps.answerHelp.error'
})

/**
 * How worried to be.
 *
 * `unknown` is deliberately NOT `ok`. The whole point of the item is that a
 * number nobody looked at is not a judgement, and a question we could not ask
 * is not a pass.
 */
export type DbVerdictLevel = 'ok' | 'watch' | 'alarm' | 'unknown'

export const DB_VERDICT_RANK: Record<DbVerdictLevel, number> = {
  ok: 0,
  unknown: 1,
  watch: 2,
  alarm: 3
}

export interface DbVerdict {
  level: DbVerdictLevel
  /** A sentence, not a cell. "Replication is 4h 12m behind." */
  headline: string
  /** The mechanics underneath it, when there are any worth printing. */
  because?: string
}

export interface DbAnswer<T> {
  id: DbQuestionId
  status: DbAnswerStatus
  verdict: DbVerdict
  /** The engine's own words when something went wrong. Never paraphrased away. */
  detail?: string
  value?: T
}

// ---------------------------------------------------------------------------
// The questions
// ---------------------------------------------------------------------------

/**
 * Eight per engine, and choosing them was the actual work.
 *
 * The rule applied: a question earns its place if a wrong answer to it takes
 * the database down, loses data, or is the thing the operator will be asked
 * about at 3am. Everything that is merely interesting was cut — buffer/cache
 * ratios on Postgres (unactionable without knowing the workload), index usage
 * (a query-tuning question, not an operations one), per-user connection
 * breakdowns (a report, not an alarm).
 */
export const PG_QUESTIONS = [
  'overview',
  'replication',
  'archiver',
  'autovacuum',
  'connections',
  'locks',
  'sizes',
  'statements'
] as const

export const MYSQL_QUESTIONS = [
  'overview',
  'replication',
  'binlogs',
  'slowlog',
  // Item 37. NOT the slow log: that says how many statements crossed a time
  // threshold, and this says WHICH statements read the table without an index.
  // A query can be fast on today's data and still be the one that stops
  // working when the table grows, which the slow log cannot see.
  'digests',
  'connections',
  'processlist',
  'bufferpool',
  'sizes'
] as const

/**
 * MongoDB. Eight, chosen by the same rule, and the reason `oplog` is measured
 * in HOURS rather than bytes is that the number an operator needs is "how long
 * may a secondary be down before it needs a full resync". A megabyte figure
 * cannot be turned into that without knowing the write rate, and nobody does
 * that arithmetic at 3am.
 *
 * Cut, for the same reason the Postgres list cut cache ratios: `dbStats`
 * averages (a report, not an alarm), profiler settings (a tuning question),
 * WiredTiger cache internals (unactionable without knowing the workload).
 */
export const MONGO_QUESTIONS = [
  'overview',
  'replication',
  'oplog',
  'indexes',
  'connections',
  'currentop',
  'sizes',
  'asserts'
] as const

/**
 * Redis. NINE, and the extra one is deliberate rather than sloppy.
 *
 * `cluster` cannot fold into `replication`: a cluster whose state is `fail`
 * refuses a third of the keyspace while `INFO replication` on every node
 * reports a healthy master with healthy replicas, so no other question here can
 * see it. And `overview` cannot fold away either, because the VERSION decides
 * which of the other eight can be answered at all — `maxclients` does not exist
 * before Redis 6, and without knowing that, "no ceiling reported" is
 * indistinguishable from "no ceiling".
 */
/**
 * SQL Server. Eight, by the same rule, and two of them exist because a real
 * server answered a question in a way that would have been read wrong.
 *
 * `alwayson` rather than reusing `replication`, because the shape of the wrong
 * answer is different. `sys.dm_hadr_availability_replica_states` returns ZERO
 * ROWS on a server with no availability group -- it does not error. Zero
 * healthy replicas and no replication configured are the same query result and
 * the opposite operational fact, and `SERVERPROPERTY('IsHadrEnabled')` is the
 * only thing that separates them.
 *
 * `backups` has no equivalent on the other engines and is arguably the single
 * most useful question here: a database in FULL recovery whose log has never
 * been backed up grows that log until the disk fills, and SQL Server will not
 * warn anybody. `msdb.dbo.backupset` reports NULL for never-backed-up, which is
 * not "backed up a long time ago".
 *
 * `logspace` for the same failure one step later. Cut, by the rule the other
 * lists use: wait statistics (tuning, not an alarm), index fragmentation (a
 * maintenance report), plan cache internals (unactionable without the workload).
 */
export const MSSQL_QUESTIONS = [
  'overview',
  'alwayson',
  'backups',
  'logspace',
  'connections',
  'blocking',
  'slowlog',
  'sizes'
] as const

export const REDIS_QUESTIONS = [
  'overview',
  'memory',
  'persistence',
  'replication',
  'slowlog',
  'clients',
  'keyspace',
  'stats',
  'cluster'
] as const

export type PgQuestionId = (typeof PG_QUESTIONS)[number]
export type MysqlQuestionId = (typeof MYSQL_QUESTIONS)[number]
export type MongoQuestionId = (typeof MONGO_QUESTIONS)[number]
export type RedisQuestionId = (typeof REDIS_QUESTIONS)[number]
export type MssqlQuestionId = (typeof MSSQL_QUESTIONS)[number]
export type DbQuestionId =
  | PgQuestionId
  | MysqlQuestionId
  | MongoQuestionId
  | RedisQuestionId
  | MssqlQuestionId

export const DB_QUESTION_LABEL: Record<DbQuestionId, string> = translatedTable({
  digests: 'shared.dbOps.question.label.digests',
  alwayson: 'shared.dbOps.question.label.alwayson',
  backups: 'shared.dbOps.question.label.backups',
  logspace: 'shared.dbOps.question.label.logspace',
  blocking: 'shared.dbOps.question.label.blocking',
  overview: 'shared.dbOps.question.label.overview',
  replication: 'shared.dbOps.question.label.replication',
  archiver: 'shared.dbOps.question.label.archiver',
  autovacuum: 'shared.dbOps.question.label.autovacuum',
  connections: 'shared.dbOps.question.label.connections',
  locks: 'shared.dbOps.question.label.locks',
  sizes: 'shared.dbOps.question.label.sizes',
  statements: 'shared.dbOps.question.label.statements',
  binlogs: 'shared.dbOps.question.label.binlogs',
  slowlog: 'shared.dbOps.question.label.slowlog',
  processlist: 'shared.dbOps.question.label.processlist',
  bufferpool: 'shared.dbOps.question.label.bufferpool',
  oplog: 'shared.dbOps.question.label.oplog',
  indexes: 'shared.dbOps.question.label.indexes',
  currentop: 'shared.dbOps.question.label.currentop',
  asserts: 'shared.dbOps.question.label.asserts',
  memory: 'shared.dbOps.question.label.memory',
  persistence: 'shared.dbOps.question.label.persistence',
  clients: 'shared.dbOps.question.label.clients',
  keyspace: 'shared.dbOps.question.label.keyspace',
  stats: 'shared.dbOps.question.label.stats',
  cluster: 'shared.dbOps.question.label.cluster'
})

/** Why this one is on the page. Shown in the UI, so the editorial choice is
 *  visible to the operator rather than only to whoever wrote it. */
export const DB_QUESTION_WHY: Record<DbQuestionId, string> = translatedTable({
  digests: 'shared.dbOps.question.why.digests',
  alwayson: 'shared.dbOps.question.why.alwayson',
  backups: 'shared.dbOps.question.why.backups',
  logspace: 'shared.dbOps.question.why.logspace',
  blocking: 'shared.dbOps.question.why.blocking',
  overview: 'shared.dbOps.question.why.overview',
  replication: 'shared.dbOps.question.why.replication',
  archiver: 'shared.dbOps.question.why.archiver',
  autovacuum: 'shared.dbOps.question.why.autovacuum',
  connections: 'shared.dbOps.question.why.connections',
  locks: 'shared.dbOps.question.why.locks',
  sizes: 'shared.dbOps.question.why.sizes',
  statements: 'shared.dbOps.question.why.statements',
  binlogs: 'shared.dbOps.question.why.binlogs',
  slowlog: 'shared.dbOps.question.why.slowlog',
  processlist: 'shared.dbOps.question.why.processlist',
  bufferpool: 'shared.dbOps.question.why.bufferpool',
  oplog: 'shared.dbOps.question.why.oplog',
  indexes: 'shared.dbOps.question.why.indexes',
  currentop: 'shared.dbOps.question.why.currentop',
  asserts: 'shared.dbOps.question.why.asserts',
  memory: 'shared.dbOps.question.why.memory',
  persistence: 'shared.dbOps.question.why.persistence',
  clients: 'shared.dbOps.question.why.clients',
  keyspace: 'shared.dbOps.question.why.keyspace',
  stats: 'shared.dbOps.question.why.stats',
  cluster: 'shared.dbOps.question.why.cluster'
})

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Named, in one place, with the reason. A magic number buried in a comparison
 * is a judgement nobody can argue with.
 */
export const DB_THRESHOLDS = {
  /** Replica lag. A minute is noise on a busy server; an hour is a decision. */
  replicaLagWatchSeconds: 60,
  replicaLagAlarmSeconds: 3600,
  /** Fraction of autovacuum_freeze_max_age. Postgres itself forces an
   *  anti-wraparound vacuum at 1.0; half of that is when a human should be
   *  planning the window rather than discovering it. */
  freezeWatchFraction: 0.5,
  freezeAlarmFraction: 0.9,
  /** Absolute backstop, independent of the setting. Wraparound is at 2^31;
   *  Postgres refuses new transactions at 2^31 - 1e7. */
  freezeAlarmAbsolute: 1_500_000_000,
  /** Fraction of max_connections. */
  connectionsWatchFraction: 0.8,
  connectionsAlarmFraction: 0.9,
  /** An idle-in-transaction session holds back vacuum and keeps its locks. */
  idleInTransactionWatchSeconds: 300,
  idleInTransactionAlarmSeconds: 900,
  /** How long a session may sit behind a lock before it is worth a page. */
  lockWaitWatchSeconds: 10,
  lockWaitAlarmSeconds: 60,
  /** A single running statement. */
  longQueryWatchSeconds: 60,
  longQueryAlarmSeconds: 300,
  /** InnoDB buffer pool hit rate. */
  bufferPoolWatchRate: 0.99,
  bufferPoolAlarmRate: 0.95,
  /**
   * The buffer pool hit rate is meaningless on a server that has just started —
   * every first read is a miss. Measured, not assumed: a Postgres/MySQL pair
   * five minutes old reported a 93.9% hit rate, which would have alarmed for a
   * server doing nothing wrong. Below either of these the verdict is `unknown`.
   */
  bufferPoolMinUptimeSeconds: 3600,
  bufferPoolMinReadRequests: 1_000_000,
  /** A slow log whose threshold is this high records almost nothing. */
  slowLogUselessThresholdSeconds: 10,
  /**
   * MongoDB oplog window. An hour is not enough room to restart a member and
   * let it catch up; a day is the smallest window most maintenance fits in, and
   * is what MongoDB's own guidance asks for.
   */
  oplogWindowAlarmSeconds: 3600,
  oplogWindowWatchSeconds: 86_400,
  /**
   * How much of a member's uptime the oplog must cover before its window counts
   * as "everything since start" rather than a measurement.
   *
   * Measured against UPTIME and not against the oplog's storage numbers,
   * because the storage numbers do not work: a genuinely rolling oplog reports
   * storageSize 225353728 against maxSize 1048576, since WiredTiger never
   * shrinks a file it has allocated. Captured, not reasoned about — see
   * tests/fixtures/dbops/mongodb/oplog-saturated.json.
   */
  oplogNeverRolledFraction: 0.9,
  /**
   * How long $indexStats counters must have been running before zero accesses
   * is allowed to mean "unused".
   *
   * They reset when the server restarts, so on a freshly restarted server every
   * index looks unused. A week is the shortest span that survives a report
   * which only runs on Sundays.
   */
  indexUnusedMinCounterAgeSeconds: 604_800,
  /** Fraction of Redis maxmemory. */
  redisMemoryWatchFraction: 0.9,
  redisMemoryAlarmFraction: 0.95,
  /** A Redis process holding this much more than it uses is fragmented enough
   *  to be worth saying out loud. */
  redisFragmentationWatchRatio: 1.5,
  /** How stale an RDB snapshot may get, with unsaved changes behind it, before
   *  the amount a restart would lose is worth a sentence. */
  redisRdbStaleWatchSeconds: 3600,
  redisRdbStaleAlarmSeconds: 86_400,
  /** A single Redis command. Redis runs them one at a time, so these are much
   *  tighter than the SQL equivalents: every other client waited for it. */
  redisSlowCommandWatchMicroseconds: 100_000,
  redisSlowCommandAlarmMicroseconds: 1_000_000,
  /** Below this share of keys carrying a TTL, under noeviction, the keyspace
   *  only ever grows. */
  redisNoTtlWatchFraction: 0.5
} as const

/**
 * Where PostgreSQL actually stops.
 *
 * 2^31 minus the 10 million transaction safety margin it keeps for the vacuum
 * that has to get you out. This is the denominator for the sentence "N% of the
 * way to transaction-ID wraparound"; `autovacuum_freeze_max_age` is NOT — that
 * is where autovacuum STARTS, 200 million by default, and 90% of it is 8.5% of
 * the way to wraparound. A busy table cycles that band as normal steady state.
 */
export const PG_WRAPAROUND_XID_LIMIT = 2_147_483_647 - 10_000_000

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

/**
 * A driver value to a number, or null.
 *
 * The single most important function in this file, because of what it REFUSES
 * to do: `num(null)` is `null`. `pg` hands back `bigint` and `numeric` columns
 * as strings; `mysql2` hands `SHOW STATUS` values back as strings and
 * `Seconds_Behind_Source` back as a number or as `null`. A `Number(x) || 0`
 * anywhere on that path turns "the server would not say" into "zero", which is
 * the bug this whole feature exists to not have.
 */
export function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') {
    const t = v.trim()
    if (t === '') return null
    const n = Number(t)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** A driver value to a string, or null. Empty string stays empty — MySQL uses
 *  `''` for "no error", which is different from "no such column". */
export function str(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v)
  return null
}

/** MySQL reports booleans as 0/1, Postgres as true/false, and both drivers
 *  sometimes as the strings 'ON'/'OFF'. */
export function bool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'boolean') return v
  const n = num(v)
  if (n !== null && (typeof v === 'number' || typeof v === 'bigint')) return n !== 0
  const s = str(v)?.trim().toLowerCase()
  if (s === undefined || s === null) return null
  if (s === 'on' || s === 'yes' || s === 'true' || s === '1') return true
  if (s === 'off' || s === 'no' || s === 'false' || s === '0') return false
  return null
}

// ---------------------------------------------------------------------------
// Formatting — a duration a person reads, not a float
// ---------------------------------------------------------------------------

export function formatSeconds(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return st('shared.dbOps.format.unknown')
  const n = Math.max(0, Math.round(s))
  if (n < 60) return st('shared.dbOps.format.seconds', { s: n })
  const m = Math.floor(n / 60)
  if (m < 60) return st('shared.dbOps.format.minutesSeconds', { m, s: n % 60 })
  const h = Math.floor(m / 60)
  if (h < 24) return st('shared.dbOps.format.hoursMinutes', { h, m: m % 60 })
  return st('shared.dbOps.format.daysHours', { d: Math.floor(h / 24), h: h % 24 })
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

export function formatBytes(b: number | null | undefined): string {
  if (b === null || b === undefined || !Number.isFinite(b)) return st('shared.dbOps.format.unknown')
  let n = Math.abs(b)
  let i = 0
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024
    i++
  }
  const sign = b < 0 ? '-' : ''
  return `${sign}${i === 0 ? Math.round(n) : n.toFixed(n < 10 ? 1 : 0)} ${UNITS[i]}`
}

/** A count, grouped. 1500000 -> "1,500,000". */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return st('shared.dbOps.format.unknown')
  return Math.round(n).toLocaleString('en-US')
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

export interface DbFailure {
  status: DbAnswerStatus
  detail: string
}

/**
 * A Postgres error to a status.
 *
 * SQLSTATE first, because it is stable across versions and locales; the message
 * text is only consulted when there is no code, which happens for driver-level
 * failures. The three codes that matter:
 *
 *  * 42501 insufficient_privilege — `denied`.
 *  * 42P01 undefined_table and 42883 undefined_function — the object is not
 *    there. For `pg_stat_statements` that is `absent` (an extension nobody
 *    installed), which is a first-class answer, not an error. Captured from a
 *    real database without the extension: SQLSTATE 42P01, "relation
 *    \"pg_stat_statements\" does not exist".
 *  * 55000 object_not_in_prerequisite_state — what `pg_last_wal_receive_lsn()`
 *    raises on a primary ("recovery is not in progress"). That is `not-applicable`:
 *    the question was aimed at the wrong role, not refused.
 */
export function classifyPgFailure(code: string | null | undefined, message: string): DbFailure {
  const detail = (message || '').trim() || st('shared.dbOps.failure.statementSilent')
  const c = (code || '').trim()
  if (c === '42501') return { status: 'denied', detail }
  if (c === '42P01' || c === '42883' || c === '3F000') return { status: 'absent', detail }
  // Checked before the SQLSTATE below because Postgres raises 55000 for two
  // completely different situations: "recovery is not in progress" (the
  // question was aimed at the wrong role) and "pg_stat_statements must be
  // loaded via shared_preload_libraries" (the extension row exists, the
  // library does not). Seen on a standby built by pg_basebackup, which inherits
  // the CREATE EXTENSION and not the postgresql.conf.
  if (/shared_preload_libraries/i.test(detail)) return { status: 'absent', detail }
  if (c === '55000') return { status: 'not-applicable', detail }
  if (c === '42703' || c === '42601') return { status: 'unsupported', detail }
  const m = detail.toLowerCase()
  if (/permission denied|must be superuser|insufficient privilege/.test(m)) return { status: 'denied', detail }
  if (/does not exist/.test(m)) return { status: 'absent', detail }
  return { status: 'error', detail }
}

/**
 * A MySQL/MariaDB error to a status.
 *
 * Every code below was produced by a real server and is in
 * tests/fixtures/dbops/:
 *
 *  * 1227 ER_SPECIFIC_ACCESS_DENIED_ERROR — "you need (at least one of) the
 *    SUPER, REPLICATION CLIENT privilege(s)". What an application user gets for
 *    `SHOW REPLICA STATUS` and `SHOW BINARY LOGS`. `denied`.
 *  * 1381 ER_NO_BINARY_LOGGING — `SHOW BINARY LOGS` on a server with the binlog
 *    off. An ERROR, not an empty list, and it means `absent`.
 *  * 1064 ER_PARSE_ERROR — MariaDB 10.4 on `SHOW REPLICA STATUS`. The statement
 *    does not exist in that dialect, so this is `unsupported` and the caller
 *    falls back to the older spelling. It is emphatically not a failure.
 *  * 1193 ER_UNKNOWN_SYSTEM_VARIABLE — `@@binlog_expire_logs_seconds` on
 *    MariaDB, which spells it `@@expire_logs_days`. `unsupported`, same fallback.
 */
export function classifyMysqlFailure(errno: number | null | undefined, message: string): DbFailure {
  const detail = (message || '').trim() || st('shared.dbOps.failure.statementSilent')
  switch (errno) {
    case 1227:
    case 1045:
    case 1142:
    case 1143:
      return { status: 'denied', detail }
    case 1381:
      return { status: 'absent', detail }
    case 1064:
    case 1193:
    case 1146:
      return { status: 'unsupported', detail }
    default:
      break
  }
  const m = detail.toLowerCase()
  if (/access denied|privilege/.test(m)) return { status: 'denied', detail }
  if (/you have an error in your sql syntax|unknown system variable/.test(m)) return { status: 'unsupported', detail }
  if (/not using binary logging/.test(m)) return { status: 'absent', detail }
  return { status: 'error', detail }
}

// ---------------------------------------------------------------------------
// Statement timeouts — the only two statements that cannot bind a parameter
// ---------------------------------------------------------------------------

/**
 * `SET statement_timeout = 5000`.
 *
 * Postgres will not take a parameter here — `SET statement_timeout = $1` is a
 * syntax error — so this is the one place a value is written into SQL text, and
 * it is the reason this function exists rather than a template literal at the
 * call site. It throws rather than sanitising: a caller passing something that
 * is not a plain positive integer has a bug, and quietly clamping it would hide
 * the bug while still being the shape an injection takes.
 */
export function pgStatementTimeout(ms: number): string {
  return `SET statement_timeout = ${safeMs(ms)}`
}

/** `SET SESSION MAX_EXECUTION_TIME = 5000`. Same constraint, same guard. */
export function mysqlMaxExecutionTime(ms: number): string {
  return `SET SESSION MAX_EXECUTION_TIME = ${safeMs(ms)}`
}

/**
 * `SET SESSION max_statement_time = 8`. MariaDB, which spells it differently
 * AND counts in SECONDS.
 *
 * Not a nicety. MariaDB raises ER_UNKNOWN_SYSTEM_VARIABLE (1193) on
 * MAX_EXECUTION_TIME, so before this existed the collector caught that, shrugged,
 * and ran unbounded — including `sizes`, which stats every file on the server.
 * A best-effort net that is always absent on one of the two supported flavours
 * is not a net. The value is rounded UP to a whole second, because rounding a
 * sub-second budget down to zero means "no limit" in MariaDB.
 */
export function mariadbMaxStatementTime(ms: number): string {
  return `SET SESSION max_statement_time = ${Math.max(1, Math.ceil(safeMs(ms) / 1000))}`
}

/**
 * Every statement this feature sends that is NOT in PG_QUERIES/MYSQL_QUERIES.
 *
 * Enumerated so the read-only assertion in tests/dbOpsRegressions.test.ts can
 * see them. They were the hole: the test that proves nothing here writes
 * iterated the query maps, and these were the only statements the app sends
 * that the assertion never saw.
 */
export const DB_TIMEOUT_STATEMENT_BUILDERS: ((ms: number) => string)[] = [
  pgStatementTimeout,
  mysqlMaxExecutionTime,
  mariadbMaxStatementTime
]

/**
 * Strip credentials and hostnames out of an engine's own error text.
 *
 * `Last_IO_Error` reads, verbatim: `error connecting to master
 * 'replicator@db-eu.internal:3306' - ... Unknown MySQL server host
 * 'db-eu.internal' (-2)`. That sentence is shown on screen AND written into the
 * durable event store, where it becomes a replication username and a source
 * host sitting in a table nobody thinks of as sensitive. The judgement does not
 * need either to be right, so neither is kept.
 */
export function redactDbIdentifiers(text: string): string {
  return text
    .replace(/'[^'@\s]+@[^']*'/g, "'<redacted>'")
    .replace(/\b(host|master|source)\s+'[^']*'/gi, "$1 '<redacted>'")
    .replace(/\buser\s+'[^']*'/gi, "user '<redacted>'")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<redacted>')
}

function safeMs(ms: unknown): number {
  if (typeof ms !== 'number' || !Number.isInteger(ms) || ms <= 0 || ms > 3_600_000) {
    throw new Error(`Refusing to build a timeout statement from ${JSON.stringify(ms)}: expected a positive integer of milliseconds.`)
  }
  return ms
}

// ===========================================================================
// Postgres
// ===========================================================================

export interface PgOverview {
  serverVersion: string
  versionNum: number
  inRecovery: boolean
  maxConnections: number
  /** `superuser_reserved_connections`, and on PostgreSQL 16+ the separate
   *  `reserved_connections`. max_connections is not the ceiling an ordinary
   *  client can reach: these come off it first. */
  superuserReservedConnections: number
  reservedConnections: number
  autovacuumFreezeMaxAge: number
  archiveMode: string
  walLevel: string
  database: string
  username: string
  uptimeSeconds: number | null
}

export interface PgReplica {
  applicationName: string | null
  clientAddr: string | null
  state: string | null
  syncState: string | null
  writeLagSeconds: number | null
  flushLagSeconds: number | null
  replayLagSeconds: number | null
  sentLagBytes: number | null
  replayLagBytes: number | null
  replyAgeSeconds: number | null
  /**
   * The row is there and everything that would answer the question is NULL.
   *
   * Not hypothetical. A role without `pg_monitor` SELECTing pg_stat_replication
   * gets one row per walsender with `application_name` filled in and `state`,
   * `sync_state` and every lag column NULL — no error, no warning. Rendered
   * naively that is "0 bytes behind, streaming", which is the Postgres twin of
   * the Seconds_Behind_Source trap. Captured in
   * tests/fixtures/dbops/postgres/unprivileged.json.
   */
  redacted: boolean
}

export interface PgReplicationPrimary {
  role: 'primary'
  replicas: PgReplica[]
}

export interface PgReplicationStandby {
  role: 'standby'
  receiveLsn: string | null
  replayLsn: string | null
  replayAgeSeconds: number | null
  replayPaused: boolean
  applyLagBytes: number | null
  /**
   * `pg_last_xact_replay_timestamp()` is NULL until this standby replays its
   * first COMMIT. Measured on a freshly built standby that was streaming
   * perfectly. "No timestamp" is therefore NOT "no lag" — it is "no evidence
   * either way", and it is reported as unknown.
   */
  neverReplayed: boolean
}

export type PgReplicationValue = PgReplicationPrimary | PgReplicationStandby

export interface PgArchiver {
  archiveMode: string
  archivedCount: number | null
  lastArchivedWal: string | null
  lastArchivedAgeSeconds: number | null
  failedCount: number | null
  lastFailedWal: string | null
  lastFailedAgeSeconds: number | null
  statsResetAgeSeconds: number | null
}

export interface PgVacuumTable {
  schema: string
  name: string
  /** 'r' ordinary, 'm' materialised view, 't' TOAST. Partitioned parents ('p')
   *  are not asked for: they hold no rows, their relfrozenxid is 0, and
   *  `age()` of a non-normal xid is INT_MAX rather than an error. */
  relkind: string | null
  /** For a TOAST relation, the table it belongs to. `pg_toast.pg_toast_16384`
   *  is not a name anybody can act on. */
  parent: string | null
  xidAge: number | null
  deadTuples: number | null
  liveTuples: number | null
  lastAutovacuumAgeSeconds: number | null
  lastVacuumAgeSeconds: number | null
  lastAutoanalyzeAgeSeconds: number | null
  /** xidAge as a fraction of autovacuum_freeze_max_age. */
  freezeFraction: number | null
}

export interface PgDatabaseAge {
  name: string
  xidAge: number | null
  freezeFraction: number | null
  /** Fraction of the point at which PostgreSQL stops accepting transactions. */
  wraparoundFraction: number | null
}

export interface PgVacuumValue {
  freezeMaxAge: number
  tables: PgVacuumTable[]
  /**
   * `age(datfrozenxid)` per database.
   *
   * pg_class is per-database and wraparound is a property of the CLUSTER, so
   * the table list above can only ever see one database's share of it. A
   * neighbouring database at 1.9 billion takes this one down with it.
   */
  databases: PgDatabaseAge[]
}

export interface PgConnectionState {
  /**
   * NULL is not a state. It is the signature of a backend this role may see and
   * may not read: without pg_read_all_stats, pg_stat_activity returns the row
   * with `state`, `query_start`, `query` and `wait_event*` all NULL and raises
   * nothing. COALESCE-ing it to a word laundered that into a bucket no rule
   * inspects, which made the idle-in-transaction alarm unreachable.
   */
  state: string | null
  n: number
  oldestSeconds: number | null
}

export interface PgConnectionsValue {
  maxConnections: number
  /** `superuser_reserved_connections` (+ PG16 `reserved_connections`). */
  superuserReserved: number
  reserved: number
  /** What an ordinary client can actually reach. */
  usableConnections: number
  states: PgConnectionState[]
  used: number
  /** Backends counted but not readable. See PgConnectionState.state. */
  redactedCount: number
}

export interface PgLock {
  pid: number
  username: string | null
  state: string | null
  /**
   * How long this session has been waiting — or NULL because the role may not
   * read `query_start` for a backend it does not own. `?? 0` turned a two-hour
   * block into "briefly blocked (0s)".
   */
  waitingSeconds: number | null
  /** The row is blocked and this account may not see for how long. */
  redacted: boolean
  blockedBy: number[]
  waitEventType: string | null
  waitEvent: string | null
  query: string | null
}

export interface PgSized {
  schema?: string
  name: string
  totalBytes: number | null
  heapBytes?: number | null
  indexBytes?: number | null
}

export interface PgSizesValue {
  databases: PgSized[]
  tables: PgSized[]
}

export interface PgStatement {
  query: string
  calls: number | null
  totalExecMs: number | null
  meanExecMs: number | null
  rows: number | null
}

export interface PgStatementsValue {
  extensionVersion: string | null
  /** True when EVERY statement's text was redacted. */
  redactedText: boolean
  /**
   * How many statement texts came back as `<insufficient privilege>`.
   *
   * Postgres keeps the timings and hides the text from a role that lacks
   * pg_read_all_stats — but it shows the role its OWN statements, so the usual
   * result is a partly-redacted list rather than a wholly redacted one. Counted
   * rather than flagged, because "3 of 20 shown" and "0 of 20 shown" are
   * different situations and a boolean cannot tell them apart.
   */
  redactedCount: number
  statements: PgStatement[]
}

/** Postgres reports a redacted statement text with this exact literal. */
export const PG_REDACTED_QUERY = '<insufficient privilege>'

// ---- Queries --------------------------------------------------------------
//
// Frozen, parameterised, and asserted free of interpolation by
// tests/dbOps.test.ts. `$1` is always a row limit.

export const PG_QUERIES = Object.freeze({
  overview: `SELECT current_setting('server_version') AS server_version,
       current_setting('server_version_num')::int AS version_num,
       pg_is_in_recovery() AS in_recovery,
       current_setting('max_connections')::int AS max_connections,
       current_setting('superuser_reserved_connections')::int AS superuser_reserved,
       -- PostgreSQL 16 added a second reserve on top of the superuser one. The
       -- missing_ok form of current_setting returns NULL on 15 and below rather
       -- than raising, which is what keeps this query working on both.
       current_setting('reserved_connections', true)::int AS reserved,
       current_setting('autovacuum_freeze_max_age')::bigint AS freeze_max_age,
       current_setting('archive_mode') AS archive_mode,
       current_setting('wal_level') AS wal_level,
       current_database() AS database,
       current_user AS username,
       EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))::bigint AS uptime_seconds`,

  replication: `SELECT application_name, server(client_addr) AS client_addr, state, sync_state,
       EXTRACT(EPOCH FROM write_lag) AS write_lag_seconds,
       EXTRACT(EPOCH FROM flush_lag) AS flush_lag_seconds,
       EXTRACT(EPOCH FROM replay_lag) AS replay_lag_seconds,
       pg_wal_lsn_diff(pg_current_wal_lsn(), sent_lsn)::bigint AS sent_lag_bytes,
       pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)::bigint AS replay_lag_bytes,
       EXTRACT(EPOCH FROM (now() - reply_time)) AS reply_age_seconds
  FROM pg_stat_replication ORDER BY application_name`,

  // A standby does not appear in its own pg_stat_replication — that view lists
  // the walsenders a PRIMARY is feeding. Asking a replica how far behind it is
  // means asking it directly, which is this.
  standby: `SELECT pg_last_wal_receive_lsn()::text AS receive_lsn,
       pg_last_wal_replay_lsn()::text AS replay_lsn,
       EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) AS replay_age_seconds,
       pg_is_wal_replay_paused() AS replay_paused,
       pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn())::bigint AS apply_lag_bytes`,

  archiver: `SELECT archived_count::bigint AS archived_count, last_archived_wal,
       EXTRACT(EPOCH FROM (now() - last_archived_time)) AS last_archived_age_seconds,
       failed_count::bigint AS failed_count, last_failed_wal,
       EXTRACT(EPOCH FROM (now() - last_failed_time)) AS last_failed_age_seconds,
       EXTRACT(EPOCH FROM (now() - stats_reset))::bigint AS stats_reset_age_seconds
  FROM pg_stat_archiver`,

  // pg_class carries relfrozenxid; pg_stat_user_tables carries the vacuum
  // history. The LEFT JOIN is deliberate: a table that autovacuum has never
  // touched has no stats row, and dropping it would hide the table most likely
  // to be the problem.
  //
  // The relkind filter is not a tidiness choice, it is the whole correctness of
  // this question:
  //
  //  * 'p', a PARTITIONED PARENT, is excluded. It holds no rows, so its
  //    relfrozenxid is 0, and `age()` of a non-normal xid returns INT_MAX
  //    rather than raising — 2147483647 against a 200 million
  //    autovacuum_freeze_max_age is 1074%. Any database using declarative
  //    partitioning — which is most databases big enough to care about
  //    wraparound — opened this page to a permanent red alarm, and because the
  //    sort is `ORDER BY age(relfrozenxid) DESC` the storage-less parents took
  //    every one of the LIMIT $1 rows and hid the real worst table behind them.
  //    `NOT (relfrozenxid = '0'::xid)` catches the same thing for any other
  //    storage-less relation. (Negated equality because `xid` is guaranteed the
  //    `=` operator and nothing else.)
  //  * 't', a TOAST relation, is now INCLUDED, and pg_toast is no longer
  //    excluded by namespace. A toast table ages independently of its parent
  //    and is a classic wraparound source; excluding it hid exactly the kind of
  //    table this question exists to find. The join to the owning relation is
  //    so the answer can say `public.documents (TOAST)` rather than
  //    `pg_toast.pg_toast_16384`, which nobody can act on.
  vacuum: `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind,
       pn.nspname AS parent_schema, p.relname AS parent_name,
       age(c.relfrozenxid)::bigint AS xid_age,
       COALESCE(s.n_dead_tup, 0)::bigint AS dead_tuples,
       COALESCE(s.n_live_tup, 0)::bigint AS live_tuples,
       EXTRACT(EPOCH FROM (now() - s.last_autovacuum))::bigint AS last_autovacuum_age_seconds,
       EXTRACT(EPOCH FROM (now() - s.last_vacuum))::bigint AS last_vacuum_age_seconds,
       EXTRACT(EPOCH FROM (now() - s.last_autoanalyze))::bigint AS last_autoanalyze_age_seconds
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
  LEFT JOIN pg_class p ON p.reltoastrelid = c.oid
  LEFT JOIN pg_namespace pn ON pn.oid = p.relnamespace
  WHERE c.relkind IN ('r','m','t')
    AND NOT (c.relfrozenxid = '0'::xid)
    AND n.nspname NOT IN ('pg_catalog','information_schema')
  ORDER BY age(c.relfrozenxid) DESC LIMIT $1`,

  // Wraparound is a CLUSTER property and pg_class is per-database, so the
  // question above can only ever see one database's worth of it. datfrozenxid
  // is the cluster's real position, and it is readable by anybody.
  databaseAges: `SELECT datname AS name, age(datfrozenxid)::bigint AS xid_age
  FROM pg_database ORDER BY 2 DESC`,

  connections: `SELECT state, count(*)::int AS n,
       MAX(EXTRACT(EPOCH FROM (now() - state_change)))::bigint AS oldest_seconds
  FROM pg_stat_activity WHERE backend_type = 'client backend' GROUP BY 1 ORDER BY 2 DESC`,

  // THE SESSION HOLDING THE LOCK IS NOT ITSELF BLOCKED, so a filter of
  // "blocked sessions" omits the only one an operator can act on. Measured on
  // PostgreSQL 16.15 with a three-deep chain: this query returned two rows and
  // the blocker was not among them. The screen showed two stuck queries and
  // nothing to do about either.
  //
  // The EXISTS clause adds the sessions that block somebody. It is a
  // correlated subquery over pg_stat_activity, which is a handful of rows on
  // any real server -- pg_stat_activity is a view over shared memory, not a
  // table -- so the cost is the same order as the original.
  locks: `SELECT a.pid, a.usename AS username, a.state,
       EXTRACT(EPOCH FROM (now() - a.query_start))::bigint AS waiting_seconds,
       pg_blocking_pids(a.pid) AS blocked_by, a.wait_event_type, a.wait_event,
       left(a.query, 200) AS query
  FROM pg_stat_activity a
  WHERE cardinality(pg_blocking_pids(a.pid)) > 0
     OR EXISTS (SELECT 1 FROM pg_stat_activity b WHERE a.pid = ANY(pg_blocking_pids(b.pid)))
  ORDER BY 4 DESC NULLS LAST LIMIT $1`,

  databases: `SELECT datname AS name, pg_database_size(oid)::bigint AS bytes
  FROM pg_database WHERE datallowconn ORDER BY 2 DESC`,

  tables: `SELECT n.nspname AS schema, c.relname AS name,
       pg_total_relation_size(c.oid)::bigint AS total_bytes,
       pg_relation_size(c.oid)::bigint AS heap_bytes,
       pg_indexes_size(c.oid)::bigint AS index_bytes
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r','m') AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
  ORDER BY 3 DESC LIMIT $1`,

  // Detect, do not assume. pg_extension is per-database, which is exactly the
  // granularity that matters: the extension can be loaded in one database of a
  // cluster and absent in the next.
  extension: `SELECT extversion FROM pg_extension WHERE extname = 'pg_stat_statements'`,

  // pg_stat_statements 1.8 (Postgres 13) renamed total_time/mean_time to
  // total_exec_time/mean_exec_time. Both spellings ship; the caller tries the
  // modern one and falls back on SQLSTATE 42703.
  statements: `SELECT left(query, 300) AS query, calls::bigint AS calls,
       total_exec_time, mean_exec_time, rows::bigint AS rows
  FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT $1`,

  statementsLegacy: `SELECT left(query, 300) AS query, calls::bigint AS calls,
       total_time AS total_exec_time, mean_time AS mean_exec_time, rows::bigint AS rows
  FROM pg_stat_statements ORDER BY total_time DESC LIMIT $1`
})

/**
 * The oldest Postgres this feature will speak to.
 *
 * 9.6 for `pg_blocking_pids()`, 10 for `pg_wal_lsn_diff` and the
 * `pg_current_wal_lsn` spelling. 10 is the floor, and versions below it get
 * `unsupported` on the questions that need those rather than a syntax error
 * presented as a database problem.
 */
export const PG_MIN_VERSION_NUM = 100000

type Row = Record<string, unknown>

export function parsePgOverview(row: Row | undefined): PgOverview | null {
  if (!row) return null
  return {
    serverVersion: str(row.server_version) ?? 'unknown',
    versionNum: num(row.version_num) ?? 0,
    inRecovery: bool(row.in_recovery) ?? false,
    maxConnections: num(row.max_connections) ?? 0,
    superuserReservedConnections: num(row.superuser_reserved) ?? 0,
    // NULL on PostgreSQL 15 and below, where the setting does not exist.
    reservedConnections: num(row.reserved) ?? 0,
    autovacuumFreezeMaxAge: num(row.freeze_max_age) ?? 200_000_000,
    archiveMode: str(row.archive_mode) ?? 'unknown',
    walLevel: str(row.wal_level) ?? 'unknown',
    database: str(row.database) ?? '',
    username: str(row.username) ?? '',
    uptimeSeconds: num(row.uptime_seconds)
  }
}

export function parsePgReplicas(rows: Row[]): PgReplica[] {
  return rows.map((r) => {
    const replica: PgReplica = {
      applicationName: str(r.application_name),
      clientAddr: str(r.client_addr),
      state: str(r.state),
      syncState: str(r.sync_state),
      writeLagSeconds: num(r.write_lag_seconds),
      flushLagSeconds: num(r.flush_lag_seconds),
      replayLagSeconds: num(r.replay_lag_seconds),
      sentLagBytes: num(r.sent_lag_bytes),
      replayLagBytes: num(r.replay_lag_bytes),
      replyAgeSeconds: num(r.reply_age_seconds),
      redacted: false
    }
    // `state` NULL with a row present is the signature of a role that may see
    // the walsender exists and nothing about it.
    replica.redacted =
      replica.state === null &&
      replica.replayLagBytes === null &&
      replica.sentLagBytes === null &&
      replica.replayLagSeconds === null
    return replica
  })
}

export function parsePgStandby(row: Row | undefined): PgReplicationStandby | null {
  if (!row) return null
  const age = num(row.replay_age_seconds)
  return {
    role: 'standby',
    receiveLsn: str(row.receive_lsn),
    replayLsn: str(row.replay_lsn),
    replayAgeSeconds: age,
    replayPaused: bool(row.replay_paused) ?? false,
    applyLagBytes: num(row.apply_lag_bytes),
    neverReplayed: age === null
  }
}

export function parsePgArchiver(row: Row | undefined, archiveMode: string): PgArchiver | null {
  if (!row) return null
  return {
    archiveMode,
    archivedCount: num(row.archived_count),
    lastArchivedWal: str(row.last_archived_wal),
    lastArchivedAgeSeconds: num(row.last_archived_age_seconds),
    failedCount: num(row.failed_count),
    lastFailedWal: str(row.last_failed_wal),
    lastFailedAgeSeconds: num(row.last_failed_age_seconds),
    statsResetAgeSeconds: num(row.stats_reset_age_seconds)
  }
}

export function parsePgVacuum(rows: Row[], freezeMaxAge: number, databaseRows: Row[] = []): PgVacuumValue {
  const max = freezeMaxAge > 0 ? freezeMaxAge : 200_000_000
  return {
    freezeMaxAge: max,
    databases: databaseRows.map((r) => {
      const xidAge = num(r.xid_age)
      return {
        name: str(r.name) ?? '',
        xidAge,
        freezeFraction: xidAge === null ? null : xidAge / max,
        wraparoundFraction: xidAge === null ? null : xidAge / PG_WRAPAROUND_XID_LIMIT
      }
    }),
    tables: rows.map((r) => {
      const xidAge = num(r.xid_age)
      const parentSchema = str(r.parent_schema)
      const parentName = str(r.parent_name)
      return {
        schema: str(r.schema) ?? '',
        name: str(r.name) ?? '',
        relkind: str(r.relkind),
        parent: parentName ? `${parentSchema ? `${parentSchema}.` : ''}${parentName}` : null,
        xidAge,
        deadTuples: num(r.dead_tuples),
        liveTuples: num(r.live_tuples),
        lastAutovacuumAgeSeconds: num(r.last_autovacuum_age_seconds),
        lastVacuumAgeSeconds: num(r.last_vacuum_age_seconds),
        lastAutoanalyzeAgeSeconds: num(r.last_autoanalyze_age_seconds),
        freezeFraction: xidAge === null ? null : xidAge / max
      }
    })
  }
}

export function parsePgConnections(
  rows: Row[],
  maxConnections: number,
  reserved: { superuserReserved?: number; reserved?: number } = {}
): PgConnectionsValue {
  const states = rows.map((r) => ({
    state: str(r.state),
    n: num(r.n) ?? 0,
    oldestSeconds: num(r.oldest_seconds)
  }))
  const superuserReserved = reserved.superuserReserved ?? 0
  const alsoReserved = reserved.reserved ?? 0
  return {
    maxConnections,
    superuserReserved,
    reserved: alsoReserved,
    usableConnections: Math.max(0, maxConnections - superuserReserved - alsoReserved),
    states,
    used: states.reduce((a, s) => a + s.n, 0),
    redactedCount: states.filter((s) => s.state === null).reduce((a, s) => a + s.n, 0)
  }
}

export function parsePgLocks(rows: Row[]): PgLock[] {
  return rows.map((r) => ({
    pid: num(r.pid) ?? 0,
    username: str(r.username),
    state: str(r.state),
    waitingSeconds: num(r.waiting_seconds),
    // A blocked backend is by definition `active`, so a NULL state on a row
    // pg_blocking_pids() put here is the redaction, not a quiet session.
    redacted: str(r.state) === null && num(r.waiting_seconds) === null,
    blockedBy: Array.isArray(r.blocked_by) ? r.blocked_by.map((p) => num(p) ?? 0) : [],
    waitEventType: str(r.wait_event_type),
    waitEvent: str(r.wait_event),
    query: str(r.query)
  }))
}

export function parsePgSizes(databases: Row[], tables: Row[]): PgSizesValue {
  return {
    databases: databases.map((r) => ({ name: str(r.name) ?? '', totalBytes: num(r.bytes) })),
    tables: tables.map((r) => ({
      schema: str(r.schema) ?? undefined,
      name: str(r.name) ?? '',
      totalBytes: num(r.total_bytes),
      heapBytes: num(r.heap_bytes),
      indexBytes: num(r.index_bytes)
    }))
  }
}

export function parsePgStatements(rows: Row[], extensionVersion: string | null): PgStatementsValue {
  const statements = rows.map((r) => ({
    query: str(r.query) ?? '',
    calls: num(r.calls),
    totalExecMs: num(r.total_exec_time),
    meanExecMs: num(r.mean_exec_time),
    rows: num(r.rows)
  }))
  const redactedCount = statements.filter((s) => s.query === PG_REDACTED_QUERY).length
  return {
    extensionVersion,
    redactedText: statements.length > 0 && redactedCount === statements.length,
    redactedCount,
    statements
  }
}

// ---- Judgements -----------------------------------------------------------

const T = DB_THRESHOLDS

/**
 * Replication, primary or standby.
 *
 * The ordering is the design. `redacted` is checked BEFORE any lag comparison,
 * because a redacted row's lag columns are all NULL and every comparison
 * against them is false — so a naive "lag > threshold" chain would fall through
 * to `ok` and tell an operator with no monitoring privileges that replication
 * is healthy. Same shape, same reason, as the MySQL rule below.
 */
export function judgePgReplication(v: PgReplicationValue): DbVerdict {
  if (v.role === 'standby') {
    if (v.replayPaused) {
      return {
        level: 'alarm',
        headline: st('shared.dbOps.pg.replication.replayPaused.headline'),
        because: st('shared.dbOps.pg.replication.replayPaused.because')
      }
    }

    // BYTES FIRST, and this ordering is not a preference — it is a correction.
    //
    // The obvious measure of standby lag, `now() - pg_last_xact_replay_timestamp()`,
    // is wrong, and it was caught here by running against a real streaming pair
    // rather than by reading about it: a standby that was byte-for-byte current
    // reported nine and a half minutes of "lag", because that timestamp is the
    // commit time of the last transaction it replayed and the PRIMARY had been
    // idle for nine and a half minutes. On a quiet database that number grows
    // without bound while nothing at all is wrong, and it would page somebody
    // every night.
    //
    // The receive/replay LSN difference has no such failure mode: zero means
    // everything received has been applied, whatever the clock says.
    const bytes = v.applyLagBytes
    const age = v.replayAgeSeconds

    if (bytes === 0) {
      return {
        level: 'ok',
        headline: st('shared.dbOps.pg.replication.standbyCurrent.headline'),
        because:
          age === null
            ? st('shared.dbOps.pg.replication.standbyCurrent.becauseNothingReplayed')
            : st('shared.dbOps.pg.replication.standbyCurrent.becauseIdlePrimary', { age: formatSeconds(age) })
      }
    }

    if (bytes === null) {
      if (v.neverReplayed) {
        return {
          level: 'unknown',
          headline: st('shared.dbOps.pg.replication.neverReplayed.headline'),
          because: st('shared.dbOps.pg.replication.neverReplayed.because')
        }
      }
      const s = age ?? 0
      return {
        level: s >= T.replicaLagAlarmSeconds ? 'alarm' : s >= T.replicaLagWatchSeconds ? 'watch' : 'unknown',
        headline: st('shared.dbOps.pg.replication.timestampOnly.headline', { age: formatSeconds(s) }),
        because: st('shared.dbOps.pg.replication.timestampOnly.because')
      }
    }

    // There IS unapplied WAL, so the replay timestamp finally means something.
    const s = age ?? 0
    const because = st('shared.dbOps.pg.replication.unapplied', { bytes: formatBytes(bytes) })
    if (s >= T.replicaLagAlarmSeconds) {
      return { level: 'alarm', headline: st('shared.dbOps.pg.replication.standbyBehind', { lag: formatSeconds(s) }), because }
    }
    if (s >= T.replicaLagWatchSeconds) {
      return { level: 'watch', headline: st('shared.dbOps.pg.replication.standbyBehind', { lag: formatSeconds(s) }), because }
    }
    return { level: 'ok', headline: st('shared.dbOps.pg.replication.standbyApplying', { bytes: formatBytes(bytes) }), because }
  }

  if (v.replicas.length === 0) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.pg.replication.noStandby.headline'),
      because: st('shared.dbOps.pg.replication.noStandby.because')
    }
  }

  const redacted = v.replicas.filter((r) => r.redacted)
  if (redacted.length === v.replicas.length) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.pg.replication.allHidden.headline', { count: redacted.length }),
      because: st('shared.dbOps.pg.replication.allHidden.because')
    }
  }

  // 'backup' is a walsender serving a running pg_basebackup. It is not a
  // standby that stopped, it is a backup being taken, and alarming on it fires
  // every time somebody clones the server.
  const notStreaming = v.replicas.filter(
    (r) => !r.redacted && r.state !== null && r.state !== 'streaming' && r.state !== 'backup'
  )
  if (notStreaming.length > 0) {
    const worst = notStreaming[0]
    return {
      level: 'alarm',
      headline: st('shared.dbOps.pg.replication.notStreaming.headline', {
        name: worst.applicationName ?? worst.clientAddr ?? st('shared.dbOps.format.unknown'),
        state: worst.state ?? ''
      }),
      because: st('shared.dbOps.pg.replication.notStreaming.because')
    }
  }

  let worstSeconds = 0
  let worstReplica: PgReplica | null = null
  for (const r of v.replicas) {
    const s = r.replayLagSeconds
    if (s !== null && s >= worstSeconds) {
      worstSeconds = s
      worstReplica = r
    }
  }
  const name = worstReplica?.applicationName ?? worstReplica?.clientAddr ?? st('shared.dbOps.pg.replication.theStandby')
  const because =
    worstReplica?.replayLagBytes === null || worstReplica?.replayLagBytes === undefined
      ? undefined
      : st('shared.dbOps.pg.replication.sentNotReplayed', { bytes: formatBytes(worstReplica.replayLagBytes) })
  if (worstSeconds >= T.replicaLagAlarmSeconds) {
    return { level: 'alarm', headline: st('shared.dbOps.pg.replication.behindOn', { lag: formatSeconds(worstSeconds), name }), because }
  }
  if (worstSeconds >= T.replicaLagWatchSeconds) {
    return { level: 'watch', headline: st('shared.dbOps.pg.replication.behindOn', { lag: formatSeconds(worstSeconds), name }), because }
  }
  const n = v.replicas.length
  // SOME redacted, not all. The all-redacted branch above is the easy case; the
  // mixed one fell through it, and every lag comparison against a redacted
  // row's NULLs is false, so two standbys of which one is hidden rendered as
  // "2 standbys streaming" with a verdict of ok.
  if (redacted.length > 0) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.pg.replication.someHidden.headline', { hidden: redacted.length, total: n }),
      because: st('shared.dbOps.pg.replication.someHidden.because', { count: n - redacted.length, lag: formatSeconds(worstSeconds) })
    }
  }
  return {
    level: 'ok',
    headline: st('shared.dbOps.pg.replication.streaming', { count: n, lag: formatSeconds(worstSeconds) }),
    because
  }
}

/**
 * WAL archiving.
 *
 * `failed_count` alone is not the signal — a server that failed once a year ago
 * and has archived cleanly since is fine. The signal is whether the LAST thing
 * that happened was a failure, which is what comparing the two ages does. A
 * failure with no successful archive at all is the worst case and the one the
 * captured fixture shows: 28 failures, `last_archived_wal` NULL.
 */
export function judgePgArchiver(a: PgArchiver): DbVerdict {
  if (a.archiveMode !== 'on' && a.archiveMode !== 'always') {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.pg.archiver.off.headline', { mode: a.archiveMode }),
      because: st('shared.dbOps.pg.archiver.off.because')
    }
  }
  const failed = a.failedCount ?? 0
  const failedAge = a.lastFailedAgeSeconds
  const archivedAge = a.lastArchivedAgeSeconds
  const failingNow = failed > 0 && (archivedAge === null || (failedAge !== null && failedAge < archivedAge))
  if (failingNow) {
    return {
      level: 'alarm',
      headline: st('shared.dbOps.pg.archiver.failing.headline', { count: failed, failures: formatCount(failed), age: formatSeconds(failedAge) }),
      because:
        a.lastArchivedWal === null
          ? st('shared.dbOps.pg.archiver.failing.becauseNeverArchived')
          : st('shared.dbOps.pg.archiver.failing.becauseLastArchived', { wal: a.lastArchivedWal, age: formatSeconds(archivedAge) })
    }
  }
  if (failed > 0) {
    return {
      level: 'watch',
      headline: st('shared.dbOps.pg.archiver.recovered.headline', { count: failed, failures: formatCount(failed) }),
      because: st('shared.dbOps.pg.archiver.recovered.because', {
        failedAge: formatSeconds(failedAge),
        wal: a.lastFailedWal ?? st('shared.dbOps.pg.archiver.unnamedSegment'),
        archivedAge: formatSeconds(archivedAge)
      })
    }
  }
  if ((a.archivedCount ?? 0) === 0) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.pg.archiver.nothingYet.headline'),
      because: st('shared.dbOps.pg.archiver.nothingYet.because')
    }
  }
  return {
    level: 'ok',
    headline: st('shared.dbOps.pg.archiver.ok', { archived: formatCount(a.archivedCount), age: formatSeconds(archivedAge) })
  }
}

/**
 * Autovacuum and transaction-ID wraparound.
 *
 * Two questions in one because they are read from the same place and the second
 * one is what kills you: when `age(relfrozenxid)` reaches roughly 2^31 Postgres
 * stops accepting writes entirely, and the only way out is a vacuum that takes
 * as long as it takes. It is visible for weeks first.
 */
export function judgePgVacuum(v: PgVacuumValue): DbVerdict {
  // The CLUSTER first, because pg_class is per-database and wraparound is not.
  // A neighbouring database at 1.9 billion stops this one too, and nothing in
  // the table list below can see it.
  const worstDb = (v.databases ?? [])
    .filter((d) => d.xidAge !== null)
    .reduce<PgDatabaseAge | null>((a, b) => ((b.xidAge ?? 0) > (a?.xidAge ?? -1) ? b : a), null)
  if (worstDb && (worstDb.xidAge ?? 0) >= T.freezeAlarmAbsolute) {
    return {
      level: 'alarm',
      headline: st('shared.dbOps.pg.vacuum.databaseWraparound.headline', {
        name: worstDb.name,
        pct: Math.round((worstDb.wraparoundFraction ?? 0) * 100)
      }),
      because: st('shared.dbOps.pg.vacuum.databaseWraparound.because', {
        age: formatCount(worstDb.xidAge),
        limit: formatCount(PG_WRAPAROUND_XID_LIMIT)
      })
    }
  }

  const withAge = v.tables.filter((t) => t.xidAge !== null)
  if (withAge.length === 0) {
    return { level: 'unknown', headline: st('shared.dbOps.pg.vacuum.noAges') }
  }
  const worst = withAge.reduce((a, b) => ((b.xidAge ?? 0) > (a.xidAge ?? 0) ? b : a))
  const age = worst.xidAge ?? 0
  const frac = worst.freezeFraction ?? 0
  // A TOAST relation is named pg_toast.pg_toast_16384, which nobody can act on.
  const where =
    worst.relkind === 't' && worst.parent ? st('shared.dbOps.pg.vacuum.toastOf', { table: worst.parent }) : `${worst.schema}.${worst.name}`
  // The genuine shutdown alarm, measured against the point Postgres actually
  // stops rather than against the point autovacuum starts.
  if (age >= T.freezeAlarmAbsolute) {
    return {
      level: 'alarm',
      headline: st('shared.dbOps.pg.vacuum.tableWraparound.headline', { where, pct: Math.round((age / PG_WRAPAROUND_XID_LIMIT) * 100) }),
      because: st('shared.dbOps.pg.vacuum.tableWraparound.because', { age: formatCount(age), limit: formatCount(PG_WRAPAROUND_XID_LIMIT) })
    }
  }
  if (frac >= T.freezeAlarmFraction) {
    // NOT wraparound. autovacuum_freeze_max_age is where autovacuum STARTS, and
    // saying "90% of the way to wraparound" here overstated it by more than ten
    // times — 180M of 200M is 8.5% of the way to the number that matters.
    return {
      level: 'alarm',
      headline: st('shared.dbOps.pg.vacuum.forcedFreeze.headline', { where, pct: Math.round(frac * 100) }),
      because: st('shared.dbOps.pg.vacuum.forcedFreeze.because', {
        age: formatCount(age),
        maxAge: formatCount(v.freezeMaxAge),
        pct: Math.round((age / PG_WRAPAROUND_XID_LIMIT) * 100)
      })
    }
  }
  if (frac >= T.freezeWatchFraction) {
    return {
      level: 'watch',
      headline: st('shared.dbOps.pg.vacuum.approachingFreeze.headline', { where, pct: Math.round(frac * 100) }),
      because: st('shared.dbOps.pg.vacuum.approachingFreeze.because', { age: formatCount(age), maxAge: formatCount(v.freezeMaxAge) })
    }
  }
  const bloated = v.tables.filter(
    (t) => (t.deadTuples ?? 0) > 100_000 && (t.deadTuples ?? 0) > (t.liveTuples ?? 0) * 0.2
  )
  if (bloated.length > 0) {
    const b = bloated[0]
    return {
      level: 'watch',
      headline: st('shared.dbOps.pg.vacuum.bloated.headline', {
        table: `${b.schema}.${b.name}`,
        dead: formatCount(b.deadTuples),
        live: formatCount(b.liveTuples)
      }),
      because:
        b.lastAutovacuumAgeSeconds === null
          ? st('shared.dbOps.pg.vacuum.bloated.becauseNever')
          : st('shared.dbOps.pg.vacuum.bloated.becauseBehind', { age: formatSeconds(b.lastAutovacuumAgeSeconds) })
    }
  }
  return {
    level: 'ok',
    headline: st('shared.dbOps.pg.vacuum.ok.headline', { pct: Math.round(frac * 100), where }),
    because: st('shared.dbOps.pg.vacuum.ok.because', { age: formatCount(age), maxAge: formatCount(v.freezeMaxAge) })
  }
}

export function judgePgConnections(v: PgConnectionsValue): DbVerdict {
  const idleTx = v.states.find((s) => s.state === 'idle in transaction')
  const idleAborted = v.states.find((s) => s.state === 'idle in transaction (aborted)')
  // The ceiling an ordinary client can reach is max_connections minus what is
  // held back for superusers (and, on PostgreSQL 16+, the second reserve). The
  // old text asserted Postgres "reserves a handful for superusers and nothing
  // else" while dividing by the number that includes them.
  const ceiling = v.usableConnections > 0 ? v.usableConnections : v.maxConnections
  const frac = ceiling > 0 ? v.used / ceiling : 0
  const held = v.superuserReserved + v.reserved
  const usage = { used: v.used, max: v.maxConnections, pct: Math.round(frac * 100) }

  if (ceiling > 0 && frac >= T.connectionsAlarmFraction) {
    return {
      level: 'alarm',
      headline: st('shared.dbOps.pg.connections.usage', usage),
      because:
        held > 0
          ? st('shared.dbOps.pg.connections.ceiling.becauseReserved', {
              held,
              superuser: v.superuserReserved,
              reserved: v.reserved,
              ceiling
            })
          : st('shared.dbOps.pg.connections.ceiling.because')
    }
  }
  const oldestIdleTx = Math.max(idleTx?.oldestSeconds ?? 0, idleAborted?.oldestSeconds ?? 0)
  if (oldestIdleTx >= T.idleInTransactionAlarmSeconds) {
    return {
      level: 'alarm',
      headline: st('shared.dbOps.pg.connections.idleInTransaction.headline', { age: formatSeconds(oldestIdleTx) }),
      because: st('shared.dbOps.pg.connections.idleInTransaction.becauseAlarm')
    }
  }
  if (ceiling > 0 && frac >= T.connectionsWatchFraction) {
    return { level: 'watch', headline: st('shared.dbOps.pg.connections.usage', usage) }
  }
  if (oldestIdleTx >= T.idleInTransactionWatchSeconds) {
    return {
      level: 'watch',
      headline: st('shared.dbOps.pg.connections.idleInTransaction.headline', { age: formatSeconds(oldestIdleTx) }),
      because: st('shared.dbOps.pg.connections.idleInTransaction.becauseWatch')
    }
  }
  // Below every threshold — but if part of the picture came back NULL, this is
  // not a clean bill of health, it is a bill this account could not read. The
  // idle-in-transaction rules above are silently unreachable in this state.
  if (v.redactedCount > 0) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.pg.connections.redacted.headline', { ...usage, hidden: v.redactedCount }),
      because: st('shared.dbOps.pg.connections.redacted.because')
    }
  }
  return { level: 'ok', headline: st('shared.dbOps.pg.connections.usage', usage) }
}

export function judgePgLocks(locks: PgLock[]): DbVerdict {
  if (locks.length === 0) return { level: 'ok', headline: st('shared.dbOps.pg.locks.none') }
  // BLOCKED sessions only, for the counting. The query now also returns the
  // sessions that are BLOCKING -- the ones an operator can actually act on,
  // which it used to omit -- and those are not themselves waiting. Counting
  // every returned row would report three sessions blocked where two are, and
  // the third is the one holding the lock.
  const blocked = locks.filter((l) => l.blockedBy.length > 0)
  const roots = locks.filter((l) => l.blockedBy.length === 0)
  if (blocked.length === 0) return { level: 'ok', headline: st('shared.dbOps.pg.locks.none') }
  // `?? 0` here was the bug: a role without pg_read_all_stats gets NULL for
  // query_start on a backend it does not own, so a session blocked for two
  // hours rendered as "briefly blocked (0s)" — a watch instead of an alarm.
  // A wait nobody could time is not a wait of zero.
  const timed = blocked.filter((l) => l.waitingSeconds !== null)
  const hidden = blocked.length - timed.length
  const worst = timed.length > 0 ? timed.reduce((a, b) => ((b.waitingSeconds ?? 0) > (a.waitingSeconds ?? 0) ? b : a)) : null
  const s = worst?.waitingSeconds ?? null
  const blockers = [...new Set(blocked.flatMap((l) => l.blockedBy))]
  const target = worst ?? blocked[0]
  // The root's own query, when the query returned it. This is the whole point
  // of including blockers: "waiting on pid 124" is not actionable and
  // "waiting on pid 124, which is running <this>" is.
  const root = roots.find((r) => target.blockedBy.includes(r.pid))
  const waiting = {
    pid: target.pid,
    holder: target.blockedBy.join(', ') || st('shared.dbOps.pg.locks.anotherSession'),
    // The blocker's own state and query, as the server reported them.
    root: root ? ` (${root.state}${root.query ? `: ${root.query}` : ''})` : ''
  }
  const because =
    blockers.length > 1
      ? st('shared.dbOps.pg.locks.waitingOnMany', { ...waiting, blockers: blockers.length })
      : st('shared.dbOps.pg.locks.waitingOn', waiting)
  const count = blocked.length
  if (s !== null && s >= T.lockWaitAlarmSeconds) {
    return { level: 'alarm', headline: st('shared.dbOps.pg.locks.blockedUpTo', { count, wait: formatSeconds(s) }), because }
  }
  if (hidden > 0) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.pg.locks.blockedUntimed.headline', { count }),
      because: st('shared.dbOps.pg.locks.blockedUntimed.because', { hidden, detail: because })
    }
  }
  if (s !== null && s >= T.lockWaitWatchSeconds) {
    return { level: 'watch', headline: st('shared.dbOps.pg.locks.blockedLongest', { count, wait: formatSeconds(s) }), because }
  }
  return { level: 'watch', headline: st('shared.dbOps.pg.locks.blockedBriefly', { count, wait: formatSeconds(s ?? 0) }), because }
}

export function judgePgSizes(v: PgSizesValue): DbVerdict {
  const total = v.databases.reduce((a, d) => a + (d.totalBytes ?? 0), 0)
  const biggest = v.tables[0]
  return {
    level: 'ok',
    headline: st('shared.dbOps.pg.sizes.headline', { count: v.databases.length, bytes: formatBytes(total) }),
    because: biggest
      ? st('shared.dbOps.pg.sizes.largest', {
          table: `${biggest.schema ? `${biggest.schema}.` : ''}${biggest.name}`,
          bytes: formatBytes(biggest.totalBytes)
        })
      : undefined
  }
}

export function judgePgStatements(v: PgStatementsValue): DbVerdict {
  if (v.redactedText) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.pg.statements.textHidden.headline'),
      because: st('shared.dbOps.pg.statements.textHidden.because', { redacted: PG_REDACTED_QUERY })
    }
  }
  if (v.statements.length === 0) {
    return { level: 'unknown', headline: st('shared.dbOps.pg.statements.empty') }
  }
  const top = v.statements[0]
  const headline = st('shared.dbOps.pg.statements.top', {
    total: v.statements.length,
    cost: formatSeconds((top.totalExecMs ?? 0) / 1000),
    calls: formatCount(top.calls)
  })
  if (v.redactedCount > 0) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.pg.statements.someHidden.headline', { headline, hidden: v.redactedCount, total: v.statements.length }),
      because: st('shared.dbOps.pg.statements.someHidden.because', { redacted: PG_REDACTED_QUERY })
    }
  }
  return { level: 'ok', headline }
}

// ===========================================================================
// MySQL / MariaDB
// ===========================================================================

export interface MysqlOverview {
  version: string
  versionComment: string
  /** MariaDB and MySQL diverge on statement names, system variables and error
   *  codes; this is read from the version string, not guessed. */
  flavour: 'mysql' | 'mariadb'
  serverId: number | null
  readOnly: boolean | null
  maxConnections: number
  hostname: string | null
  uptimeSeconds: number | null
}

/** Which spelling of the replication vocabulary a row used. */
export type MysqlReplicaVocabulary = 'replica' | 'slave'

export interface MysqlReplicationChannel {
  channel: string
  vocabulary: MysqlReplicaVocabulary
  sourceHost: string | null
  ioState: string | null
  ioRunning: string | null
  sqlRunning: string | null
  /**
   * `Seconds_Behind_Source` / `Seconds_Behind_Master`, VERBATIM.
   *
   * NULL means the server declined to state a lag, which happens whenever the
   * IO thread is not connected — i.e. whenever replication is broken. It does
   * NOT mean zero, and nothing in this file may coerce it. The type is
   * `number | null` for exactly that reason and `num()` preserves the null.
   */
  secondsBehind: number | null
  lastIoErrno: number | null
  lastIoError: string | null
  lastSqlErrno: number | null
  lastSqlError: string | null
  /** A deliberately delayed replica (CHANGE REPLICATION SOURCE ... SOURCE_DELAY).
   *  Its lag is intentional and must not be alarmed on. */
  sqlDelaySeconds: number | null
  autoPosition: boolean | null
  sourceLogFile: string | null
  relayLogSpaceBytes: number | null
}

export interface MysqlBinlogFile {
  name: string
  bytes: number | null
  encrypted: string | null
}

export interface MysqlBinlogsValue {
  logBin: boolean
  /** MySQL 8 spells it binlog_expire_logs_seconds; MariaDB and MySQL 5.7 spell
   *  it expire_logs_days. Whichever answered. */
  expireSeconds: number | null
  expireSource: 'binlog_expire_logs_seconds' | 'expire_logs_days' | null
  files: MysqlBinlogFile[]
  totalBytes: number
}

export interface MysqlSlowLogValue {
  enabled: boolean
  longQueryTimeSeconds: number | null
  file: string | null
  output: string | null
  slowQueries: number | null
  uptimeSeconds: number | null
}

export interface MysqlConnectionsValue {
  maxConnections: number
  threadsConnected: number | null
  threadsRunning: number | null
  maxUsedConnections: number | null
  abortedConnects: number | null
  /** Non-zero means clients have ALREADY been refused for hitting
   *  max_connections. Not a risk — an outage that happened. */
  connectionErrorsMaxConnections: number | null
}

export interface MysqlProcess {
  id: number | null
  user: string | null
  host: string | null
  db: string | null
  command: string | null
  seconds: number | null
  state: string | null
  info: string | null
}

export interface MysqlProcesslistValue {
  processes: MysqlProcess[]
  /** How many rows information_schema.PROCESSLIST returned in total. */
  visible: number | null
  /** What SHOW GLOBAL STATUS says is actually connected. */
  threadsConnected: number | null
}

export interface MysqlBufferPoolValue {
  sizeBytes: number | null
  instances: number | null
  readRequests: number | null
  reads: number | null
  pagesTotal: number | null
  pagesFree: number | null
  pagesDirty: number | null
  uptimeSeconds: number | null
  /** 1 - reads/read_requests, or null when there is nothing to divide. */
  hitRate: number | null
}

export interface MysqlTableSize {
  schema: string
  name: string
  engine: string | null
  rows: number | null
  dataBytes: number | null
  indexBytes: number | null
  freeBytes: number | null
}

export interface MysqlSizesValue {
  tables: MysqlTableSize[]
  totalBytes: number
}

// ---- Queries --------------------------------------------------------------

export const MYSQL_QUERIES = Object.freeze({
  overview: `SELECT VERSION() AS version, @@version_comment AS version_comment, @@server_id AS server_id,
       @@read_only AS read_only, @@max_connections AS max_connections, @@hostname AS hostname`,

  // MySQL 8.0.22 renamed SHOW SLAVE STATUS to SHOW REPLICA STATUS. MariaDB kept
  // the old spelling and did not add the new one until 10.5. So BOTH are tried
  // and neither failing is an error on its own — only both failing is.
  //
  // The subtlety the fixtures caught: MySQL 8.0.46 accepts BOTH statements and
  // answers them with DIFFERENT column names (Replica_IO_Running vs
  // Slave_IO_Running, Seconds_Behind_Source vs Seconds_Behind_Master). The
  // parser therefore reads either vocabulary from whichever row it got, rather
  // than assuming the columns follow the statement it happened to send.
  replicaStatus: 'SHOW REPLICA STATUS',
  // MariaDB's multi-source spelling. `SHOW SLAVE STATUS` there returns ONLY the
  // unnamed default connection, so a MariaDB server replicating from two
  // sources answers it with the one row and says nothing about the other.
  allSlavesStatus: 'SHOW ALL SLAVES STATUS',
  slaveStatus: 'SHOW SLAVE STATUS',

  logBin: 'SELECT @@log_bin AS log_bin',
  binlogExpireSeconds: 'SELECT @@binlog_expire_logs_seconds AS expire_seconds',
  binlogExpireDays: 'SELECT @@expire_logs_days AS expire_days',
  binaryLogs: 'SHOW BINARY LOGS',

  // Item 37. `sum_no_index_used` is MySQL's OWN count of executions that read
  // the table without an index -- not a ratio inferred from rows, which on a
  // small table says nothing: the scanning statement measured on MySQL 8.4.11
  // examined four rows to return two.
  //
  // `digest_text` is normalised by the server before it is read, so a user's
  // literal cannot arrive here. Table and column names still can, and it is
  // treated as remote text on that basis.
  digests: `SELECT COALESCE(schema_name,'') AS schema_name, COALESCE(LEFT(digest_text,120),'') AS digest_text,
       count_star, ROUND(sum_timer_wait/1000000000,1) AS total_ms,
       ROUND(max_timer_wait/1000000000,1) AS max_ms,
       sum_rows_examined, sum_rows_sent, sum_no_index_used
  FROM performance_schema.events_statements_summary_by_digest
  WHERE digest_text IS NOT NULL
  ORDER BY sum_timer_wait DESC LIMIT ?`,
  slowSettings: `SELECT @@slow_query_log AS slow_query_log, @@long_query_time AS long_query_time,
       @@slow_query_log_file AS slow_query_log_file, @@log_output AS log_output`,

  // One round trip for every counter any question below needs. SHOW GLOBAL
  // STATUS unfiltered is ~500 rows on MySQL 8 and most of them are noise.
  status: `SHOW GLOBAL STATUS WHERE Variable_name IN
    ('Uptime','Threads_connected','Threads_running','Max_used_connections','Aborted_connects',
     'Connection_errors_max_connections','Slow_queries','Queries',
     'Innodb_buffer_pool_read_requests','Innodb_buffer_pool_reads','Innodb_buffer_pool_pages_total',
     'Innodb_buffer_pool_pages_free','Innodb_buffer_pool_pages_dirty','Innodb_row_lock_waits',
     'Innodb_row_lock_time_avg','Innodb_buffer_pool_wait_free')`,

  bufferPool: `SELECT @@innodb_buffer_pool_size AS bytes, @@innodb_buffer_pool_instances AS instances`,

  processlist: `SELECT ID AS id, USER AS user, HOST AS server, DB AS db, COMMAND AS command,
       TIME AS seconds, STATE AS state, LEFT(INFO, 200) AS info
  FROM information_schema.PROCESSLIST WHERE COMMAND <> 'Sleep' ORDER BY TIME DESC LIMIT ?`,

  // Counted separately from the listing above so "how many can this account
  // see" can be compared with Threads_connected. Without the PROCESS privilege
  // MySQL silently shows only the caller's own connections — no error, a
  // smaller number, and a page that would otherwise say "1 query running" on a
  // server with two hundred.
  processlistCount: 'SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST',

  sizes: `SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name, ENGINE AS engine,
       TABLE_ROWS AS table_rows, DATA_LENGTH AS data_bytes, INDEX_LENGTH AS index_bytes,
       DATA_FREE AS free_bytes
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA NOT IN ('mysql','information_schema','performance_schema','sys')
    AND TABLE_TYPE = 'BASE TABLE'
  ORDER BY (COALESCE(DATA_LENGTH,0) + COALESCE(INDEX_LENGTH,0)) DESC LIMIT ?`
})

/**
 * Read a replication field under either vocabulary.
 *
 * `SHOW SLAVE STATUS` on MySQL 8 returns Slave_IO_Running and
 * Seconds_Behind_Master; `SHOW REPLICA STATUS` on the SAME SERVER returns
 * Replica_IO_Running and Seconds_Behind_Source. Reading by the statement we
 * sent would work until someone reordered the fallback.
 *
 * `in` rather than `!== undefined`: the whole point is to tell a column that is
 * present and NULL from a column that is not present at all.
 */
export function replicaField(row: Row, modern: string, legacy: string): unknown {
  if (modern in row) return row[modern]
  if (legacy in row) return row[legacy]
  return undefined
}

/** Whether a row uses the post-8.0.22 spelling. Recorded so the UI can say
 *  which dialect answered rather than implying one. */
export function replicaVocabulary(row: Row): MysqlReplicaVocabulary {
  return 'Replica_IO_Running' in row || 'Seconds_Behind_Source' in row ? 'replica' : 'slave'
}

export function parseMysqlOverview(row: Row | undefined, uptimeSeconds: number | null): MysqlOverview | null {
  if (!row) return null
  const version = str(row.version) ?? 'unknown'
  const comment = str(row.version_comment) ?? ''
  return {
    version,
    versionComment: comment,
    flavour: /mariadb/i.test(version) || /mariadb/i.test(comment) ? 'mariadb' : 'mysql',
    serverId: num(row.server_id),
    readOnly: bool(row.read_only),
    maxConnections: num(row.max_connections) ?? 0,
    hostname: str(row.hostname),
    uptimeSeconds
  }
}

export function parseMysqlReplication(rows: Row[]): MysqlReplicationChannel[] {
  return rows.map((r) => ({
    // MySQL calls it Channel_Name; MariaDB calls it Connection_name. Reading
    // only the first collapsed every MariaDB multi-source connection into
    // "default", so a server replicating from two places looked like one.
    channel: str(replicaField(r, 'Channel_Name', 'Connection_name')) || 'default',
    vocabulary: replicaVocabulary(r),
    sourceHost: str(replicaField(r, 'Source_Host', 'Master_Host')),
    ioState: str(replicaField(r, 'Replica_IO_State', 'Slave_IO_State')),
    ioRunning: str(replicaField(r, 'Replica_IO_Running', 'Slave_IO_Running')),
    sqlRunning: str(replicaField(r, 'Replica_SQL_Running', 'Slave_SQL_Running')),
    // num() and not Number(): this is the value the whole item is about.
    secondsBehind: num(replicaField(r, 'Seconds_Behind_Source', 'Seconds_Behind_Master')),
    lastIoErrno: num(r.Last_IO_Errno),
    lastIoError: str(r.Last_IO_Error),
    lastSqlErrno: num(r.Last_SQL_Errno),
    lastSqlError: str(r.Last_SQL_Error),
    sqlDelaySeconds: num(r.SQL_Delay),
    autoPosition: bool(r.Auto_Position),
    sourceLogFile: str(replicaField(r, 'Source_Log_File', 'Master_Log_File')),
    relayLogSpaceBytes: num(r.Relay_Log_Space)
  }))
}

export function parseMysqlBinlogs(
  rows: Row[],
  logBin: boolean,
  expire: { seconds: number | null; days: number | null }
): MysqlBinlogsValue {
  const files = rows.map((r) => ({
    name: str(r.Log_name) ?? '',
    bytes: num(r.File_size),
    encrypted: str(r.Encrypted)
  }))
  const seconds = expire.seconds
  const days = expire.days
  return {
    logBin,
    expireSeconds: seconds !== null ? seconds : days !== null ? days * 86_400 : null,
    expireSource: seconds !== null ? 'binlog_expire_logs_seconds' : days !== null ? 'expire_logs_days' : null,
    files,
    totalBytes: files.reduce((a, f) => a + (f.bytes ?? 0), 0)
  }
}

/** SHOW GLOBAL STATUS rows to a map. Both drivers return
 *  `{ Variable_name, Value }`; the values are always strings. */
export function statusMap(rows: Row[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rows) {
    const k = str(r.Variable_name) ?? str(r.VARIABLE_NAME)
    if (k) out[k] = str(r.Value) ?? str(r.VALUE) ?? ''
  }
  return out
}

export function parseMysqlSlowLog(settings: Row | undefined, status: Record<string, string>): MysqlSlowLogValue {
  return {
    enabled: bool(settings?.slow_query_log) ?? false,
    longQueryTimeSeconds: num(settings?.long_query_time),
    file: str(settings?.slow_query_log_file),
    output: str(settings?.log_output),
    slowQueries: num(status.Slow_queries),
    uptimeSeconds: num(status.Uptime)
  }
}

export function parseMysqlConnections(status: Record<string, string>, maxConnections: number): MysqlConnectionsValue {
  return {
    maxConnections,
    threadsConnected: num(status.Threads_connected),
    threadsRunning: num(status.Threads_running),
    maxUsedConnections: num(status.Max_used_connections),
    abortedConnects: num(status.Aborted_connects),
    connectionErrorsMaxConnections: num(status.Connection_errors_max_connections)
  }
}

export function parseMysqlProcesslist(
  rows: Row[],
  visible: number | null,
  threadsConnected: number | null
): MysqlProcesslistValue {
  return {
    processes: rows.map((r) => ({
      id: num(r.id),
      user: str(r.user),
      host: str(r.host),
      db: str(r.db),
      command: str(r.command),
      seconds: num(r.seconds),
      state: str(r.state),
      info: str(r.info)
    })),
    visible,
    threadsConnected
  }
}

export function parseMysqlBufferPool(status: Record<string, string>, settings: Row | undefined): MysqlBufferPoolValue {
  const requests = num(status.Innodb_buffer_pool_read_requests)
  const reads = num(status.Innodb_buffer_pool_reads)
  return {
    sizeBytes: num(settings?.bytes),
    instances: num(settings?.instances),
    readRequests: requests,
    reads,
    pagesTotal: num(status.Innodb_buffer_pool_pages_total),
    pagesFree: num(status.Innodb_buffer_pool_pages_free),
    pagesDirty: num(status.Innodb_buffer_pool_pages_dirty),
    uptimeSeconds: num(status.Uptime),
    hitRate: requests !== null && reads !== null && requests > 0 ? 1 - reads / requests : null
  }
}

export function parseMysqlSizes(rows: Row[]): MysqlSizesValue {
  const tables = rows.map((r) => ({
    schema: str(r.schema) ?? '',
    name: str(r.name) ?? '',
    engine: str(r.engine),
    rows: num(r.table_rows),
    dataBytes: num(r.data_bytes),
    indexBytes: num(r.index_bytes),
    freeBytes: num(r.free_bytes)
  }))
  return { tables, totalBytes: tables.reduce((a, t) => a + (t.dataBytes ?? 0) + (t.indexBytes ?? 0), 0) }
}

// ---- Judgements -----------------------------------------------------------

/**
 * The most important function in this feature.
 *
 * Four rules, and the ORDER of the first three is the whole thing. Each was
 * derived from output captured off a real MySQL 8.0.46 replica
 * (tests/fixtures/dbops/mysql/), not from the documentation.
 *
 *  1. No channels at all — the server is not a replica. `SHOW REPLICA STATUS`
 *     on a source returns an EMPTY RESULT SET, not an error, so this case has
 *     to be recognised here or it becomes "healthy, zero lag".
 *
 *  2. Either thread not running is an ALARM, regardless of Seconds_Behind.
 *     This rule comes before the seconds check because of a capture that is
 *     worse than the famous NULL: a replica pointed at a host that does not
 *     resolve reported `Replica_IO_Running: No`, `Last_IO_Errno: 2005` — and
 *     `Seconds_Behind_Source: 0`. A genuinely dead replica reporting ZERO
 *     seconds behind. Checking only for NULL would call that healthy.
 *
 *  3. Seconds_Behind NULL is an ALARM, never zero and never "healthy".
 *     `STOP REPLICA IO_THREAD` produces `Seconds_Behind_Source: NULL` with
 *     `Last_IO_Errno: 0` and an EMPTY `Last_IO_Error` — replication stopped
 *     with no error text at all. The NULL is the only signal there is.
 *
 *  4. Only once both threads run and the value is a real number does the
 *     number get compared with a threshold, minus any deliberate SQL_Delay.
 */
export function judgeMysqlReplication(channels: MysqlReplicationChannel[]): DbVerdict {
  if (channels.length === 0) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.mysql.replication.none.headline'),
      because: st('shared.dbOps.mysql.replication.none.because')
    }
  }

  // Worst channel wins. A server with four channels where one is dead is a
  // server with a dead channel.
  const verdicts = channels.map(judgeMysqlChannel)
  return verdicts.reduce((a, b) => (DB_VERDICT_RANK[b.level] > DB_VERDICT_RANK[a.level] ? b : a))
}

function channelName(c: MysqlReplicationChannel): string {
  const host = c.sourceHost
  if (c.channel && c.channel !== 'default') {
    return host
      ? st('shared.dbOps.mysql.channel.namedFrom', { channel: c.channel, host })
      : st('shared.dbOps.mysql.channel.named', { channel: c.channel })
  }
  return host ? st('shared.dbOps.mysql.channel.defaultFrom', { host }) : st('shared.dbOps.mysql.channel.default')
}

export function judgeMysqlChannel(c: MysqlReplicationChannel): DbVerdict {
  const name = channelName(c)
  const ioOk = c.ioRunning === 'Yes'
  const sqlOk = c.sqlRunning === 'Yes'

  if (!ioOk || !sqlOk) {
    // Last_IO_Error reads `error connecting to master 'replicator@db:3306'`.
    // That sentence is shown here AND written into the durable event store.
    const err = redactDbIdentifiers((c.lastIoError || '').trim() || (c.lastSqlError || '').trim())
    const errnos = { io: c.lastIoErrno ?? 0, sql: c.lastSqlErrno ?? 0 }
    return {
      level: 'alarm',
      headline:
        !ioOk && !sqlOk
          ? st('shared.dbOps.mysql.channel.bothThreadsStopped', { name })
          : st('shared.dbOps.mysql.channel.threadStopped', { name, thread: !ioOk ? 'IO' : 'SQL' }),
      because: err
        ? err
        : c.secondsBehind === 0
          ? st('shared.dbOps.mysql.channel.noErrorZeroLag', errnos)
          : st('shared.dbOps.mysql.channel.noError', errnos)
    }
  }

  if (c.secondsBehind === null) {
    return {
      level: 'alarm',
      headline: st('shared.dbOps.mysql.channel.lagNull.headline', { name }),
      because: st('shared.dbOps.mysql.channel.lagNull.because')
    }
  }

  // A deliberately delayed replica is meant to be behind by exactly this much.
  const delay = c.sqlDelaySeconds ?? 0
  const effective = Math.max(0, c.secondsBehind - delay)
  const lag = { name, lag: formatSeconds(c.secondsBehind), delay: formatSeconds(delay) }
  const behind = delay > 0 ? st('shared.dbOps.mysql.channel.behindDelayed', lag) : st('shared.dbOps.mysql.channel.behind', lag)

  if (effective >= T.replicaLagAlarmSeconds) {
    return {
      level: 'alarm',
      headline: behind,
      because: st('shared.dbOps.mysql.channel.behindAlarm')
    }
  }
  if (effective >= T.replicaLagWatchSeconds) {
    return { level: 'watch', headline: behind }
  }
  return {
    level: 'ok',
    headline: delay > 0 ? st('shared.dbOps.mysql.channel.runningDelayed', lag) : st('shared.dbOps.mysql.channel.running', lag),
    because: c.ioState ? st('shared.dbOps.mysql.channel.ioThread', { state: c.ioState }) : undefined
  }
}

export function judgeMysqlBinlogs(v: MysqlBinlogsValue): DbVerdict {
  if (!v.logBin) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.mysql.binlogs.off.headline'),
      because: st('shared.dbOps.mysql.binlogs.off.because')
    }
  }
  if (v.expireSeconds === 0) {
    return {
      level: 'watch',
      headline: st('shared.dbOps.mysql.binlogs.neverExpire.headline', { files: v.files.length, bytes: formatBytes(v.totalBytes) }),
      because: st('shared.dbOps.mysql.binlogs.neverExpire.because', { setting: String(v.expireSource) })
    }
  }
  const expiryNote =
    v.expireSeconds === null
      ? st('shared.dbOps.mysql.binlogs.noExpiry')
      : st('shared.dbOps.mysql.binlogs.keptFor', { age: formatSeconds(v.expireSeconds), setting: String(v.expireSource) })
  if (v.files.length === 0) {
    return { level: 'unknown', headline: st('shared.dbOps.mysql.binlogs.noFiles'), because: expiryNote }
  }
  return {
    level: 'ok',
    headline: st('shared.dbOps.mysql.binlogs.ok', { count: v.files.length, bytes: formatBytes(v.totalBytes) }),
    because: expiryNote
  }
}

export function judgeMysqlSlowLog(v: MysqlSlowLogValue): DbVerdict {
  if (!v.enabled) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.mysql.slowlog.off.headline'),
      because: st('shared.dbOps.mysql.slowlog.off.because')
    }
  }
  if ((v.output ?? '').toUpperCase().includes('NONE')) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.mysql.slowlog.outputNone.headline'),
      because: st('shared.dbOps.mysql.slowlog.outputNone.because', { output: v.output ?? '' })
    }
  }
  const t = v.longQueryTimeSeconds
  // SHOW GLOBAL STATUS feeds both of these. When it failed — a denied account,
  // a dropped connection — they are null, and the sentence built from them read
  // "unknown slow queries recorded in unknown of uptime" under a green tick.
  const uncounted = v.slowQueries === null || v.uptimeSeconds === null
  const counted = uncounted
    ? st('shared.dbOps.mysql.slowlog.uncounted')
    : st('shared.dbOps.mysql.slowlog.counted', {
        count: v.slowQueries ?? 0,
        queries: formatCount(v.slowQueries),
        uptime: formatSeconds(v.uptimeSeconds)
      })
  if (t !== null && t >= T.slowLogUselessThresholdSeconds) {
    return {
      level: 'watch',
      headline: st('shared.dbOps.mysql.slowlog.thresholdTooHigh.headline', { threshold: t }),
      because: st('shared.dbOps.mysql.slowlog.thresholdTooHigh.because', { counted })
    }
  }
  return {
    level: uncounted ? 'unknown' : 'ok',
    headline: st('shared.dbOps.mysql.slowlog.on', { threshold: t ?? '?', output: v.output ?? 'FILE' }),
    because: v.file ? st('shared.dbOps.mysql.slowlog.withFile', { counted, file: v.file }) : counted
  }
}

export function judgeMysqlConnections(v: MysqlConnectionsValue): DbVerdict {
  const refused = v.connectionErrorsMaxConnections ?? 0
  const used = v.threadsConnected ?? 0
  const frac = v.maxConnections > 0 ? used / v.maxConnections : 0
  const usage = { used, max: v.maxConnections, pct: Math.round(frac * 100) }
  const shape = st('shared.dbOps.mysql.connections.usage', usage)
  const peak = st('shared.dbOps.mysql.connections.highWater', { peak: formatCount(v.maxUsedConnections) })

  if (refused > 0) {
    return {
      level: 'alarm',
      headline: st('shared.dbOps.mysql.connections.refused.headline', { count: refused, refused: formatCount(refused) }),
      because: st('shared.dbOps.mysql.connections.refused.because', {
        ...usage,
        refused: formatCount(refused),
        peak: formatCount(v.maxUsedConnections)
      })
    }
  }
  if (v.maxConnections > 0 && frac >= T.connectionsAlarmFraction) {
    return { level: 'alarm', headline: shape, because: peak }
  }
  if (v.maxConnections > 0 && frac >= T.connectionsWatchFraction) {
    return { level: 'watch', headline: shape, because: peak }
  }
  const highWater = v.maxUsedConnections ?? 0
  if (v.maxConnections > 0 && highWater / v.maxConnections >= T.connectionsAlarmFraction) {
    return {
      level: 'watch',
      headline: st('shared.dbOps.mysql.connections.nearPeak.headline', { ...usage, peak: formatCount(highWater) }),
      because: st('shared.dbOps.mysql.connections.nearPeak.because')
    }
  }
  return { level: 'ok', headline: shape, because: peak }
}

/**
 * Running queries.
 *
 * The partial-visibility check is the point. Without the PROCESS privilege
 * MySQL shows an account ONLY its own connections and says nothing about it, so
 * the count is compared with Threads_connected — which every account can read —
 * and the gap is reported rather than swallowed. Captured: an application user
 * saw 1 row where root saw 3 on the same server at the same moment.
 */
/**
 * The server's own threads, which are not queries anyone is waiting on.
 *
 * Found by running this against a real replica: its applier thread shows up as
 * `system user` in state "Waiting for an event from Coordinator" with a TIME
 * equal to the replica's uptime, so a naive "longest running query" alarmed at
 * eleven minutes on a completely healthy server. The binlog dump thread on a
 * source has the same shape, and so does the event scheduler.
 */
export const MYSQL_INTERNAL_COMMANDS = ['Daemon', 'Binlog Dump', 'Binlog Dump GTID', 'Connect'] as const

export function isClientQuery(p: MysqlProcess): boolean {
  if (p.user === 'system user' || p.user === 'event_scheduler') return false
  return !MYSQL_INTERNAL_COMMANDS.includes((p.command ?? '') as (typeof MYSQL_INTERNAL_COMMANDS)[number])
}

export function judgeMysqlProcesslist(v: MysqlProcesslistValue): DbVerdict {
  const hidden =
    v.visible !== null && v.threadsConnected !== null && v.visible < v.threadsConnected
      ? v.threadsConnected - v.visible
      : 0
  const partialNote = hidden > 0
    ? st('shared.dbOps.mysql.processlist.partial', { count: hidden, visible: v.visible ?? 0, total: v.threadsConnected ?? 0 })
    : undefined

  const running = v.processes.filter(isClientQuery)
  const longest = running.reduce<MysqlProcess | null>((a, b) => ((b.seconds ?? 0) > (a?.seconds ?? -1) ? b : a), null)
  const s = longest?.seconds ?? 0

  if (s >= T.longQueryAlarmSeconds) {
    return {
      level: 'alarm',
      headline: st('shared.dbOps.mysql.processlist.longRunning', { age: formatSeconds(s) }),
      because: [
        st('shared.dbOps.mysql.processlist.whoWithState', {
          user: longest?.user ?? st('shared.dbOps.format.unknown'),
          db: longest?.db ?? st('shared.dbOps.mysql.processlist.noDatabase'),
          state: longest?.state ?? '?'
        }),
        partialNote
      ]
        .filter(Boolean)
        .join(' ')
    }
  }
  if (s >= T.longQueryWatchSeconds) {
    return {
      level: 'watch',
      headline: st('shared.dbOps.mysql.processlist.longRunning', { age: formatSeconds(s) }),
      because: [
        st('shared.dbOps.mysql.processlist.who', {
          user: longest?.user ?? st('shared.dbOps.format.unknown'),
          db: longest?.db ?? st('shared.dbOps.mysql.processlist.noDatabase')
        }),
        partialNote
      ]
        .filter(Boolean)
        .join(' ')
    }
  }
  if (hidden > 0) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.mysql.processlist.partialHeadline', { count: running.length }),
      because: partialNote
    }
  }
  return { level: 'ok', headline: st('shared.dbOps.mysql.processlist.ok', { count: running.length, age: formatSeconds(s) }) }
}

/**
 * InnoDB buffer pool.
 *
 * The uptime guard exists because the first version of this alarmed on a
 * perfectly healthy server. A MySQL container five minutes old reported 17,345
 * read requests against 1,050 disk reads — a 93.9% hit rate, below the alarm
 * line — purely because every first read of a cold pool is a miss. A ratio over
 * too short a window is not a measurement, and saying so is more useful than a
 * number that is technically correct and operationally wrong.
 */
export function judgeMysqlBufferPool(v: MysqlBufferPoolValue): DbVerdict {
  const size = v.instances
    ? st('shared.dbOps.mysql.bufferpool.poolInstances', { bytes: formatBytes(v.sizeBytes), count: v.instances })
    : st('shared.dbOps.mysql.bufferpool.pool', { bytes: formatBytes(v.sizeBytes) })
  if (v.hitRate === null) {
    return { level: 'unknown', headline: st('shared.dbOps.mysql.bufferpool.noReads'), because: size }
  }
  const pct = `${(v.hitRate * 100).toFixed(2)}%`
  const tooYoung = (v.uptimeSeconds ?? 0) < T.bufferPoolMinUptimeSeconds
  const tooFew = (v.readRequests ?? 0) < T.bufferPoolMinReadRequests
  // AND, not OR. A million requests is a lot for a busy server and nothing for
  // a quiet one, so a server up a hundred days with half a million reads was
  // `unknown` forever at a 99.98% hit rate — a permanently unanswered question
  // rather than a warm-up guard. Either signal on its own is enough to judge;
  // it takes both to mean the pool is still cold.
  if (tooYoung && tooFew) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.mysql.bufferpool.cold.headline', { pct }),
      because: st('shared.dbOps.mysql.bufferpool.cold.because', {
        requests: formatCount(v.readRequests),
        uptime: formatSeconds(v.uptimeSeconds),
        minUptime: formatSeconds(T.bufferPoolMinUptimeSeconds),
        minRequests: formatCount(T.bufferPoolMinReadRequests),
        size
      })
    }
  }
  const detail = st('shared.dbOps.mysql.bufferpool.reads', {
    reads: formatCount(v.reads),
    requests: formatCount(v.readRequests),
    size
  })
  if (v.hitRate < T.bufferPoolAlarmRate) {
    return {
      level: 'alarm',
      headline: st('shared.dbOps.mysql.bufferpool.alarm.headline', { pct }),
      because: st('shared.dbOps.mysql.bufferpool.alarm.because', { detail })
    }
  }
  if (v.hitRate < T.bufferPoolWatchRate) {
    return { level: 'watch', headline: st('shared.dbOps.mysql.bufferpool.hitRate', { pct }), because: detail }
  }
  return { level: 'ok', headline: st('shared.dbOps.mysql.bufferpool.hitRate', { pct }), because: detail }
}

export function judgeMysqlSizes(v: MysqlSizesValue): DbVerdict {
  // information_schema.TABLES is filtered by grants, silently — the identical
  // mechanism as PROCESSLIST, and there is no counter to cross-check it
  // against, so it is disclosed instead of guessed at. A 500 GB server read by
  // an account with SELECT on one schema answers "32 KB across 1 table" with no
  // error and no warning.
  const scope = st('shared.dbOps.mysql.sizes.scope')
  if (v.tables.length === 0) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.mysql.sizes.empty.headline'),
      because: `${st('shared.dbOps.mysql.sizes.empty.because')} ${scope}`
    }
  }
  const biggest = v.tables[0]
  const fragmented = v.tables.filter((t) => (t.freeBytes ?? 0) > 1_000_000_000)
  return {
    level: 'ok',
    headline: st('shared.dbOps.mysql.sizes.headline', { count: v.tables.length, bytes: formatBytes(v.totalBytes) }),
    because: [
      st('shared.dbOps.mysql.sizes.largest', {
        table: `${biggest.schema}.${biggest.name}`,
        bytes: formatBytes((biggest.dataBytes ?? 0) + (biggest.indexBytes ?? 0))
      }),
      fragmented.length > 0 ? st('shared.dbOps.mysql.sizes.fragmented', { count: fragmented.length }) : null,
      scope
    ]
      .filter(Boolean)
      .join(' ')
  }
}

// ===========================================================================
// MongoDB
// ===========================================================================
//
// Nothing here is a string. A MongoDB command is a document, so the injection
// surface the SQL half of this file spends four paragraphs closing does not
// exist: there is no text to concatenate into. What replaces it is a different
// hazard — three of these commands name a COLLECTION, and a collection name is
// the one value that comes from outside a frozen constant. It comes from the
// server's own listCollections rather than from anything a user typed, and it
// is validated anyway by the builders below, which throw rather than sanitise.

/** A member state, by the number `replSetGetStatus` reports.
 *
 *  `stateStr` is also in the row and is what the panel shows, but the NUMBER is
 *  what is judged, because the string is localised prose — the down member in
 *  tests/fixtures/dbops/mongodb/secondary-down.json calls itself
 *  "(not reachable/healthy)", with the parentheses and the slash, and matching
 *  that text is matching a sentence. */
export const MONGO_MEMBER_STATES: Record<number, string> = {
  0: 'STARTUP',
  1: 'PRIMARY',
  2: 'SECONDARY',
  3: 'RECOVERING',
  5: 'STARTUP2',
  6: 'UNKNOWN',
  7: 'ARBITER',
  8: 'DOWN',
  9: 'ROLLBACK',
  10: 'REMOVED'
}

/** States in which a member is carrying its share of the set. Everything else
 *  is either transitional or broken, and neither is "fine". */
const MONGO_HEALTHY_STATES = new Set([1, 2, 7])

export type MongoRole = 'primary' | 'secondary' | 'arbiter' | 'standalone' | 'router' | 'unknown'

export interface MongoOverview {
  version: string
  process: string | null
  host: string | null
  uptimeSeconds: number | null
  /** `hello().setName`. Absent on a standalone, which is how a standalone is
   *  told from a replica-set member that has not been reached yet. */
  setName: string | null
  role: MongoRole
  /** `hello().msg === 'isdbgrid'`. A mongos answers every command here with a
   *  cluster-wide aggregate or refuses it, and none of the eight questions
   *  below mean what they say against one. */
  isRouter: boolean
  readOnly: boolean | null
  /** How many members `hello()` lists. Null on a standalone. */
  memberCount: number | null
}

export interface MongoMember {
  id: number | null
  name: string
  state: number | null
  stateStr: string
  /**
   * 1 or 0, and the field that is read FIRST.
   *
   * See tests/fixtures/dbops/mongodb/secondary-down.json: eighteen seconds
   * after the member was paused it reports `health: 0` alongside `pingMs: 0`
   * and `uptime: 0`, two numbers that read as excellent to anything that has
   * not looked at this one.
   */
  health: number | null
  self: boolean
  uptimeSeconds: number | null
  /**
   * The member's optime as milliseconds, or null.
   *
   * NULL when the member reported the UNIX EPOCH, which is what an unreachable
   * member reports — not its last known position, and not null. Subtracting it
   * from the primary's optime gives fifty-six years, and clamping that at zero
   * gives the MySQL `Seconds_Behind_Source: 0` bug in different field names.
   */
  optimeMs: number | null
  /** Whether optimeDate was the epoch, so the UI can say "did not report"
   *  rather than showing 1970. */
  optimeIsEpoch: boolean
  lastHeartbeatMs: number | null
  /** `lastHeartbeatMessage`, redacted: the raw text embeds the source and
   *  target host names and the whole internal heartbeat command. */
  heartbeatMessage: string | null
  /** Null on an unhealthy member. A round trip that was never made is not a
   *  round trip of zero milliseconds. */
  pingMs: number | null
  syncSourceHost: string | null
  /** Seconds behind the set's primary, or null when either side did not say. */
  lagSeconds: number | null
}

export interface MongoReplicationValue {
  setName: string | null
  /** `myState` — the state of the member that answered. */
  myState: number | null
  members: MongoMember[]
  /** How many votes a majority needs. Below it, the set cannot elect and
   *  cannot acknowledge a majority write. */
  majorityVoteCount: number | null
  healthyCount: number
}

export interface MongoOplogValue {
  /** False on a standalone, where `local.oplog.rs` does not exist. */
  present: boolean
  firstMs: number | null
  lastMs: number | null
  /** THE answer, in seconds. How long a secondary may be down before it needs
   *  a full resync. Never expressed in bytes, which tell an operator nothing. */
  windowSeconds: number | null
  /** `serverStatus().uptime`, and the only reliable discriminator below. */
  uptimeSeconds: number | null
  /**
   * True when the oplog still holds everything since this member started, so
   * it has never had to discard an entry and the window is a FLOOR that will
   * keep growing — not a measurement.
   *
   * Measured against uptime and not against the storage numbers, because the
   * storage numbers lie: tests/fixtures/dbops/mongodb/oplog-saturated.json is
   * a genuinely rolling oplog whose `$collStats` reports `storageSize`
   * 225353728 against a `maxSize` of 1048576. WiredTiger does not shrink the
   * file it has already allocated, so "used against configured" reads as
   * 21000% on a healthy server.
   */
  neverRolled: boolean | null
  sizeBytes: number | null
  maxSizeBytes: number | null
  storageBytes: number | null
  count: number | null
}

export interface MongoIndexUse {
  collection: string
  name: string
  /** `accesses.ops`. Zero is a real zero and still proves nothing on its own —
   *  see `sinceMs`. */
  ops: number | null
  /**
   * `accesses.since` — when these counters started, which is when the server
   * last restarted. An index with zero accesses since eight minutes ago is not
   * an unused index; it is an index nobody has needed for eight minutes.
   */
  sinceMs: number | null
  sizeBytes: number | null
}

export interface MongoIndexesValue {
  indexes: MongoIndexUse[]
  /** Collections whose `$indexStats` could not be read. A `read` role is
   *  granted `$collStats` and refused `$indexStats` on the same collection —
   *  captured, see tests/fixtures/dbops/mongodb/unauthorized.json. */
  unreadable: string[]
  /** The shortest counter age across every collection read, in seconds. The
   *  whole "unused" judgement is gated on this. */
  counterAgeSeconds: number | null
}

export interface MongoConnectionsValue {
  current: number | null
  available: number | null
  totalCreated: number | null
  rejected: number | null
  active: number | null
  /**
   * `current + available`.
   *
   * `serverStatus` never states the ceiling directly, and `net.maxIncomingConnections`
   * is a config file this app does not read. The sum is what the server itself
   * uses, and it is null rather than a guess when either half is missing.
   */
  ceiling: number | null
}

export interface MongoOperation {
  opid: number | string | null
  type: string | null
  desc: string | null
  appName: string | null
  op: string | null
  ns: string | null
  secondsRunning: number | null
  planSummary: string | null
  waitingForLock: boolean | null
  /** A server thread rather than somebody's query. See isMongoClientOp. */
  internal: boolean
}

export interface MongoCurrentOpValue {
  operations: MongoOperation[]
  /**
   * True when `$currentOp` was asked with `allUsers: false` because
   * `allUsers: true` was refused.
   *
   * The MySQL `information_schema.PROCESSLIST` trap, exactly: the fallback
   * succeeds, returns only this connection's own operations, and reports "1
   * operation running" on a server running two hundred. Captured in
   * tests/fixtures/dbops/mongodb/unauthorized.json, where `allUsers: true`
   * raises code 13 and `allUsers: false` returns `ok: 1`.
   */
  ownOpsOnly: boolean
}

export interface MongoDatabaseSize {
  name: string
  sizeOnDiskBytes: number | null
  empty: boolean | null
}

export interface MongoCollectionSize {
  name: string
  documents: number | null
  dataBytes: number | null
  storageBytes: number | null
  indexBytes: number | null
  indexes: number | null
}

export interface MongoSizesValue {
  databases: MongoDatabaseSize[]
  collections: MongoCollectionSize[]
  totalBytes: number | null
  /**
   * True when `listDatabases` answered with a list that has no `admin` and no
   * `local`.
   *
   * Every mongod has both. Their absence means the server silently returned
   * only the databases this user is authorized on — `ok: 1`, no error, no
   * flag — and the total underneath is a floor. `information_schema` shrinking
   * without saying so, in a different engine: see
   * tests/fixtures/dbops/mongodb/unauthorized.json, where a four-database
   * cluster reports one database and `totalSize: 40960`.
   */
  databasesFiltered: boolean
}

export interface MongoAssertsValue {
  regular: number | null
  warning: number | null
  msg: number | null
  user: number | null
  rollovers: number | null
  /**
   * `extra_info.page_faults`, or null.
   *
   * serverStatus states the hazard itself: `extra_info` carries
   * `note: "fields vary by platform"`, and on the Linux container these
   * fixtures came from `page_faults` is present and 0. Somewhere else it is
   * absent entirely. Those are different facts and are not collapsed.
   */
  pageFaults: number | null
  pageFaultsReported: boolean
  uptimeSeconds: number | null
}

// ---- Commands -------------------------------------------------------------

/**
 * Every command this feature sends to MongoDB, frozen, with the database each
 * one runs against.
 *
 * `serverStatus` names thirty-four sections it does NOT want rather than the
 * handful it does, because there is no include form. It is worth the length:
 * the full document is 9.4 KB of which 7.5 KB is WiredTiger counters no
 * operator reads, and every one of those bytes would also be in six fixtures.
 */
export const MONGO_COMMANDS = Object.freeze({
  hello: { db: 'admin', command: { hello: 1 } },
  buildInfo: { db: 'admin', command: { buildInfo: 1 } },
  serverStatus: {
    db: 'admin',
    command: {
      serverStatus: 1,
      wiredTiger: 0,
      tcmalloc: 0,
      metrics: 0,
      locks: 0,
      indexStats: 0,
      transactions: 0,
      opLatencies: 0,
      electionMetrics: 0,
      logicalSessionRecordCache: 0,
      catalogStats: 0,
      collectionCatalog: 0,
      queryAnalyzers: 0,
      internalTransactions: 0,
      twoPhaseCommitCoordinator: 0,
      shardSplits: 0,
      tenantMigrations: 0,
      trafficRecording: 0,
      flowControl: 0,
      indexBuilds: 0,
      indexBulkBuilder: 0,
      oplogTruncation: 0,
      readConcernCounters: 0,
      readPreferenceCounters: 0,
      scramCache: 0,
      queues: 0,
      batchedDeletes: 0,
      defaultRWConcern: 0,
      profiler: 0,
      globalLock: 0,
      storageEngine: 0,
      network: 0,
      security: 0,
      transportSecurity: 0,
      opcountersRepl: 0
    }
  },
  replSetGetStatus: { db: 'admin', command: { replSetGetStatus: 1 } },
  // Sorted by $natural, which on a capped collection is insertion order and is
  // the only ordering the oplog has. There is no index on ts to sort by.
  oplogFirst: { db: 'local', command: { find: 'oplog.rs', filter: {}, sort: { $natural: 1 }, limit: 1, projection: { ts: 1 } } },
  oplogLast: { db: 'local', command: { find: 'oplog.rs', filter: {}, sort: { $natural: -1 }, limit: 1, projection: { ts: 1 } } },
  oplogStats: {
    db: 'local',
    command: {
      aggregate: 'oplog.rs',
      pipeline: [{ $collStats: { storageStats: { scale: 1 } } }, { $project: MONGO_STORAGE_PROJECTION() }],
      cursor: {}
    }
  },
  listDatabases: { db: 'admin', command: { listDatabases: 1 } },
  // `db: null` means "the database the operator is pointed at", which the
  // collector fills in. It is the only entry that is not fixed to admin/local.
  listCollections: { db: null, command: { listCollections: 1, nameOnly: true, authorizedCollections: true } }
})

/**
 * The fields kept from `$collStats`.
 *
 * Without it the stage returns the entire WiredTiger statistics block: 82 KB
 * for one collection, none of it read by anything here, all of it destined for
 * a fixture. A function rather than a constant only so MONGO_COMMANDS above can
 * be a single frozen literal without a forward reference.
 */
function MONGO_STORAGE_PROJECTION(): Record<string, number> {
  return {
    ns: 1,
    'storageStats.size': 1,
    'storageStats.count': 1,
    'storageStats.avgObjSize': 1,
    'storageStats.storageSize': 1,
    'storageStats.freeStorageSize': 1,
    'storageStats.totalIndexSize': 1,
    'storageStats.indexSizes': 1,
    'storageStats.nindexes': 1,
    'storageStats.capped': 1,
    'storageStats.max': 1,
    'storageStats.maxSize': 1,
    'storageStats.totalSize': 1
  }
}

/**
 * A collection name that came from the server, checked anyway.
 *
 * The three per-collection commands take a name out of `listCollections`, so
 * nothing a user typed reaches them. This throws rather than escaping, for the
 * reason `safeMs` does: a caller passing something else has a bug, and quietly
 * repairing it hides the bug while leaving the shape an attack takes.
 */
function safeCollectionName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 200 || name.includes('$') || name.includes('\0')) {
    throw new Error(`Refusing to build a command for the collection ${JSON.stringify(name)}: expected a plain collection name from listCollections.`)
  }
  return name
}

function safeLimit(n: unknown): number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0 || n > 1000) {
    throw new Error(`Refusing to build a command with a limit of ${JSON.stringify(n)}: expected a positive integer no greater than 1000.`)
  }
  return n
}

export function mongoCollStatsCommand(collection: string): Record<string, unknown> {
  return {
    aggregate: safeCollectionName(collection),
    pipeline: [{ $collStats: { storageStats: { scale: 1 } } }, { $project: MONGO_STORAGE_PROJECTION() }],
    cursor: {}
  }
}

export function mongoIndexStatsCommand(collection: string): Record<string, unknown> {
  return { aggregate: safeCollectionName(collection), pipeline: [{ $indexStats: {} }], cursor: {} }
}

/**
 * `$currentOp`, projected.
 *
 * The projection is not tidying. Unprojected, every row carries `command` in
 * full — which on a real server is somebody's query, with their filter values
 * in it — plus the originating command of every tailing cursor and a
 * `clientMetadata` block. None of it is needed to answer "what has been running
 * too long", so none of it is asked for, and none of it can end up on screen or
 * in the durable event store.
 *
 * `allUsers` is a parameter and not a constant because refusal is a real
 * answer here: see MongoCurrentOpValue.ownOpsOnly.
 */
export function mongoCurrentOpCommand(limit: number, allUsers: boolean): Record<string, unknown> {
  return {
    aggregate: 1,
    pipeline: [
      { $currentOp: { allUsers, idleConnections: false, localOps: true } },
      {
        $project: {
          opid: 1,
          type: 1,
          desc: 1,
          appName: 1,
          active: 1,
          op: 1,
          ns: 1,
          secs_running: 1,
          microsecs_running: 1,
          planSummary: 1,
          waitingForLock: 1,
          currentOpTime: 1,
          effectiveUsers: 1,
          killPending: 1
        }
      },
      { $sort: { secs_running: -1 } },
      { $limit: safeLimit(limit) }
    ],
    cursor: {}
  }
}

/** Every MongoDB command builder, enumerated so the read-only assertion in
 *  tests/dbOpsRegressions.test.ts can reach the ones MONGO_COMMANDS does not
 *  contain. The same hole the timeout builders were. */
export const MONGO_COMMAND_BUILDERS: (() => Record<string, unknown>)[] = [
  () => mongoCollStatsCommand('placeholder'),
  () => mongoIndexStatsCommand('placeholder'),
  () => mongoCurrentOpCommand(20, true),
  // The live panel's two. They are NOT in MONGO_COMMANDS -- that map is the
  // operational read's, and every entry in it must have a captured fixture --
  // but they are commands this app sends, so they belong under the same
  // read-only assertion. Arrows, so the forward reference resolves at call
  // time rather than at module evaluation.
  () => MONGO_MONITOR_COMMANDS.serverStatus.command,
  () => MONGO_MONITOR_COMMANDS.top.command
]

// ---- Coercion -------------------------------------------------------------

/**
 * A BSON timestamp to whole seconds, or null.
 *
 * Four shapes reach this, and the fourth is the reason it exists rather than a
 * `.high` on the call site:
 *
 *  * a `Timestamp` from the driver, which extends Long and carries `high`
 *    (seconds) and `low` (the per-second ordinal);
 *  * `{ t, i }`, the same thing spelled by name;
 *  * `{ $timestamp: { t, i } }`, canonical Extended JSON;
 *  * `{ $timestamp: "7681494973912449025" }`, which is what `JSON.stringify`
 *    of a driver Timestamp produces — a DECIMAL STRING of the whole 64-bit
 *    value, whose seconds are the top 32 bits. Every captured fixture is in
 *    this form, so a parser that handled only the live shapes would pass every
 *    test against real data and be tested against nothing.
 *
 * `>>> 0` rather than `>>`: the seconds are unsigned, and a signed shift turns
 * every timestamp after 2038 into a negative number.
 */
export function mongoTimestampSeconds(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null
  if (typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if ('$timestamp' in o) {
    const inner = o.$timestamp
    if (typeof inner === 'string') {
      try {
        return Number(BigInt(inner) >> 32n)
      } catch {
        return null
      }
    }
    return mongoTimestampSeconds(inner)
  }
  const t = num(o.t)
  if (t !== null && 'i' in o) return t
  const high = num(o.high)
  if (high !== null && 'low' in o) return high >>> 0
  return t
}

/** A driver Date, an ISO string, or `{ $date }`, to epoch milliseconds. */
export function mongoDateMs(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const n = Date.parse(v)
    return Number.isFinite(n) ? n : null
  }
  if (typeof v === 'object') {
    const d = (v as Record<string, unknown>).$date
    if (d !== undefined) return mongoDateMs(d)
  }
  return null
}

/**
 * The epoch, to the second.
 *
 * An unreachable member reports `optimeDate: "1970-01-01T00:00:00.000Z"`. That
 * is not a time, and the window is generous because a member whose clock has
 * never been set reports something near it rather than exactly it. No real
 * MongoDB optime is within a day of 1970.
 */
const MONGO_EPOCH_WINDOW_MS = 86_400_000

export function isMongoEpoch(ms: number | null): boolean {
  return ms !== null && Math.abs(ms) < MONGO_EPOCH_WINDOW_MS
}

// ---- Failure classification -----------------------------------------------

/**
 * A MongoDB error to a status. Every code below came off a real server and is
 * in tests/fixtures/dbops/mongodb/:
 *
 *  * 13 Unauthorized — what a `read`-on-one-database user gets for
 *    `serverStatus`, `replSetGetStatus`, `$currentOp` with `allUsers: true`,
 *    anything on `local`, and `$indexStats`. `denied`.
 *  * 76 NoReplicationEnabled — `replSetGetStatus` on a mongod started without
 *    `--replSet`. It ERRORS rather than returning an empty status, and the
 *    error means the question does not apply, so it is `not-applicable`. A
 *    standalone with no replication is not an unhealthy replica set and is not
 *    a healthy one either.
 *  * 26 NamespaceNotFound — `$collStats` on `local.oplog.rs` where there is no
 *    oplog. `absent`.
 *  * 59 CommandNotFound and 40324 "Unrecognized pipeline stage name" — the
 *    server is too old for the stage. `unsupported`.
 *  * 18 AuthenticationFailed — `denied`.
 */
export function classifyMongoFailure(code: number | null | undefined, codeName: string | null | undefined, message: string): DbFailure {
  const detail = redactMongoCommandEcho((message || '').trim()) || st('shared.dbOps.failure.commandSilent')
  const name = (codeName || '').trim()
  switch (code) {
    case 13:
    case 18:
      return { status: 'denied', detail }
    case 76:
      return { status: 'not-applicable', detail }
    case 26:
      return { status: 'absent', detail }
    case 59:
    case 40324:
      return { status: 'unsupported', detail }
    default:
      break
  }
  if (name === 'Unauthorized' || name === 'AuthenticationFailed') return { status: 'denied', detail }
  if (name === 'NoReplicationEnabled') return { status: 'not-applicable', detail }
  if (name === 'NamespaceNotFound') return { status: 'absent', detail }
  if (name === 'CommandNotFound') return { status: 'unsupported', detail }
  const m = detail.toLowerCase()
  if (/not authorized|unauthorized|requires authentication/.test(m)) return { status: 'denied', detail }
  if (/unrecognized pipeline stage|no such command|command .* not found/.test(m)) return { status: 'unsupported', detail }
  return { status: 'error', detail }
}

/**
 * Cut the command MongoDB echoes back at us out of its own error text.
 *
 * An Unauthorized message reads, verbatim: `not authorized on admin to execute
 * command { replSetGetStatus: 1, lsid: { id: UUID("4fbac30f-…") }, $db:
 * "admin" }`. The first eight words are the answer; the rest is the statement
 * we sent, which the panel already knows, plus a session identifier that has no
 * business in the durable event store. The engine's own words are kept — this
 * removes only the echo of ours.
 */
export function redactMongoCommandEcho(text: string): string {
  const i = text.indexOf(' command { ')
  if (i === -1) return text
  const head = text.slice(0, i + ' command'.length)
  const first = /\{\s*([A-Za-z_$][\w$]*)\s*:/.exec(text.slice(i))
  return first ? `${head} { ${first[1]}: … }` : head
}

// ---- Parsers --------------------------------------------------------------

export function parseMongoOverview(hello: Row | undefined, buildInfo: Row | undefined, serverStatus: Row | undefined): MongoOverview | null {
  if (!hello && !buildInfo && !serverStatus) return null
  const setName = str(hello?.setName)
  const isRouter = str(hello?.msg) === 'isdbgrid'
  const primary = bool(hello?.isWritablePrimary) ?? bool(hello?.ismaster)
  const secondary = bool(hello?.secondary)
  const arbiter = bool(hello?.arbiterOnly)
  let role: MongoRole = 'unknown'
  if (isRouter) role = 'router'
  else if (!setName) role = primary === true ? 'standalone' : 'unknown'
  else if (arbiter === true) role = 'arbiter'
  else if (primary === true) role = 'primary'
  else if (secondary === true) role = 'secondary'
  const hosts = Array.isArray(hello?.hosts) ? (hello?.hosts as unknown[]) : null
  return {
    version: str(serverStatus?.version) ?? str(buildInfo?.version) ?? 'unknown',
    process: str(serverStatus?.process),
    host: str(serverStatus?.host),
    uptimeSeconds: num(serverStatus?.uptime),
    setName,
    role,
    isRouter,
    readOnly: bool(hello?.readOnly),
    memberCount: hosts ? hosts.length : null
  }
}

export function parseMongoReplication(status: Row | undefined): MongoReplicationValue {
  const rows = Array.isArray(status?.members) ? (status?.members as Row[]) : []
  // The primary's optime is the reference every lag below is measured against.
  // Taken from the member row with state 1 rather than from the top-level
  // `optimes`, because on a set with no primary there IS no reference and the
  // lag has to come back null rather than measured against a secondary.
  const primaryRow = rows.find((r) => num(r.state) === 1)
  const primaryOptime = primaryRow ? optimeOf(primaryRow).ms : null
  const members = rows.map((r) => {
    const { ms, epoch } = optimeOf(r)
    const health = num(r.health)
    const healthy = health === 1
    return {
      id: num(r._id),
      name: str(r.name) ?? 'unknown',
      state: num(r.state),
      stateStr: str(r.stateStr) ?? MONGO_MEMBER_STATES[num(r.state) ?? -1] ?? 'unknown',
      health,
      self: bool(r.self) === true,
      // A member that is not reachable reports uptime 0. That is not "started
      // this instant", so it is not carried as a measurement.
      uptimeSeconds: healthy ? num(r.uptime) : null,
      optimeMs: ms,
      optimeIsEpoch: epoch,
      lastHeartbeatMs: mongoDateMs(r.lastHeartbeat),
      heartbeatMessage: cleanHeartbeatMessage(str(r.lastHeartbeatMessage)),
      // pingMs 0 on a member that did not answer is not a round trip.
      pingMs: healthy ? num(r.pingMs) : null,
      syncSourceHost: str(r.syncSourceHost) || null,
      lagSeconds: ms !== null && primaryOptime !== null && !epoch ? Math.max(0, Math.round((primaryOptime - ms) / 1000)) : null
    }
  })
  return {
    setName: str(status?.set),
    myState: num(status?.myState),
    members,
    majorityVoteCount: num(status?.majorityVoteCount),
    healthyCount: members.filter((m) => m.health === 1 && MONGO_HEALTHY_STATES.has(m.state ?? -1)).length
  }
}

function optimeOf(r: Row): { ms: number | null; epoch: boolean } {
  const ms = mongoDateMs(r.optimeDate)
  if (ms === null) {
    // Some members report only the raw timestamp. Seconds, so × 1000.
    const ts = mongoTimestampSeconds((r.optime as Row | undefined)?.ts ?? r.optime)
    if (ts === null) return { ms: null, epoch: false }
    const fromTs = ts * 1000
    return isMongoEpoch(fromTs) ? { ms: null, epoch: true } : { ms: fromTs, epoch: false }
  }
  return isMongoEpoch(ms) ? { ms: null, epoch: true } : { ms, epoch: false }
}

function cleanHeartbeatMessage(text: string | null): string | null {
  if (!text) return null
  const trimmed = text.trim()
  if (!trimmed) return null
  // The timeout message carries the whole internal heartbeat command, with the
  // source and target host names in it, and it is 300 characters long.
  const cut = redactMongoCommandEcho(redactDbIdentifiers(trimmed).replace(/\btarget:\[[^\]]*\]/g, 'target:[<redacted>]'))
  return cut.length > 240 ? `${cut.slice(0, 240)}…` : cut
}

export function parseMongoOplog(
  first: Row[] | null,
  last: Row[] | null,
  stats: Row | undefined,
  uptimeSeconds: number | null
): MongoOplogValue {
  const firstSec = first && first.length > 0 ? mongoTimestampSeconds(first[0].ts) : null
  const lastSec = last && last.length > 0 ? mongoTimestampSeconds(last[0].ts) : null
  const storage = (stats?.storageStats ?? {}) as Row
  const windowSeconds = firstSec !== null && lastSec !== null ? Math.max(0, lastSec - firstSec) : null
  // An oplog with no entries and no stats is a server that keeps no oplog. An
  // empty `find` alone is not enough: a replica-set member that has genuinely
  // written nothing would also answer with an empty batch, and that is a
  // different fact from local.oplog.rs not existing.
  const present = (first !== null && first.length > 0) || stats !== undefined
  return {
    present,
    firstMs: firstSec === null ? null : firstSec * 1000,
    lastMs: lastSec === null ? null : lastSec * 1000,
    windowSeconds,
    uptimeSeconds,
    neverRolled:
      windowSeconds === null || uptimeSeconds === null || uptimeSeconds <= 0
        ? null
        : windowSeconds >= uptimeSeconds * T.oplogNeverRolledFraction,
    sizeBytes: num(storage.size),
    maxSizeBytes: num(storage.maxSize),
    storageBytes: num(storage.storageSize),
    count: num(storage.count)
  }
}

export function parseMongoIndexes(
  perCollection: { collection: string; rows: Row[] | null; sizes?: Record<string, unknown> }[],
  nowMs: number
): MongoIndexesValue {
  const indexes: MongoIndexUse[] = []
  const unreadable: string[] = []
  let counterAgeSeconds: number | null = null
  for (const entry of perCollection) {
    if (entry.rows === null) {
      unreadable.push(entry.collection)
      continue
    }
    for (const r of entry.rows) {
      const accesses = (r.accesses ?? {}) as Row
      const sinceMs = mongoDateMs(accesses.since)
      if (sinceMs !== null) {
        const age = Math.max(0, Math.round((nowMs - sinceMs) / 1000))
        counterAgeSeconds = counterAgeSeconds === null ? age : Math.min(counterAgeSeconds, age)
      }
      indexes.push({
        collection: entry.collection,
        name: str(r.name) ?? 'unknown',
        ops: num(accesses.ops),
        sinceMs,
        sizeBytes: num(entry.sizes?.[str(r.name) ?? ''])
      })
    }
  }
  indexes.sort((a, b) => (a.ops ?? 0) - (b.ops ?? 0))
  return { indexes, unreadable, counterAgeSeconds }
}

export function parseMongoConnections(serverStatus: Row | undefined): MongoConnectionsValue {
  const c = (serverStatus?.connections ?? {}) as Row
  const current = num(c.current)
  const available = num(c.available)
  return {
    current,
    available,
    totalCreated: num(c.totalCreated),
    rejected: num(c.rejected),
    active: num(c.active),
    ceiling: current !== null && available !== null ? current + available : null
  }
}

/**
 * Whether an operation is somebody's query rather than the server's own
 * machinery.
 *
 * All four rules below are captured, not reasoned about, in
 * tests/fixtures/dbops/mongodb/replica-set-primary.json:
 *
 *  * `op: "none"` with an empty `ns` — JournalFlusher, NoopWriter,
 *    Checkpointer. Permanently "running" on every healthy server.
 *  * a namespace under `local.` — the OplogFetcher's `getmore` on
 *    `local.oplog.rs`. It is a TAILING cursor, so on a healthy secondary it has
 *    been running for the member's entire uptime, and a long-running-operation
 *    alarm that does not exclude it fires on every replica set forever. This is
 *    the MySQL applier-thread false positive with a different name.
 *  * an `appName` the server gave itself.
 *  * this panel's own read, which is an `aggregate` against `admin.$cmd`.
 */
const MONGO_INTERNAL_APP_NAMES = new Set(['OplogFetcher', 'MongoDB Internal Client', 'NetworkInterfaceTL'])

export function isMongoClientOp(o: MongoOperation): boolean {
  return !o.internal
}

export function parseMongoCurrentOp(rows: Row[], ownOpsOnly: boolean): MongoCurrentOpValue {
  const operations = rows.map((r) => {
    const ns = str(r.ns)
    const op = str(r.op)
    const appName = str(r.appName)
    const desc = str(r.desc)
    const internal =
      op === 'none' ||
      !ns ||
      ns.startsWith('local.') ||
      ns.startsWith('admin.$cmd') ||
      (appName !== null && MONGO_INTERNAL_APP_NAMES.has(appName)) ||
      (desc !== null && !desc.startsWith('conn'))
    return {
      opid: typeof r.opid === 'number' || typeof r.opid === 'string' ? r.opid : num(r.opid),
      type: str(r.type),
      desc,
      appName,
      op,
      ns,
      secondsRunning: num(r.secs_running),
      planSummary: str(r.planSummary),
      waitingForLock: bool(r.waitingForLock),
      internal
    }
  })
  return { operations, ownOpsOnly }
}

export function parseMongoSizes(listDatabases: Row | undefined, collections: { name: string; stats: Row | null }[]): MongoSizesValue {
  const rows = Array.isArray(listDatabases?.databases) ? (listDatabases?.databases as Row[]) : []
  const databases = rows.map((r) => ({
    name: str(r.name) ?? 'unknown',
    sizeOnDiskBytes: num(r.sizeOnDisk),
    empty: bool(r.empty)
  }))
  const names = new Set(databases.map((d) => d.name))
  return {
    databases,
    collections: collections
      .filter((c) => c.stats !== null)
      .map((c) => {
        const s = (c.stats?.storageStats ?? {}) as Row
        return {
          name: c.name,
          documents: num(s.count),
          dataBytes: num(s.size),
          storageBytes: num(s.storageSize),
          indexBytes: num(s.totalIndexSize),
          indexes: num(s.nindexes)
        }
      })
      .sort((a, b) => (b.storageBytes ?? 0) - (a.storageBytes ?? 0)),
    totalBytes: num(listDatabases?.totalSize),
    databasesFiltered: rows.length > 0 && !names.has('admin') && !names.has('local')
  }
}

export function parseMongoAsserts(serverStatus: Row | undefined): MongoAssertsValue {
  const a = (serverStatus?.asserts ?? {}) as Row
  const extra = (serverStatus?.extra_info ?? {}) as Row
  return {
    regular: num(a.regular),
    warning: num(a.warning),
    msg: num(a.msg),
    user: num(a.user),
    rollovers: num(a.rollovers),
    pageFaults: num(extra.page_faults),
    pageFaultsReported: 'page_faults' in extra,
    uptimeSeconds: num(serverStatus?.uptime)
  }
}

// ---- Judgements -----------------------------------------------------------

export function judgeMongoReplication(v: MongoReplicationValue): DbVerdict {
  if (v.members.length === 0) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.mongo.replication.noMembers.headline'),
      because: st('shared.dbOps.mongo.replication.noMembers.because')
    }
  }

  const broken = v.members.filter((m) => m.health !== 1 || !MONGO_HEALTHY_STATES.has(m.state ?? -1))
  if (broken.length > 0) {
    const worst = broken[0]
    const stale = broken.filter((m) => m.optimeIsEpoch)
    const list = broken.map((m) => st('shared.dbOps.mongo.replication.memberState', { name: m.name, state: m.stateStr })).join(', ')
    return {
      level: 'alarm',
      headline:
        broken.length === 1
          ? st('shared.dbOps.mongo.replication.brokenOne', { name: worst.name, list })
          : st('shared.dbOps.mongo.replication.brokenMany', { members: broken.length, list }),
      because:
        (worst.heartbeatMessage ? `${worst.heartbeatMessage} ` : '') +
        (stale.length > 0
          ? st('shared.dbOps.mongo.replication.brokenEpoch')
          : st('shared.dbOps.mongo.replication.brokenNotReplicating'))
    }
  }

  if (!v.members.some((m) => m.state === 1)) {
    return {
      level: 'alarm',
      headline: st('shared.dbOps.mongo.replication.noPrimary.headline'),
      because: st('shared.dbOps.mongo.replication.noPrimary.because')
    }
  }

  const voting = v.majorityVoteCount
  if (voting !== null && v.healthyCount < voting) {
    return {
      level: 'alarm',
      headline: st('shared.dbOps.mongo.replication.noMajority.headline', { healthy: v.healthyCount, voting }),
      because: st('shared.dbOps.mongo.replication.noMajority.because')
    }
  }

  const lags = v.members.filter((m) => !m.self && m.lagSeconds !== null)
  const worst = lags.reduce<MongoMember | null>((a, b) => (a === null || (b.lagSeconds ?? 0) > (a.lagSeconds ?? 0) ? b : a), null)
  const behind = worst?.lagSeconds ?? 0
  if (worst && behind >= T.replicaLagAlarmSeconds) {
    return {
      level: 'alarm',
      headline: st('shared.dbOps.mongo.replication.behind.headline', { name: worst.name, lag: formatSeconds(behind) }),
      because: st('shared.dbOps.mongo.replication.behind.because')
    }
  }
  if (worst && behind >= T.replicaLagWatchSeconds) {
    return { level: 'watch', headline: st('shared.dbOps.mongo.replication.behind.headline', { name: worst.name, lag: formatSeconds(behind) }) }
  }
  const healthy = worst
    ? st('shared.dbOps.mongo.replication.allHealthyLag', { members: v.members.length, lag: formatSeconds(behind) })
    : st('shared.dbOps.mongo.replication.allHealthy', { members: v.members.length })
  return {
    level: 'ok',
    headline: v.setName ? st('shared.dbOps.mongo.replication.setPrefix', { set: v.setName, headline: healthy }) : healthy,
    because: v.members.map((m) => `${m.name} ${m.stateStr}`).join(', ')
  }
}

export function judgeMongoOplog(v: MongoOplogValue): DbVerdict {
  if (!v.present) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.mongo.oplog.absent.headline'),
      because: st('shared.dbOps.mongo.oplog.absent.because')
    }
  }
  if (v.windowSeconds === null) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.mongo.oplog.unmeasured.headline'),
      because: st('shared.dbOps.mongo.oplog.unmeasured.because')
    }
  }

  const window = formatSeconds(v.windowSeconds)
  const fill =
    v.maxSizeBytes && v.sizeBytes !== null
      ? ` ${st('shared.dbOps.mongo.oplog.fill', { entries: formatCount(v.count), bytes: formatBytes(v.sizeBytes), max: formatBytes(v.maxSizeBytes) })}`
      : ''

  // The distinction the whole question exists for. Both fixtures report a small
  // number; only one of them is a small window.
  if (v.neverRolled === true) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.mongo.oplog.neverRolled.headline', { window, uptime: formatSeconds(v.uptimeSeconds) }),
      because: st('shared.dbOps.mongo.oplog.neverRolled.because') + fill
    }
  }

  if (v.windowSeconds < T.oplogWindowAlarmSeconds) {
    return {
      level: 'alarm',
      headline: st('shared.dbOps.mongo.oplog.short.headline', { window }),
      because: st('shared.dbOps.mongo.oplog.short.because', { uptime: formatSeconds(v.uptimeSeconds), window }) + fill
    }
  }
  if (v.windowSeconds < T.oplogWindowWatchSeconds) {
    return {
      level: 'watch',
      headline: st('shared.dbOps.mongo.oplog.covers', { window }),
      because: st('shared.dbOps.mongo.oplog.belowADay') + fill
    }
  }
  return { level: 'ok', headline: st('shared.dbOps.mongo.oplog.covers', { window }), because: st('shared.dbOps.mongo.oplog.ok') + fill }
}

export function judgeMongoIndexes(v: MongoIndexesValue): DbVerdict {
  if (v.indexes.length === 0) {
    return {
      level: 'unknown',
      headline:
        v.unreadable.length > 0
          ? st('shared.dbOps.mongo.indexes.unreadable.headline', { collections: v.unreadable.length })
          : st('shared.dbOps.mongo.indexes.noStats'),
      because:
        v.unreadable.length > 0
          ? st('shared.dbOps.mongo.indexes.unreadable.because', { list: v.unreadable.join(', ') })
          : st('shared.dbOps.mongo.indexes.noCollections')
    }
  }

  // _id_ is out of BOTH sides of the ratio. It cannot be dropped, so counting
  // it as an index that might be is a sentence the operator cannot act on.
  const droppable = v.indexes.filter((i) => i.name !== '_id_')
  const unused = droppable.filter((i) => i.ops === 0)
  const age = v.counterAgeSeconds

  // The counters reset when the server restarts, so "zero accesses" is only a
  // claim about the time since then. Below the threshold the honest answer is
  // that the question has not been answered yet.
  if (age !== null && age < T.indexUnusedMinCounterAgeSeconds) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.mongo.indexes.countersYoung.headline', {
        unused: unused.length,
        droppable: droppable.length,
        age: formatSeconds(age)
      }),
      because: st('shared.dbOps.mongo.indexes.countersYoung.because', { minAge: formatSeconds(T.indexUnusedMinCounterAgeSeconds) })
    }
  }

  if (unused.length === 0) {
    return {
      level: 'ok',
      headline:
        age !== null
          ? st('shared.dbOps.mongo.indexes.allUsedFor', { droppable: droppable.length, age: formatSeconds(age) })
          : st('shared.dbOps.mongo.indexes.allUsed', { droppable: droppable.length })
    }
  }
  const bytes = unused.reduce((a, i) => a + (i.sizeBytes ?? 0), 0)
  const vars = { unused: unused.length, droppable: droppable.length, age: formatSeconds(age), bytes: formatBytes(bytes) }
  const unusedKey: MessageKey =
    age !== null
      ? bytes > 0 ? 'shared.dbOps.mongo.indexes.unused.ageBytes' : 'shared.dbOps.mongo.indexes.unused.age'
      : bytes > 0 ? 'shared.dbOps.mongo.indexes.unused.bytes' : 'shared.dbOps.mongo.indexes.unused.plain'
  return {
    level: 'watch',
    headline: st(unusedKey, vars),
    because: st('shared.dbOps.mongo.indexes.unused.because', {
      list: unused
        .slice(0, 6)
        .map((i) => `${i.collection}.${i.name}`)
        .join(', ')
    })
  }
}

export function judgeMongoConnections(v: MongoConnectionsValue): DbVerdict {
  if (v.rejected !== null && v.rejected > 0) {
    return {
      level: 'alarm',
      headline: st('shared.dbOps.mongo.connections.rejected.headline', { rejected: formatCount(v.rejected) }),
      because: st('shared.dbOps.mongo.connections.rejected.because')
    }
  }
  if (v.current === null || v.ceiling === null || v.ceiling <= 0) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.mongo.connections.noCeiling.headline'),
      because: st('shared.dbOps.mongo.connections.noCeiling.because')
    }
  }
  const used = v.current / v.ceiling
  const sentence = st('shared.dbOps.mongo.connections.usage', { current: formatCount(v.current), ceiling: formatCount(v.ceiling) })
  if (used >= T.connectionsAlarmFraction) {
    return { level: 'alarm', headline: sentence, because: st('shared.dbOps.mongo.connections.nearCeiling') }
  }
  if (used >= T.connectionsWatchFraction) return { level: 'watch', headline: sentence }
  return {
    level: 'ok',
    headline: sentence,
    because: v.active !== null ? st('shared.dbOps.mongo.connections.active', { active: formatCount(v.active) }) : undefined
  }
}

export function judgeMongoCurrentOp(v: MongoCurrentOpValue): DbVerdict {
  const client = v.operations.filter(isMongoClientOp)
  const longest = client.reduce<MongoOperation | null>((a, b) => (a === null || (b.secondsRunning ?? 0) > (a.secondsRunning ?? 0) ? b : a), null)
  const seconds = longest?.secondsRunning ?? 0

  if (v.ownOpsOnly) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.mongo.currentop.ownOnly.headline', { ops: client.length }),
      because: st('shared.dbOps.mongo.currentop.ownOnly.because')
    }
  }
  if (client.length === 0) {
    return {
      level: 'ok',
      headline: st('shared.dbOps.mongo.currentop.idle.headline'),
      because: st('shared.dbOps.mongo.currentop.idle.because', { internal: v.operations.length - client.length })
    }
  }
  if (seconds >= T.longQueryAlarmSeconds) {
    return {
      level: 'alarm',
      headline: st('shared.dbOps.mongo.currentop.longRunning', {
        age: formatSeconds(seconds),
        ns: longest?.ns ?? st('shared.dbOps.mongo.currentop.unknownNamespace')
      }),
      because: st('shared.dbOps.mongo.currentop.noKill', {
        op: `${longest?.op ?? 'op'}${longest?.planSummary ? `, ${longest.planSummary}` : ''}`
      })
    }
  }
  if (seconds >= T.longQueryWatchSeconds) {
    return {
      level: 'watch',
      headline: st('shared.dbOps.mongo.currentop.longRunning', {
        age: formatSeconds(seconds),
        ns: longest?.ns ?? st('shared.dbOps.mongo.currentop.unknownNamespace')
      })
    }
  }
  return { level: 'ok', headline: st('shared.dbOps.mongo.currentop.ok', { ops: client.length, age: formatSeconds(seconds) }) }
}

export function judgeMongoSizes(v: MongoSizesValue): DbVerdict {
  const total = v.totalBytes
  const biggest = v.collections[0]
  const tail = biggest
    ? ` ${st('shared.dbOps.mongo.sizes.largest', { name: biggest.name, bytes: formatBytes(biggest.storageBytes) })}`
    : ''
  if (v.databasesFiltered) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.mongo.sizes.filtered.headline', { bytes: formatBytes(total), databases: v.databases.length }),
      because: st('shared.dbOps.mongo.sizes.filtered.because') + tail
    }
  }
  return {
    level: 'ok',
    headline: st('shared.dbOps.mongo.sizes.ok', { bytes: formatBytes(total), databases: v.databases.length }),
    because: tail || undefined
  }
}

export function judgeMongoAsserts(v: MongoAssertsValue): DbVerdict {
  const rate = (n: number | null): string =>
    n !== null && v.uptimeSeconds ? ` ${st('shared.dbOps.mongo.asserts.perHour', { rate: (n / (v.uptimeSeconds / 3600)).toFixed(1) })}` : ''
  if ((v.regular ?? 0) > 0 || (v.msg ?? 0) > 0) {
    return {
      level: 'alarm',
      headline: st('shared.dbOps.mongo.asserts.fired.headline', {
        asserts: formatCount((v.regular ?? 0) + (v.msg ?? 0)),
        rate: rate((v.regular ?? 0) + (v.msg ?? 0))
      }),
      because: st('shared.dbOps.mongo.asserts.fired.because')
    }
  }
  if ((v.rollovers ?? 0) > 0) {
    return {
      level: 'watch',
      headline: st('shared.dbOps.mongo.asserts.rolledOver.headline', { rollovers: formatCount(v.rollovers) }),
      because: st('shared.dbOps.mongo.asserts.rolledOver.because')
    }
  }
  const faults = v.pageFaultsReported
    ? ` ${st('shared.dbOps.mongo.asserts.pageFaults', { faults: formatCount(v.pageFaults), rate: rate(v.pageFaults) })}`
    : ` ${st('shared.dbOps.mongo.asserts.pageFaultsUnreported')}`
  return {
    level: 'ok',
    headline:
      v.user !== null
        ? st('shared.dbOps.mongo.asserts.noneWithUser', { user: formatCount(v.user) })
        : st('shared.dbOps.mongo.asserts.none'),
    because: (v.user !== null && v.user > 0 ? st('shared.dbOps.mongo.asserts.userNormal') : '') + faults
  }
}

// ---------------------------------------------------------------------------
// Live monitoring
// ---------------------------------------------------------------------------
//
// The Operations tab above answers eight questions once, when somebody presses
// a button. This is the other half: a handful of numbers, sampled on a timer,
// that say what the server is DOING right now. Compass calls it the
// performance tab.
//
// The trap here is a single one and it is fatal: `opcounters`, `network.bytesIn`
// and every counter under `top` are MONOTONIC TOTALS SINCE STARTUP. A server up
// for three weeks reports `opcounters.query: 91043771`, and a panel that prints
// that beside the word "queries" has told the operator nothing about now and
// something false about the last minute. Every one of them is a delta between
// two samples divided by the seconds between them, and where there is no
// previous sample, or the previous sample is from before a restart, the rate is
// NULL rather than the total and never zero.

/** The six counters `opcounters` and `opcountersRepl` carry, in the order
 *  Compass lists them. */
export const MONGO_OPCOUNTERS = ['insert', 'query', 'update', 'delete', 'getmore', 'command'] as const
export type MongoOpCounter = (typeof MONGO_OPCOUNTERS)[number]

/**
 * What the live panel asks for, and it is NOT what MONGO_COMMANDS asks for.
 *
 * MONGO_COMMANDS.serverStatus switches `globalLock`, `network` and
 * `opcountersRepl` OFF, because none of the eight questions reads them. They
 * are three quarters of this panel — active/queued readers and writers, bytes
 * on the wire, and how much of the write load is replication. So the same
 * trimmed document is asked for again with those three turned back on, spread
 * from the original rather than retyped so the thirty-odd sections neither one
 * wants cannot drift apart.
 *
 * `top` is per-collection activity since startup, admin-only, and the source of
 * the hottest-collections list. In-flight operations come from
 * mongoCurrentOpCommand(), which already exists.
 */
export const MONGO_MONITOR_COMMANDS = Object.freeze({
  serverStatus: {
    db: 'admin',
    command: { ...MONGO_COMMANDS.serverStatus.command, globalLock: 1, network: 1, opcountersRepl: 1 }
  },
  top: { db: 'admin', command: { top: 1 } }
})

/** One reading of the whole live surface. Every field is nullable because
 *  `serverStatus` sections come and go by version, storage engine and platform,
 *  and an absent section is not a zeroed one. */
export interface MongoMonitorSample {
  /** When this app received the reply. Used as the denominator, rather than the
   *  server's own clock, because the two need not agree and only one of them is
   *  measuring the interval between two of OUR requests. */
  atMs: number
  /** `serverStatus().uptime`. The restart detector — see mongoMonitorRates. */
  uptimeSeconds: number | null
  opcounters: Record<MongoOpCounter, number | null>
  replOpcounters: Record<MongoOpCounter, number | null>
  /** `globalLock.activeClients` / `globalLock.currentQueue` — gauges, not
   *  counters, so these are true as they stand and are not differenced. */
  activeReads: number | null
  activeWrites: number | null
  queuedReads: number | null
  queuedWrites: number | null
  bytesIn: number | null
  bytesOut: number | null
  numRequests: number | null
  connectionsCurrent: number | null
  connectionsAvailable: number | null
  /** `mem.virtual` / `mem.resident`, which serverStatus reports in MEGABYTES.
   *  Converted to bytes here so formatBytes can be used like everywhere else. */
  memVirtualBytes: number | null
  memResidentBytes: number | null
}

export interface MongoMonitorRates {
  /** The measured interval, which is what the numbers below are per. Shown, so
   *  nobody has to trust that it was the configured one. */
  windowSeconds: number
  opsPerSec: Record<MongoOpCounter, number | null>
  replOpsPerSec: Record<MongoOpCounter, number | null>
  bytesInPerSec: number | null
  bytesOutPerSec: number | null
  requestsPerSec: number | null
}

const ZERO_COUNTERS = (): Record<MongoOpCounter, number | null> =>
  Object.fromEntries(MONGO_OPCOUNTERS.map((k) => [k, null])) as Record<MongoOpCounter, number | null>

function counters(section: unknown): Record<MongoOpCounter, number | null> {
  const o = (section ?? {}) as Row
  return Object.fromEntries(MONGO_OPCOUNTERS.map((k) => [k, num(o[k])])) as Record<MongoOpCounter, number | null>
}

export function parseMongoMonitorSample(serverStatus: Row | undefined, atMs: number): MongoMonitorSample {
  const lock = (serverStatus?.globalLock ?? {}) as Row
  const active = (lock.activeClients ?? {}) as Row
  const queue = (lock.currentQueue ?? {}) as Row
  const net = (serverStatus?.network ?? {}) as Row
  const conn = (serverStatus?.connections ?? {}) as Row
  const mem = (serverStatus?.mem ?? {}) as Row
  const mb = (v: unknown): number | null => {
    const n = num(v)
    return n === null ? null : n * 1024 * 1024
  }
  return {
    atMs,
    uptimeSeconds: num(serverStatus?.uptime),
    opcounters: serverStatus ? counters(serverStatus.opcounters) : ZERO_COUNTERS(),
    replOpcounters: serverStatus ? counters(serverStatus.opcountersRepl) : ZERO_COUNTERS(),
    activeReads: num(active.readers),
    activeWrites: num(active.writers),
    queuedReads: num(queue.readers),
    queuedWrites: num(queue.writers),
    bytesIn: num(net.bytesIn),
    bytesOut: num(net.bytesOut),
    numRequests: num(net.numRequests),
    connectionsCurrent: num(conn.current),
    connectionsAvailable: num(conn.available),
    memVirtualBytes: mb(mem.virtual),
    memResidentBytes: mb(mem.resident)
  }
}

/**
 * One counter's rate, or null.
 *
 * Null for four different reasons, and collapsing any of them to zero is the
 * bug: either end absent, or the counter went BACKWARDS. A counter that fell
 * means the server restarted between the two samples — the totals began again
 * from zero, the difference is a large negative number, and `Math.max(0, ...)`
 * would report a dead quiet minute on a server that had just come back up.
 */
function perSecond(before: number | null, after: number | null, seconds: number): number | null {
  if (before === null || after === null || after < before) return null
  return (after - before) / seconds
}

/**
 * The rates between two samples, or null when there is no honest window.
 *
 * Null when the samples are not in order, when no measurable time passed, or
 * when the server restarted between them (its uptime went backwards, which is
 * the only signal that says so directly — every counter below it also resets,
 * but a counter that merely stood still is indistinguishable from an idle one).
 */
export function mongoMonitorRates(prev: MongoMonitorSample, next: MongoMonitorSample): MongoMonitorRates | null {
  const seconds = (next.atMs - prev.atMs) / 1000
  if (!(seconds > 0)) return null
  if (prev.uptimeSeconds !== null && next.uptimeSeconds !== null && next.uptimeSeconds < prev.uptimeSeconds) return null
  const rates = (a: Record<MongoOpCounter, number | null>, b: Record<MongoOpCounter, number | null>): Record<MongoOpCounter, number | null> =>
    Object.fromEntries(MONGO_OPCOUNTERS.map((k) => [k, perSecond(a[k], b[k], seconds)])) as Record<MongoOpCounter, number | null>
  return {
    windowSeconds: seconds,
    opsPerSec: rates(prev.opcounters, next.opcounters),
    replOpsPerSec: rates(prev.replOpcounters, next.replOpcounters),
    bytesInPerSec: perSecond(prev.bytesIn, next.bytesIn, seconds),
    bytesOutPerSec: perSecond(prev.bytesOut, next.bytesOut, seconds),
    requestsPerSec: perSecond(prev.numRequests, next.numRequests, seconds)
  }
}

/** One namespace's totals out of `top`, in microseconds and counts since the
 *  server started. Differenced by mongoTopRates, never shown raw. */
export interface MongoTopEntry {
  ns: string
  atMs: number
  /** `total.count` — every operation of every kind against this namespace. */
  count: number | null
  /** `total.time`, microseconds of server time spent in them. */
  micros: number | null
  readCount: number | null
  writeCount: number | null
}

/**
 * `top`'s reply to a list of namespaces.
 *
 * `totals` is a map keyed by namespace with ONE key that is not a namespace:
 * `note`, a string of prose telling the reader the numbers are cumulative. It
 * is skipped by shape rather than by name — anything that is not an object with
 * a `total` is not a namespace — so a future sibling of `note` cannot arrive as
 * a row called "note" with every column empty.
 */
export function parseMongoTop(reply: Row | undefined, atMs: number): MongoTopEntry[] {
  const totals = (reply?.totals ?? {}) as Row
  const out: MongoTopEntry[] = []
  for (const [ns, raw] of Object.entries(totals)) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Row
    const total = r.total as Row | undefined
    if (!total || typeof total !== 'object') continue
    const sum = (...keys: string[]): number | null => {
      let acc: number | null = null
      for (const k of keys) {
        const n = num((r[k] as Row | undefined)?.count)
        if (n === null) continue
        acc = (acc ?? 0) + n
      }
      return acc
    }
    out.push({
      ns,
      atMs,
      count: num(total.count),
      micros: num(total.time),
      readCount: sum('queries', 'getmore'),
      writeCount: sum('insert', 'update', 'remove')
    })
  }
  return out
}

export interface MongoTopRate {
  ns: string
  opsPerSec: number
  readsPerSec: number | null
  writesPerSec: number | null
  /** Mean server time per operation over the window, in milliseconds. Null
   *  when nothing ran — a mean of no operations is not zero. */
  meanMs: number | null
}

/**
 * The hottest namespaces over one window, busiest first.
 *
 * Namespaces absent from `prev` are skipped rather than counted from zero: a
 * collection first seen in this sample has an unknown history, and treating its
 * lifetime total as one window's work puts a three-week-old collection at the
 * top of the list the moment the panel is opened.
 */
export function mongoTopRates(prev: MongoTopEntry[], next: MongoTopEntry[], seconds: number): MongoTopRate[] {
  if (!(seconds > 0)) return []
  const before = new Map(prev.map((e) => [e.ns, e]))
  const out: MongoTopRate[] = []
  for (const e of next) {
    const b = before.get(e.ns)
    if (!b) continue
    const ops = perSecond(b.count, e.count, seconds)
    if (ops === null) continue
    const micros = perSecond(b.micros, e.micros, seconds)
    out.push({
      ns: e.ns,
      opsPerSec: ops,
      readsPerSec: perSecond(b.readCount, e.readCount, seconds),
      writesPerSec: perSecond(b.writeCount, e.writeCount, seconds),
      meanMs: micros === null || ops <= 0 ? null : micros / ops / 1000
    })
  }
  return out.sort((a, b) => b.opsPerSec - a.opsPerSec)
}

// ===========================================================================
// Redis
// ===========================================================================
//
// Redis answers almost everything with ONE BLOB. `INFO memory` is a hundred
// lines of `key:value` under a `# Memory` header, and the single most important
// thing about it is what a missing line means, which is not zero.
//
//   maxmemory:0         the field is there and the answer is "no limit"
//   (no maxclients)     the field is not there because this is Redis 5
//
// Those are as different as an answer and a refusal, and every reader below
// goes through infoNum(), which returns null for absent and the number for
// present — never `Number(x) || 0`. tests/fixtures/dbops/redis/redis-5.json is
// the evidence: `maxclients` is genuinely missing from `INFO clients` on
// 5.0.14, and thirty-seven `INFO stats` fields do not exist there either.
//
// Redis errors carry no numeric code at all, so classifyRedisFailure below
// matches the leading token of the message. That is not a shortcut — the token
// IS the protocol: `NOPERM`, `WRONGPASS`, `NOAUTH`, `ERR`.

export interface RedisInfo {
  /** Every `key:value` line that was present, in the order Redis emitted them.
   *  A key that is NOT here was not in the reply — the distinction the whole
   *  section is built on. */
  fields: Record<string, string>
  /** The `# Name` headers, so the collector can tell "this section was empty"
   *  from "this section was never requested". */
  sections: string[]
}

export interface RedisOverview {
  version: string
  mode: string | null
  role: string | null
  uptimeSeconds: number | null
  os: string | null
  /** `INFO cluster`'s `cluster_enabled`. Null when the field was absent. */
  clusterEnabled: boolean | null
}

export interface RedisMemoryValue {
  usedBytes: number | null
  rssBytes: number | null
  peakBytes: number | null
  /**
   * `maxmemory`. ZERO IS A REAL ANSWER and means unlimited; null means the
   * field was not in the reply. Collapsing the two turns "this instance will
   * grow until the machine dies" and "this server is too old to say" into the
   * same green tick.
   */
  maxmemoryBytes: number | null
  maxmemoryReported: boolean
  policy: string | null
  fragmentationRatio: number | null
  /** used/maxmemory, or null when there is no limit to be a fraction of. */
  usedFraction: number | null
}

export interface RedisPersistenceValue {
  rdbLastSaveMs: number | null
  rdbLastSaveAgeSeconds: number | null
  rdbChangesSinceLastSave: number | null
  rdbLastBgsaveStatus: string | null
  rdbBgsaveInProgress: boolean | null
  aofEnabled: boolean | null
  aofLastWriteStatus: string | null
  aofLastBgrewriteStatus: string | null
  aofRewriteFailures: number | null
  loading: boolean | null
}

export interface RedisReplicaLink {
  ip: string | null
  port: number | null
  state: string | null
  offsetBytes: number | null
  lagSeconds: number | null
}

export interface RedisReplicationValue {
  role: string | null
  connectedReplicas: number | null
  replicas: RedisReplicaLink[]
  masterHost: string | null
  masterLinkStatus: string | null
  /**
   * Seconds since this replica last heard from its master, or null.
   *
   * NULL when Redis reported -1, which is its sentinel for "there is no
   * measurement" and is what a replica with a down link reports. Carried
   * through as a number it is either a negative duration on screen or, after
   * the Math.max(0, …) somebody will eventually add, "last heard from 0 seconds
   * ago" on a replica that has heard nothing at all. Captured:
   * tests/fixtures/dbops/redis/replica-link-down.json.
   */
  masterLastIoSeconds: number | null
  masterLastIoSentinel: boolean
  linkDownSeconds: number | null
  masterReplOffset: number | null
  replicaReplOffset: number | null
  syncInProgress: boolean | null
}

export interface RedisSlowEntry {
  id: number | null
  atMs: number | null
  microseconds: number | null
  /** The command name and how many arguments followed it. The argument VALUES
   *  are not kept: a slowlog entry is `SET session:… <the session token>`, and
   *  this panel writes its output into a durable event store. */
  command: string
  argumentCount: number
  clientAddr: string | null
}

export interface RedisSlowlogValue {
  entries: RedisSlowEntry[]
  length: number | null
  /** `slowlog-log-slower-than`. Negative disables the log; zero logs
   *  everything, including this panel's own reads. */
  thresholdMicroseconds: number | null
  maxLength: number | null
}

export interface RedisClientsValue {
  connected: number | null
  blocked: number | null
  tracking: number | null
  /** Absent on Redis 5 and earlier. See RedisMemoryValue.maxmemoryReported. */
  maxclients: number | null
  maxclientsReported: boolean
  usedFraction: number | null
}

export interface RedisKeyspaceDb {
  name: string
  keys: number | null
  expires: number | null
  avgTtlMs: number | null
}

export interface RedisKeyspaceValue {
  databases: RedisKeyspaceDb[]
  totalKeys: number | null
  totalExpires: number | null
  /** `DBSIZE`, which is the database this connection is actually pointed at
   *  and is O(1). `KEYS` is not sent here and will not be. */
  selectedDbKeys: number | null
}

export interface RedisStatsValue {
  rejectedConnections: number | null
  evictedKeys: number | null
  expiredKeys: number | null
  keyspaceHits: number | null
  keyspaceMisses: number | null
  hitRate: number | null
  totalConnectionsReceived: number | null
  uptimeSeconds: number | null
}

export interface RedisClusterValue {
  enabled: boolean | null
  state: string | null
  slotsAssigned: number | null
  slotsOk: number | null
  slotsPfail: number | null
  slotsFail: number | null
  knownNodes: number | null
  size: number | null
}

// ---- Commands -------------------------------------------------------------

/**
 * Every command this feature sends to Redis, frozen, as argv.
 *
 * Twelve reads and one of them is a `CONFIG GET`, which deserves its own
 * sentence because `CONFIG` is one word away from the most destructive thing on
 * this list. `CONFIG GET slowlog-*` is here because without it the slow log
 * cannot be interpreted at all: an empty log means "nothing was slow" if the
 * threshold is 10 ms and means nothing whatsoever if it is 10 seconds or
 * negative. `CONFIG SET` is not sent, is not built, and is asserted absent in
 * tests/dbOpsRegressions.test.ts.
 *
 * `DBSIZE` and not `KEYS`. `KEYS *` on a production Redis blocks the single
 * command thread for the length of a full keyspace scan, which is an outage
 * caused by a monitoring page. `SCAN` is not here either: a cursor loop over
 * millions of keys is the same cost paid in instalments.
 */
export const REDIS_COMMANDS = Object.freeze({
  infoServer: ['INFO', 'server'],
  infoMemory: ['INFO', 'memory'],
  infoPersistence: ['INFO', 'persistence'],
  infoReplication: ['INFO', 'replication'],
  infoClients: ['INFO', 'clients'],
  infoStats: ['INFO', 'stats'],
  infoKeyspace: ['INFO', 'keyspace'],
  infoCluster: ['INFO', 'cluster'],
  clusterInfo: ['CLUSTER', 'INFO'],
  configSlowlog: ['CONFIG', 'GET', 'slowlog-*'],
  slowlogLen: ['SLOWLOG', 'LEN'],
  dbsize: ['DBSIZE']
})

/** `SLOWLOG GET <n>`, built rather than frozen because n is the row limit the
 *  collector chooses. Validated for the same reason the timeout builders are. */
export function redisSlowlogGetCommand(limit: number): string[] {
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0 || limit > 1000) {
    throw new Error(`Refusing to build SLOWLOG GET with a count of ${JSON.stringify(limit)}: expected a positive integer no greater than 1000.`)
  }
  return ['SLOWLOG', 'GET', String(limit)]
}

export const REDIS_COMMAND_BUILDERS: (() => string[])[] = [() => redisSlowlogGetCommand(20)]

// ---- The INFO parser ------------------------------------------------------

/**
 * One `INFO` reply to fields and section names.
 *
 * CRLF, because Redis uses `\r\n` and a `split('\n')` leaves a carriage return
 * on the end of every value — which makes `maxmemory_policy` compare unequal to
 * `'noeviction'` while looking identical in a log.
 *
 * The value is split on the FIRST colon only. `slave0` and the keyspace lines
 * carry structured values with colons and equals signs inside them, and
 * `master_replid` is a hex string; splitting on every colon corrupts all three.
 */
export function parseRedisInfo(text: string | null | undefined): RedisInfo {
  const fields: Record<string, string> = {}
  const sections: string[] = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('#')) {
      const name = line.slice(1).trim()
      if (name) sections.push(name)
      continue
    }
    const i = line.indexOf(':')
    if (i <= 0) continue
    fields[line.slice(0, i)] = line.slice(i + 1)
  }
  return { fields, sections }
}

/** Several INFO replies as one. Later replies win, which never matters because
 *  the sections do not overlap — except `connected_slaves`, which `INFO
 *  replication` is the only source of. */
export function mergeRedisInfo(...infos: (RedisInfo | null | undefined)[]): RedisInfo {
  const fields: Record<string, string> = {}
  const sections: string[] = []
  for (const info of infos) {
    if (!info) continue
    Object.assign(fields, info.fields)
    for (const s of info.sections) if (!sections.includes(s)) sections.push(s)
  }
  return { fields, sections }
}

export function infoHas(info: RedisInfo, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(info.fields, key)
}

export function infoStr(info: RedisInfo, key: string): string | null {
  return infoHas(info, key) ? info.fields[key] : null
}

/** The number, or null. Null for absent AND for a value that is not a number —
 *  never zero for either. */
export function infoNum(info: RedisInfo, key: string): number | null {
  return infoHas(info, key) ? num(info.fields[key]) : null
}

export function infoBool(info: RedisInfo, key: string): boolean | null {
  return infoHas(info, key) ? bool(info.fields[key]) : null
}

/**
 * `slave0:ip=172.23.0.6,port=6379,state=online,offset=226642,lag=0` to a record.
 *
 * Also what the keyspace lines are — `db0:keys=5800,expires=800,avg_ttl=…` —
 * so it is used for both.
 */
export function parseRedisPairs(value: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of String(value ?? '').split(',')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

/**
 * A `CONFIG GET` reply to a map.
 *
 * Read as a flat pair list and never by index, because the order is not
 * stable: `CONFIG GET slowlog-*` answers `[slowlog-max-len, 128,
 * slowlog-log-slower-than, 10000]` on Redis 7 and
 * `[slowlog-log-slower-than, 10000, slowlog-max-len, 128]` on Redis 5. Both
 * captured, in the same directory.
 */
export function parseRedisConfig(reply: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!Array.isArray(reply)) return out
  for (let i = 0; i + 1 < reply.length; i += 2) {
    const k = str(reply[i])
    const v = str(reply[i + 1])
    if (k !== null && v !== null) out[k] = v
  }
  return out
}

// ---- Failure classification -----------------------------------------------

/**
 * A Redis error to a status. There is no numeric code — the leading token of
 * the message is the protocol, and every string below came off a real server:
 *
 *  * `NOPERM User app has no permissions to run the 'info' command` — an ACL
 *    user. THIRTEEN of thirteen commands fail this way in
 *    tests/fixtures/dbops/redis/acl-denied.json, with no partial data and no
 *    empty reply. `denied`, never absent.
 *  * `WRONGPASS invalid username-password pair or user is disabled` and
 *    `NOAUTH Authentication required` — `denied`.
 *  * `ERR This instance has cluster support disabled` — `CLUSTER INFO` on a
 *    non-cluster instance, identical on 5.0.14 and 7.4.7. `absent`: the feature
 *    is off, which is a first-class answer.
 *  * `ERR unknown command` — a command this server version does not have.
 *    `unsupported`.
 *  * `LOADING Redis is loading the dataset in memory` — a real, temporary
 *    state, and reporting it as an error with the server's own words is
 *    correct: nothing here can be answered yet.
 */
export function classifyRedisFailure(message: string): DbFailure {
  const detail = (message || '').trim() || st('shared.dbOps.failure.commandSilent')
  if (/^NOPERM\b/.test(detail)) return { status: 'denied', detail }
  if (/^(NOAUTH|WRONGPASS)\b/.test(detail)) return { status: 'denied', detail }
  if (/cluster support disabled/i.test(detail)) return { status: 'absent', detail }
  if (/^ERR unknown command/i.test(detail) || /unknown subcommand/i.test(detail)) return { status: 'unsupported', detail }
  if (/^ERR unknown parameter/i.test(detail)) return { status: 'unsupported', detail }
  return { status: 'error', detail }
}

// ---- Parsers --------------------------------------------------------------

export function parseRedisOverview(info: RedisInfo): RedisOverview {
  return {
    version: infoStr(info, 'redis_version') ?? 'unknown',
    mode: infoStr(info, 'redis_mode'),
    role: infoStr(info, 'role'),
    uptimeSeconds: infoNum(info, 'uptime_in_seconds'),
    os: infoStr(info, 'os'),
    clusterEnabled: infoBool(info, 'cluster_enabled')
  }
}

export function parseRedisMemory(info: RedisInfo): RedisMemoryValue {
  const used = infoNum(info, 'used_memory')
  const max = infoNum(info, 'maxmemory')
  return {
    usedBytes: used,
    rssBytes: infoNum(info, 'used_memory_rss'),
    peakBytes: infoNum(info, 'used_memory_peak'),
    maxmemoryBytes: max,
    maxmemoryReported: infoHas(info, 'maxmemory'),
    policy: infoStr(info, 'maxmemory_policy'),
    fragmentationRatio: infoNum(info, 'mem_fragmentation_ratio'),
    // Not a fraction of zero. Zero means unlimited, so there is nothing to be a
    // fraction OF, and 0/0 is the shape that renders as NaN% on a dashboard.
    usedFraction: used !== null && max !== null && max > 0 ? used / max : null
  }
}

export function parseRedisPersistence(info: RedisInfo, nowMs: number): RedisPersistenceValue {
  const saveSeconds = infoNum(info, 'rdb_last_save_time')
  const saveMs = saveSeconds === null ? null : saveSeconds * 1000
  return {
    rdbLastSaveMs: saveMs,
    rdbLastSaveAgeSeconds: saveMs === null ? null : Math.max(0, Math.round((nowMs - saveMs) / 1000)),
    rdbChangesSinceLastSave: infoNum(info, 'rdb_changes_since_last_save'),
    rdbLastBgsaveStatus: infoStr(info, 'rdb_last_bgsave_status'),
    rdbBgsaveInProgress: infoBool(info, 'rdb_bgsave_in_progress'),
    aofEnabled: infoBool(info, 'aof_enabled'),
    aofLastWriteStatus: infoStr(info, 'aof_last_write_status'),
    aofLastBgrewriteStatus: infoStr(info, 'aof_last_bgrewrite_status'),
    aofRewriteFailures: infoNum(info, 'aof_rewrites_consecutive_failures'),
    loading: infoBool(info, 'loading')
  }
}

export function parseRedisReplication(info: RedisInfo): RedisReplicationValue {
  const replicas: RedisReplicaLink[] = []
  for (const [key, value] of Object.entries(info.fields)) {
    if (!/^slave\d+$/.test(key)) continue
    const p = parseRedisPairs(value)
    replicas.push({
      ip: p.ip ?? null,
      port: num(p.port),
      state: p.state ?? null,
      offsetBytes: num(p.offset),
      lagSeconds: num(p.lag)
    })
  }
  const lastIo = infoNum(info, 'master_last_io_seconds_ago')
  const sentinel = lastIo !== null && lastIo < 0
  return {
    role: infoStr(info, 'role'),
    connectedReplicas: infoNum(info, 'connected_slaves'),
    replicas,
    masterHost: infoStr(info, 'master_host'),
    masterLinkStatus: infoStr(info, 'master_link_status'),
    masterLastIoSeconds: sentinel ? null : lastIo,
    masterLastIoSentinel: sentinel,
    linkDownSeconds: infoNum(info, 'master_link_down_since_seconds'),
    masterReplOffset: infoNum(info, 'master_repl_offset'),
    replicaReplOffset: infoNum(info, 'slave_repl_offset'),
    syncInProgress: infoBool(info, 'master_sync_in_progress')
  }
}

/**
 * `SLOWLOG GET` rows to entries.
 *
 * Each row is a positional array — `[id, unixSeconds, microseconds, argv,
 * clientAddr, clientName]` — so it is read by index, which is safe here and not
 * in `CONFIG GET` because this shape is part of the protocol rather than a
 * hash rendered as a list.
 *
 * `argv` is dropped after the command NAME. A real entry reads
 * `["SET", "session:8f2…", "<the token>"]`, and this panel's output is shown on
 * screen AND written into the durable event store. The command name and the
 * argument COUNT answer "which command is slow"; the values only answer "whose
 * data was it".
 *
 * The name is two tokens for the container commands, because that is what Redis
 * itself calls them — its own ACL error names `'slowlog|get'`, not `'slowlog'`.
 * Everywhere else argv[1] is data: keeping it turned the captured `EVAL` entry
 * into eighty characters of somebody's Lua script.
 */
export function parseRedisSlowlog(rows: unknown, config: Record<string, string>, length: number | null): RedisSlowlogValue {
  const entries: RedisSlowEntry[] = []
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (!Array.isArray(row)) continue
      const argv = Array.isArray(row[3]) ? (row[3] as unknown[]) : []
      const at = num(row[1])
      entries.push({
        id: num(row[0]),
        atMs: at === null ? null : at * 1000,
        microseconds: num(row[2]),
        command: redisCommandName(argv),
        argumentCount: Math.max(0, argv.length - 1),
        clientAddr: redactDbIdentifiers(str(row[4]) ?? '') || null
      })
    }
  }
  entries.sort((a, b) => (b.microseconds ?? 0) - (a.microseconds ?? 0))
  return {
    entries,
    length,
    thresholdMicroseconds: 'slowlog-log-slower-than' in config ? num(config['slowlog-log-slower-than']) : null,
    maxLength: 'slowlog-max-len' in config ? num(config['slowlog-max-len']) : null
  }
}

/**
 * Redis's own name for a command, from its argv.
 *
 * Two tokens for a container command and one for everything else. Uppercased
 * because a client may send either case and `SET` and `set` are the same
 * command; truncated because a name is a name.
 */
const REDIS_CONTAINER_COMMANDS = new Set([
  'ACL',
  'CLIENT',
  'CLUSTER',
  'COMMAND',
  'CONFIG',
  'FUNCTION',
  'LATENCY',
  'MEMORY',
  'OBJECT',
  'PUBSUB',
  'SCRIPT',
  'SLOWLOG',
  'XGROUP',
  'XINFO'
])

export function redisCommandName(argv: unknown[]): string {
  const head = (str(argv[0]) ?? '').trim().slice(0, 24).toUpperCase()
  if (!REDIS_CONTAINER_COMMANDS.has(head)) return head
  const sub = (str(argv[1]) ?? '').trim().slice(0, 24).toUpperCase()
  return sub ? `${head} ${sub}` : head
}

export function parseRedisClients(info: RedisInfo): RedisClientsValue {
  const connected = infoNum(info, 'connected_clients')
  const max = infoNum(info, 'maxclients')
  return {
    connected,
    blocked: infoNum(info, 'blocked_clients'),
    tracking: infoNum(info, 'tracking_clients'),
    maxclients: max,
    maxclientsReported: infoHas(info, 'maxclients'),
    usedFraction: connected !== null && max !== null && max > 0 ? connected / max : null
  }
}

export function parseRedisKeyspace(info: RedisInfo, selectedDbKeys: number | null): RedisKeyspaceValue {
  const databases: RedisKeyspaceDb[] = []
  for (const [key, value] of Object.entries(info.fields)) {
    if (!/^db\d+$/.test(key)) continue
    const p = parseRedisPairs(value)
    databases.push({ name: key, keys: num(p.keys), expires: num(p.expires), avgTtlMs: num(p.avg_ttl) })
  }
  databases.sort((a, b) => a.name.localeCompare(b.name, 'en'))
  // Absence here genuinely IS zero: Redis omits a database from INFO keyspace
  // when it holds no keys, and an empty instance answers with the bare
  // `# Keyspace` header. Captured on redis:5. That is the one place in this
  // file where a missing line is a zero, and it is missing for a reason the
  // protocol states rather than because the server is too old to say.
  const known = databases.length > 0 || info.sections.includes('Keyspace')
  return {
    databases,
    totalKeys: known ? databases.reduce((a, d) => a + (d.keys ?? 0), 0) : null,
    totalExpires: known ? databases.reduce((a, d) => a + (d.expires ?? 0), 0) : null,
    selectedDbKeys
  }
}

export function parseRedisStats(info: RedisInfo): RedisStatsValue {
  const hits = infoNum(info, 'keyspace_hits')
  const misses = infoNum(info, 'keyspace_misses')
  return {
    rejectedConnections: infoNum(info, 'rejected_connections'),
    evictedKeys: infoNum(info, 'evicted_keys'),
    expiredKeys: infoNum(info, 'expired_keys'),
    keyspaceHits: hits,
    keyspaceMisses: misses,
    hitRate: hits !== null && misses !== null && hits + misses > 0 ? hits / (hits + misses) : null,
    totalConnectionsReceived: infoNum(info, 'total_connections_received'),
    uptimeSeconds: infoNum(info, 'uptime_in_seconds')
  }
}

export function parseRedisCluster(info: RedisInfo, clusterInfo: RedisInfo | null): RedisClusterValue {
  const c = clusterInfo ?? { fields: {}, sections: [] }
  return {
    enabled: infoBool(info, 'cluster_enabled'),
    state: infoStr(c, 'cluster_state'),
    slotsAssigned: infoNum(c, 'cluster_slots_assigned'),
    slotsOk: infoNum(c, 'cluster_slots_ok'),
    slotsPfail: infoNum(c, 'cluster_slots_pfail'),
    slotsFail: infoNum(c, 'cluster_slots_fail'),
    knownNodes: infoNum(c, 'cluster_known_nodes'),
    size: infoNum(c, 'cluster_size')
  }
}

// ---- Judgements -----------------------------------------------------------

export function judgeRedisMemory(v: RedisMemoryValue): DbVerdict {
  if (!v.maxmemoryReported) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.redis.memory.noLimitReported.headline', { used: formatBytes(v.usedBytes) }),
      because: st('shared.dbOps.redis.memory.noLimitReported.because')
    }
  }
  if (v.maxmemoryBytes === 0) {
    return {
      level: 'watch',
      headline: st('shared.dbOps.redis.memory.unlimited.headline', { used: formatBytes(v.usedBytes) }),
      because: st('shared.dbOps.redis.memory.unlimited.because')
    }
  }
  if (v.usedFraction === null) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.redis.memory.unmeasured.headline'),
      because: st('shared.dbOps.redis.memory.unmeasured.because')
    }
  }

  const pct = `${(v.usedFraction * 100).toFixed(1)}%`
  const sentence = v.policy !== null
    ? st('shared.dbOps.redis.memory.usage', { used: formatBytes(v.usedBytes), max: formatBytes(v.maxmemoryBytes), pct, policy: v.policy })
    : st('shared.dbOps.redis.memory.usageNoPolicy', { used: formatBytes(v.usedBytes), max: formatBytes(v.maxmemoryBytes), pct })
  const noEviction = v.policy === 'noeviction'

  if (noEviction && v.usedFraction >= T.redisMemoryAlarmFraction) {
    return {
      level: 'alarm',
      headline: sentence,
      because: st('shared.dbOps.redis.memory.noEvictionFull')
    }
  }
  if (v.usedFraction >= 1) {
    return { level: 'alarm', headline: sentence, because: st('shared.dbOps.redis.memory.overLimit') }
  }
  if (v.usedFraction >= T.redisMemoryAlarmFraction) {
    return { level: 'alarm', headline: sentence, because: st('shared.dbOps.redis.memory.evicting', { policy: String(v.policy) }) }
  }
  if (v.usedFraction >= T.redisMemoryWatchFraction) {
    return { level: 'watch', headline: sentence, because: noEviction ? st('shared.dbOps.redis.memory.noEvictionNear') : undefined }
  }
  return {
    level: 'ok',
    headline: sentence,
    because: v.fragmentationRatio !== null && v.fragmentationRatio > T.redisFragmentationWatchRatio
      ? st('shared.dbOps.redis.memory.fragmentation', { ratio: v.fragmentationRatio.toFixed(2) })
      : undefined
  }
}

export function judgeRedisPersistence(v: RedisPersistenceValue): DbVerdict {
  if (v.loading === true) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.redis.persistence.loading.headline'),
      because: st('shared.dbOps.redis.persistence.loading.because')
    }
  }
  if (v.rdbLastBgsaveStatus !== null && v.rdbLastBgsaveStatus !== 'ok') {
    return {
      level: 'alarm',
      headline: st('shared.dbOps.redis.persistence.rdbFailed.headline', { status: v.rdbLastBgsaveStatus }),
      because: st('shared.dbOps.redis.persistence.rdbFailed.because')
    }
  }
  if (v.aofEnabled === true && v.aofLastWriteStatus !== null && v.aofLastWriteStatus !== 'ok') {
    return {
      level: 'alarm',
      headline: st('shared.dbOps.redis.persistence.aofFailed.headline', { status: v.aofLastWriteStatus }),
      because: st('shared.dbOps.redis.persistence.aofFailed.because')
    }
  }
  if (v.aofEnabled === false && v.rdbLastSaveAgeSeconds === null) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.redis.persistence.unreadable.headline'),
      because: st('shared.dbOps.redis.persistence.unreadable.because')
    }
  }
  if (v.aofEnabled === false) {
    const age = v.rdbLastSaveAgeSeconds ?? 0
    const pending = v.rdbChangesSinceLastSave ?? 0
    const sentence = st('shared.dbOps.redis.persistence.rdbOnly', { age: formatSeconds(age), changes: formatCount(pending) })
    if (pending > 0 && age >= T.redisRdbStaleAlarmSeconds) {
      return { level: 'alarm', headline: sentence, because: st('shared.dbOps.redis.persistence.rdbStaleAlarm') }
    }
    if (pending > 0 && age >= T.redisRdbStaleWatchSeconds) {
      return { level: 'watch', headline: sentence, because: st('shared.dbOps.redis.persistence.rdbStaleWatch') }
    }
    return { level: 'ok', headline: sentence }
  }
  if (v.aofRewriteFailures !== null && v.aofRewriteFailures > 0) {
    return {
      level: 'watch',
      headline: st('shared.dbOps.redis.persistence.rewriteFailed.headline', { failures: formatCount(v.aofRewriteFailures) }),
      because: st('shared.dbOps.redis.persistence.rewriteFailed.because')
    }
  }
  return {
    level: 'ok',
    headline:
      v.aofLastWriteStatus !== null
        ? st('shared.dbOps.redis.persistence.aofOn', { status: v.aofLastWriteStatus })
        : st('shared.dbOps.redis.persistence.aofOnUnreported'),
    because:
      v.rdbLastSaveAgeSeconds !== null
        ? st('shared.dbOps.redis.persistence.lastRdbSave', { age: formatSeconds(v.rdbLastSaveAgeSeconds) })
        : undefined
  }
}

export function judgeRedisReplication(v: RedisReplicationValue): DbVerdict {
  if (v.role === 'slave' || v.role === 'replica') {
    if (v.masterLinkStatus !== 'up') {
      const status = v.masterLinkStatus ?? st('shared.dbOps.redis.notReported')
      return {
        level: 'alarm',
        headline:
          v.linkDownSeconds !== null
            ? st('shared.dbOps.redis.replication.lostMaster.headlineAgo', { age: formatSeconds(v.linkDownSeconds), status })
            : st('shared.dbOps.redis.replication.lostMaster.headline', { status }),
        because: v.masterLastIoSentinel
          ? st('shared.dbOps.redis.replication.lostMaster.becauseSentinel')
          : st('shared.dbOps.redis.replication.lostMaster.because')
      }
    }
    if (v.syncInProgress === true) {
      return {
        level: 'watch',
        headline: st('shared.dbOps.redis.replication.resyncing.headline'),
        because: st('shared.dbOps.redis.replication.resyncing.because')
      }
    }
    const io = v.masterLastIoSeconds
    const sentence = st('shared.dbOps.redis.replication.replicating', {
      master: v.masterHost ?? st('shared.dbOps.redis.replication.itsMaster'),
      age: io === null ? st('shared.dbOps.redis.replication.unreportedTime') : formatSeconds(io)
    })
    if (io !== null && io >= T.replicaLagAlarmSeconds) {
      return { level: 'alarm', headline: sentence, because: st('shared.dbOps.redis.replication.silentLink') }
    }
    if (io !== null && io >= T.replicaLagWatchSeconds) return { level: 'watch', headline: sentence }
    return {
      level: 'ok',
      headline: sentence,
      because:
        v.replicaReplOffset !== null
          ? st('shared.dbOps.redis.replication.atOffset', { offset: formatCount(v.replicaReplOffset) })
          : undefined
    }
  }

  const count = v.connectedReplicas
  if (count === null) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.redis.replication.roleUnreadable.headline'),
      because: st('shared.dbOps.redis.replication.roleUnreadable.because')
    }
  }
  if (count === 0) {
    // The trap this question is written around. It cannot be resolved from INFO
    // and is therefore not guessed at.
    return {
      level: 'unknown',
      headline: st('shared.dbOps.redis.replication.noReplicas.headline'),
      because: st('shared.dbOps.redis.replication.noReplicas.because')
    }
  }
  const offline = v.replicas.filter((r) => r.state !== 'online')
  if (offline.length > 0) {
    return {
      level: 'alarm',
      headline: st('shared.dbOps.redis.replication.offline.headline', {
        offline: offline.length,
        total: count,
        states: offline.map((r) => r.state ?? st('shared.dbOps.redis.replication.noState')).join(', ')
      }),
      because: st('shared.dbOps.redis.replication.offline.because')
    }
  }
  const laggiest = v.replicas.reduce<RedisReplicaLink | null>((a, b) => (a === null || (b.lagSeconds ?? 0) > (a.lagSeconds ?? 0) ? b : a), null)
  const lag = laggiest?.lagSeconds ?? 0
  if (lag >= T.replicaLagWatchSeconds) {
    return { level: 'watch', headline: st('shared.dbOps.redis.replication.lagging', { replicas: count, lag: formatSeconds(lag) }) }
  }
  const gaps = v.replicas
    .map((r) => (v.masterReplOffset !== null && r.offsetBytes !== null ? v.masterReplOffset - r.offsetBytes : null))
    .filter((n): n is number => n !== null)
  return {
    level: 'ok',
    headline: st('shared.dbOps.redis.replication.ok', { replicas: count }),
    because: gaps.length > 0 ? st('shared.dbOps.redis.replication.furthestBehind', { bytes: formatBytes(Math.max(...gaps)) }) : undefined
  }
}

export function judgeRedisSlowlog(v: RedisSlowlogValue): DbVerdict {
  const threshold = v.thresholdMicroseconds
  if (threshold === null) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.redis.slowlog.noThreshold.headline', { entries: formatCount(v.length) }),
      because: st('shared.dbOps.redis.slowlog.noThreshold.because')
    }
  }
  if (threshold < 0) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.redis.slowlog.off.headline'),
      because: st('shared.dbOps.redis.slowlog.off.because')
    }
  }
  if (threshold === 0) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.redis.slowlog.everything.headline'),
      because: st('shared.dbOps.redis.slowlog.everything.because')
    }
  }

  const slowest = v.entries[0]
  const full = v.maxLength !== null && v.length !== null && v.length >= v.maxLength
  const rolled = full ? ` ${st('shared.dbOps.redis.slowlog.rolled', { max: formatCount(v.maxLength) })}` : ''
  const thresholdMs = threshold / 1000
  const held = st('shared.dbOps.redis.slowlog.held', { entries: formatCount(v.length) }) + rolled

  if (v.entries.length === 0) {
    return {
      level: 'ok',
      headline: st('shared.dbOps.redis.slowlog.empty', { threshold: thresholdMs.toFixed(0) }),
      because: held
    }
  }
  const micros = slowest.microseconds ?? 0
  const sentence = st('shared.dbOps.redis.slowlog.slowest', {
    command: slowest.command || st('shared.dbOps.format.unknown'),
    ms: (micros / 1000).toFixed(0),
    threshold: thresholdMs.toFixed(0)
  })
  if (micros >= T.redisSlowCommandAlarmMicroseconds) {
    return {
      level: 'alarm',
      headline: sentence,
      because: st('shared.dbOps.redis.slowlog.blockedEveryone', { held })
    }
  }
  if (micros >= T.redisSlowCommandWatchMicroseconds) {
    return { level: 'watch', headline: sentence, because: held }
  }
  return { level: 'ok', headline: sentence, because: held }
}

export function judgeRedisClients(v: RedisClientsValue): DbVerdict {
  const blocked =
    v.blocked !== null && v.blocked > 0 ? ` ${st('shared.dbOps.redis.clients.blocked', { blocked: formatCount(v.blocked) })}` : ''
  if (!v.maxclientsReported) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.redis.clients.noCeiling.headline', { connected: formatCount(v.connected) }),
      because: st('shared.dbOps.redis.clients.noCeiling.because') + blocked
    }
  }
  if (v.usedFraction === null) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.redis.clients.unreadable.headline'),
      because: st('shared.dbOps.redis.clients.unreadable.because')
    }
  }
  const sentence = st('shared.dbOps.redis.clients.usage', { connected: formatCount(v.connected), max: formatCount(v.maxclients) })
  if (v.usedFraction >= T.connectionsAlarmFraction) {
    return { level: 'alarm', headline: sentence, because: st('shared.dbOps.redis.clients.atCeiling') + blocked }
  }
  if (v.usedFraction >= T.connectionsWatchFraction) return { level: 'watch', headline: sentence, because: blocked || undefined }
  return { level: 'ok', headline: sentence, because: blocked || undefined }
}

export function judgeRedisKeyspace(v: RedisKeyspaceValue, policy: string | null): DbVerdict {
  if (v.totalKeys === null) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.redis.keyspace.unreadable.headline'),
      because: st('shared.dbOps.redis.keyspace.unreadable.because')
    }
  }
  if (v.totalKeys === 0) {
    return {
      level: 'ok',
      headline: st('shared.dbOps.redis.keyspace.empty.headline'),
      because: st('shared.dbOps.redis.keyspace.empty.because')
    }
  }
  const withoutTtl = v.totalKeys - (v.totalExpires ?? 0)
  const sentence = st('shared.dbOps.redis.keyspace.summary', {
    keys: formatCount(v.totalKeys),
    databases: v.databases.length,
    expiring: formatCount(v.totalExpires)
  })
  // The combination that fills an instance: keys that never expire under a
  // policy that never evicts.
  if (policy === 'noeviction' && withoutTtl > 0 && (v.totalExpires ?? 0) / v.totalKeys < T.redisNoTtlWatchFraction) {
    return {
      level: 'watch',
      headline: sentence,
      because: st('shared.dbOps.redis.keyspace.noTtl', { keys: formatCount(withoutTtl) })
    }
  }
  return {
    level: 'ok',
    headline: sentence,
    because: v.selectedDbKeys !== null ? st('shared.dbOps.redis.keyspace.selectedDb', { keys: formatCount(v.selectedDbKeys) }) : undefined
  }
}

export function judgeRedisStats(v: RedisStatsValue): DbVerdict {
  if (v.rejectedConnections !== null && v.rejectedConnections > 0) {
    return {
      level: 'alarm',
      headline: st('shared.dbOps.redis.stats.refused.headline', { refused: formatCount(v.rejectedConnections) }),
      because: st('shared.dbOps.redis.stats.refused.because')
    }
  }
  if (v.evictedKeys !== null && v.evictedKeys > 0) {
    return {
      level: 'watch',
      headline: st('shared.dbOps.redis.stats.evicted.headline', { evicted: formatCount(v.evictedKeys) }),
      because: st('shared.dbOps.redis.stats.evicted.because')
    }
  }
  if (v.rejectedConnections === null && v.evictedKeys === null) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.redis.stats.unreported.headline'),
      because: st('shared.dbOps.redis.stats.unreported.because')
    }
  }
  return {
    level: 'ok',
    headline: st('shared.dbOps.redis.stats.ok'),
    because:
      (v.hitRate !== null ? `${st('shared.dbOps.redis.stats.hitRate', { pct: (v.hitRate * 100).toFixed(1) })} ` : '') +
      (v.expiredKeys !== null ? st('shared.dbOps.redis.stats.expired', { expired: formatCount(v.expiredKeys) }) : '')
  }
}

export function judgeRedisCluster(v: RedisClusterValue): DbVerdict {
  if (v.enabled === null) {
    return {
      level: 'unknown',
      headline: st('shared.dbOps.redis.cluster.unreadable.headline'),
      because: st('shared.dbOps.redis.cluster.unreadable.because')
    }
  }
  if (v.enabled === false) {
    return {
      level: 'ok',
      headline: st('shared.dbOps.redis.cluster.off.headline'),
      because: st('shared.dbOps.redis.cluster.off.because')
    }
  }
  if (v.state !== null && v.state !== 'ok') {
    return {
      level: 'alarm',
      headline: st('shared.dbOps.redis.cluster.state.headline', { state: v.state }),
      because: st('shared.dbOps.redis.cluster.state.because')
    }
  }
  if (v.slotsAssigned !== null && v.slotsAssigned < 16384) {
    return {
      level: 'alarm',
      headline: st('shared.dbOps.redis.cluster.slots.headline', { assigned: formatCount(v.slotsAssigned) }),
      because: st('shared.dbOps.redis.cluster.slots.because')
    }
  }
  return {
    level: 'ok',
    headline: st('shared.dbOps.redis.cluster.ok.headline', { nodes: formatCount(v.knownNodes) }),
    because:
      v.slotsFail !== null || v.slotsPfail !== null
        ? st('shared.dbOps.redis.cluster.ok.because', { failed: formatCount(v.slotsFail), pfailed: formatCount(v.slotsPfail) })
        : undefined
  }
}

// ===========================================================================
// The report
// ===========================================================================

export interface DbOpsReport {
  ok: boolean
  /** Set only when the connection itself failed. Individual questions failing
   *  is normal and is reported per answer. */
  error?: string
  engine: DbOpsEngine
  connectionId: string
  at: number
  elapsedMs: number
  /** In the order they should be read. */
  answers: DbAnswer<unknown>[]
}

export type DbOpsEngine = 'postgres' | 'mysql' | 'mongodb' | 'redis' | 'mssql'

/**
 * Which engines this feature covers.
 *
 * MongoDB and Redis were held back from the first pass rather than half-built,
 * because they answer completely different questions and a thin imitation of
 * the SQL page would have been worse than no page. They have their own
 * questions now — replica-set state and oplog window; eviction policy,
 * persistence and the link to a master. SQL Server is still out.
 */
export function supportsDbOps(kind: string): kind is DbOpsEngine {
  return (
    kind === 'postgres' ||
    kind === 'mysql' ||
    kind === 'mongodb' ||
    kind === 'redis' ||
    kind === 'mssql'
  )
}

export const DB_OPS_UNSUPPORTED_NOTE =
  'Operational reads are available for PostgreSQL, MySQL/MariaDB, MongoDB, Redis and SQL Server. ' +
  'Every engine this app can connect to is now covered, so this note is kept for the next engine ' +
  'rather than for a gap that exists today.'

/** The questions asked of each engine, in the order they should be read. */
export const DB_QUESTIONS_BY_ENGINE: Record<DbOpsEngine, readonly DbQuestionId[]> = {
  postgres: PG_QUESTIONS,
  mysql: MYSQL_QUESTIONS,
  mongodb: MONGO_QUESTIONS,
  redis: REDIS_QUESTIONS,
  mssql: MSSQL_QUESTIONS
}

/** The worst verdict on the page, which is the one the tab badge shows. */
export function worstVerdict(answers: DbAnswer<unknown>[]): DbVerdictLevel {
  let worst: DbVerdictLevel = 'ok'
  for (const a of answers) {
    if (DB_VERDICT_RANK[a.verdict.level] > DB_VERDICT_RANK[worst]) worst = a.verdict.level
  }
  return worst
}

/**
 * The states worth remembering.
 *
 * Item A's store (src/main/services/history.ts) already has recordEvent, and
 * item 19b will alert off it. This function decides WHAT is worth a row; it
 * does not write one and it does not alert. Two rules:
 *
 *  * Only `alarm` and `watch`. An `ok` every sixty seconds is a log nobody
 *    reads and a table that grows forever.
 *  * `unknown` is excluded even though it is not `ok`, with one exception:
 *    a question that went from answerable to `denied` is itself an event —
 *    someone changed a grant — but OpsMaxx cannot see the transition from a
 *    single read, so that belongs to whoever compares two reads, not here.
 */
export function notableDbEvents(report: DbOpsReport): { kind: string; payload: Record<string, unknown> }[] {
  const out: { kind: string; payload: Record<string, unknown> }[] = []
  for (const a of report.answers) {
    if (a.verdict.level !== 'alarm' && a.verdict.level !== 'watch') continue
    out.push({
      kind: `db-${a.verdict.level}`,
      payload: {
        connectionId: report.connectionId,
        engine: report.engine,
        question: a.id,
        status: a.status,
        level: a.verdict.level,
        headline: a.verdict.headline,
        because: a.verdict.because,
        metrics: dbEventMetrics(a)
      }
    })
  }
  return out
}

/**
 * The numbers behind a verdict, for whoever alerts off it.
 *
 * A rule of the shape "alert when lag exceeds N" needs a number. Without this
 * the payload is prose, and the only way to express such a rule is a regular
 * expression over an English sentence — which breaks the first time a headline
 * is reworded. The numbers are cheap to add now and a schema migration to add
 * later.
 *
 * Item 19b does NOT read them, and that is deliberate rather than an oversight
 * to be tidied up: it alerts at the levels this file already decided, because
 * an alert that re-derived a verdict could disagree with the screen item 18
 * renders. These are carried for a rule that does not exist yet.
 *
 * Only finite numbers go in. A metric that is null is omitted rather than
 * written as 0, for the same reason `num()` refuses to: an absent measurement
 * and a measurement of zero are the whole subject of this file.
 */
export function dbEventMetrics(a: DbAnswer<unknown>): Record<string, number> {
  const out: Record<string, number> = {}
  const put = (k: string, n: number | null | undefined): void => {
    if (typeof n === 'number' && Number.isFinite(n)) out[k] = n
  }
  const v = a.value as Record<string, unknown> | undefined
  switch (a.id) {
    case 'replication': {
      if (Array.isArray(v)) {
        // MySQL: worst channel.
        const channels = v as MysqlReplicationChannel[]
        put('channels', channels.length)
        const behind = channels.map((c) => c.secondsBehind).filter((n): n is number => n !== null)
        if (behind.length > 0) put('secondsBehind', Math.max(...behind))
        put('channelsStopped', channels.filter((c) => c.ioRunning !== 'Yes' || c.sqlRunning !== 'Yes').length)
      } else if (v && (v as unknown as PgReplicationValue).role === 'standby') {
        const st = v as unknown as PgReplicationStandby
        put('secondsBehind', st.replayAgeSeconds)
        put('applyLagBytes', st.applyLagBytes)
      } else if (v && 'members' in v) {
        // MongoDB: the set, and the member furthest behind.
        const rs = v as unknown as MongoReplicationValue
        put('members', rs.members.length)
        put('healthyMembers', rs.healthyCount)
        put('membersDown', rs.members.filter((m) => m.health !== 1).length)
        const lags = rs.members.map((m) => m.lagSeconds).filter((n): n is number => n !== null)
        if (lags.length > 0) put('secondsBehind', Math.max(...lags))
      } else if (v && 'masterLinkStatus' in v) {
        // Redis. `linkUp` and not `secondsBehind`: a replica cannot measure how
        // far behind it is from INFO, and inventing the number for a rule to
        // read would be the same lie the panel refuses to tell.
        const rr = v as unknown as RedisReplicationValue
        put('connectedReplicas', rr.connectedReplicas)
        put('replicas', rr.replicas.length)
        put('linkUp', rr.masterLinkStatus === null ? 0 : rr.masterLinkStatus === 'up' ? 1 : 0)
        put('masterLastIoSeconds', rr.masterLastIoSeconds)
        put('linkDownSeconds', rr.linkDownSeconds)
      } else if (v && (v as unknown as PgReplicationValue).role === 'primary') {
        const replicas = (v as unknown as PgReplicationPrimary).replicas
        put('replicas', replicas.length)
        put('replicasRedacted', replicas.filter((r) => r.redacted).length)
        const lags = replicas.map((r) => r.replayLagSeconds).filter((n): n is number => n !== null)
        if (lags.length > 0) put('secondsBehind', Math.max(...lags))
      }
      break
    }
    case 'archiver': {
      const ar = v as unknown as PgArchiver | undefined
      put('failedCount', ar?.failedCount)
      put('archivedCount', ar?.archivedCount)
      put('lastFailedAgeSeconds', ar?.lastFailedAgeSeconds)
      break
    }
    case 'autovacuum': {
      const va = v as unknown as PgVacuumValue | undefined
      const worst = (va?.tables ?? []).reduce<number | null>((m, t) => (t.xidAge !== null && t.xidAge > (m ?? -1) ? t.xidAge : m), null)
      put('xidAge', worst)
      put('freezeMaxAge', va?.freezeMaxAge)
      if (worst !== null && va) put('freezeFraction', worst / va.freezeMaxAge)
      if (worst !== null) put('wraparoundFraction', worst / PG_WRAPAROUND_XID_LIMIT)
      const db = (va?.databases ?? []).reduce<number | null>((m, d) => (d.xidAge !== null && d.xidAge > (m ?? -1) ? d.xidAge : m), null)
      put('databaseXidAge', db)
      break
    }
    case 'connections': {
      if (v && 'ceiling' in v) {
        const c = v as unknown as MongoConnectionsValue
        put('used', c.current)
        put('maxConnections', c.ceiling)
        put('refused', c.rejected)
        if (c.current !== null && c.ceiling !== null && c.ceiling > 0) put('usedFraction', c.current / c.ceiling)
      } else if (v && 'usableConnections' in v) {
        const c = v as unknown as PgConnectionsValue
        put('used', c.used)
        put('maxConnections', c.maxConnections)
        put('usableConnections', c.usableConnections)
        put('redactedCount', c.redactedCount)
        if (c.usableConnections > 0) put('usedFraction', c.used / c.usableConnections)
      } else if (v) {
        const c = v as unknown as MysqlConnectionsValue
        put('used', c.threadsConnected)
        put('maxConnections', c.maxConnections)
        put('refused', c.connectionErrorsMaxConnections)
        put('highWaterMark', c.maxUsedConnections)
        if (c.maxConnections > 0 && c.threadsConnected !== null) put('usedFraction', c.threadsConnected / c.maxConnections)
      }
      break
    }
    case 'locks': {
      const locks = (Array.isArray(v) ? v : []) as PgLock[]
      // BLOCKED rows only. The query also returns the sessions doing the
      // blocking, which are not themselves waiting -- counting them would
      // inflate this metric by one per chain, silently, in a stored series.
      const blocked = locks.filter((l) => l.blockedBy.length > 0)
      put('blockedSessions', blocked.length)
      const waits = blocked.map((l) => l.waitingSeconds).filter((n): n is number => n !== null)
      if (waits.length > 0) put('longestWaitSeconds', Math.max(...waits))
      put('redactedSessions', locks.filter((l) => l.redacted).length)
      break
    }
    case 'sizes': {
      if (v && 'collections' in v) {
        const sz = v as unknown as MongoSizesValue
        put('totalBytes', sz.totalBytes)
        put('databases', sz.databases.length)
        put('collections', sz.collections.length)
        put('largestCollectionBytes', sz.collections[0]?.storageBytes)
        put('databasesFiltered', sz.databasesFiltered ? 1 : 0)
      } else if (v && 'databases' in v) {
        const sz = v as unknown as PgSizesValue
        put('totalBytes', sz.databases.reduce((acc, d) => acc + (d.totalBytes ?? 0), 0))
        put('largestTableBytes', sz.tables[0]?.totalBytes)
      } else if (v) {
        const sz = v as unknown as MysqlSizesValue
        put('totalBytes', sz.totalBytes)
        put('tables', sz.tables.length)
      }
      break
    }
    case 'statements': {
      const st = v as unknown as PgStatementsValue | undefined
      put('statements', st?.statements.length)
      put('redactedCount', st?.redactedCount)
      put('slowestMeanMs', st?.statements[0]?.meanExecMs)
      break
    }
    case 'binlogs': {
      const b = v as unknown as MysqlBinlogsValue | undefined
      put('totalBytes', b?.totalBytes)
      put('files', b?.files.length)
      put('expireSeconds', b?.expireSeconds)
      break
    }
    case 'slowlog': {
      if (v && 'entries' in v) {
        const rs = v as unknown as RedisSlowlogValue
        put('entries', rs.length)
        put('thresholdMicroseconds', rs.thresholdMicroseconds)
        put('slowestMicroseconds', rs.entries[0]?.microseconds)
        break
      }
      const sl = v as unknown as MysqlSlowLogValue | undefined
      put('slowQueries', sl?.slowQueries)
      put('longQueryTimeSeconds', sl?.longQueryTimeSeconds)
      put('uptimeSeconds', sl?.uptimeSeconds)
      break
    }
    case 'processlist': {
      const pl = v as unknown as MysqlProcesslistValue | undefined
      put('visible', pl?.visible)
      put('threadsConnected', pl?.threadsConnected)
      const running = (pl?.processes ?? []).filter(isClientQuery)
      put('running', running.length)
      const secs = running.map((r) => r.seconds).filter((n): n is number => n !== null)
      if (secs.length > 0) put('longestSeconds', Math.max(...secs))
      break
    }
    case 'bufferpool': {
      const bp = v as unknown as MysqlBufferPoolValue | undefined
      put('hitRate', bp?.hitRate)
      put('readRequests', bp?.readRequests)
      put('reads', bp?.reads)
      put('sizeBytes', bp?.sizeBytes)
      break
    }
    case 'oplog': {
      const op = v as unknown as MongoOplogValue | undefined
      put('windowSeconds', op?.windowSeconds)
      put('uptimeSeconds', op?.uptimeSeconds)
      put('maxSizeBytes', op?.maxSizeBytes)
      // A boolean matters to a rule as much as a number does — "alert when the
      // window is under an hour AND it is a real window" is unwriteable without
      // it — so it is carried as 1/0 rather than left out for being a flag.
      if (op?.neverRolled !== null && op?.neverRolled !== undefined) put('neverRolled', op.neverRolled ? 1 : 0)
      break
    }
    case 'indexes': {
      const ix = v as unknown as MongoIndexesValue | undefined
      put('indexes', ix?.indexes.length)
      put('droppable', ix?.indexes.filter((i) => i.name !== '_id_').length)
      put('unused', ix?.indexes.filter((i) => i.ops === 0 && i.name !== '_id_').length)
      put('unreadableCollections', ix?.unreadable.length)
      put('counterAgeSeconds', ix?.counterAgeSeconds)
      break
    }
    case 'currentop': {
      const co = v as unknown as MongoCurrentOpValue | undefined
      const client = (co?.operations ?? []).filter(isMongoClientOp)
      put('running', client.length)
      put('internal', (co?.operations.length ?? 0) - client.length)
      const secs = client.map((o) => o.secondsRunning).filter((n): n is number => n !== null)
      if (secs.length > 0) put('longestSeconds', Math.max(...secs))
      if (co) put('ownOpsOnly', co.ownOpsOnly ? 1 : 0)
      break
    }
    case 'asserts': {
      const as = v as unknown as MongoAssertsValue | undefined
      put('regular', as?.regular)
      put('msg', as?.msg)
      put('user', as?.user)
      put('rollovers', as?.rollovers)
      // Omitted rather than zeroed when the platform does not report it.
      put('pageFaults', as?.pageFaultsReported ? as.pageFaults : null)
      break
    }
    case 'memory': {
      const mem = v as unknown as RedisMemoryValue | undefined
      put('usedBytes', mem?.usedBytes)
      // Only when it was actually reported. A rule of the shape "alert when
      // maxmemory is 0" must not fire on a server that never said.
      put('maxmemoryBytes', mem?.maxmemoryReported ? mem.maxmemoryBytes : null)
      put('usedFraction', mem?.usedFraction)
      break
    }
    case 'persistence': {
      const pe = v as unknown as RedisPersistenceValue | undefined
      put('rdbLastSaveAgeSeconds', pe?.rdbLastSaveAgeSeconds)
      put('rdbChangesSinceLastSave', pe?.rdbChangesSinceLastSave)
      put('aofRewriteFailures', pe?.aofRewriteFailures)
      break
    }
    case 'clients': {
      const cl = v as unknown as RedisClientsValue | undefined
      put('connected', cl?.connected)
      put('blocked', cl?.blocked)
      put('maxclients', cl?.maxclientsReported ? cl.maxclients : null)
      put('usedFraction', cl?.usedFraction)
      break
    }
    case 'keyspace': {
      const ks = v as unknown as RedisKeyspaceValue | undefined
      put('keys', ks?.totalKeys)
      put('expires', ks?.totalExpires)
      put('databases', ks?.databases.length)
      break
    }
    case 'stats': {
      const st = v as unknown as RedisStatsValue | undefined
      put('rejectedConnections', st?.rejectedConnections)
      put('evictedKeys', st?.evictedKeys)
      put('expiredKeys', st?.expiredKeys)
      put('hitRate', st?.hitRate)
      break
    }
    case 'cluster': {
      const cu = v as unknown as RedisClusterValue | undefined
      put('slotsAssigned', cu?.slotsAssigned)
      put('slotsFail', cu?.slotsFail)
      put('slotsPfail', cu?.slotsPfail)
      put('knownNodes', cu?.knownNodes)
      break
    }
    default:
      break
  }
  return out
}

/** A question that could not be asked at all, with the reason kept intact. */
export function unanswered<T>(id: DbQuestionId, failure: DbFailure, headline?: string): DbAnswer<T> {
  return {
    id,
    status: failure.status,
    detail: failure.detail,
    verdict: {
      level: 'unknown',
      headline: headline ?? defaultUnansweredHeadline(id, failure.status),
      because: DB_ANSWER_HELP[failure.status]
    }
  }
}

function defaultUnansweredHeadline(id: DbQuestionId, status: DbAnswerStatus): string {
  const label = DB_QUESTION_LABEL[id]
  switch (status) {
    case 'denied':
      return st('shared.dbOps.unanswered.denied', { label })
    case 'absent':
      return st('shared.dbOps.unanswered.absent', { label })
    case 'unsupported':
      return st('shared.dbOps.unanswered.unsupported', { label })
    case 'not-applicable':
      return st('shared.dbOps.unanswered.notApplicable', { label })
    default:
      return st('shared.dbOps.unanswered.unreadable', { label })
  }
}
