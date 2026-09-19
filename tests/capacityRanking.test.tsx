// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import {
  CapacityPanel,
  capacityRow,
  rankCapacity
} from '../src/renderer/src/components/monitor/CapacityPanel'
import {
  CAPACITY_THRESHOLDS,
  buildCapacityReport,
  diskBytesPolicy,
  diskCeilingBytes,
  type CapacityMetric,
  type CapacityReport,
  type TrendPoint
} from '../src/shared/capacity'
import { forecastBytes } from '../src/shared/bytesForecast'
import type { Server } from '../src/renderer/src/types'

// The ranking, and the arithmetic under it.
//
// The screen this file guards exists to answer one question — what is going to
// run out, and when — and the way it failed was never a wrong number. It was
// four metrics in a fixed order, each headed by a chart, with the sentence
// anybody came for as the last line of the block. A disk eleven days from full
// and a CPU that cannot fill up at all were laid out identically.
//
// So the assertions here are about ORDER and about what the headline SAYS,
// and every fixture goes through `buildCapacityReport` — the real fit, the
// real refusal rules — rather than through a hand-written Forecast literal. A
// ranking test that ranks numbers somebody typed proves nothing about the
// screen.

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const T0 = 1_700_000_000_000

function server(id: string, name: string): Server {
  return {
    id,
    workspaceId: 'ws-default',
    folderId: null,
    name,
    host: `${id}.example.internal`,
    port: 22,
    username: 'ops',
    auth: 'key',
    status: 'online',
    tags: [],
    favorite: false,
    os: 'linux',
    route: [],
    vpnProfileId: null
  }
}

const ALPHA = server('srv-alpha', 'alpha')

/** `count` samples ending at `end`, one every `step` ms. */
function points(
  end: number,
  count: number,
  step: number,
  res: 'full' | 'hourly',
  value: (i: number) => number
): TrendPoint[] {
  const start = end - (count - 1) * step
  return Array.from({ length: count }, (_, i) => ({ ts: start + i * step, v: value(i), res }))
}

/** Seven days of hourly means starting at `from` and rising `perDay` a day. */
function ramp(from: number, perDay: number, hours = 169): TrendPoint[] {
  return points(T0, hours, HOUR, 'hourly', (i) => from + (i / 24) * perDay)
}

function report(
  series: Partial<Record<CapacityMetric, TrendPoint[]>>,
  windowDays = 7,
  now = T0
): CapacityReport {
  return buildCapacityReport(
    'srv-alpha',
    { cpu: [], memPct: [], diskPct: [], inodePct: [], ...series },
    {
      now,
      from: T0 - windowDays * DAY,
      to: T0,
      thresholds: CAPACITY_THRESHOLDS,
      fullResolutionDays: 7,
      retainedDays: 90
    }
  )
}

function trendOf(r: CapacityReport, metric: CapacityMetric) {
  const t = r.trends.find((x) => x.metric === metric)
  expect(t, `${metric} must be in the report`).toBeDefined()
  return t!
}

async function panel(r: CapacityReport): Promise<HTMLElement> {
  stubBridge({ capacity: { trends: () => Promise.resolve(r) } })
  const { container } = render(<CapacityPanel servers={[ALPHA]} />)
  await waitFor(() => expect(container.querySelector('.cap-card')).not.toBeNull())
  return container
}

// ---------------------------------------------------------------------------
// The arithmetic. Known inputs, derived answers.
// ---------------------------------------------------------------------------

