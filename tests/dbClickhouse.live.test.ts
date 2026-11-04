import { afterAll, describe, expect, it } from 'vitest'
import { dbClose, dbInfo, dbQuery, dbTest } from '../src/main/services/db'
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
