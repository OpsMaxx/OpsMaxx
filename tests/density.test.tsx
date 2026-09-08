// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { InventoryPanel } from '../src/renderer/src/components/monitor/InventoryPanel'
import { ChangeLogPanel } from '../src/renderer/src/components/monitor/ChangeLogPanel'
import { CronPanel } from '../src/renderer/src/components/monitor/CronPanel'
import { useFleet } from '../src/renderer/src/store/fleet'
import {
  FACT_SOURCE_IDS,
  FACT_SOURCE_LABEL,
  type FactSourceId,
  type FactSourceReport,
  type FactStatus,
  type HostFacts
} from '../src/shared/hostFacts'
import type { HostMetrics } from '../src/shared/ssh'
import type { Server } from '../src/renderer/src/types'

// How much of the window is spent before the first row of data.
//
// The measurement that prompted this, on Inventory at 900px tall: the page
// title block ended at 181px; the panel heading, a two-line description, the
// count strip and a four-line caveat ran to 392px; the TABLE HEADER sat at
// 397px. The table then ended at 608px, leaving 264px of dead space below it.
// Forty-four percent of the window spent before the data, on a panel whose
// entire content is the data.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE ASSERTS STRUCTURE AND NEVER A PIXEL COUNT
// ---------------------------------------------------------------------------
//
// jsdom does no layout. Every element it reports is 0×0, so a test here that
// claimed "the first row is above 220px" would be computing that number from an
// assumed character width and an assumed line height and then asserting it as
// though it had been measured. This codebase's governing rule is that a value
// nobody measured must never render as though it were measured, and a test is
// not exempt from it: a fabricated 220px would fail for a font change and pass
// for a regression, which is worse than no test.
//
// So what is held here is the STRUCTURE that produced the height — how many
// blocks stand between the header and the table, and what each is allowed to
// contain. Those are the things that changed, they are exactly checkable, and
// they cannot be satisfied by markup that merely looks shorter.

const MINUTE = 60_000

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

const metrics = (): HostMetrics => ({
  cpu: 1, memPct: 1, memUsed: 1, memTotal: 8 * 1024 * 1024 * 1024,
  cpuCores: null, memAvailable: null, memFree: null, memCache: null,
  diskPct: 1, diskUsed: 1, diskTotal: 2, netRx: 0, netTx: 0, uptime: 100,
  hostname: 'box', kernel: 'Linux 6.8.0-45-generic', cores: 4,
  services: [], listeners: [], listenerSource: 'ss'
})

const sources = (over: Partial<Record<FactSourceId, FactStatus>> = {}): FactSourceReport[] =>
  FACT_SOURCE_IDS.map((id) => ({ id, label: FACT_SOURCE_LABEL[id], status: over[id] ?? 'ok' }))

const facts = (over: Partial<HostFacts> = {}): HostFacts => ({
  distroId: 'ubuntu',
  distroVersion: '24.04',
  prettyName: 'Ubuntu 24.04.1 LTS',
  arch: 'x86_64',
  cpuModel: 'AMD EPYC 7543',
  packageManager: 'apt',
  pendingUpdates: 4,
  securityUpdates: 5,
  rebootRequired: false,
  rebootReason: null,
  virtualisation: 'kvm',
  metadataAt: Date.now() - 30 * MINUTE,
  collectedAt: Date.now(),
  sources: sources(),
  ...over
})

/** An Arch host: pending updates countable, security updates never. It is what
 *  makes the unanswerable caveat render, which is the thing being sized here. */
const archFacts = (): HostFacts =>
  facts({
    distroId: 'arch',
    prettyName: 'Arch Linux',
    packageManager: 'pacman',
    pendingUpdates: 7,
    securityUpdates: null,
    sources: sources({ 'security-updates': 'unsupported' })
  })

function seed(serverId: string, f: HostFacts): void {
  const s = useFleet.getState()
  s.report(serverId, metrics(), Date.now())
  s.reportFacts(serverId, f, Date.now())
}

