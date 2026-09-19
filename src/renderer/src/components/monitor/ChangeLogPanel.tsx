import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Bot,
  ChevronRight,
  Database,
  History,
  Play,
  RefreshCw,
  Server as ServerIcon,
  ShieldCheck,
  SquareTerminal,
  User
} from 'lucide-react'
import { clsx } from '../../lib/format'
import { openSettings } from '../../store/nav'
import {
  CHANGELOG_KINDS,
  CHANGELOG_SWITCH_OFF,
  CHANGELOG_SWITCH_ON,
  changeLogCoverageText,
  type ChangeLogActor,
  type ChangeLogBridge,
  type ChangeLogCoverage,
  type ChangeLogEntry,
  type ChangeLogFilter,
  type ChangeLogKind,
  type ChangeLogPage
} from '../../../../shared/changelog'
import type { Server } from '../../types'
import { NoteWhy, PanelShell } from './PanelShell'

// "What did I change on Tuesday." — roadmap item 14, the view.
//
// One timeline over four append-only records that never met: the local session
// log, the approval log, the agent audit log and the durable store's events.
// The merge, the ordering and the redaction all happen in main; this renders
// what came back and — the part that matters — renders what did NOT.
//
// THE COVERAGE LINES ARE NOT DECORATION. A timeline is read as a complete
// account of a period, so a source that was missing, unreadable or truncated
// has to say so IN the timeline; leaving it out turns "I could not read the
// approval log" into "you approved nothing that day". That is the failure
// alertCoverage.ts was written for one level up, and the sentences here come
// from the same place its sentences do — a function over what actually
// happened, never a paraphrase written beside a switch.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCREEN WAS, AND WHY IT IS NOT THAT ANY MORE
// ---------------------------------------------------------------------------
//
// It was four dropdowns, three paragraphs of coverage prose, and then a flat
// list of undifferentiated rows. Measured on a real estate: eighteen visible
// rows, fourteen of them `OpsMaxx itself · fact-changed · Chain305`, several
// sharing a timestamp. Three things were wrong with that and only the third is
// cosmetic:
//
//  1. NO ANSWER. A change log is opened to ask "what did we do" or "why did
//     this break". A list answers neither until you have read all of it, and
//     the list is capped at 200 rows. The summary band answers both in one
//     glance, and it is built from the page — never from a second read, and
//     never claiming a total the page does not contain (see `more`).
//
//  2. NO RANK. "The sampler noticed a fact changed" and "you approved a
//     restart on prod" arrived at the same visual weight. They are not the
//     same class of event: one is a thing a person DID and the other is a
//     thing the machine OBSERVED, and the shared vocabulary already knows the
//     difference (ChangeLogActor, three values, deliberately not two). The
//     three classes now differ in colour, in left edge and in icon.
//
//  3. NO COLLAPSING. Fourteen identical rows are one fact — "Chain305's facts
//     changed 14 times" — and the fourteen rows crowded out the four that were
//     not identical. Identical (actor, kind, summary, target) within a day
//     collapse to one expandable row.
//
// THE ORDERING IS STILL NOT OURS. `shared/changelog.ts` owns it, it is total,
// and a second opinion here is how two screens end up disagreeing about what
// happened when. Nothing below sorts: day sections are cut run-length as the
// given order crosses midnight, and a collapsed group takes the position of
// its FIRST member. An entry can therefore move up within its own day section
// and can never move anywhere else.

const WINDOWS: { id: string; label: string; short: string; ms: number | null }[] = [
  { id: '24h', label: 'Last 24 hours', short: 'in the last 24 hours', ms: 86_400_000 },
  { id: '7d', label: 'Last 7 days', short: 'in the last 7 days', ms: 7 * 86_400_000 },
  { id: '30d', label: 'Last 30 days', short: 'in the last 30 days', ms: 30 * 86_400_000 },
  { id: 'all', label: 'Everything kept', short: 'across everything kept', ms: null }
]

const ACTOR_LABEL: Record<ChangeLogActor, string> = {
  human: 'You',
  agent: 'An agent',
  // Not a person and not an agent. A host that went unreachable at 03:00 was
  // nobody's doing, and filing it under either of the other two would make
  // this screen answer "what did I do" with something nobody did.
  system: 'OpsMaxx itself'
}

