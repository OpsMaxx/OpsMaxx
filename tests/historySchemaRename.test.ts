import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { loadHistory, resetHistoryModuleForTests, HISTORY_FILE } from '../src/main/services/history'

/**
 * Opening a store written before the `host` -> `server` rename.
 *
 * Reported from a real machine, and it reproduces only this way: a store
 * created by a current build has `server` already, so nothing in the suite
 * ever exercised the upgrade. What the user saw was jobs refusing to run —
 *
 *   Jobs need the history store, which is not open on this machine.
 *
 * — because `openStore` threw on the first statement naming `events.server`,
 * `loadHistory` returned null, and history was disabled with no reason given
 * anywhere a user can look. The two visible symptoms, dead jobs and a fleet
 * with no past, both trace to a column name.
 *
 * The version could not catch it: the rename shipped WITHOUT bumping
 * SCHEMA_VERSION, so such a store declares 5 and looks current.
 */

const PRE_RENAME_TABLES = ['events', 'facts', 'samples', 'samples_hourly'] as const

/**
 * A store shaped the way the app used to write one.
 *
 * Taken from a real database that predates the rename, not invented: the first
 * attempt at this fixture guessed `servers(id, uuid, name)` and the open failed
 * on `no such column: host_key` — a failure of the fixture, which would have
 * been read as a failure of the migration. The shape that matters is the one
 * that actually shipped.
 */
function writePreRenameStore(dir: string): void {
  const db = new DatabaseSync(join(dir, HISTORY_FILE))
  db.exec(`
    CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE hosts (id INTEGER PRIMARY KEY AUTOINCREMENT, host_key TEXT NOT NULL UNIQUE);
    CREATE TABLE metric_names (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE samples (ts INTEGER NOT NULL, host INTEGER NOT NULL, metric INTEGER NOT NULL,
      v REAL NOT NULL, PRIMARY KEY (ts, host, metric)) WITHOUT ROWID;
    CREATE TABLE samples_hourly (ts INTEGER NOT NULL, host INTEGER NOT NULL, metric INTEGER NOT NULL,
      v_avg REAL NOT NULL, v_min REAL NOT NULL, v_max REAL NOT NULL, n INTEGER NOT NULL,
      PRIMARY KEY (ts, host, metric)) WITHOUT ROWID;
    CREATE TABLE events (ts INTEGER NOT NULL, kind TEXT NOT NULL, host INTEGER, payload TEXT);
    CREATE TABLE facts (host INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
      first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY (host, key)) WITHOUT ROWID;

    INSERT INTO meta (k, v) VALUES ('schema', '5');
    INSERT INTO hosts (id, host_key) VALUES (7, 'srv-web-1'), (9, 'srv-db-1');
    INSERT INTO metric_names (id, name) VALUES (1, 'cpu');
    INSERT INTO events (ts, kind, host, payload) VALUES (1000, 'host-unreachable', 7, '{}');
    INSERT INTO samples (ts, host, metric, v) VALUES (1000, 7, 1, 42.0);
    INSERT INTO facts (host, key, value, first_seen, last_seen)
      VALUES (9, 'os', 'Debian 12', 500, 1000);
  `)
  db.close()
}

let dir: string

