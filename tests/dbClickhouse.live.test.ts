import { afterAll, describe, expect, it } from 'vitest'
import { clickhouseUrl, dbClose, dbInfo, dbQuery, dbTest } from '../src/main/services/db'
import { dbShell } from '../src/main/services/dbshell'
import type { DbConnectConfig } from '../src/shared/db'

// Against a REAL ClickHouse, through the same entry points the app's IPC
// handlers call, because what this engine does with a statement depends on the
// server: which ones take a FORMAT clause, and whether /ping checks a password
// (it does not, which is why the driver pings with a SELECT).
//
//   docker run -d --rm --name omx-ch -p 28123:8123 \
//     -e CLICKHOUSE_PASSWORD=omx-test -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 \
//     clickhouse/clickhouse-server:24.8
//
// Access management lets the suite create the readonly = 1 user it needs.
//
// The client cache is keyed by id and rev, as in the app, so a case pointed at
// another database takes its own id rather than reusing a client on `default`.
//
// Skipped unless OPSMAXX_CLICKHOUSE_LIVE=1, so the suite runs without Docker.
const LIVE = process.env.OPSMAXX_CLICKHOUSE_LIVE === '1'
const PASSWORD = process.env.OPSMAXX_CLICKHOUSE_PASSWORD ?? 'omx-test'

const cfg = (over: Partial<DbConnectConfig> = {}): DbConnectConfig => ({
  id: 'ch-live',
  kind: 'clickhouse',
  host: '127.0.0.1',
  port: 28123,
  username: 'default',
  password: PASSWORD,
  ...over
})

