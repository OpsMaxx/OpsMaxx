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
//     -e CLICKHOUSE_PASSWORD=omx-test clickhouse/clickhouse-server:24.8
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
    expect(r.rows!.length).toBeLessThan(1_000_000)
    expect(r.message).toMatch(/limit/)
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