describe('the projection, against inputs whose answer is arithmetic', () => {
  it('turns a clean 2 points a day into the date that rate reaches 90%', () => {
    // 50% at the start of a seven-day run, 2 points a day, so the last reading
    // is 50 + 14 = 64. (90 - 64) / 2 = 13 days after the end of the run, and
    // the run ends at `now`. Nothing here is a judgement call: if the fit is
    // sound these are the only numbers it can produce.
    const row = capacityRow(trendOf(report({ diskPct: ramp(50, 2) }), 'diskPct'))
    expect(row.rank).toBe('crossing')
    expect(row.days).toBeCloseTo(13, 5)
    expect(row.headline).toBe('Full in 13 days')
    const f = row.trend.forecast
    expect(f?.ok).toBe(true)
    if (f?.ok === true) {
      expect(f.perDay).toBeCloseTo(2, 6)
      expect(f.threshold).toBe(90)
      // The window it was drawn from, which the headline is never allowed to
      // travel without.
      expect(f.to - f.from).toBe(168 * HOUR)
    }
  })

  it('gives a faster climb a sooner date, in proportion', () => {
    const slow = capacityRow(trendOf(report({ diskPct: ramp(50, 1) }), 'diskPct'))
    const fast = capacityRow(trendOf(report({ diskPct: ramp(50, 4) }), 'diskPct'))
    // 50 + 7 = 57, (90 - 57) / 1 = 33. 50 + 28 = 78, (90 - 78) / 4 = 3.
    expect(slow.days).toBeCloseTo(33, 5)
    expect(fast.days).toBeCloseTo(3, 5)
  })

  it('refuses a single sample rather than extrapolating from a point', () => {
    // A point has no slope. The thing a naive implementation does here is
    // divide by zero and print a date in the year 30,000.
    const row = capacityRow(trendOf(report({ diskPct: [{ ts: T0, v: 71, res: 'full' }] }), 'diskPct'))
    expect(row.rank).toBe('quiet')
    expect(row.days).toBeNull()
    expect(row.headline).toBe('Not enough history yet')
    expect(row.trend.forecast).toMatchObject({ ok: false, reason: 'too-few-points' })
  })

  it('refuses an empty series and says nothing was sampled', () => {
    const row = capacityRow(trendOf(report({}), 'diskPct'))
    expect(row.rank).toBe('quiet')
    expect(row.headline).toBe('Nothing sampled in this window')
    expect(row.trend.forecast).toMatchObject({ ok: false, reason: 'no-data' })
  })

  it('calls a flat series flat rather than a date at infinity', () => {
    const row = capacityRow(trendOf(report({ diskPct: points(T0, 169, HOUR, 'hourly', () => 71) }), 'diskPct'))
    expect(row.rank).toBe('quiet')
    expect(row.headline).toBe('Not moving')
    expect(row.days).toBeNull()
    expect(row.trend.forecast).toMatchObject({ ok: false, reason: 'flat' })
  })

  it('calls a series that goes down falling, and gives it no date at all', () => {
    const row = capacityRow(trendOf(report({ diskPct: ramp(71, -2) }), 'diskPct'))
    expect(row.rank).toBe('quiet')
    expect(row.headline).toBe('Going down, not up')
    expect(row.days).toBeNull()
    // A negative slope crossing an upward threshold produces a date in the
    // PAST if nothing stops it, which renders as "reaches 90% in 0 days".
    expect(row.trend.forecast).toMatchObject({ ok: false, reason: 'falling' })
  })

  it('gives no date for a disk that somebody cleaned up mid-window', () => {
    // Five days climbing 50 to 70, then a tidy-up takes it to 30 and it stays
    // there. Every naive treatment of this is wrong in a different direction:
    // fit the whole window and the slope is steeply negative; fit the tail and
    // the disk is flat at 30; fit the head and it is filling. What must not
    // happen is a crossing date.
    const climbed = points(T0 - 2 * DAY, 121, HOUR, 'hourly', (i) => 50 + i / 6)
    const cleaned = points(T0, 49, HOUR, 'hourly', () => 30)
    const row = capacityRow(trendOf(report({ diskPct: [...climbed, ...cleaned] }), 'diskPct'))
    expect(row.rank).toBe('quiet')
    expect(row.days).toBeNull()
    expect(row.trend.forecast?.ok).toBe(false)
  })

  it('promotes a metric already over its threshold out of the refusals', () => {
    // `already-past` is a refusal in capacity.ts — there is nothing left to
    // predict — and it is the one refusal that describes trouble right now.
    const row = capacityRow(trendOf(report({ diskPct: points(T0, 169, HOUR, 'hourly', () => 93) }), 'diskPct'))
    expect(row.rank).toBe('over')
    expect(row.headline).toBe('At or over 90% now')
  })

  it('ranks a host that stopped reporting apart from one that is steady', () => {
    // Six days of samples that stop two days before now. "We have stopped
    // knowing" and "this is not moving" are opposite facts, and folding the
    // first away with the second is how a screen comes to read as an all-clear
    // for a host nobody can see.
    const stopped = points(T0 - 2 * DAY, 145, HOUR, 'hourly', (i) => 40 + i / 24)
    const row = capacityRow(trendOf(report({ diskPct: stopped }), 'diskPct'))
    expect(row.rank).toBe('stalled')
    expect(row.headline).toBe('Not reporting any more')
    expect(row.trend.forecast).toMatchObject({ ok: false, reason: 'stale' })
  })

  it('says a CPU has no ceiling instead of leaving the row blank', () => {
    const row = capacityRow(trendOf(report({ cpu: ramp(20, 3) }), 'cpu'))
    expect(row.rank).toBe('quiet')
    expect(row.threshold).toBeNull()
    expect(row.headline).toBe('No ceiling — a CPU does not fill up')
  })
})

