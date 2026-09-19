// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { ChangeLogPanel } from '../src/renderer/src/components/monitor/ChangeLogPanel'
import type { ChangeLogEntry, ChangeLogFilter, ChangeLogPage } from '../src/shared/changelog'
import type { Server } from '../src/renderer/src/types'

// The panel half of roadmap item 14.
//
// These assert what an operator SEES, because everything this item can get
// wrong looks fine on screen: a timeline missing a source it could not read, a
// filtered page that hides unattributed rows without a word, and a switched-off
// view that renders as an uneventful week.

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

const SERVERS = [server('srv-1', 'web-01'), server('srv-2', 'db-01')]

function entry(over: Partial<ChangeLogEntry> = {}): ChangeLogEntry {
  return {
    id: 'local:l1',
    source: 'local-shell',
    ts: T0,
    actor: 'human',
    kind: 'shell',
    summary: 'zsh (default) exited on this machine',
    detail: ['/bin/zsh', 'exit 0'],
    hostId: null,
    hosts: [],
    ...over
  }
}

function page(over: Partial<ChangeLogPage> = {}): ChangeLogPage {
  return {
    enabled: true,
    entries: [],
    coverage: [
      { source: 'local-shell', state: 'read', entries: 0 },
      { source: 'approvals', state: 'read', entries: 0 },
      { source: 'agent-audit', state: 'read', entries: 0 },
      { source: 'history', state: 'read', entries: 0 }
    ],
    oldest: null,
    more: false,
    ...over
  }
}

/** The stub records the filter it was asked for, so a test can assert what the
 *  controls actually requested rather than that a call happened. */
function stub(reply: (f: ChangeLogFilter) => ChangeLogPage): { asked: ChangeLogFilter[] } {
  const asked: ChangeLogFilter[] = []
  stubBridge({
    changelog: {
      read: async (f: ChangeLogFilter = {}) => {
        asked.push(f)
        return reply(f)
      }
    }
  })
  return { asked }
}

describe('what the change log says it could not read', () => {
  it('names an unreadable source above the timeline rather than dropping it', async () => {
    stub(() =>
      page({
        entries: [entry()],
        coverage: [
          { source: 'local-shell', state: 'read', entries: 1 },
          { source: 'approvals', state: 'unreadable', entries: 0, error: 'EACCES: permission denied' },
          { source: 'agent-audit', state: 'absent', entries: 0 },
          { source: 'history', state: 'truncated', entries: 0, bytesUnread: 4096 }
        ]
      })
    )
    render(<ChangeLogPanel servers={SERVERS} />)

    const approvals = await screen.findByTestId('changelog-coverage-approvals')
    expect(approvals.textContent).toContain(
      'Could NOT be read, so anything it holds is missing from the timeline below.'
    )
    expect(approvals.textContent).toContain('EACCES: permission denied')

    expect(screen.getByTestId('changelog-coverage-agent-audit').textContent).toContain(
      'this record does not exist on this machine'
    )
    expect(screen.getByTestId('changelog-coverage-history').textContent).toContain(
      'Older entries exist and are NOT in the timeline below.'
    )
    // And the one source that did read still renders its row.
    expect(screen.getByTestId('changelog-entries').textContent).toContain(
      'zsh (default) exited on this machine'
    )
  })

  it('says what each source is a record of, whatever state it is in', async () => {
    stub(() => page())
    render(<ChangeLogPanel servers={SERVERS} />)
    expect((await screen.findByTestId('changelog-coverage-agent-audit')).textContent).toContain(
      'what an agent did through the MCP bridge'
    )
    expect(screen.getByTestId('changelog-coverage-local-shell').textContent).toContain(
      'never keystrokes, and never what a shell printed'
    )
  })

  it('does not let an empty page read as a quiet period on its own', async () => {
    stub(() => page())
    render(<ChangeLogPanel servers={SERVERS} />)
    expect((await screen.findByTestId('changelog-empty')).textContent).toContain(
      'read the coverage above before reading that as a quiet period'
    )
  })
})

