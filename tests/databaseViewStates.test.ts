import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const VIEW = readFileSync(
  fileURLToPath(new URL('../src/renderer/src/components/databases/DatabaseView.tsx', import.meta.url)),
  'utf8'
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
    expect(VIEW).toMatch(/title="Not connected"/)
    expect(VIEW).toMatch(/title=\{`No \$\{objectWord\.toLowerCase\(\)\}`\}/)
  })

  it('names the objects the way the engine does, in one place', () => {
    // Was a three-way conditional repeated at each site that needed it.
    expect(VIEW).toMatch(/const objectWord =/)
    expect(VIEW.match(/db\.kind === 'redis' \? 'Keyspace'/g)?.length).toBe(1)
  })
})

describe('the results pane', () => {
  it('does not invite a query while the connection is still being made', () => {
    expect(VIEW).toMatch(/if \(!result && phase === 'connecting'\)/)
    expect(VIEW).toMatch(/Connecting to \{where\}…/)
  })

  it('does not invite one after the connection failed either', () => {
    expect(VIEW).toMatch(/if \(!result && phase === 'error'\)/)
  })

  it('still says nothing has been sent, which was the honest part', () => {
    expect(VIEW).toMatch(/Nothing is sent to the server until you do/)
    expect(VIEW).toMatch(/Nothing has been sent to the server/)
  })
})

describe('how long MongoDB is allowed to hang', () => {
  it('is told explicitly, because its own default is thirty seconds', () => {
    expect(DB).toMatch(/const DB_CONNECT_TIMEOUT_MS = 10_000/)
    expect(DB).toMatch(/serverSelectionTimeoutMS: DB_CONNECT_TIMEOUT_MS/)
    expect(DB).toMatch(/connectTimeoutMS: DB_CONNECT_TIMEOUT_MS/)
  })
})