beforeEach(() => {
  resetHistoryModuleForTests()
  dir = mkdtempSync(join(tmpdir(), 'opsmaxx-schema-'))
})
afterEach(() => {
  // `maxRetries`, because the teardown of a SQLITE test races the database's
  // own flushing: this failed once with ENOTEMPTY under parallel load, having
  // deleted the files while a -wal was still being written beside them. A
  // cleanup that can fail turns a passing migration test into a red one.
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('a store from before the rename', () => {
  /**
   * The whole bug in one assertion. Before the migration this returned null,
   * which is how "history disabled" and "jobs refuse" both happened at once.
   */
  it('opens instead of disabling history', async () => {
    writePreRenameStore(dir)
    const store = await loadHistory(dir)
    expect(store, 'a pre-rename store must not disable history').not.toBeNull()
    store?.close()
  })

  it('renames the column on every table that carried it', async () => {
    writePreRenameStore(dir)
    const store = await loadHistory(dir)
    store?.close()

    const db = new DatabaseSync(join(dir, HISTORY_FILE))
    for (const table of PRE_RENAME_TABLES) {
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
        (c) => c.name
      )
      expect(cols, `${table} still has host`).not.toContain('host')
      expect(cols, `${table} did not gain server`).toContain('server')
    }
    db.close()
  })

  // A rename that dropped the rows would be a worse bug than the one it fixed:
  // the whole point of migrating rather than starting fresh is the history.
  it('keeps the rows it already had', async () => {
    writePreRenameStore(dir)
    const store = await loadHistory(dir)
    store?.close()

    const db = new DatabaseSync(join(dir, HISTORY_FILE))
    const events = db.prepare('SELECT count(*) c FROM events').get() as { c: number }
    const samples = db.prepare('SELECT count(*) c FROM samples').get() as { c: number }
    expect(events.c).toBe(1)
    expect(samples.c).toBe(1)
    // And the value travelled with the column rather than being nulled.
    const row = db.prepare('SELECT server FROM events').get() as { server: number }
    expect(row.server).toBe(7)
    db.close()
  })

  /**
   * The half that loses data rather than throwing.
   *
   * Only the TABLE was renamed — `host_key` kept its name — and SCHEMA creates
   * `servers` with CREATE TABLE IF NOT EXISTS, so an old store gains an empty
   * `servers` while every real row stays in `hosts`. Nothing errors: the id
   * lookup simply matches nothing, so the fleet reads as one this store has
   * never seen and a year of samples is orphaned. An empty database rather
   * than a broken one, which is harder to notice and harder to diagnose.
   */
  it('moves the host rows into servers, keeping their ids', async () => {
    writePreRenameStore(dir)
    const store = await loadHistory(dir)
    store?.close()

    const db = new DatabaseSync(join(dir, HISTORY_FILE))
    const rows = db.prepare('SELECT id, host_key FROM servers ORDER BY id').all() as {
      id: number
      host_key: string
    }[]
    expect(rows).toEqual([
      { id: 7, host_key: 'srv-web-1' },
      { id: 9, host_key: 'srv-db-1' }
    ])
    // Ids are foreign keys in all four renamed tables, so minting new ones
    // would silently re-point a year of samples at the wrong servers.
    const ev = db.prepare('SELECT server FROM events').get() as { server: number }
    const fact = db.prepare('SELECT server FROM facts').get() as { server: number }
    expect(ev.server).toBe(7)
    expect(fact.server).toBe(9)
    // And the old table is gone, so a later open cannot copy from it twice.
    const left = db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='hosts'")
      .get() as { n: number }
    expect(left.n).toBe(0)
    db.close()
  })

  it('records a version a later change can start from', async () => {
    writePreRenameStore(dir)
    const store = await loadHistory(dir)
    store?.close()
    const db = new DatabaseSync(join(dir, HISTORY_FILE))
    const row = db.prepare("SELECT v FROM meta WHERE k = 'schema'").get() as { v: string }
    expect(Number(row.v)).toBeGreaterThanOrEqual(6)
    db.close()
  })
})

describe('stores that must not be touched', () => {
  it('opens a fresh store, which never had the old column', async () => {
    const store = await loadHistory(dir)
    expect(store).not.toBeNull()
    store?.close()
  })

  /**
   * Idempotent, because this runs on EVERY open. A second pass must not throw
   * — `ALTER TABLE ... RENAME COLUMN` on a column that is not there is an
   * error that would take the whole store down, which is the failure mode
   * migrateJobTarget's own comment warns about.
   */
  it('is safe to run again on an already-migrated store', async () => {
    writePreRenameStore(dir)
    const first = await loadHistory(dir)
    first?.close()
    resetHistoryModuleForTests()
    const second = await loadHistory(dir)
    expect(second, 'the second open must not throw').not.toBeNull()
    second?.close()
  })
})