describe('the switch', () => {
  it('shows what being off does and does not turn off, and no timeline', async () => {
    stub(() =>
      page({
        enabled: false,
        coverage: [
          { source: 'local-shell', state: 'off', entries: 0 },
          { source: 'approvals', state: 'off', entries: 0 },
          { source: 'agent-audit', state: 'off', entries: 0 },
          { source: 'history', state: 'off', entries: 0 }
        ]
      })
    )
    render(<ChangeLogPanel servers={SERVERS} />)

    const off = await screen.findByTestId('changelog-off')
    expect(off.textContent).toContain('does NOT stop anything being recorded')
    expect(off.textContent).toContain(
      'Switching this off removes the timeline, not the records behind it.'
    )
    // The tab is reachable and says why it is empty. It does not render a
    // coverage table or an empty timeline, either of which would invite the
    // reading that the sources were consulted and had nothing.
    expect(screen.queryByTestId('changelog-entries')).toBe(null)
    expect(screen.queryByTestId('changelog-empty')).toBe(null)
    expect(screen.queryByTestId('changelog-coverage-history')).toBe(null)
  })

  it('says so when the bridge cannot be reached at all', async () => {
    stubBridge({})
    render(<ChangeLogPanel servers={SERVERS} />)
    expect((await screen.findByTestId('changelog-unavailable')).textContent).toContain(
      'Nothing below is a statement about what happened.'
    )
  })
})

describe('the timeline', () => {
  it('renders the order it was given rather than re-sorting it', async () => {
    // The ordering is total and lives in shared/changelog.ts. A second opinion
    // here is how two screens end up disagreeing about what happened when.
    stub(() =>
      page({
        entries: [
          entry({ id: 'a', ts: T0, summary: 'newest' }),
          entry({ id: 'b', ts: T0 + 5000, summary: 'arrived second' }),
          entry({ id: 'c', ts: T0 - 5000, summary: 'oldest' })
        ]
      })
    )
    render(<ChangeLogPanel servers={SERVERS} />)
    const text = (await screen.findByTestId('changelog-entries')).textContent ?? ''
    expect(text.indexOf('newest')).toBeLessThan(text.indexOf('arrived second'))
    expect(text.indexOf('arrived second')).toBeLessThan(text.indexOf('oldest'))
  })

  it('labels an agent row as an agent and a system row as neither of the two', async () => {
    stub(() =>
      page({
        entries: [
          entry({ id: 'g', actor: 'agent', summary: 'ran a terminal call', hosts: ['db-01'] }),
          entry({ id: 's', actor: 'system', summary: 'host-unreachable' })
        ]
      })
    )
    render(<ChangeLogPanel servers={SERVERS} />)
    const text = (await screen.findByTestId('changelog-entries')).textContent ?? ''
    expect(text).toContain('An agent · ran a terminal call · db-01')
    expect(text).toContain('OpsMaxx itself · host-unreachable')
  })

  it('shows the commands and targets it was given', async () => {
    stub(() =>
      page({
        entries: [
          entry({
            id: 'a',
            actor: 'human',
            kind: 'approval',
            summary: 'Job granted — Restart nginx',
            detail: ['systemctl restart nginx'],
            hosts: ['web-01']
          })
        ]
      })
    )
    render(<ChangeLogPanel servers={SERVERS} />)
    const text = (await screen.findByTestId('changelog-entries')).textContent ?? ''
    expect(text).toContain('You · Job granted — Restart nginx · web-01')
    expect(text).toContain('systemctl restart nginx')
  })

  it('names a server the store only knew by id, and falls back to the id when it is gone', async () => {
    // main does not hold the workspace's server list, so a history event
    // reaches the panel with a uuid on it. Rendering the uuid is bad; rendering
    // nothing is worse, because an empty cell reads as "no host".
    stub(() =>
      page({
        entries: [
          entry({ id: 'known', actor: 'system', summary: 'host-unreachable', hostId: 'srv-2' }),
          entry({ id: 'gone', actor: 'system', summary: 'host-recovered', hostId: 'srv-removed' })
        ]
      })
    )
    render(<ChangeLogPanel servers={SERVERS} />)
    const text = (await screen.findByTestId('changelog-entries')).textContent ?? ''
    expect(text).toContain('host-unreachable · db-01')
    expect(text).toContain('host-recovered · srv-removed')
  })

  it('says when a server filter hid rows that name no server', async () => {
    stub(() => page({ entries: [entry()], hostFilterHidUnattributed: 3 }))
    render(<ChangeLogPanel servers={SERVERS} />)
    expect((await screen.findByTestId('changelog-host-filter-note')).textContent).toContain(
      '3 entries in this window name no server at all'
    )
  })

  it('says when the page was cut rather than showing its last row as the end', async () => {
    stub(() => page({ entries: [entry()], more: true, oldest: T0 }))
    render(<ChangeLogPanel servers={SERVERS} />)
    expect((await screen.findByTestId('changelog-more')).textContent).toContain(
      'More entries matched than fit on one page'
    )
  })
})

