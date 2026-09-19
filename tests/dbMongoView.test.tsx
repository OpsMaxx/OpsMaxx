// @vitest-environment jsdom
import { useEffect, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { stubBridge } from './setup/renderer'
import { DatabaseView } from '../src/renderer/src/components/databases/DatabaseView'
import { MongoMonitor } from '../src/renderer/src/components/databases/MongoMonitor'
import { MONGO_OPCOUNTERS } from '../src/shared/dbOps'
import type { DatabaseConn } from '../src/renderer/src/types'
import type { DbConnectConfig, DbInfo } from '../src/shared/db'

/**
 * Rendered, not read.
 *
 * Three of the four things this change is about are only true on screen, and a
 * source-regex test can see the words in the file without ever finding out
 * whether they reach a person:
 *
 *  1. The left column was a FLAT list of one database's collections. A tree
 *     that eagerly listed every database's collections would look identical in
 *     a screenshot and would issue one listCollections per database on a
 *     server with four hundred of them.
 *  2. The results pane took the whole height before a query had ever been run,
 *     so the editor sat in a 160px box under a screenful of one grey sentence.
 *  3. The monitor must print RATES. The captured server's `opcounters.insert`
 *     is 23002, and 23002 appearing anywhere on that panel is the bug.
 */

const DB: DatabaseConn = {
  id: 'db-mongo-1',
  workspaceId: 'ws-1',
  name: 'shop cluster',
  kind: 'mongodb',
  host: 'mongo.example.internal',
  port: 27017,
  username: 'ops',
  database: '',
  ssl: false,
  uri: false,
  folderId: null,
  sshServerId: null,
  vpnProfileId: null
}

const FIXTURES = resolve(__dirname, 'fixtures/dbops/mongodb')
const PRIMARY = JSON.parse(
  readFileSync(join(FIXTURES, 'replica-set-primary.json'), 'utf8')
) as Record<string, { ok: boolean; result?: Record<string, unknown>; message?: string }>
const UNAUTHORIZED = JSON.parse(
  readFileSync(join(FIXTURES, 'unauthorized.json'), 'utf8')
) as Record<string, { ok: boolean; result?: Record<string, unknown>; message?: string }>

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

/** What each database holds. `admin` refuses, which is the ordinary case for a
 *  read-only user and the one an empty branch would misreport. */
const SERVER: Record<string, string[] | 'denied'> = {
  shop: ['orders', 'customers', 'invoices'],
  analytics: ['events'],
  admin: 'denied'
}

function stubMongo(): { info: ReturnType<typeof vi.fn> } {
  const info = vi.fn(async (cfg: DbConnectConfig): Promise<DbInfo> => {
    const databases = Object.keys(SERVER)
    const held = cfg.database ? SERVER[cfg.database] : undefined
    if (held === 'denied') return { ok: false, error: 'not authorized on admin to execute command { listCollections: 1 }' }
    return { ok: true, databases, tables: Array.isArray(held) ? held : [] }
  })
  stubBridge({
    db: {
      test: async () => ({ ok: true, version: 'MongoDB 8.0.4' }),
      info,
      query: async () => ({ ok: true, kind: 'json', json: {} })
    },
    secrets: { delete: async () => undefined }
  })
  return { info }
}

describe('the schema column', () => {
  it('lists databases, not one database’s collections', async () => {
    stubMongo()
    render(<DatabaseView db={DB} visible />)
    await screen.findByText('Databases')
    for (const name of ['shop', 'analytics', 'admin']) {
      expect(await screen.findByTitle(name)).toBeTruthy()
    }
    // The flat heading the screenshot was of.
    expect(screen.queryByText('Collections')).toBeNull()
  })

  it('does not fetch a database’s collections until it is opened', async () => {
    const { info } = stubMongo()
    render(<DatabaseView db={DB} visible />)
    await screen.findByTitle('analytics')
    // Whatever the connect path asked for, it did not ask for analytics.
    expect(info.mock.calls.some(([c]) => (c as DbConnectConfig).database === 'analytics')).toBe(false)
    // Its collection is not on screen either, which is the same fact seen from
    // the other side: nothing can be drawn that was never fetched.
    expect(screen.queryByTitle('events')).toBeNull()

    await userEvent.click(await screen.findByTitle('analytics'))
    expect(await screen.findByTitle('events')).toBeTruthy()
    expect(info.mock.calls.some(([c]) => (c as DbConnectConfig).database === 'analytics')).toBe(true)
  })

  it('says a database refused rather than drawing it empty', async () => {
    stubMongo()
    render(<DatabaseView db={DB} visible />)
    await userEvent.click(await screen.findByTitle('admin'))
    expect(await screen.findByText(/may not list admin/i)).toBeTruthy()
    expect(screen.queryByText(/no collections/i)).toBeNull()
  })

  it('opens the database the connection is pointed at, with its collections already there', async () => {
    const { info } = stubMongo()
    render(<DatabaseView db={DB} visible />)
    // MongoDB URIs often name no database, so the view picks a real one. Its
    // collections came back with dbInfo and are not fetched a second time.
    expect(await screen.findByTitle('orders')).toBeTruthy()
    const forShop = info.mock.calls.filter(([c]) => (c as DbConnectConfig).database === 'shop')
    expect(forShop.length).toBe(1)
  })

  it('points the connection at the right database when a collection is clicked', async () => {
    stubMongo()
    render(<DatabaseView db={DB} visible />)
    await userEvent.click(await screen.findByTitle('analytics'))
    await userEvent.click(await screen.findByTitle('events'))
    const editor = screen.getByPlaceholderText(/MongoDB command as JSON/i) as HTMLTextAreaElement
    expect(editor.value).toContain('"find": "events"')
    // And the database picker followed, so the query does not run against shop.
    await waitFor(() => expect((screen.getByTitle('Database (type or pick)') as HTMLInputElement).value).toBe('analytics'))
  })
})

// ---------------------------------------------------------------------------
// The layout
// ---------------------------------------------------------------------------

describe('the query pane', () => {
  it('gives the editor the height while there is nothing to show', async () => {
    stubMongo()
    const { container } = render(<DatabaseView db={DB} visible />)
    await screen.findByTitle('shop')
    const editor = container.querySelector('.db-editor') as HTMLElement
    const results = container.querySelector('.db-results') as HTMLElement
    // `grow` is flex:1 and no inline height; `idle` takes the results out of
    // the flex fight. Both are asserted here rather than in CSS because the
    // CSS is true of a class nothing puts on the element.
    expect(editor.classList.contains('grow')).toBe(true)
    expect(editor.style.height).toBe('')
    expect(results.classList.contains('idle')).toBe(true)
    // Nothing to divide, so no divider.
    expect(container.querySelector('.resizer-h')).toBeNull()
  })

  it('hands the height back, and the divider with it, once a query has answered', async () => {
    stubMongo()
    const { container } = render(<DatabaseView db={DB} visible />)
    await screen.findByTitle('shop')
    await userEvent.click(screen.getByRole('button', { name: /Run/ }))
    await waitFor(() => expect(container.querySelector('.db-editor.grow')).toBeNull())
    const editor = container.querySelector('.db-editor') as HTMLElement
    expect(editor.style.height).not.toBe('')
    expect(container.querySelector('.db-results.idle')).toBeNull()
    expect(container.querySelector('.resizer-h')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// The monitor
// ---------------------------------------------------------------------------

const CFG: DbConnectConfig = { id: 'db-mongo-1', kind: 'mongodb', host: 'mongo.example.internal', port: 27017, username: 'ops' }

/** The captured primary, with the sections its capture suppressed put back, and
 *  a knob for advancing the counters between samples. */
function status(insert: number, bytesIn: number): Record<string, unknown> {
  const base = PRIMARY.serverStatus.result as Record<string, unknown>
  return {
    ...base,
    opcounters: { ...(base.opcounters as Record<string, number>), insert },
    globalLock: { activeClients: { readers: 3, writers: 1 }, currentQueue: { readers: 7, writers: 0 } },
    network: { bytesIn, bytesOut: 2_000_000, numRequests: 400 },
    mem: { virtual: 3000, resident: 180 }
  }
}

const TOP = (count: number): Record<string, unknown> => ({
  totals: { note: 'all times in microseconds', 'shop.orders': { total: { time: count * 1000, count } } },
  ok: 1
})

/**
 * A stub that answers the three commands the monitor sends, advancing the
 * counters on each sweep so the second sample can be differenced against the
 * first.
 */
function stubMonitor(over: { serverStatus?: () => never; top?: () => never } = {}): { calls: () => number } {
  let sweep = 0
  const query = vi.fn(async (_cfg: DbConnectConfig, text: string) => {
    const cmd = JSON.parse(text) as Record<string, unknown>
    if ('serverStatus' in cmd) {
      if (over.serverStatus) return { ok: false, error: UNAUTHORIZED.serverStatus.message }
      sweep++
      return { ok: true, kind: 'json', json: status(23_002 + sweep * 20, 1_000_000 + sweep * 10_000) }
    }
    if ('top' in cmd) {
      if (over.top) return { ok: false, error: UNAUTHORIZED.serverStatus.message }
      return { ok: true, kind: 'json', json: TOP(1000 + sweep * 20) }
    }
    // $currentOp, whose reply the query bridge already unwraps to the batch.
    const batch = (PRIMARY.currentOp.result as { cursor: { firstBatch: unknown[] } }).cursor.firstBatch
    return { ok: true, kind: 'json', json: batch }
  })
  stubBridge({ db: { query } })
  return { calls: () => query.mock.calls.length }
}

describe('the monitor', () => {
  it('prints a rate, never the counter the server actually sent', async () => {
    stubMonitor()
    render(<MongoMonitor cfg={CFG} visible />)
    // Two samples, two seconds apart in real time, so this waits for the
    // second one rather than faking a clock the rate maths depends on.
    await waitFor(() => expect(screen.getByText(/Rates over the last/)).toBeTruthy(), { timeout: 6000 })
    const panel = screen.getByText('Operations').closest('section') as HTMLElement
    expect(panel).toBeTruthy()
    // 23002 and its successors are the totals since the server started.
    expect(panel.textContent).not.toMatch(/23,?0\d\d/)
    expect(within(panel).getByText('insert')).toBeTruthy()
    // 20 inserts over a ~2s window.
    expect(panel.textContent).toMatch(/\d+\.\d\/s/)
  }, 10_000)

  it('shows gauges as read, because active and queued clients are not counters', async () => {
    stubMonitor()
    render(<MongoMonitor cfg={CFG} visible />)
    const panel = (await screen.findByText('Read & write')).closest('section') as HTMLElement
    await waitFor(() => expect(within(panel).getByText('7')).toBeTruthy(), { timeout: 6000 })
    expect(within(panel).getByText('queued reads')).toBeTruthy()
  }, 10_000)

  it('darkens only the panel that was refused, and says so in words', async () => {
    stubMonitor({ serverStatus: (() => undefined) as never })
    render(<MongoMonitor cfg={CFG} visible />)
    const ops = (await screen.findByText('Operations')).closest('section') as HTMLElement
    await waitFor(() => expect(ops.textContent).toMatch(/will not tell us/i), { timeout: 6000 })
    // Not a zero, and not a blank chart.
    expect(ops.textContent).toMatch(/nothing here is a measurement of zero/i)
    // and the command the server echoed back is cut out of its own error text.
    expect(ops.textContent).not.toContain('wiredTiger')
    expect(ops.querySelector('svg.spark')).toBeNull()
    // The other two commands were not refused, so their panels still work.
    const hottest = screen.getByText('Hottest collections').closest('section') as HTMLElement
    await waitFor(() => expect(hottest.textContent).toContain('shop.orders'), { timeout: 6000 })
    const slowest = screen.getByText('Slowest operations').closest('section') as HTMLElement
    expect(slowest.textContent).toContain('shop.orders')
  }, 10_000)

  it('sends nothing at all while the tab is not the one on screen', async () => {
    const { calls } = stubMonitor()
    render(<MongoMonitor cfg={CFG} visible={false} />)
    await new Promise((r) => setTimeout(r, 300))
    expect(calls()).toBe(0)
    expect(screen.getByText(/Sampling is stopped/)).toBeTruthy()
  })

  it('samples on its interval however often its parent re-renders', async () => {
    // DatabaseView builds the config object fresh on every render, so an
    // effect keyed on the object restarts itself with every setState the
    // sample makes -- three admin commands per render, forever, against
    // somebody's primary. The parent here does exactly what DatabaseView does.
    const { calls } = stubMonitor()
    function Parent(): React.JSX.Element {
      const [, tick] = useState(0)
      useEffect(() => {
        const iv = setInterval(() => tick((n) => n + 1), 10)
        return () => clearInterval(iv)
      }, [])
      // A NEW object every render, exactly as cfgWith(dbName) produces.
      return <MongoMonitor cfg={{ ...CFG }} visible />
    }
    render(<Parent />)
    await new Promise((r) => setTimeout(r, 1200))
    // Three commands per sweep, and at ~2s apart a 1.2s window holds one.
    expect(calls()).toBeLessThanOrEqual(6)
  })

  it('names every counter Compass names', async () => {
    stubMonitor()
    render(<MongoMonitor cfg={CFG} visible />)
    const panel = (await screen.findByText('Operations')).closest('section') as HTMLElement
    for (const k of MONGO_OPCOUNTERS) expect(within(panel).getByText(k)).toBeTruthy()
  })
})