// ---------------------------------------------------------------------------
// The order.
// ---------------------------------------------------------------------------

describe('the ranking', () => {
  it('puts a moving 60% above a motionless 85%, which is the whole point', () => {
    // The brief's case, and the one the old screen got backwards by printing
    // memory before disk whatever either of them was doing. 85% that has not
    // moved in a week is not a problem; 60% gaining five points a day is nine
    // days from trouble.
    const r = report({
      diskPct: ramp(60 - 5 * 7, 5),
      memPct: points(T0, 169, HOUR, 'hourly', () => 85)
    })
    const ranked = rankCapacity(r.trends)
    const disk = ranked.findIndex((x) => x.trend.metric === 'diskPct')
    const mem = ranked.findIndex((x) => x.trend.metric === 'memPct')
    expect(ranked[disk].rank).toBe('crossing')
    expect(ranked[mem].rank).toBe('quiet')
    expect(disk).toBeLessThan(mem)
  })

  it('orders two real crossings soonest first', () => {
    const r = report({ diskPct: ramp(50, 1), memPct: ramp(50, 4) })
    const ranked = rankCapacity(r.trends).filter((x) => x.rank === 'crossing')
    expect(ranked.map((x) => x.trend.metric)).toEqual(['memPct', 'diskPct'])
    expect(ranked[0].days!).toBeLessThan(ranked[1].days!)
  })

  it('puts a metric already over the line above every future crossing', () => {
    // A crossing three days out is urgent; being over the line now is not a
    // forecast at all, and sorting it by a date it does not have would bury it.
    const r = report({
      diskPct: ramp(50, 4),
      memPct: points(T0, 169, HOUR, 'hourly', () => 93)
    })
    expect(rankCapacity(r.trends).map((x) => x.rank).slice(0, 2)).toEqual(['over', 'crossing'])
  })

  it('puts a host that went quiet below the crossings and above the steady ones', () => {
    const r = report({
      diskPct: ramp(50, 4),
      memPct: points(T0 - 2 * DAY, 145, HOUR, 'hourly', (i) => 40 + i / 24),
      inodePct: points(T0, 169, HOUR, 'hourly', () => 12)
    })
    const ranked = rankCapacity(r.trends)
    expect(ranked.map((x) => x.trend.metric).slice(0, 3)).toEqual(['diskPct', 'memPct', 'inodePct'])
    expect(ranked.map((x) => x.rank).slice(0, 3)).toEqual(['crossing', 'stalled', 'quiet'])
  })

  it('breaks a tie by the declared metric order, not by whatever the fit returned', () => {
    // Two metrics with the identical series must not swap places between one
    // refresh and the next for a reason nobody can see.
    const same = points(T0, 169, HOUR, 'hourly', () => 44)
    const ranked = rankCapacity(
      report({ cpu: same, memPct: same, diskPct: same, inodePct: same }).trends
    )
    expect(ranked.map((x) => x.trend.metric)).toEqual(['cpu', 'memPct', 'diskPct', 'inodePct'])
  })
})