/** The plural the summary band counts in. `ACTOR_LABEL` is the row's voice
 *  ("You · started a shell"); a tile is a heading over a number. */
const ACTOR_TILE: Record<ChangeLogActor, { label: string; sub: string }> = {
  human: { label: 'You', sub: 'done by a person at this app' },
  agent: { label: 'Agents', sub: 'done through the MCP bridge' },
  system: { label: 'OpsMaxx itself', sub: 'observed, not done by anyone' }
}

/** Ranked, and the rank is the point: a person's actions lead, an agent's
 *  follow, and what nobody did comes last. */
const ACTOR_ORDER: ChangeLogActor[] = ['human', 'agent', 'system']

const KIND_LABEL: Record<ChangeLogKind, string> = {
  shell: 'Local shells',
  approval: 'Approvals',
  'agent-action': 'Agent actions',
  job: 'Jobs',
  host: 'Hosts',
  store: 'The store itself'
}

/** One icon per event class, so a row is recognisable before it is read. The
 *  ACTOR is carried by colour and the left edge; the KIND is carried by this. */
function KindIcon({ kind }: { kind: ChangeLogKind }): React.JSX.Element {
  const size = 13
  if (kind === 'shell') return <SquareTerminal size={size} />
  if (kind === 'approval') return <ShieldCheck size={size} />
  if (kind === 'agent-action') return <Bot size={size} />
  if (kind === 'job') return <Play size={size} />
  if (kind === 'host') return <ServerIcon size={size} />
  return <Database size={size} />
}

function ActorTileIcon({ actor }: { actor: ChangeLogActor }): React.JSX.Element {
  if (actor === 'agent') return <Bot size={13} />
  if (actor === 'human') return <User size={13} />
  return <ServerIcon size={13} />
}

function bridge(): Partial<ChangeLogBridge> | undefined {
  return (window.opsmaxx as unknown as { changelog?: Partial<ChangeLogBridge> } | undefined)
    ?.changelog
}

function absolute(ts: number): string {
  const d = new Date(ts)
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`
}

/**
 * Relative, with the absolute on hover.
 *
 * "14 min ago" is what a person reading a change log at 3am is actually doing
 * arithmetic on; `9/19/2026 8:09:09 PM` made them do it themselves, fourteen
 * times in a column. The absolute never leaves — it is the `title`, and it is
 * also the day heading above every row.
 */
function ago(ts: number, now: number): string {
  const secs = Math.floor((now - ts) / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} d ago`
  return new Date(ts).toLocaleDateString()
}

function dayKey(ts: number): string {
  return new Date(ts).toDateString()
}

function dayLabel(key: string, now: number): string {
  if (key === dayKey(now)) return 'Today'
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  if (key === y.toDateString()) return 'Yesterday'
  const d = new Date(key)
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    // A change log is read a year later. Dropping the year is fine for this
    // week and wrong for the row that turns out to be from last September.
    ...(d.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' })
  })
}

// ---------------------------------------------------------------------------
// Collapsing
// ---------------------------------------------------------------------------

export interface ChangeLogGroup {
  key: string
  /** Every member, in the order main gave them. `[0]` is the group's face. */
  entries: ChangeLogEntry[]
  actor: ChangeLogActor
  kind: ChangeLogKind
  summary: string
  /** Display names. Empty means the entry names no server, which is a fact
   *  about the entry and not a missing value — see hostFilterHidUnattributed. */
  targets: string[]
}

export interface ChangeLogDay {
  key: string
  label: string
  groups: ChangeLogGroup[]
  /** Entries, not groups. The heading counts what happened, not what it drew. */
  count: number
}

/** The host names an entry is about, resolved. The store keeps a server ID and
 *  nothing else, and a year later a uuid is not a host — but a host that has
 *  since been REMOVED falls back to its id rather than to nothing, because an
 *  empty cell reads as "no host", which is the wrong fact. */
function targetsOf(e: ChangeLogEntry, nameOf: (id: string) => string): string[] {
  if (e.hosts.length > 0) return e.hosts
  return e.hostId === null ? [] : [nameOf(e.hostId)]
}