describe('ClickHouse connection strings from other tools', () => {
  it('takes JDBC forms and their parameters', () => {
    expect(clickhouseUrl('jdbc:clickhouse://h:8443/?ssl=true&database=logs&user=bob&password=p%40ss').toString()).toBe(
      'https://bob:p%40ss@h:8443/logs'
    )
    expect(clickhouseUrl('jdbc:ch:https://h:8443/db').toString()).toBe('https://h:8443/db')
    expect(clickhouseUrl('http://h:8123/?secure=1').protocol).toBe('https:')
  })

  it('keeps what the URL already says over a parameter', () => {
    expect(clickhouseUrl('http://ann:x@h:8123/main?user=bob&database=logs').toString()).toBe('http://ann:x@h:8123/main')
  })

  it('names the native protocol rather than failing on it', () => {
    expect(() => clickhouseUrl('clickhouse://h:9000/db')).toThrow(/native protocol/)
    expect(() => clickhouseUrl('ftp://h/db')).toThrow(/http:\/\/ or https:\/\//)
  })
})

describe.skipIf(!LIVE)('ClickHouse, against a real server', () => {
  afterAll(async () => {
    await dbClose('ch-live')
    await dbClose('ch-uri')
    await dbClose('ch-sys')
    await dbClose('ch-ro')
  })

  it('tests the connection and reports the version', async () => {
    const r = await dbTest(cfg())
    expect(r.error).toBeUndefined()
    expect(r.version).toMatch(/^ClickHouse \d+\./)
  })

  it('refuses a wrong password at Test, not at the first query', async () => {
    const r = await dbTest(cfg({ password: 'wrong' }))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/password|authentic/i)
  })

  it('runs a SELECT as rows and DDL/INSERT as commands', async () => {
    expect((await dbQuery(cfg(), 'CREATE TABLE IF NOT EXISTS omx_t (id UInt32, name String) ENGINE = MergeTree ORDER BY id;')).ok).toBe(true)
    expect((await dbQuery(cfg(), "INSERT INTO omx_t VALUES (1, 'a'), (2, 'b')")).ok).toBe(true)
    const r = await dbQuery(cfg(), 'SELECT id, name FROM omx_t ORDER BY id;')
    expect(r).toMatchObject({ ok: true, kind: 'rows', columns: ['id', 'name'], rows: [[1, 'a'], [2, 'b']] })
    expect((await dbQuery(cfg(), 'DROP TABLE omx_t')).ok).toBe(true)
  })

  it('stops a huge result at the row cap instead of loading it', async () => {
    const r = await dbQuery(cfg(), 'SELECT number FROM system.numbers LIMIT 1000000')
    expect(r.ok).toBe(true)
    expect(r.rows!.length).toBe(10_000)
    expect(r.message).toMatch(/there are more/)
  })

  it('does not call a result of exactly the cap cut off', async () => {
    const r = await dbQuery(cfg(), 'SELECT number FROM numbers(10000)')
    expect(r.rows!.length).toBe(10_000)
    expect(r.message).toBe('10000 row(s)')
  })

  // The cap used to be max_result_rows, a setting -- and a readonly = 1 user
  // may change none, so every SELECT they ran was refused.
  it('runs a SELECT for a readonly = 1 user', async () => {
    await dbQuery(cfg(), "CREATE USER IF NOT EXISTS omx_ro IDENTIFIED BY 'omx-ro' SETTINGS readonly = 1")
    await dbQuery(cfg(), 'GRANT SELECT ON system.* TO omx_ro')
    const r = await dbQuery(cfg({ id: 'ch-ro', username: 'omx_ro', password: 'omx-ro' }), 'SELECT 1 AS x')
    expect(r).toMatchObject({ ok: true, rows: [[1]] })
  })

  it('returns rows for a SELECT that starts with a comment or a parenthesis', async () => {
    expect((await dbQuery(cfg(), '-- why\nSELECT 42 AS a')).rows).toEqual([[42]])
    expect((await dbQuery(cfg(), '/* x */ (SELECT 7 AS a)')).rows).toEqual([[7]])
  })

  it('reports an error that arrives after the first rows, not the rows before it', async () => {
    const r = await dbQuery(cfg(), 'SELECT throwIf(number = 5000) FROM numbers(10000) SETTINGS max_block_size = 100')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/DB::Exception/)
  })

  it('keeps a temporary table and a SET for the next statement', async () => {
    const c = cfg({ id: 'ch-sess' })
    expect((await dbQuery(c, 'CREATE TEMPORARY TABLE omx_tmp (x UInt8)')).ok).toBe(true)
    expect((await dbQuery(c, 'INSERT INTO omx_tmp VALUES (1), (2)')).ok).toBe(true)
    expect((await dbQuery(c, 'SELECT count() AS n FROM omx_tmp')).rows).toEqual([['2']])
    expect((await dbQuery(c, 'SET max_threads = 3')).ok).toBe(true)
    expect((await dbQuery(c, "SELECT value FROM system.settings WHERE name = 'max_threads'")).rows).toEqual([['3']])
    await dbClose('ch-sess')
  })

  it('runs statements that arrive together one after another, not into a locked session', async () => {
    const c = cfg({ id: 'ch-sess' })
    const [a, b] = await Promise.all([dbQuery(c, 'SELECT sleep(1) AS s'), dbQuery(c, 'SELECT 2 AS x')])
    expect(a.ok && b.ok).toBe(true)
    // A capped read leaves the server finishing up; the next one waits for it.
    expect((await dbQuery(c, 'SELECT number FROM system.numbers')).rowCount).toBe(10_000)
    expect((await dbQuery(c, 'SELECT 3 AS x')).rows).toEqual([[3]])
    await dbClose('ch-sess')
  })

  it('keeps a String value that only looks like an error, when rows follow it', async () => {
    const msg = "Code: 1. DB::Exception: fake (version 24.8.1.1 (official build))"
    const r = await dbQuery(cfg(), `SELECT arrayJoin(['${msg}', 'after']) AS s`)
    expect(r).toMatchObject({ ok: true, rows: [[msg], ['after']] })
  })

  it('refuses a FORMAT clause of its own with a reason', async () => {
    const r = await dbQuery(cfg(), 'SELECT 1 FORMAT CSV')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/FORMAT clause/)
  })

  it('lists databases and tables for the sidebar', async () => {
    const r = await dbInfo(cfg({ id: 'ch-sys', database: 'system' }))
    expect(r.ok).toBe(true)
    expect(r.databases).toContain('system')
    expect(r.tables).toContain('tables')
  })

  it('describes a table from the shell', async () => {
    const r = await dbShell(cfg({ id: 'ch-sys', database: 'system' }), '\\d tables')
    expect(r.ok).toBe(true)
    expect(r.columns).toContain('name')
    expect(r.rows!.map((row) => row[0])).toContain('engine')
  })

  it('lets a database chosen later override the one in a connection string', async () => {
    const uri = `http://default:${encodeURIComponent(PASSWORD)}@127.0.0.1:28123/default`
    const r = await dbQuery({ ...cfg(), id: 'ch-uri', uri, database: 'system' }, 'SELECT currentDatabase() AS db')
    expect(r.rows).toEqual([['system']])
  })
})
