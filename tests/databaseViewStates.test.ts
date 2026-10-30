import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const VIEW = readFileSync(
  fileURLToPath(new URL('../src/renderer/src/components/databases/DatabaseView.tsx', import.meta.url)),
  'utf8'
)
// The copy lives in en.json and the view names it by key, so a sentence is
// checked as "the view uses this key, and the key still says this".
const en: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL('../src/shared/locales/en.json', import.meta.url)), 'utf8')
)
const DB = readFileSync(
  fileURLToPath(new URL('../src/main/services/db.ts', import.meta.url)),
  'utf8'
)

/**
 * A database that is still connecting must not look like an empty one.
 *
 * Reported against MongoDB and true of every engine, because this view serves
 * all five. Connecting to an unreachable host left: an empty Collections
 * column, an empty database picker, "No results yet — write a query above and
 * press Run", and a 14px spinner in the toolbar as the only thing on screen
 * that knew anything was happening. It looked like a database with nothing in
 * it, and it invited a query against a server that was not there.
 */

describe('the schema column', () => {
  it('says it is loading rather than rendering nothing', () => {
    // `info` is null while connecting AND after a failed load, and the old code
    // drew neither the list nor the empty message in that case -- a heading
    // with a blank column under it.
    expect(VIEW).toMatch(/conn\.phase === 'connecting' \|\| \(!info && !objects\.length\)/)
  })

  it('distinguishes not-connected from genuinely empty', () => {
    expect(VIEW).toMatch(/title=\{t\('databases\.view\.notConnected'\)\}/)
    expect(en['databases.view.notConnected']).toBe('Not connected')
    expect(VIEW).toMatch(/title=\{t\(objectCopy\.noneKey\)\}/)
    expect(en['databases.view.objects.tables.none']).toBe('No tables')
  })

  it('names the objects the way the engine does, in one place', () => {
    // Was a three-way conditional repeated at each site that needed it.
    expect(VIEW).toMatch(/const objectWord =/)
    expect(VIEW.match(/db\.kind === 'redis' \? 'keyspace'/g)?.length).toBe(1)
    expect(en['databases.view.objects.keyspace.heading']).toBe('Keyspace')
  })
})

describe('the results pane', () => {
  it('does not invite a query while the connection is still being made', () => {
    expect(VIEW).toMatch(/if \(!result && phase === 'connecting'\)/)
    expect(VIEW).toMatch(/t\('databases\.view\.connectingTo', \{ where \}\)/)
    expect(en['databases.view.connectingTo']).toBe('Connecting to {{where}}…')
  })

  it('does not invite one after the connection failed either', () => {
    expect(VIEW).toMatch(/if \(!result && phase === 'error'\)/)
  })

  it('still says nothing has been sent, which was the honest part', () => {
    expect(VIEW).toMatch(/t\('databases\.view\.noResults'\)/)
    expect(en['databases.view.noResults']).toMatch(/Nothing is sent to the server until you do/)
    expect(VIEW).toMatch(/t\('databases\.view\.notConnectedResults'\)/)
    expect(en['databases.view.notConnectedResults']).toMatch(/Nothing has been sent to the server/)
  })
})

describe('how long MongoDB is allowed to hang', () => {
  it('is told explicitly, because its own default is thirty seconds', () => {
    expect(DB).toMatch(/const DB_CONNECT_TIMEOUT_MS = 10_000/)
    expect(DB).toMatch(/serverSelectionTimeoutMS: DB_CONNECT_TIMEOUT_MS/)
    expect(DB).toMatch(/connectTimeoutMS: DB_CONNECT_TIMEOUT_MS/)
  })
})
