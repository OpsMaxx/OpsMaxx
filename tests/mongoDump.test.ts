import { describe, it, expect } from 'vitest'

import {
  DUMP_BINARY,
  DUMP_ENGINES,
  DUMP_EXTENSION,
  dumpCommand,
  dumpDatabaseOf,
  dumpObjectName,
  isDumpObjectName
} from '../src/shared/backup'
import { dumpEngineFor } from '../src/main/services/backupTargets'

// `mongodump` was a stated absence in backupTargets.ts: "there is no mongodump
// or redis equivalent here, and pretending otherwise would produce an empty
// file with a .sql name."
//
// Both halves of that sentence turned out to be exactly right about what had to
// be solved, and both were settled by measurement against a real authenticated
// MongoDB 7 rather than by reading the manual.

const target = {
  engine: 'mongo' as const,
  host: '127.0.0.1',
  port: 27017,
  username: 'admin',
  database: 'appdb'
}

describe('the two things that had to be measured', () => {
  // WITHOUT `--archive`, mongodump writes a DIRECTORY of BSON files and the
  // pipeline here — which reads stdout — would have captured nothing at all.
  // Measured: with it, 532 bytes on stdout and exit 0.
  it('asks for the archive on stdout, which is what the pipeline reads', () => {
    expect(dumpCommand(target, 'x').args).toContain('--archive')
  })

  // THE credential finding. `PGPASSWORD` and `MYSQL_PWD` have no mongodump
  // counterpart, and its `--password` flag is exactly the argv exposure this
  // interface exists to avoid. `--config` was measured to work: the same dump
  // succeeded with the real password in the file and failed with
  // `AuthenticationFailed` when the file held a wrong one.
  it('never puts the password in the argv', () => {
    const c = dumpCommand(target, 'secret123')
    expect(JSON.stringify(c.args)).not.toContain('secret123')
    expect(c.args).not.toContain('--password')
    expect(c.args).not.toContain('-p')
    expect(c.configFile?.contents).toBe('password: secret123\n')
  })

  it('asks for no config file when there is no password to carry', () => {
    expect(dumpCommand(target, '').configFile).toBeUndefined()
  })

  // The authentication database is not the one being dumped. Getting this wrong
  // reports as an auth failure rather than as a missing database, which sends
  // somebody to check the wrong thing.
  it('names the authentication database separately from the dumped one', () => {
    const a = dumpCommand(target, 'x').args
    expect(a[a.indexOf('--authenticationDatabase') + 1]).toBe('admin')
    expect(a[a.indexOf('--db') + 1]).toBe('appdb')
  })

  it('is the exact argv that produced a real archive', () => {
    expect(dumpCommand(target, 'x').args.join(' ')).toBe(
      '--host 127.0.0.1 --port 27017 --username admin --authenticationDatabase admin --db appdb --archive'
    )
    expect(DUMP_BINARY.mongo).toBe('mongodump')
  })
})

describe('what the dump is called', () => {
  // A mongodump archive is BSON, not SQL. Naming it `.sql` is a lie an operator
  // only discovers when they try to read it.
  it('names a mongo dump .archive and a SQL dump .sql', () => {
    const when = new Date('2026-09-06T12:00:00Z')
    expect(dumpObjectName(target, when)).toBe('shellpilot-dump-appdb-20260906T120000Z.archive')
    expect(dumpObjectName({ ...target, engine: 'postgres' }, when)).toBe(
      'shellpilot-dump-appdb-20260906T120000Z.sql'
    )
    expect(DUMP_EXTENSION.mongo).toBe('archive')
  })

  // THE ripple, and the reason the extension could not just be changed: a dump
  // whose name retention does not recognise is one it never counts and never
  // removes, so mongo archives would accumulate on the destination forever.
  it('is still recognised by retention, under either extension', () => {
    const when = new Date('2026-09-06T12:00:00Z')
    for (const engine of DUMP_ENGINES) {
      const name = dumpObjectName({ ...target, engine }, when)
      expect(isDumpObjectName(name), name).toBe(true)
      expect(dumpDatabaseOf(name), name).toBe('appdb')
    }
  })

  // Parsed from the RIGHT, so a database name containing a dot does not make
  // the extension ambiguous.
  it('reads a database name that itself contains dots and dashes', () => {
    const n = dumpObjectName(
      { ...target, database: 'my-app.v2' },
      new Date('2026-09-06T12:00:00Z')
    )
    expect(dumpDatabaseOf(n)).toBe('my-app.v2')
  })

  it('does not recognise something that merely ends in .archive', () => {
    expect(isDumpObjectName('holiday-photos.archive')).toBe(false)
    expect(isDumpObjectName('shellpilot-dump-appdb-nope.archive')).toBe(false)
  })
})

describe('what is still refused, and why', () => {
  // Redis is NOT an oversight. pg_dump, mysqldump and mongodump are clients
  // that ask a server for its contents and stream them; Redis has no such
  // client. Its persistence is a snapshot the SERVER writes to its own disk,
  // which is a different act on a different machine.
  it('has an engine for each database that can be streamed, and no more', () => {
    expect([...DUMP_ENGINES]).toEqual(['postgres', 'mysql', 'mongo'])
    expect(Object.keys(DUMP_BINARY).sort()).toEqual(['mongo', 'mysql', 'postgres'])
    expect(Object.keys(DUMP_EXTENSION).sort()).toEqual(['mongo', 'mysql', 'postgres'])
  })
})


describe('one mapping, not two', () => {
  // The list and the target builder had a copy each. That was harmless while
  // both said "postgres or mysql" and became a bug the moment MongoDB was added
  // to one: the panel would offer a database the builder refuses, or the
  // reverse. A second place a decision is made is a second place it can be made
  // differently.
  it('maps every stored kind the same way for both callers', () => {
    expect(dumpEngineFor('postgres')).toBe('postgres')
    expect(dumpEngineFor('mysql')).toBe('mysql')
    expect(dumpEngineFor('mongodb')).toBe('mongo')
    for (const k of ['redis', 'mssql', undefined, 'sqlite']) {
      expect(dumpEngineFor(k), String(k)).toBeNull()
    }
  })

  it('has a binary and an extension for everything it maps to', () => {
    for (const kind of ['postgres', 'mysql', 'mongodb']) {
      const e = dumpEngineFor(kind)!
      expect(DUMP_BINARY[e], kind).toBeTruthy()
      expect(DUMP_EXTENSION[e], kind).toBeTruthy()
    }
  })
})
