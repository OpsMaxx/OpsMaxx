import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  MONGO_COMMANDS,
  MONGO_COMMAND_BUILDERS,
  MONGO_MONITOR_COMMANDS,
  MONGO_OPCOUNTERS,
  classifyMongoFailure,
  mongoMonitorRates,
  mongoTopRates,
  parseMongoMonitorSample,
  parseMongoTop,
  type MongoMonitorSample
} from '../src/shared/dbOps'

/**
 * The live monitor's arithmetic.
 *
 * One defect is worth a whole suite here and it is the same one in six places:
 * `opcounters`, `network.bytesIn` and every counter under `top` are TOTALS
 * SINCE THE SERVER STARTED. The fixture below is a real replica-set primary
 * whose `opcounters.insert` is 23002 after eight minutes of uptime. A panel
 * that prints 23002 beside the word "inserts" has told the operator a true
 * number that answers no question anybody asked, and a panel that clamps a
 * negative difference to zero draws a quiet minute over a server that just
 * restarted.
 *
 * The fixtures are the captures the operations tab already uses, which makes
 * them useful for a second reason: they were taken with
 * MONGO_COMMANDS.serverStatus, which switches `globalLock`, `network` and
 * `opcountersRepl` OFF. So they are also, for free, the evidence that an absent
 * section parses to null rather than to zero.
 */

const FIXTURES = resolve(__dirname, 'fixtures/dbops/mongodb')
function fixture(file: string): Record<string, { ok: boolean; result?: Record<string, unknown>; message?: string }> {
  return JSON.parse(readFileSync(join(FIXTURES, `${file}.json`), 'utf8'))
}

const PRIMARY = fixture('replica-set-primary')
const UNAUTHORIZED = fixture('unauthorized')

describe('what the monitor asks for', () => {
  it('turns back on the three sections the operations read switches off', () => {
    // Without this the panel has no active/queued clients, no bytes on the
    // wire and no replicated write rate -- three of its four gauges.
    const ops = MONGO_COMMANDS.serverStatus.command as Record<string, unknown>
    const live = MONGO_MONITOR_COMMANDS.serverStatus.command as Record<string, unknown>
    expect(ops.globalLock).toBe(0)
    expect(ops.network).toBe(0)
    expect(ops.opcountersRepl).toBe(0)
    expect(live.globalLock).toBe(1)
    expect(live.network).toBe(1)
    expect(live.opcountersRepl).toBe(1)
  })

  it('keeps every other suppression, rather than asking for the whole document', () => {
    // serverStatus in full is 9.4 KB of which 7.5 KB is WiredTiger counters.
    // Sampled every two seconds, "just ask for all of it" is a real cost.
    const ops = MONGO_COMMANDS.serverStatus.command as Record<string, unknown>
    const live = MONGO_MONITOR_COMMANDS.serverStatus.command as Record<string, unknown>
    for (const [k, v] of Object.entries(ops)) {
      if (k === 'globalLock' || k === 'network' || k === 'opcountersRepl') continue
      expect(live[k], k).toBe(v)
    }
    expect(live.wiredTiger).toBe(0)
  })

  it('runs against admin, and is covered by the read-only assertion', () => {
    expect(MONGO_MONITOR_COMMANDS.serverStatus.db).toBe('admin')
    expect(MONGO_MONITOR_COMMANDS.top.db).toBe('admin')
    // MONGO_COMMAND_BUILDERS is what tests/dbOpsMongoRedis.test.ts iterates to
    // prove nothing this app sends writes, kills or reconfigures. A command
    // that is not in it is a command that assertion cannot see.
    const built = MONGO_COMMAND_BUILDERS.map((b) => JSON.stringify(b()))
    expect(built).toContain(JSON.stringify(MONGO_MONITOR_COMMANDS.serverStatus.command))
    expect(built).toContain(JSON.stringify(MONGO_MONITOR_COMMANDS.top.command))
  })
})