// ---------------------------------------------------------------------------
// What is actually on screen.
// ---------------------------------------------------------------------------

describe('the screen', () => {
  it('leads with the conclusion and keeps the window it came from beside it', async () => {
    await panel(report({ diskPct: ramp(50, 2) }))
    const card = screen.getByTestId('cap-card-diskPct')
    // The headline is the answer, not the percentage.
    expect(within(card).getByText('Full in 13 days')).toBeTruthy()
    // And the full sentence — conclusion AND the data behind it — is on the
    // card, not one click away. "Full in 13 days" alone is the failure this
    // whole feature is written against.
    expect(within(card).getByText(/Reaches 90% in 13 days/)).toBeTruthy()
    expect(within(card).getByText(/from 7 days of data/)).toBeTruthy()
    expect(within(card).getByText('64.0%')).toBeTruthy()
  })

  it('states what the percentage is a percentage of, and how many readings it is', async () => {
    await panel(report({ diskPct: ramp(50, 2) }))
    const card = screen.getByTestId('cap-card-diskPct')
    expect(within(card).getByText(/of the root filesystem, as df reports it/)).toBeTruthy()
    expect(within(card).getByText(/169 readings over 7 days/)).toBeTruthy()
  })

  it('renders the urgent metric first in the DOM and folds the steady one away', async () => {
    const container = await panel(
      report({
        diskPct: ramp(60 - 5 * 7, 5),
        memPct: points(T0, 169, HOUR, 'hourly', () => 85)
      })
    )
    const ranked = screen.getByTestId('capacity-ranked')
    // Only the metric that is going somewhere is in the ranked list.
    expect([...ranked.children].map((li) => li.getAttribute('data-testid'))).toEqual([
      'cap-card-diskPct'
    ])
    // The 85% one is reachable, under a summary that carries the count.
    const quiet = screen.getByTestId('capacity-quiet')
    expect(quiet.textContent).toMatch(/No date for 3 of 4/)
    expect(within(quiet).getByTestId('cap-card-memPct')).toBeTruthy()
    expect(within(quiet).getByText('Not moving')).toBeTruthy()
    expect(container.querySelectorAll('.cap-card').length).toBe(4)
  })

  it('says "not enough history yet" rather than a fabricated projection', async () => {
    await panel(report({ diskPct: [{ ts: T0, v: 71, res: 'full' }] }))
    expect(screen.getAllByText('Not enough history yet').length).toBeGreaterThan(0)
    // The refusal still says WHICH rule and what would change it.
    expect(screen.getByText(/Only 1 sample so far; 12 are needed/)).toBeTruthy()
    expect(screen.queryByText(/Reaches 90%/)).toBeNull()
    expect(document.body.textContent).not.toMatch(/Infinity|NaN/)
  })

  it('does not report an all-clear when nothing could be forecast', async () => {
    await panel(report({ diskPct: points(T0, 169, HOUR, 'hourly', () => 71) }))
    const note = screen.getByTestId('capacity-none-urgent')
    // The denominator, not just the reassuring half of it.
    expect(note.textContent).toMatch(/None of the 4 metrics produced a date/)
  })

  it('discloses the method rather than implying a precision the fit does not have', async () => {
    await panel(report({ diskPct: ramp(50, 2) }))
    const how = screen.getByTestId('capacity-method')
    expect(how.textContent).toMatch(/a straight line/)
    expect(how.textContent).toMatch(/least-squares/)
    expect(how.textContent).toMatch(/assumes the current rate holds/)
    // The refusal thresholds, from the constants that enforce them.
    expect(how.textContent).toMatch(/fewer than 12 samples/)
    expect(how.textContent).toMatch(/r² of 0\.5/)
    expect(how.textContent).toMatch(/further out than 90 days/)
  })

  it('draws the sparkline over an unbroken run only, never across a silence', async () => {
    // A sparkline has no room to show a hole, so it is given a stretch with
    // none rather than one it would quietly bridge. The authoritative line,
    // with the silence in it, is in the card's own disclosure.
    const before = points(T0 - 2 * DAY - 12 * HOUR, 73, HOUR, 'hourly', (i) => 40 + i * 0.4)
    const after = points(T0, 13, HOUR, 'hourly', (i) => 80 + i * 0.05)
    const rep = report({ diskPct: [...before, ...after] })
    const container = await panel(rep)

    const trend = trendOf(rep, 'diskPct')
    const lastRun = trend.segments[trend.segments.length - 1].points.length
    expect(lastRun).toBeLessThan(trend.read)

    const spark = container.querySelector('.cap-spark path[fill="none"]')!
    expect(spark).not.toBeNull()
    expect(spark.getAttribute('d')!.match(/[ML]/g)!.length).toBe(lastRun)

    // And the chart underneath still breaks where the samples stopped.
    expect(screen.getByText(/No samples for 2 days/)).toBeTruthy()
  })

  it('keeps every measured detail one click away rather than removing it', async () => {
    const container = await panel(report({ diskPct: ramp(50, 2) }))
    const card = screen.getByTestId('cap-card-diskPct')
    const fold = within(card).getByText('Show the measured line')
    await userEvent.click(fold)
    expect(within(card).getByLabelText(/^Disk over the last/)).toBeTruthy()
    expect(within(card).getByText('169 samples.')).toBeTruthy()
    expect(container.querySelectorAll('[data-testid="segment-hourly"]').length).toBe(1)
  })

  it('shows the time to the crossing as its own column in the estate list', async () => {
    // The estate roll-up was a table of sentences with the number anybody
    // wanted at the end of the third cell. `buildFleetForecast` had ranked it
    // correctly the whole time; nothing on screen let you see the rank.
    stubBridge({
      capacity: {
        trends: (id: string) =>
          Promise.resolve(
            id === 'srv-alpha'
              ? report({ diskPct: ramp(50, 2) })
              : report({ diskPct: ramp(50, 4) })
          )
      }
    })
    render(<CapacityPanel servers={[ALPHA, server('srv-bravo', 'bravo')]} />)
    await userEvent.click(await screen.findByText('Forecast the whole estate'))
    const rows = await screen.findByTestId('capacity-fleet-rows')
    const whens = [...rows.querySelectorAll('.cap-fleet-when')].map((n) => n.textContent)
    // Soonest first, and the number is the first thing in the row.
    expect(whens).toEqual(['3d', '13d'])
  })
})