describe('filters', () => {
  it('asks for a window rather than reading everything by default', async () => {
    const { asked } = stub(() => page())
    render(<ChangeLogPanel servers={SERVERS} />)
    await waitFor(() => expect(asked.length).toBeGreaterThan(0))
    // Seven days is the default, so the first read is bounded.
    expect(asked[0].from).toBeGreaterThan(Date.now() - 7 * 86_400_000 - 5000)
    expect(asked[0].from).toBeLessThanOrEqual(Date.now() - 7 * 86_400_000 + 5000)
    expect(asked[0].actors).toBeUndefined()
    expect(asked[0].kinds).toBeUndefined()
    expect(asked[0].hosts).toBeUndefined()
  })

  it('asks main for the narrowed read rather than narrowing what it already has', async () => {
    // Filtering in the renderer would silently break the per-source budget:
    // main would still return the newest 200 of everything and the panel would
    // show whichever few of them matched, which is not the same answer.
    const { asked } = stub(() => page())
    render(<ChangeLogPanel servers={SERVERS} />)
    await waitFor(() => expect(asked.length).toBeGreaterThan(0))

    await userEvent.selectOptions(screen.getByLabelText('Who'), 'agent')
    await waitFor(() => expect(asked[asked.length - 1].actors).toEqual(['agent']))

    await userEvent.selectOptions(screen.getByLabelText('What'), 'approval')
    await waitFor(() => expect(asked[asked.length - 1].kinds).toEqual(['approval']))

    await userEvent.selectOptions(screen.getByLabelText('Host'), 'srv-2')
    await waitFor(() => expect(asked[asked.length - 1].hosts).toEqual(['srv-2']))

    await userEvent.selectOptions(screen.getByLabelText('Time range'), 'all')
    await waitFor(() => expect(asked[asked.length - 1].from).toBeUndefined())
    // The other three survive the fourth change.
    const last = asked[asked.length - 1]
    expect(last.actors).toEqual(['agent'])
    expect(last.kinds).toEqual(['approval'])
    expect(last.hosts).toEqual(['srv-2'])
  })
})

// ---------------------------------------------------------------------------
// The overhaul: an answer, then a ranked and collapsed timeline.
//
// The screen this replaces was four dropdowns, three paragraphs of coverage
// prose and a flat list — eighteen visible rows on a real estate, fourteen of
// them the same sampler event on the same host. Everything below asserts on
// what is actually in the DOM, because every one of those failures looked fine
// in a test that only checked a heading rendered.
// ---------------------------------------------------------------------------

const NOW = Date.now()

/** The sampler event that made this screen unreadable, N times over. */
function burst(n: number, over: Partial<ChangeLogEntry> = {}): ChangeLogEntry[] {
  return Array.from({ length: n }, (_, i) =>
    entry({
      id: `fact-${i}`,
      source: 'history',
      actor: 'system',
      kind: 'host',
      summary: 'fact-changed',
      detail: [`sample ${i}`],
      hosts: ['Chain305'],
      ts: NOW - i * 1000,
      ...over
    })
  )
}

function rows(c: HTMLElement): HTMLElement[] {
  return Array.from(c.querySelectorAll('.cl-row'))
}