describe('one sample of a real server', () => {
  const sample = parseMongoMonitorSample(PRIMARY.serverStatus.result, 1_000)

  it('reads the counters that are there', () => {
    expect(sample.opcounters.insert).toBe(23002)
    expect(sample.opcounters.query).toBe(551)
    expect(sample.opcounters.delete).toBe(0)
    expect(sample.connectionsCurrent).toBe(16)
    expect(sample.connectionsAvailable).toBe(307120)
    expect(sample.uptimeSeconds).toBe(493)
  })

  it('returns null, never zero, for a section the server did not send', () => {
    // This capture has no globalLock, no network and no mem, because the
    // command that took it suppressed them. Zero here would draw an idle
    // server with no traffic and no memory.
    expect(PRIMARY.serverStatus.result).not.toHaveProperty('globalLock')
    expect(PRIMARY.serverStatus.result).not.toHaveProperty('network')
    expect(PRIMARY.serverStatus.result).not.toHaveProperty('mem')
    expect(sample.activeReads).toBeNull()
    expect(sample.queuedWrites).toBeNull()
    expect(sample.bytesIn).toBeNull()
    expect(sample.bytesOut).toBeNull()
    expect(sample.numRequests).toBeNull()
    expect(sample.memResidentBytes).toBeNull()
    expect(sample.memVirtualBytes).toBeNull()
  })

  it('reports memory in bytes, because serverStatus reports it in megabytes', () => {
    const s = parseMongoMonitorSample({ mem: { virtual: 2048, resident: 96 } }, 0)
    expect(s.memResidentBytes).toBe(96 * 1024 * 1024)
    expect(s.memVirtualBytes).toBe(2048 * 1024 * 1024)
  })

  it('survives a reply that is not there at all', () => {
    const s = parseMongoMonitorSample(undefined, 5)
    expect(s.atMs).toBe(5)
    for (const k of MONGO_OPCOUNTERS) expect(s.opcounters[k]).toBeNull()
    expect(s.uptimeSeconds).toBeNull()
  })
})

/** The captured primary, with the three sections its capture suppressed put
 *  back at plausible values, so the rate arithmetic can be exercised over
 *  fields no fixture in this repo carries. The counters that ARE captured are
 *  left exactly as the server sent them. */
function live(over: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(PRIMARY.serverStatus.result as Record<string, unknown>),
    globalLock: { activeClients: { readers: 2, writers: 1 }, currentQueue: { readers: 0, writers: 0 } },
    network: { bytesIn: 1_000_000, bytesOut: 4_000_000, numRequests: 5_000 },
    mem: { virtual: 3000, resident: 180 },
    ...over
  }
}

describe('rates between two samples', () => {
  const a = parseMongoMonitorSample(live({}), 10_000)
  const b = parseMongoMonitorSample(
    live({
      uptime: 503,
      opcounters: { ...(PRIMARY.serverStatus.result!.opcounters as Record<string, number>), insert: 23_022, query: 551 },
      network: { bytesIn: 1_010_000, bytesOut: 4_000_000, numRequests: 5_200 }
    }),
    20_000
  )

  it('divides the difference by the measured window, not the configured one', () => {
    const r = mongoMonitorRates(a, b)!
    expect(r.windowSeconds).toBe(10)
    // 20 inserts in 10 seconds. NOT 23022, which is what the server sent.
    expect(r.opsPerSec.insert).toBe(2)
    expect(r.bytesInPerSec).toBe(1000)
    expect(r.requestsPerSec).toBe(20)
  })

  it('reports a counter that did not move as zero, because that is a measurement', () => {
    const r = mongoMonitorRates(a, b)!
    expect(r.opsPerSec.query).toBe(0)
    expect(r.bytesOutPerSec).toBe(0)
  })

  it('refuses a window of no time', () => {
    expect(mongoMonitorRates(a, parseMongoMonitorSample(live({}), 10_000))).toBeNull()
    expect(mongoMonitorRates(b, a)).toBeNull()
  })

  it('refuses the whole window when the server restarted inside it', () => {
    // Uptime going backwards is the only direct signal. Every counter resets
    // with it, and a counter that merely stood still is indistinguishable from
    // an idle one -- so the restart is detected from uptime and the answer is
    // "we do not know", not a clamped zero.
    const after = parseMongoMonitorSample(live({ uptime: 4, opcounters: { insert: 3, query: 0, update: 0, delete: 0, getmore: 0, command: 9 } }), 20_000)
    expect(mongoMonitorRates(a, after)).toBeNull()
  })

  it('refuses a single counter that went backwards even when uptime did not', () => {
    const after = parseMongoMonitorSample(
      live({ opcounters: { ...(PRIMARY.serverStatus.result!.opcounters as Record<string, number>), insert: 5 } }),
      20_000
    )
    const r = mongoMonitorRates(a, after)!
    expect(r.opsPerSec.insert).toBeNull()
    // and the counters beside it are still readable
    expect(r.opsPerSec.query).toBe(0)
  })

  it('gives null, not zero, where either end was never reported', () => {
    const bare: MongoMonitorSample = parseMongoMonitorSample(PRIMARY.serverStatus.result, 10_000)
    const r = mongoMonitorRates(bare, parseMongoMonitorSample(PRIMARY.serverStatus.result, 20_000))!
    expect(r.bytesInPerSec).toBeNull()
    expect(r.requestsPerSec).toBeNull()
  })
})