/**
 * Day sections, and identical events collapsed inside them.
 *
 * Exported because the collapsing is the one piece of real logic on this
 * screen and it should be arguable without a DOM.
 *
 * Two rules, both conservative:
 *  - Day sections are cut RUN-LENGTH. Crossing midnight in the given order
 *    starts a section; a day that reappears later starts another one. A map
 *    keyed by day would look tidier and would silently reorder a page whose
 *    order this panel does not own.
 *  - A group is keyed by (actor, kind, summary, targets) and lives inside one
 *    day section. `detail` is deliberately NOT in the key and deliberately not
 *    shown on a collapsed row: two rows with the same summary can carry
 *    different commands, and showing the first member's would be a claim about
 *    the other thirteen.
 */
export function groupChangeLog(
  entries: ChangeLogEntry[],
  nameOf: (id: string) => string,
  now: number
): ChangeLogDay[] {
  const days: ChangeLogDay[] = []
  let day: ChangeLogDay | null = null
  let index = new Map<string, ChangeLogGroup>()

  for (const e of entries) {
    const key = dayKey(e.ts)
    if (day === null || day.key !== key) {
      day = { key, label: dayLabel(key, now), groups: [], count: 0 }
      days.push(day)
      index = new Map()
    }
    day.count += 1

    const targets = targetsOf(e, nameOf)
    const gk = `${e.actor} ${e.kind} ${e.summary} ${targets.join('')}`
    const existing = index.get(gk)
    if (existing !== undefined) {
      existing.entries.push(e)
      continue
    }
    const group: ChangeLogGroup = {
      key: `${e.id}:${gk}`,
      entries: [e],
      actor: e.actor,
      kind: e.kind,
      summary: e.summary,
      targets
    }
    index.set(gk, group)
    day.groups.push(group)
  }

  return days
}

// ---------------------------------------------------------------------------
// The answer, before the list
// ---------------------------------------------------------------------------

export interface ChangeLogSummary {
  total: number
  hosts: number
  byActor: Record<ChangeLogActor, number>
  /** The largest collapsed group, when it is large enough to be the reason the
   *  page looks the way it does. Null when nothing repeats meaningfully. */
  busiest: { count: number; what: string } | null
}

/** Loud enough to be worth a tile. Two of a thing is a coincidence. */
const BUSIEST_MIN = 3

export function summariseChangeLog(days: ChangeLogDay[]): ChangeLogSummary {
  const byActor: Record<ChangeLogActor, number> = { human: 0, agent: 0, system: 0 }
  const hosts = new Set<string>()
  let total = 0
  let busiest: ChangeLogSummary['busiest'] = null

  for (const day of days) {
    total += day.count
    for (const g of day.groups) {
      byActor[g.actor] += g.entries.length
      for (const t of g.targets) hosts.add(t)
      if (g.entries.length >= BUSIEST_MIN && (busiest === null || g.entries.length > busiest.count)) {
        busiest = {
          count: g.entries.length,
          what: g.targets.length > 0 ? `${g.summary} · ${g.targets.join(', ')}` : g.summary
        }
      }
    }
  }

  return { total, hosts: hosts.size, byActor, busiest }
}

/**
 * One line about completeness, standing in front of four paragraphs.
 *
 * PanelShell's header draws the line this has to respect: a LIMIT OF THE
 * READING stays on the page, only the EXPLANATION folds. So the finding — "one
 * of four records is incomplete" — is the `<summary>` of a `<details>` and is
 * always rendered; the per-source prose is the body. A reader who never opens
 * it still cannot conclude the week was quiet.
 */
function coverageHeadline(coverage: ChangeLogCoverage[]): { text: string; incomplete: boolean } {
  const bad = coverage.filter((r) => r.state !== 'read')
  if (bad.length === 0) {
    return { text: 'All four records were read in full for this window.', incomplete: false }
  }
  const names = bad.map((r) => {
    if (r.state === 'unreadable') return 'one could not be read'
    if (r.state === 'truncated') return 'one was read only back to a point'
    if (r.state === 'absent') return 'one does not exist yet'
    if (r.state === 'off') return 'one was not opened'
    return 'one had lines that would not parse'
  })
  return {
    text: `This timeline is NOT complete: of four records, ${[...new Set(names)].join(', ')}. What is missing is listed here.`,
    incomplete: true
  }
}

// ---------------------------------------------------------------------------