const SERVERS = [server('srv-u', 'ubuntu-1'), server('srv-a', 'arch-1')]

beforeEach(() => {
  stubBridge({})
  useFleet.setState({ samples: {}, facts: {}, errors: {} })
})

describe('what stands between the header and the table', () => {
  const renderPopulated = (): HTMLElement => {
    seed('srv-u', facts())
    seed('srv-a', archFacts())
    const { container } = render(<InventoryPanel servers={SERVERS} onOpen={() => {}} />)
    return container
  }

  it('leads the card with the count strip and nothing before it', () => {
    // The count strip is the genuine summary and the single most useful thing
    // on the panel — "12 servers · facts for 9 · 3 could not be counted". It
    // used to arrive third, under a heading and a paragraph.
    const card = renderPopulated().querySelector('.bc-panel') as HTMLElement
    expect(card.children[0].className).toContain('panel-stats')
  })

  it('has no paragraph of prose anywhere above the table', () => {
    // The description moved behind the ⓘ. What is allowed to stand between the
    // strip and the table is findings — notes that qualify a number — and
    // nothing else.
    const card = renderPopulated().querySelector('.bc-panel') as HTMLElement
    const table = card.querySelector('.inv-scroll') as HTMLElement
    const before = [...card.children].slice(0, [...card.children].indexOf(table))

    for (const el of before) {
      expect(
        el.className,
        `"${el.textContent?.slice(0, 40)}…" is standing above the table without being a finding`
      ).toMatch(/panel-stats|panel-note/)
    }
  })

  it('keeps each caveat above the table to one always-visible sentence', () => {
    // The caveats are load-bearing and none of them was deleted. What changed
    // is that the FINDING stays and the mechanism folds: "3 servers can never
    // report a security update count, so they are not in the 4 above" is on the
    // page unconditionally, and "Arch and Alpine have no security channel at
    // all, and dnf cannot answer where the repositories publish no updateinfo"
    // is one click under it.
    const card = renderPopulated().querySelector('.bc-panel') as HTMLElement
    const notes = [...card.querySelectorAll('.panel-note')] as HTMLElement[]
    expect(notes.length, 'the fixture must produce at least one caveat').toBeGreaterThan(0)

    for (const note of notes) {
      // The disclosure is removed whole — label included. Its `<summary>` is on
      // screen, but it is a control, not prose, and it is length-checked below.
      const clone = note.cloneNode(true) as HTMLElement
      clone.querySelectorAll('.note-why').forEach((d) => d.remove())
      const visible = clone.textContent ?? ''
      // Two sentences at the very most, and in practice one. Counted rather
      // than eyeballed because "shorten it" is not a thing a diff can enforce.
      const sentences = visible.split('.').filter((s) => s.trim().length > 3)
      expect(sentences.length, `this caveat still runs on: "${visible.trim()}"`).toBeLessThanOrEqual(2)
    }

    // And the disclosure labels are labels — a few words naming what is under
    // them, not the first half of the paragraph they hide.
    for (const summary of [...document.querySelectorAll('.note-why > summary')]) {
      expect(summary.textContent!.length).toBeLessThan(40)
    }
  })

  it('still says the number is short, without anybody having to click', () => {
    // The half of the previous test that matters. Folding is only allowed
    // because this stays true.
    renderPopulated()
    const shown = document.querySelector('.bc-panel')!.textContent!
    expect(shown).toContain('can never report a security update count')
    expect(shown).toContain('never as zero')
  })

  it('folds the mechanism rather than deleting it', async () => {
    // Asserted through `details.open` rather than through the text being
    // absent: jsdom implements no UA stylesheet, so a closed `<details>` still
    // has its children in the tree. Checking the text would pass in a browser
    // where the paragraph is hidden and pass here where it is not, which is a
    // test that cannot tell the two apart.
    renderPopulated()
    const why = document.querySelector('details.note-why') as HTMLDetailsElement
    expect(why, 'the mechanism was deleted rather than folded').not.toBeNull()
    expect(why.open).toBe(false)
    expect(why.textContent).toContain('no security channel at all')

    await userEvent.click(screen.getByText('Why they cannot answer'))
    expect(why.open).toBe(true)
  })
})