describe('collapsing the noise', () => {
  it('draws fourteen identical events as one row that says fourteen', async () => {
    stub(() =>
      page({
        entries: [
          ...burst(14),
          entry({ id: 'other', ts: NOW - 20_000, summary: 'zsh (default) exited on this machine' })
        ]
      })
    )
    const { container } = render(<ChangeLogPanel servers={SERVERS} />)
    await screen.findByTestId('changelog-entries')

    // Two rows for fifteen entries: the burst, and the one thing that was not
    // the burst. That second row is what the fourteen were burying.
    expect(rows(container)).toHaveLength(2)
    expect(rows(container)[0].textContent).toContain('OpsMaxx itself · fact-changed · Chain305')
    expect(rows(container)[0].textContent).toContain('×14')
    expect(rows(container)[1].textContent).toContain('zsh (default) exited on this machine')

    // And the day heading still counts EVENTS, not rows — a collapsed day that
    // reported "2 changes" would be the same lie in a smaller font.
    expect(container.querySelector('.cl-day-count')?.textContent).toBe('15 changes')
  })

  it('keeps the fourteen, one keystroke away, with their own times and commands', async () => {
    stub(() => page({ entries: burst(14) }))
    const { container } = render(<ChangeLogPanel servers={SERVERS} />)
    await screen.findByTestId('changelog-entries')

    const group = container.querySelector('details.cl-group') as HTMLDetailsElement
    expect(group).not.toBeNull()
    // Closed by default: the point of collapsing is that the page is shorter.
    expect(group.open).toBe(false)
    expect(group.querySelectorAll('li.cl-member')).toHaveLength(14)
    expect(group.textContent).toContain('sample 13')

    await userEvent.click(group.querySelector('summary') as HTMLElement)
    expect(group.open).toBe(true)
  })

  it('does not merge the same event on two different hosts', async () => {
    // (actor, event, target). Dropping the target from the key would report
    // "fact-changed ×2" for two machines, which is the opposite of useful.
    stub(() =>
      page({
        entries: [
          ...burst(3),
          ...burst(2, { hosts: ['web-01'] }).map((e, i) => ({ ...e, id: `web-${i}` }))
        ]
      })
    )
    const { container } = render(<ChangeLogPanel servers={SERVERS} />)
    await screen.findByTestId('changelog-entries')

    expect(rows(container)).toHaveLength(2)
    expect(rows(container)[0].textContent).toContain('Chain305')
    expect(rows(container)[0].textContent).toContain('×3')
    expect(rows(container)[1].textContent).toContain('web-01')
    expect(rows(container)[1].textContent).toContain('×2')
  })

  it('does not merge the same event across a day boundary', async () => {
    stub(() =>
      page({
        entries: [
          ...burst(2),
          ...burst(2, { ts: NOW - 26 * 3_600_000 }).map((e, i) => ({
            ...e,
            id: `y-${i}`,
            ts: NOW - 26 * 3_600_000 - i * 1000
          }))
        ]
      })
    )
    const { container } = render(<ChangeLogPanel servers={SERVERS} />)
    await screen.findByTestId('changelog-entries')

    expect(container.querySelectorAll('.cl-day')).toHaveLength(2)
    expect(rows(container)).toHaveLength(2)
    for (const r of rows(container)) expect(r.textContent).toContain('×2')
  })

  it('leaves a lone event as a plain row rather than an empty disclosure', async () => {
    stub(() => page({ entries: [entry({ ts: NOW })] }))
    const { container } = render(<ChangeLogPanel servers={SERVERS} />)
    await screen.findByTestId('changelog-entries')
    expect(container.querySelector('details.cl-group')).toBeNull()
    expect(screen.queryByTestId('changelog-count')).toBeNull()
  })
})

