import { describe, it, expect } from 'vitest'

import {
  DB_SIZE_REFUSAL_WORDS,
  mysqlSizeSample,
  pgSizeSample,
  unsupportedSizeSample
} from '../src/shared/dbSizeSample'
import { parseMysqlSizes, parsePgSizes } from '../src/shared/dbOps'

// Item 47's growth series, and which number out of a sizes read may be plotted.
//
// Only one of the engines produces one that can be. The tests here are mostly
// about the ones that cannot, because a series built from those numbers has a
// growth rate that means nothing and nothing on screen would say so.

describe('Postgres reports a real per-database total', () => {
  const sizes = (): ReturnType<typeof parsePgSizes> =>
    parsePgSizes(
      [
        { name: 'orders', bytes: 8_589_934_592 },
        { name: 'postgres', bytes: 8_388_608 }
      ],
      []
    )

  it('records the database this connection names', () => {
    const s = pgSizeSample(sizes(), 'orders')
    expect(s.ok && s.bytes).toBe(8_589_934_592)
  })

  // "The first database the server listed" is not this connection's database,
  // and a series built from it would be about whichever one sorted first.
  it('refuses rather than taking the first row when the name is missing', () => {
    // Including an empty name: no database is called "", so the lookup refuses
    // it without needing a guard of its own.
    expect(pgSizeSample(sizes(), '').ok).toBe(false)
    expect(pgSizeSample(sizes(), 'nope').ok).toBe(false)
  })

  it('says which database it could not find', () => {
    const s = pgSizeSample(sizes(), 'nope')
    expect(s.ok ? '' : s.reason).toBe('not-listed')
    expect(s.ok ? '' : s.detail).toContain('was not among the ones the read returned')
  })

  it('refuses a row with no number rather than recording a zero', () => {
    const none = parsePgSizes([{ name: 'orders', bytes: null }], [])
    const s = pgSizeSample(none, 'orders')
    expect(s.ok).toBe(false)
    expect(s.ok ? '' : s.reason).toBe('no-number')
  })

  it('matches the name exactly, not by prefix', () => {
    expect(pgSizeSample(sizes(), 'order').ok).toBe(false)
  })
})

describe('MySQL’s total is a sum over a capped read', () => {
  const rows = (n: number): Parameters<typeof parseMysqlSizes>[0] =>
    Array.from({ length: n }, (_, i) => ({
      schema: 'app',
      name: `t${i}`,
      engine: 'InnoDB',
      table_rows: 10,
      data_bytes: 1024,
      index_bytes: 512,
      free_bytes: 0
    }))

  // THE trap. `parseMysqlSizes` sums the rows the query returned, and the query
  // has a LIMIT. On a server with more tables than the limit, that total is the
  // biggest twenty rather than the schema, and plotting it produces a line that
  // steps whenever the ordering changes.
  it('refuses a read that came back at the limit', () => {
    const s = mysqlSizeSample(parseMysqlSizes(rows(20)), 20)
    expect(s.ok).toBe(false)
    expect(s.ok ? '' : s.reason).toBe('capped')
    expect(s.ok ? '' : s.detail).toContain('the size of the biggest few')
  })

  it('accepts one that plainly saw every table', () => {
    const s = mysqlSizeSample(parseMysqlSizes(rows(3)), 20)
    expect(s.ok && s.bytes).toBe(3 * (1024 + 512))
  })

  // There is no way from here to tell "exactly twenty tables" from "the biggest
  // twenty of two hundred", so the ambiguous case is refused.
  it('refuses the ambiguous case rather than guessing at it', () => {
    expect(mysqlSizeSample(parseMysqlSizes(rows(20)), 20).ok).toBe(false)
    expect(mysqlSizeSample(parseMysqlSizes(rows(19)), 20).ok).toBe(true)
  })

  it('refuses a total that is not a number', () => {
    const s = mysqlSizeSample({ tables: [], totalBytes: Number.NaN }, 20)
    expect(s.ok ? '' : s.reason).toBe('no-number')
  })
})

describe('engines with no total to plot', () => {
  // Stated rather than left as a fall-through, so adding one is a decision.
  it('names the engine in its refusal', () => {
    const s = unsupportedSizeSample('redis')
    expect(s.ok).toBe(false)
    expect(s.ok ? '' : s.detail).toContain('redis')
    expect(s.ok ? '' : s.reason).toBe('unsupported')
  })

  it('has a sentence for every refusal it can produce', () => {
    for (const w of Object.values(DB_SIZE_REFUSAL_WORDS)) expect(w.length).toBeGreaterThan(20)
  })
})