export function ChangeLogPanel({ servers }: { servers: Server[] }): React.JSX.Element {
  // main does not hold the workspace's server list — the renderer does — so the
  // name is resolved here.
  const nameOf = useCallback(
    (id: string): string => servers.find((s) => s.id === id)?.name ?? id,
    [servers]
  )
  const [windowId, setWindowId] = useState('7d')
  const [actor, setActor] = useState<ChangeLogActor | 'any'>('any')
  const [kind, setKind] = useState<ChangeLogKind | 'any'>('any')
  const [host, setHost] = useState('')
  const [page, setPage] = useState<ChangeLogPage | null>(null)
  const [reading, setReading] = useState(false)
  // A bridge older than this renderer, which happens under `electron-vite dev`
  // for the rest of a session. Said out loud rather than rendered as an empty
  // timeline, which would read as "nothing happened".
  const [unavailable, setUnavailable] = useState(false)
  // Frozen per read, not read from the clock per row: 200 rows each asking
  // Date.now() render "3 min ago" and "2 min ago" for the same instant.
  const [readAt, setReadAt] = useState(() => Date.now())

  const filter = useMemo<ChangeLogFilter>(() => {
    const w = WINDOWS.find((x) => x.id === windowId) ?? WINDOWS[1]
    return {
      ...(w.ms === null ? {} : { from: Date.now() - w.ms }),
      ...(actor === 'any' ? {} : { actors: [actor] }),
      ...(kind === 'any' ? {} : { kinds: [kind] }),
      ...(host === '' ? {} : { hosts: [host] })
    }
  }, [windowId, actor, kind, host])

  const read = useCallback(async (): Promise<void> => {
    const api = bridge()
    if (typeof api?.read !== 'function') {
      setUnavailable(true)
      return
    }
    setReading(true)
    try {
      setPage(await api.read(filter))
      setReadAt(Date.now())
      setUnavailable(false)
    } finally {
      setReading(false)
    }
  }, [filter])

  useEffect(() => {
    void read()
  }, [read])

  const days = useMemo(
    () => (page === null ? [] : groupChangeLog(page.entries, nameOf, readAt)),
    [page, nameOf, readAt]
  )
  const stats = useMemo(() => summariseChangeLog(days), [days])

  // Whether pressing Refresh is the task, or a way of disturbing an answer that
  // is already on screen. It decides which of the two ranks the button wears.
  const nothingToShow = page === null || page.entries.length === 0
  const windowShort = (WINDOWS.find((w) => w.id === windowId) ?? WINDOWS[1]).short
  const coverage = page === null ? null : coverageHeadline(page.coverage)

  return (
    <PanelShell
      icon={<History size={14} />}
      title="Change log"
      about={
        <>
          <p>
            What OpsMaxx itself changed on the estate, and when — with the coverage of each
            source stated, so a quiet window is not read as a quiet week.
          </p>
          <p data-testid="changelog-on">{CHANGELOG_SWITCH_ON}</p>
        </>
      }
      actions={
        // Solid only while there is nothing to read past — with a timeline on
        // screen, the timeline is the point and re-reading it is not.
        <button
          className={nothingToShow ? 'btn primary sm' : 'btn ghost sm'}
          onClick={() => void read()}
          disabled={reading}
        >
          <RefreshCw size={13} className={clsx(reading && 'spin')} /> Refresh
        </button>
      }
    >
      {unavailable && (
        <div className="panel-note is-alarm" data-testid="changelog-unavailable">
          The change log could not be read: this window is newer than the preload script it booted
          with. Restart the app to rebuild it. Nothing below is a statement about what happened.
        </div>
      )}

      {page !== null && !page.enabled && (
        <div className="panel-note is-unknown" data-testid="changelog-off">
          {CHANGELOG_SWITCH_OFF}{' '}
          <button className="btn ghost sm" onClick={() => openSettings('modules')}>
            Modules
          </button>
        </div>
      )}

      {page?.enabled === true && (
        <>
          <div className="cl-toolbar">
            <select
              className="input sm"
              aria-label="Time range"
              value={windowId}
              onChange={(e) => setWindowId(e.target.value)}
            >
              {WINDOWS.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label}
                </option>
              ))}
            </select>
            <select
              className="input sm"
              aria-label="Who"
              value={actor}
              onChange={(e) => setActor(e.target.value as ChangeLogActor | 'any')}
            >
              <option value="any">Anyone</option>
              {(Object.keys(ACTOR_LABEL) as ChangeLogActor[]).map((a) => (
                <option key={a} value={a}>
                  {ACTOR_LABEL[a]}
                </option>
              ))}
            </select>
            <select
              className="input sm"
              aria-label="What"
              value={kind}
              onChange={(e) => setKind(e.target.value as ChangeLogKind | 'any')}
            >
              <option value="any">Everything</option>
              {CHANGELOG_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
            <select
              className="input sm"
              aria-label="Host"
              value={host}
              onChange={(e) => setHost(e.target.value)}
            >
              <option value="">Every server</option>
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          {/* THE ANSWER, BEFORE THE LIST.
              Every number here is counted off the page that is on screen — not
              off a second read, and never off the window. The page is capped,
              so when main says it cut one, the count wears a `+` and says why.
              A tile that claimed "142 changes" when it meant "the newest 142 of
              an unknown number" would be the same lie the coverage rows exist
              to prevent, told by the summary instead of by the timeline. */}
          {page.entries.length > 0 && (
            <section className="kpi-band" aria-label="What changed" data-testid="changelog-summary">
              <div className="kpi">
                <div className="kpi-top">
                  <span className="kpi-icon">
                    <History size={13} />
                  </span>
                  <span className="kpi-label">Changes</span>
                </div>
                <div className="kpi-value">
                  {stats.total}
                  {page.more && <span className="kpi-unit">+</span>}
                </div>
                <div className="kpi-sub">
                  {page.more ? 'at least — the page was cut' : windowShort}
                </div>
              </div>

              <div className="kpi">
                <div className="kpi-top">
                  <span className="kpi-icon">
                    <ServerIcon size={13} />
                  </span>
                  <span className="kpi-label">Servers</span>
                </div>
                <div className="kpi-value">{stats.hosts}</div>
                <div className="kpi-sub">
                  {stats.hosts === 0 ? 'none of this names a server' : 'named on these changes'}
                </div>
              </div>

              {/* One tile per class PRESENT. A permanent "0 agents" tile is a
                  tile people stop reading, and then it says 40 on the day it
                  matters — the rule the fleet band already follows. */}
              {ACTOR_ORDER.filter((a) => stats.byActor[a] > 0).map((a) => (
                <div key={a} className={`kpi cl-kpi is-${a}`} data-testid={`changelog-by-${a}`}>
                  <div className="kpi-top">
                    <span className="kpi-icon">
                      <ActorTileIcon actor={a} />
                    </span>
                    <span className="kpi-label">{ACTOR_TILE[a].label}</span>
                  </div>
                  <div className="kpi-value">{stats.byActor[a]}</div>
                  <div className="kpi-sub">{ACTOR_TILE[a].sub}</div>
                </div>
              ))}

              {/* The closest thing to "is any of this unusual" that the data
                  actually supports. There is no severity on a change log entry
                  and none is invented here: what IS knowable is that one event
                  repeated far more than the rest, which is almost always the
                  reason the page looks the way it does. */}
              {stats.busiest !== null && (
                <div className="kpi" data-testid="changelog-busiest">
                  <div className="kpi-top">
                    <span className="kpi-icon">
                      <AlertTriangle size={13} />
                    </span>
                    <span className="kpi-label">Repeated most</span>
                  </div>
                  <div className="kpi-value">
                    <span className="kpi-unit">×</span>
                    {stats.busiest.count}
                  </div>
                  <div className="kpi-sub" title={stats.busiest.what}>
                    {stats.busiest.what}
                  </div>
                </div>
              )}
            </section>
          )}

          {/* Coverage: one line that always renders, four paragraphs that fold.
              The finding stays; the mechanism moves behind a disclosure that
              find-in-page can still open. */}
          <div
            className={clsx('panel-note cl-coverage-note', coverage!.incomplete && 'is-unknown')}
            data-testid="changelog-coverage"
          >
            {coverage!.incomplete && <AlertTriangle size={13} className="cl-coverage-warn" />}
            <NoteWhy summary={coverage!.text}>
              <div className="cl-coverage">
                {page.coverage.map((row) => (
                  <p
                    key={row.source}
                    className={clsx(
                      'cl-coverage-row',
                      // Unreadable and truncated are both "we do not know", not
                      // "we found something bad".
                      (row.state === 'unreadable' || row.state === 'truncated') && 'is-unknown'
                    )}
                    data-testid={`changelog-coverage-${row.source}`}
                  >
                    {changeLogCoverageText(row)}
                  </p>
                ))}
              </div>
            </NoteWhy>
          </div>

          {page.hostFilterHidUnattributed !== undefined && (
            <div className="panel-note is-unknown" data-testid="changelog-host-filter-note">
              {page.hostFilterHidUnattributed} entries in this window name no server at all — a local
              shell, or a job that had not reached one — so filtering by server hides them. They are
              not absent; they are unattributed.
            </div>
          )}

          {page.more && (
            <div className="panel-note" data-testid="changelog-more">
              More entries matched than fit on one page. The oldest shown is{' '}
              {page.oldest === null ? 'unknown' : absolute(page.oldest)}; narrow the window to see
              further back.
            </div>
          )}

          {page.entries.length === 0 ? (
            // The sentence is kept word for word — a test guards it, and it is
            // the one claim this panel exists to make.
            <div className="panel-empty" data-testid="changelog-empty">
              <p className="panel-empty-title">
                Nothing matched this window — read the coverage above before reading that as a
                quiet period.
              </p>
              <p className="panel-empty-body">
                Widening the time range, or clearing the server filter, is the next thing to try.
              </p>
            </div>
          ) : (
            <div className="cl-timeline" data-testid="changelog-entries">
              {days.map((day) => (
                <section key={day.key} className="cl-day" data-testid={`changelog-day-${day.key}`}>
                  <h3 className="cl-day-head">
                    <span className="cl-day-label">{day.label}</span>
                    <span className="cl-day-count">
                      {day.count} {day.count === 1 ? 'change' : 'changes'}
                    </span>
                  </h3>
                  {day.groups.map((g) => (
                    <GroupRow key={g.key} group={g} now={readAt} />
                  ))}
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </PanelShell>
  )
}

/**
 * One row, which is one event or fourteen of the same event.
 *
 * A group of one is a plain row and not a `<details>` with nothing in it: a
 * disclosure triangle that opens onto the line you are already reading trains
 * people not to press the ones that matter.
 */
function GroupRow({ group, now }: { group: ChangeLogGroup; now: number }): React.JSX.Element {
  const first = group.entries[0]
  const n = group.entries.length
  const cls = clsx('cl-row', `is-${group.actor}`)

  const face = (
    <>
      <span className="cl-icon" aria-hidden>
        <KindIcon kind={group.kind} />
      </span>
      <span className="cl-line">
        <b className="cl-actor">{ACTOR_LABEL[group.actor]}</b> · {group.summary}
        {group.targets.length > 0 && (
          <span className="cl-target"> · {group.targets.join(', ')}</span>
        )}
        {n > 1 && (
          <span className="cl-count" data-testid="changelog-count">
            ×{n}
          </span>
        )}
      </span>
      <time
        className="cl-time"
        dateTime={new Date(first.ts).toISOString()}
        title={n > 1 ? `Newest of ${n}: ${absolute(first.ts)}` : absolute(first.ts)}
      >
        {ago(first.ts, now)}
      </time>
    </>
  )

  if (n === 1) {
    return (
      <div className={cls}>
        {face}
        {first.detail.length > 0 && (
          <span className="cl-detail mono">{first.detail.join(' · ')}</span>
        )}
      </div>
    )
  }

  return (
    <details className="cl-group">
      <summary className={cls}>
        <ChevronRight size={12} className="cl-chev" aria-hidden />
        {face}
      </summary>
      <ul className="cl-members">
        {group.entries.map((e) => (
          <li key={e.id} className="cl-member">
            <time className="cl-time" dateTime={new Date(e.ts).toISOString()} title={absolute(e.ts)}>
              {ago(e.ts, now)}
            </time>
            <span className="cl-detail mono">
              {e.detail.length > 0 ? e.detail.join(' · ') : absolute(e.ts)}
            </span>
          </li>
        ))}
      </ul>
    </details>
  )
}
