import { describe, expect, it } from 'vitest'
import {
  JSONL_RETENTION_DAYS,
  retainedLines,
  timestampOf
} from '../src/shared/jsonlRetention'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 8, 4, 12, 0, 0)
const line = (agoDays: number, id = 'x'): string =>
  JSON.stringify({ id, timestamp: new Date(NOW - agoDays * DAY).toISOString() })

describe('what survives, and what must not be thrown away', () => {
  it('drops what is past the horizon and keeps what is inside it', () => {
    const lines = [line(400), line(370), line(300), line(1)]
    const { kept, dropped } = retainedLines(lines, { now: NOW, minKeep: 0 })
    expect(dropped).toBe(2)
    expect(kept).toEqual([line(300), line(1)])
  })

  it('keeps a line whose timestamp cannot be read', () => {
    // The worst possible reason to destroy an audit record is that we could not
    // understand it. A half-written line from a crash, or one written by a
    // newer build, is evidence -- and deleting it is not a tidy-up, it is the
    // removal of the only trace of whatever produced it.
    const lines = ['{ not json', JSON.stringify({ timestamp: 'not a date' }), line(400)]
    const { kept } = retainedLines(lines, { now: NOW, minKeep: 0 })
    expect(kept).toEqual(['{ not json', JSON.stringify({ timestamp: 'not a date' })])
  })

  it('keeps the newest lines however old they are', () => {
    // A vault used once and then left alone for two years should still be able
    // to say what happened that once, rather than opening on an empty log.
    const lines = [line(900), line(880), line(870)]
    const { kept, dropped } = retainedLines(lines, { now: NOW, minKeep: 2 })
    expect(dropped).toBe(1)
    expect(kept).toEqual([line(880), line(870)])
  })

  it('caps by count as well as age, dropping the oldest', () => {
    // Age alone does not bound a retry loop: an agent can write a great many
    // lines well inside the horizon.
    const lines = [line(5, 'a'), line(4, 'b'), line(3, 'c'), line(2, 'd')]
    const { kept } = retainedLines(lines, { now: NOW, maxLines: 2, minKeep: 0 })
    expect(kept).toEqual([line(3, 'c'), line(2, 'd')])
  })

  it('leaves a log that is entirely inside the horizon alone', () => {
    // The common case, and the one where a bug would be most expensive: this
    // runs at every startup, so anything it gets wrong it gets wrong to
    // everybody's log, every time.
    const lines = [line(10), line(5), line(0)]
    const { kept, dropped } = retainedLines(lines, { now: NOW })
    expect(dropped).toBe(0)
    expect(kept).toEqual(lines)
  })

  it('keeps a line written exactly on the boundary', () => {
    // `>= cutoff`, not `>`. A line is dropped for being OLDER than the horizon,
    // and one that is exactly the horizon is not older than it.
    const { kept } = retainedLines([line(JSONL_RETENTION_DAYS)], { now: NOW, minKeep: 0 })
    expect(kept).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// The fourth log spells the field differently, and that made its retention a
// complete no-op.
// ---------------------------------------------------------------------------
//
// `CredProxyCall` (src/shared/credproxy.ts) carries **`at`**, not `timestamp`.
// The other three — AuditEntry, LocalSessionEntry, JobApprovalEntry — all carry
// `timestamp`, so reading only that field looked right and was right for three
// files out of four.
//
// For the fourth it returned null for every row, which rule 1 reads as
// "unreadable: keep". So the 365-day horizon never fired on the ONE file that
// grows per forwarded REQUEST rather than per approval, and only the
// 50,000-line cap ever bit. The absence of a test with a row of this shape is
// the whole reason that shipped.
const credLine = (agoDays: number, id = 'c'): string =>
  JSON.stringify({
    id,
    at: new Date(NOW - agoDays * DAY).toISOString(),
    method: 'GET',
    origin: 'https://api.example.com',
    path: '/v1/models',
    ruleId: 'r1',
    ruleName: 'Example',
    outcome: 'forwarded',
    status: 200,
    ms: 12
  })

describe('a credential-proxy row, which dates itself with `at`', () => {
  it('ages out past the horizon like every other row', () => {
    const lines = [credLine(400, 'old'), credLine(370, 'older'), credLine(1, 'recent')]
    const { kept, dropped } = retainedLines(lines, { now: NOW, minKeep: 0 })
    expect(dropped).toBe(2)
    expect(kept).toEqual([credLine(1, 'recent')])
  })

  it('reads its timestamp rather than reporting it unreadable', () => {
    expect(timestampOf(credLine(0))).toBe(NOW)
  })

  it('mixes with `timestamp` rows in one file without either being misread', () => {
    // Not a case the app produces — one file, one writer — but the two spellings
    // share one function, and a fix that read `at` INSTEAD of `timestamp` would
    // break the three logs while fixing the fourth.
    const lines = [line(400, 'ts-old'), credLine(400, 'at-old'), line(1, 'ts-new'), credLine(1)]
    const { kept, dropped } = retainedLines(lines, { now: NOW, minKeep: 0 })
    expect(dropped).toBe(2)
    expect(kept).toEqual([line(1, 'ts-new'), credLine(1)])
  })
})

describe('reading the timestamp', () => {
  it('reads an ISO string, which is what all three logs write', () => {
    expect(timestampOf(line(0))).toBe(NOW)
  })

  // The next two are PRECONDITIONS on the merged reader, not coverage of the
  // `at` bug, and saying so is the point: both also pass against the old
  // timestamp-only reader, which returned null for every `at` row. The three
  // cases in the credproxy block above are what fail on that revert.
  //
  // They are still worth keeping: they pin the shape of the merged reader
  // against a DIFFERENT wrong version — one that reads `at` first, or reads it
  // without the string guard. `Date.parse(String(12345))` is not NaN and not
  // 1970 either -- it is the year 12345 -- so a reader that skipped the guard
  // would read that row as permanently inside the horizon.
  it('ignores an `at` that is not a string rather than returning NaN', () => {
    expect(timestampOf('{"at": 12345}')).toBeNull()
    expect(timestampOf('{"at": "nope"}')).toBeNull()
  })

  it('prefers `timestamp` when a row somehow carries both', () => {
    const row = JSON.stringify({ timestamp: new Date(NOW).toISOString(), at: 'not a date' })
    expect(timestampOf(row)).toBe(NOW)
  })

  it('returns null rather than NaN for a value it cannot use', () => {
    // NaN compares false against everything, so a NaN leaking into the age
    // comparison would silently drop the line -- the exact outcome rule 1 is
    // there to prevent.
    expect(timestampOf('{"timestamp": 12345}')).toBeNull()
    expect(timestampOf('{"timestamp": "nope"}')).toBeNull()
    expect(timestampOf('nonsense')).toBeNull()
    expect(timestampOf('{}')).toBeNull()
  })
})
