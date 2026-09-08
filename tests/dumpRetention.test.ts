import { describe, it, expect } from 'vitest'

import {
  collidingDumpDatabases,
  dumpDatabaseOf,
  dumpObjectName,
  isBackupObjectName,
  isDumpObjectName,
  planDumpRetention,
  planRetention,
  safeDumpDatabase,
  type DumpEngine
} from '../src/shared/backup'

// Item 38's first gap. Dumps had NO retention at all: `backupTick` iterates
// bundle destinations only, and `isBackupObjectName` deliberately does not
// match a `.sql`, so a destination accumulated one dump per run for ever.

const gen = (name: string, modified: number): { name: string; modified: number; bytes: number } => ({
  name,
  modified,
  bytes: 1
})

// The engine is REAL rather than cast away. It used to be `{ database } as
// never`, which was harmless while every dump was named `.sql` and stopped
// being so the moment the extension came from the engine: the lookup returned
// undefined and every name ended `.undefined`, invisible to retention.
// `Record<DumpEngine, string>` means a new engine cannot be added without an
// extension, so the only way to reach that state was to lie to the type.
const at = (db: string, day: number, engine: DumpEngine = 'postgres'): string =>
  dumpObjectName(
    { engine, host: 'h', port: 1, username: 'u', database: db },
    new Date(Date.UTC(2026, 0, day))
  )

// A mongo dump is `.archive`, and retention must count it exactly as it counts
// a `.sql`. A dump whose name retention does not recognise is one it never
// removes, so the destination accumulates them for ever -- which is the very
// gap item 38 closed for `.sql`.
describe('retention counts a mongo archive too', () => {
  it('groups .archive dumps with the same database and removes the oldest', () => {
    const gens = [gen(at('appdb', 1, 'mongo'), 1), gen(at('appdb', 2, 'mongo'), 2)] as never
    expect(at('appdb', 1, 'mongo').endsWith('.archive')).toBe(true)
    expect(planDumpRetention(gens, 1, 'appdb').remove).toHaveLength(1)
  })

  // And still never as a generation of an encrypted bundle.
  it('does not let bundle retention touch a mongo archive either', () => {
    expect(isBackupObjectName(at('appdb', 1, 'mongo'))).toBe(false)
    expect(isDumpObjectName(at('appdb', 1, 'mongo'))).toBe(true)
  })
})

describe('a dump is not a bundle, and neither retention sees the other', () => {
  it('does not let bundle retention touch a dump', () => {
    // The separation that already existed, pinned: `.sql` is not `.spbackup`,
    // and a dump counted as a generation of a bundle would be deleted by a
    // rule about something else entirely.
    expect(isBackupObjectName(at('app', 1))).toBe(false)
    const p = planRetention([gen(at('app', 1), 1), gen(at('app', 2), 2)] as never, 1)
    expect(p.remove).toEqual([])
  })

  it('does not let dump retention touch a bundle', () => {
    const p = planDumpRetention(
      [gen('opsmaxx-20260101T000000Z.spbackup', 1), gen(at('app', 2), 2)] as never,
      1,
      'app'
    )
    expect(p.keep.map((g) => g.name)).toEqual([at('app', 2)])
    expect(p.remove).toEqual([])
  })
})

describe('reading a database name back out of a dump object', () => {
  it('parses from the right, because a database name may contain - and .', () => {
    expect(dumpDatabaseOf(at('my-app.prod', 3))).toBe('my-app.prod')
    expect(isDumpObjectName(at('my-app.prod', 3))).toBe(true)
  })

  it('is null for anything that is not one of ours', () => {
    for (const n of ['dump.sql', 'opsmaxx-20260101T000000Z.spbackup', 'opsmaxx-dump-app.sql']) {
      expect(dumpDatabaseOf(n), n).toBeNull()
    }
  })
})

describe('retention counts each database separately', () => {
  // A destination holds dumps of several databases interleaved. A global
  // "keep 2" would keep two OBJECTS, so a database dumped hourly would evict
  // one dumped weekly entirely.
  it('keeps N of each rather than N in total', () => {
    const gens = [
      gen(at('app', 1), 1),
      gen(at('app', 2), 2),
      gen(at('app', 3), 3),
      gen(at('orders', 1), 1)
    ] as never
    const app = planDumpRetention(gens, 2, 'app')
    expect(app.keep.map((g) => g.name)).toEqual([at('app', 3), at('app', 2)])
    expect(app.remove.map((g) => g.name)).toEqual([at('app', 1)])

    // And the quiet database is untouched by the busy one's rule.
    const orders = planDumpRetention(gens, 2, 'orders')
    expect(orders.remove).toEqual([])
  })

  it('never deletes the last dump of a database', () => {
    const p = planDumpRetention([gen(at('app', 1), 1)] as never, 1, 'app')
    expect(p.remove).toEqual([])
    expect(p.refused).toContain('never deleted')
  })

  it('deletes nothing when no limit is set', () => {
    for (const keep of [0, -1, NaN]) {
      const p = planDumpRetention([gen(at('app', 1), 1), gen(at('app', 2), 2)] as never, keep, 'app')
      expect(p.remove, String(keep)).toEqual([])
      expect(p.refused).toBeTruthy()
    }
  })
})

describe('two databases whose names sanitise the same', () => {
  // `-` and `.` are IN the allowed set, so `my-db` does not sanitise at all --
  // the collision is between a name with a character outside it and one
  // already spelled with the underscore. `my db` and `my_db` share a retention
  // group, and one would evict the other. Surfaced rather than worked around:
  // renaming is the operator's decision, and quietly keeping more than asked
  // would be a setting that does not mean what it says.
  it('leaves the characters that are already legal alone', () => {
    expect(safeDumpDatabase('my-db')).toBe('my-db')
    expect(safeDumpDatabase('my.db')).toBe('my.db')
    expect(collidingDumpDatabases(['my-db', 'my_db', 'orders'])).toEqual([])
  })

  it('is a collision the caller can be told about', () => {
    expect(collidingDumpDatabases(['my db', 'my_db', 'orders'])).toEqual([['my db', 'my_db']])
    expect(collidingDumpDatabases(['a/b', 'a:b'])).toEqual([['a/b', 'a:b']])
    expect(collidingDumpDatabases(['app', 'orders'])).toEqual([])
  })

  it('really does share a retention group, which is why the warning exists', () => {
    expect(safeDumpDatabase('my db')).toBe(safeDumpDatabase('my_db'))
    const gens = [gen(at('my db', 1), 1), gen(at('my_db', 2), 2)] as never
    expect(planDumpRetention(gens, 1, 'my db').remove).toHaveLength(1)
  })
})