// ---------------------------------------------------------------------------
// The disk, in bytes. The case the whole panel is named for.
// ---------------------------------------------------------------------------

describe('a filesystem too large for its stored percentage to move', () => {
  const GIB = 1024 ** 3
  const USABLE = 2048 * GIB
  /** 1792 GiB used, gaining 2 GiB a day, for a week of hourly samples. */
  const bytePoints = points(T0, 169, HOUR, 'hourly', (i) => 1792 * GIB + (i / 24) * 2 * GIB).map(
    (p) => ({ ts: p.ts, v: p.v })
  )
  /** What df actually stores for that disk: 87, every hour, for a week. Two
   *  gigabytes a day is under a tenth of one percentage point, so the integer
   *  column cannot see it at all. */
  const percentPoints = points(T0, 169, HOUR, 'hourly', () => 87)

  function withBytes(): CapacityReport {
    return buildCapacityReport(
      'srv-alpha',
      { cpu: [], memPct: [], diskPct: percentPoints, inodePct: [] },
      {
        now: T0,
        from: T0 - 7 * DAY,
        to: T0,
        thresholds: CAPACITY_THRESHOLDS,
        fullResolutionDays: 7,
        retainedDays: 90,
        bytes: {
          diskPct: forecastBytes(
            bytePoints,
            diskCeilingBytes(USABLE),
            T0,
            diskBytesPolicy(USABLE)
          )
        }
      }
    )
  }

  it('the percentage series really does read as flat — that is the premise', () => {
    // Asserted, not assumed. If df's column ever became precise enough to fit,
    // the promotion below would be papering over a fit that worked.
    expect(trendOf(withBytes(), 'diskPct').forecast).toMatchObject({
      ok: false,
      reason: 'flat'
    })
  })

  it('ranks the disk on the byte series, which is the one that can see it', () => {
    // 1843.2 GiB is 90% of 2 TiB; 1806 GiB is used after the week; 2 GiB a day.
    // (1843.2 - 1806) / 2 = 18.6 days, and no part of that arithmetic is
    // visible in the percentage column.
    const row = capacityRow(trendOf(withBytes(), 'diskPct'))
    expect(row.rank).toBe('crossing')
    expect(row.basis).toBe('bytes')
    expect(row.days).toBeCloseTo(18.6, 1)
    expect(row.headline).toBe('Full in 19 days')
  })

  it('says on the card which series the date came from, and what the percentage said', async () => {
    await panel(withBytes())
    const card = screen.getByTestId('cap-card-diskPct')
    expect(within(card).getByText('Full in 19 days')).toBeTruthy()
    const why = within(card).getByTestId('cap-basis-bytes-diskPct')
    expect(why.textContent).toMatch(/Measured in bytes, not in percent/)
    // The percentage's own verdict is quoted rather than suppressed: a headline
    // that appeared to contradict the line under it would be worse than either.
    expect(why.textContent).toMatch(/Flat over 7 days/)
    // And the byte figures themselves, at full precision.
    expect(within(card).getByTestId('cap-bytes-diskPct').textContent).toMatch(
      /used · growing .* a day/
    )
  })

  it('does not promote a disk whose byte series produced no crossing either', () => {
    // A null ceiling keeps the rate and refuses the crossing. No date means no
    // promotion — the row stays where the percentage put it.
    const r = buildCapacityReport(
      'srv-alpha',
      { cpu: [], memPct: [], diskPct: percentPoints, inodePct: [] },
      {
        now: T0,
        from: T0 - 7 * DAY,
        to: T0,
        thresholds: CAPACITY_THRESHOLDS,
        fullResolutionDays: 7,
        retainedDays: 90,
        bytes: { diskPct: forecastBytes(bytePoints, null, T0, diskBytesPolicy(USABLE)) }
      }
    )
    const row = capacityRow(trendOf(r, 'diskPct'))
    expect(row.rank).toBe('quiet')
    expect(row.basis).toBe('percent')
    expect(row.headline).toBe('Not moving')
  })
})

// A sanity check on the fixture helper itself: if `ramp` ever stopped producing
// the run these tests assume, every assertion above would still pass against a
// different series and prove nothing.
describe('the fixtures', () => {
  it('ramp produces a week of hourly samples at the stated rate', () => {
    const r = ramp(50, 2)
    expect(r.length).toBe(169)
    expect(r[0]).toMatchObject({ v: 50, res: 'hourly' })
    expect(r[r.length - 1].v).toBeCloseTo(64, 9)
    expect(r[r.length - 1].ts - r[0].ts).toBe(168 * HOUR)
    expect(r[1].ts - r[0].ts).toBe(HOUR)
    expect(MIN).toBe(60_000)
  })
})