describe('the loudest pixel is not the refresh button', () => {
  it('demotes Check now to a ghost once there is something to read', () => {
    seed('srv-u', facts())
    render(<InventoryPanel servers={SERVERS} onOpen={() => {}} />)
    const check = screen.getByRole('button', { name: /Check now/ })
    expect(check.className).toContain('ghost')
    expect(check.className).not.toContain('primary')
  })

  it('spends the accent on Check now only when pressing it IS the task', () => {
    // Nothing collected: the panel has one action and the empty state's own
    // prose names it. One button, in the header where it is on every panel —
    // an empty state that grew a second copy would put two identically-named
    // controls on one screen.
    render(<InventoryPanel servers={SERVERS} onOpen={() => {}} />)
    const checks = screen.getAllByRole('button', { name: /Check now/ })
    expect(checks).toHaveLength(1)
    expect(checks[0].className).toContain('primary')
  })

  it('never has more than one accent control on screen at once', () => {
    seed('srv-u', facts())
    const { container } = render(<InventoryPanel servers={SERVERS} onOpen={() => {}} />)
    expect(container.querySelectorAll('.btn.primary')).toHaveLength(0)
  })
})

describe('a summary of "nothing" does not print the nothing N times', () => {
  it('makes the change log claim its empty window once, not three times', async () => {
    // It said it three times: the purpose line, the "reads four records and
    // stores nothing" note, and an empty state whose body opened with the same
    // five words as its own title.
    stubBridge({
      changelog: {
        read: async () => ({ enabled: true, entries: [], coverage: [], more: false, oldest: null })
      }
    })
    render(<ChangeLogPanel servers={SERVERS} />)
    const empty = await screen.findByTestId('changelog-empty')

    expect(empty.querySelectorAll('p')).toHaveLength(2)
    // And the clause that stops an empty window reading as a quiet week is in
    // the first line rather than the third.
    expect(empty.querySelector('.panel-empty-title')!.textContent).toContain(
      'read the coverage above'
    )
  })

  it('says "not editable" once per host and per reason, not once per row', async () => {
    // Measured: 55 cron lines under "55 jobs across 2 servers", with the same
    // three words in the widest column of 26 of them.
    const entry = (i: number): unknown => ({
      kind: 'cron.d',
      origin: '/etc/cron.d/thing',
      schedule: '0 3 * * *',
      command: `/usr/bin/thing --n=${i}`,
      description: 'At 03:00.',
      user: 'root'
    })
    stubBridge({
      cron: {
        collect: async () => [
          {
            serverId: 'srv-u',
            serverName: 'ubuntu-1',
            entries: [entry(1), entry(2), entry(3), entry(4)],
            sources: [{ id: 'cron.d', label: '/etc/cron.d', status: 'ok', detail: null }]
          }
        ]
      }
    })
    render(<CronPanel servers={SERVERS} />)
    await userEvent.click(screen.getByRole('button', { name: /Read schedules/ }))

    await waitFor(() =>
      expect(screen.getAllByTestId('cron-not-editable-srv-u').length).toBeGreaterThan(0)
    )
    // Four jobs, all from the same source, therefore ONE sentence.
    expect(screen.getAllByTestId('cron-not-editable-srv-u')).toHaveLength(1)
    expect(screen.getAllByTestId('cron-not-editable-srv-u')[0].textContent).toContain('4 of these')
    // And the words are gone from the rows themselves.
    expect(screen.queryByText('not editable')).toBeNull()
  })
})