describe('top', () => {
  // The shape `top` actually returns: a map keyed by namespace with one key
  // that is not a namespace.
  const reply = {
    totals: {
      note: 'all times in microseconds',
      'shop.orders': {
        total: { time: 2_000_000, count: 1_000 },
        readLock: { time: 1_000_000, count: 800 },
        writeLock: { time: 1_000_000, count: 200 },
        queries: { time: 900_000, count: 700 },
        getmore: { time: 100_000, count: 100 },
        insert: { time: 500_000, count: 150 },
        update: { time: 400_000, count: 40 },
        remove: { time: 100_000, count: 10 }
      },
      'shop.customers': { total: { time: 100_000, count: 50 } }
    },
    ok: 1
  }

  it('does not render the note as a namespace with empty columns', () => {
    const entries = parseMongoTop(reply, 0)
    expect(entries.map((e) => e.ns)).toEqual(['shop.orders', 'shop.customers'])
  })

  it('sorts by rate over the window, not by lifetime total', () => {
    const before = parseMongoTop(reply, 0)
    const after = parseMongoTop(
      {
        totals: {
          note: 'all times in microseconds',
          // orders barely moved; customers took off. Lifetime totals still put
          // orders far ahead, which is exactly the wrong answer.
          'shop.orders': { total: { time: 2_010_000, count: 1_002 }, queries: { count: 702 } },
          'shop.customers': { total: { time: 700_000, count: 250 }, queries: { count: 200 } }
        }
      },
      10_000
    )
    const rates = mongoTopRates(before, after, 10)
    expect(rates[0].ns).toBe('shop.customers')
    expect(rates[0].opsPerSec).toBe(20)
    expect(rates[1].opsPerSec).toBeCloseTo(0.2)
  })

  it('reports the mean as time per operation, in milliseconds', () => {
    const before = parseMongoTop(reply, 0)
    const after = parseMongoTop({ totals: { 'shop.orders': { total: { time: 2_100_000, count: 1_100 } } } }, 10_000)
    const [r] = mongoTopRates(before, after, 10)
    // 100_000 microseconds over 100 operations = 1 ms each.
    expect(r.meanMs).toBeCloseTo(1)
  })

  it('skips a namespace it has never seen before, rather than counting its whole life as one window', () => {
    const before = parseMongoTop({ totals: { 'shop.orders': { total: { time: 1, count: 1 } } } }, 0)
    const after = parseMongoTop(
      { totals: { 'shop.orders': { total: { time: 2, count: 2 } }, 'shop.brandnew': { total: { time: 9e9, count: 9e6 } } } },
      10_000
    )
    expect(mongoTopRates(before, after, 10).map((r) => r.ns)).toEqual(['shop.orders'])
  })

  it('has nothing to say from one sample', () => {
    expect(mongoTopRates([], parseMongoTop(reply, 0), 0)).toEqual([])
  })
})

describe('a server that will not answer', () => {
  it('classifies the captured refusals as denied, not as an error to shrug at', () => {
    // The real message a read-only user gets, verbatim from the capture.
    const status = UNAUTHORIZED.serverStatus
    expect(status.ok).toBe(false)
    const f = classifyMongoFailure(null, null, status.message ?? '')
    expect(f.status).toBe('denied')
    // And the thirty-four-key command the server echoes back is cut out of the
    // sentence before it reaches a panel.
    expect(f.detail).not.toContain('wiredTiger')
    expect(f.detail).toContain('not authorized')
  })

  it('classifies the captured $currentOp refusal the same way', () => {
    const f = classifyMongoFailure(null, null, UNAUTHORIZED.currentOp.message ?? '')
    expect(f.status).toBe('denied')
  })
})