describe('the answer above the list', () => {
  it('says how many changes, on how many servers, and by whom', async () => {
    stub(() =>
      page({
        entries: [
          ...burst(4),
          entry({ id: 'h', actor: 'human', kind: 'shell', ts: NOW - 60_000, hosts: ['web-01'] }),
          entry({
            id: 'a',
            actor: 'agent',
            kind: 'agent-action',
            summary: 'ran a terminal call',
            ts: NOW - 120_000,
            hosts: ['db-01']
          })
        ]
      })
    )
    render(<ChangeLogPanel servers={SERVERS} />)
    const band = await screen.findByTestId('changelog-summary')

    expect(band.textContent).toContain('6')
    expect(band.textContent).toContain('Servers')
    expect(screen.getByTestId('changelog-by-human').textContent).toContain('1')
    expect(screen.getByTestId('changelog-by-agent').textContent).toContain('1')
    expect(screen.getByTestId('changelog-by-system').textContent).toContain('4')
    // Three servers are named across those six entries.
    const servers = band.querySelectorAll('.kpi')[1]
    expect(servers.textContent).toContain('Servers')
    expect(servers.querySelector('.kpi-value')?.textContent).toBe('3')
  })

  it('does not draw a tile for a class that did nothing', async () => {
    // A permanent "0 agents" tile is a tile people stop reading, and then it
    // says 40 on the day it matters.
    stub(() => page({ entries: burst(3) }))
    render(<ChangeLogPanel servers={SERVERS} />)
    await screen.findByTestId('changelog-summary')
    expect(screen.getByTestId('changelog-by-system')).toBeTruthy()
    expect(screen.queryByTestId('changelog-by-human')).toBeNull()
    expect(screen.queryByTestId('changelog-by-agent')).toBeNull()
  })

  it('never claims a total when main says it cut the page', async () => {
    // The page is capped at 200. "200 changes" would be the coverage lie told
    // by the summary instead of by the timeline.
    stub(() => page({ entries: burst(5), more: true, oldest: NOW - 5000 }))
    render(<ChangeLogPanel servers={SERVERS} />)
    const band = await screen.findByTestId('changelog-summary')
    const changes = band.querySelector('.kpi') as HTMLElement
    expect(changes.querySelector('.kpi-value')?.textContent).toBe('5+')
    expect(changes.textContent).toContain('at least — the page was cut')
  })

  it('names the one event that repeated, and stays quiet when nothing did', async () => {
    // The nearest honest answer to "is any of this unusual": a change log entry
    // carries no severity, so none is invented — but one event repeating far
    // more than the rest is almost always why the page looks as it does.
    stub(() => page({ entries: burst(9) }))
    const first = render(<ChangeLogPanel servers={SERVERS} />)
    const busiest = await screen.findByTestId('changelog-busiest')
    expect(busiest.textContent).toContain('9')
    expect(busiest.textContent).toContain('fact-changed · Chain305')
    first.unmount()

    stub(() => page({ entries: [entry({ ts: NOW }), entry({ id: 'two', ts: NOW - 1000, summary: 'another thing' })] }))
    render(<ChangeLogPanel servers={SERVERS} />)
    await screen.findByTestId('changelog-summary')
    expect(screen.queryByTestId('changelog-busiest')).toBeNull()
  })

  it('shows no band at all when there is nothing to summarise', async () => {
    stub(() => page())
    render(<ChangeLogPanel servers={SERVERS} />)
    await screen.findByTestId('changelog-empty')
    expect(screen.queryByTestId('changelog-summary')).toBeNull()
  })
})

describe('a human, an agent and the machine are three different things', () => {
  it('gives each class its own row class rather than one undifferentiated list', async () => {
    stub(() =>
      page({
        entries: [
          entry({ id: 'h', actor: 'human', kind: 'shell', ts: NOW }),
          entry({ id: 'a', actor: 'agent', kind: 'agent-action', summary: 'x', ts: NOW - 1000 }),
          entry({ id: 's', actor: 'system', kind: 'host', summary: 'y', ts: NOW - 2000 })
        ]
      })
    )
    const { container } = render(<ChangeLogPanel servers={SERVERS} />)
    await screen.findByTestId('changelog-entries')
    const got = rows(container).map((r) => r.className)
    expect(got[0]).toContain('is-human')
    expect(got[1]).toContain('is-agent')
    expect(got[2]).toContain('is-system')
    // Three classes, three different classNames — not three copies of one.
    expect(new Set(got).size).toBe(3)
  })
})

describe('time a person can read', () => {
  it('groups by day and heads today with the word', async () => {
    stub(() =>
      page({
        entries: [
          entry({ id: 'now', ts: NOW, summary: 'today thing' }),
          entry({ id: 'yst', ts: NOW - 26 * 3_600_000, summary: 'yesterday thing' })
        ]
      })
    )
    const { container } = render(<ChangeLogPanel servers={SERVERS} />)
    await screen.findByTestId('changelog-entries')
    const heads = Array.from(container.querySelectorAll('.cl-day-label')).map((h) => h.textContent)
    expect(heads[0]).toBe('Today')
    expect(heads[1]).toBe('Yesterday')
  })

  it('shows the time relative, with the absolute on hover', async () => {
    const ts = NOW - 14 * 60_000
    stub(() => page({ entries: [entry({ ts })] }))
    const { container } = render(<ChangeLogPanel servers={SERVERS} />)
    await screen.findByTestId('changelog-entries')
    const time = container.querySelector('.cl-row time') as HTMLElement
    expect(time.textContent).toBe('14 min ago')
    // The absolute never leaves; it moves to the title.
    expect(time.getAttribute('title')).toContain(new Date(ts).toLocaleTimeString())
  })
})

describe('the coverage caveats are metadata, not a preamble', () => {
  it('is one line when everything read, with the four sources folded behind it', async () => {
    stub(() => page({ entries: [entry({ ts: NOW })] }))
    render(<ChangeLogPanel servers={SERVERS} />)
    const note = await screen.findByTestId('changelog-coverage')

    const details = note.querySelector('details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')?.textContent).toBe(
      'All four records were read in full for this window.'
    )
    // Folded, not deleted: every source is still in the DOM and find-in-page
    // can still open it.
    for (const s of ['local-shell', 'approvals', 'agent-audit', 'history']) {
      expect(details.contains(screen.getByTestId(`changelog-coverage-${s}`))).toBe(true)
    }
  })

  it('says the timeline is incomplete on the line that never folds', async () => {
    stub(() =>
      page({
        entries: [entry({ ts: NOW })],
        coverage: [
          { source: 'local-shell', state: 'read', entries: 1 },
          { source: 'approvals', state: 'unreadable', entries: 0, error: 'EACCES' },
          { source: 'agent-audit', state: 'read', entries: 0 },
          { source: 'history', state: 'truncated', entries: 0, bytesUnread: 467_265 }
        ]
      })
    )
    render(<ChangeLogPanel servers={SERVERS} />)
    const note = await screen.findByTestId('changelog-coverage')
    const summary = note.querySelector('summary') as HTMLElement

    expect(summary.textContent).toContain('This timeline is NOT complete')
    expect(summary.textContent).toContain('one could not be read')
    expect(summary.textContent).toContain('one was read only back to a point')
    expect(note.className).toContain('is-unknown')
    // The byte counts — the sentence that used to be in the third visible
    // paragraph — are behind the disclosure, not in front of it.
    expect(summary.textContent).not.toContain('467265')
    expect(screen.getByTestId('changelog-coverage-history').textContent).toContain('467265')
  })
})

describe('the filters still filter', () => {
  it('re-renders the timeline from the narrowed read', async () => {
    // Not just "the right filter was sent" — the rows on screen afterwards are
    // the narrowed ones. A redesign that kept the dropdowns and stopped
    // repainting would pass the request-shape test and fail a user.
    stub((f) =>
      page({
        entries:
          f.actors?.[0] === 'human'
            ? [entry({ id: 'h', actor: 'human', ts: NOW, summary: 'started a shell' })]
            : [
                entry({ id: 'h', actor: 'human', ts: NOW, summary: 'started a shell' }),
                ...burst(6)
              ]
      })
    )
    const { container } = render(<ChangeLogPanel servers={SERVERS} />)
    await screen.findByTestId('changelog-entries')
    expect(rows(container)).toHaveLength(2)
    expect(screen.getByTestId('changelog-by-system')).toBeTruthy()

    await userEvent.selectOptions(screen.getByLabelText('Who'), 'human')

    await waitFor(() => expect(rows(container)).toHaveLength(1))
    expect(rows(container)[0].textContent).toContain('started a shell')
    // The summary band followed the filter too, rather than still counting the
    // sampler events that are no longer on screen.
    expect(screen.queryByTestId('changelog-by-system')).toBeNull()
    expect(screen.getByTestId('changelog-by-human').querySelector('.kpi-value')?.textContent).toBe(
      '1'
    )
  })

  it('keeps every control the old screen had', async () => {
    stub(() => page({ entries: [entry({ ts: NOW })] }))
    render(<ChangeLogPanel servers={SERVERS} />)
    await screen.findByTestId('changelog-entries')
    for (const label of ['Time range', 'Who', 'What', 'Host']) {
      expect(screen.getByLabelText(label)).toBeTruthy()
    }
    // And the host dropdown still lists the workspace's servers.
    expect(screen.getByLabelText('Host').textContent).toContain('web-01')
    expect(screen.getByLabelText('Host').textContent).toContain('db-01')
  })
})
