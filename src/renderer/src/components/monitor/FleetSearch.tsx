import { useMemo, useState } from 'react'
import { Search, X, Server as ServerIcon, Boxes, Network } from 'lucide-react'
import { useFleet } from '../../store/fleet'
import { bridgeHas } from '../../lib/bridge'
import { searchFleet, coverageSentence, matchKey, type FleetMatch } from '../../lib/fleetSearch'
import { duration } from '../../lib/format'
import type { Server } from '../../types'
import { PanelShell } from './PanelShell'
import { SweepEmpty } from './SweepEmpty'

// Fleet-wide search over what the sampler already knows.
//
// Deliberately not a new activity in the rail: this is the monitor's own data,
// and an eighth icon for it would cost more than it returns. It sits above the
// cards and takes the panel over only while there is a query.

const ICON = {
  host: ServerIcon,
  unit: Boxes,
  port: Network
} as const

// Hoisted out of the render so the element identity is stable across renders —
// a popover whose children are a new tree every keystroke would remount while
// somebody is reading it, and this panel re-renders on every character typed.
const ABOUT = (
  <p>
    Searches what the fleet sampler already knows — unit names, listening ports, distributions
    and server names — across every server in this workspace. Nothing is asked of a host: the
    coverage line above the results says which servers the answer could be drawn from.
  </p>
)

function Row({ m, onOpen }: { m: FleetMatch; onOpen: (serverId: string) => void }): React.JSX.Element {
  const Icon = ICON[m.kind]
  return (
    <button className="fleet-hit" onClick={() => onOpen(m.serverId)} title={`Open ${m.serverName}`}>
      <Icon size={13} className="faint" />
      <b className="mono">{m.label}</b>
      <span className="faint grow">{m.detail}</span>
      {/* `.chip` is the badge idiom here, with .danger/.warn modifiers —
          FleetHealth above uses the same. There is no `.pill` in the
          stylesheet, and inventing one renders unstyled text. */}
      {m.badge && <span className={m.badge === 'failed' ? 'chip danger' : 'chip'}>{m.badge}</span>}
      <span className="faint">{m.serverName}</span>
      {/* The age is not a detail. A search that answers from a sweep four
          minutes old and does not say so is indistinguishable from one that
          just asked the host. */}
      <span className="faint mono">
        {/* An unsampled row has no reading behind it, so there is no age to
            print — `at` is 0 there, and duration(0) draws a confident "56 years
            ago" under a name the app only knows from its own config. */}
        {m.unsampled ? (
          'never sampled'
        ) : (
          <>
            {m.stale ? 'last seen ' : ''}
            {duration(m.at)} ago
          </>
        )}
      </span>
    </button>
  )
}

export function FleetSearch({
  servers,
  onOpen
}: {
  servers: Server[]
  onOpen: (serverId: string) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [sweeping, setSweeping] = useState(false)
  // The sweep is what fills this panel, so the empty state's button has to
  // start one. Everything else here reads the store the sweep writes.
  const sweepNow = async (): Promise<void> => {
    setSweeping(true)
    try {
      if (bridgeHas(window.opsmaxx?.fleet as Record<string, unknown> | undefined, 'sampleNow')) {
        await window.opsmaxx?.fleet?.sampleNow()
      }
    } finally {
      setSweeping(false)
    }
  }
  const samples = useFleet((s) => s.samples)
  const errors = useFleet((s) => s.errors)
  // Hourly, and independent of the samples above. An empty record is the
  // honest input for an estate whose facts have not been collected yet — the
  // coverage sentence then says so rather than the search quietly answering
  // "ubuntu" with nothing.
  const facts = useFleet((s) => s.facts)

  const result = useMemo(
    () =>
      searchFleet(
        { servers: servers.map((s) => ({ id: s.id, name: s.name })), hosts: samples, errors, facts },
        query
      ),
    [servers, samples, errors, facts, query]
  )
  const coverage = coverageSentence(result.coverage)
  const active = query.trim() !== ''
  // `searched` deliberately excludes a host that has a sample but neither
  // probe, so it is no longer the test for "has anything been sampled at all".
  const nothingSampled =
    result.coverage.searched.length === 0 && result.coverage.noProbes.length === 0

  return (
    // The one tab that had NO header at all — no title, no icon, no
    // description — so switching to it left nothing on screen saying which of
    // the fifteen tabs you had landed in except the strip above. It gets the
    // same header as every other tab; the search field is the card's first
    // element, the way Run a command's composer is.
    <PanelShell icon={<Search size={14} />} title="Fleet-wide search" about={ABOUT} className="fleet-search">
      <div className="input-group">
        <Search size={14} className="faint" />
        <input
          className="input"
          placeholder="Search units, ports, distributions and servers across the workspace…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {active && (
          <button className="icon-btn sm" title="Clear" onClick={() => setQuery('')}>
            <X size={13} />
          </button>
        )}
      </div>

      {active && (
        <div className="fleet-results">
          <div className="row muted" style={{ justifyContent: 'space-between' }}>
            <span>
              {result.matches.length} match{result.matches.length === 1 ? '' : 'es'}
              {result.truncated > 0 && ` · ${result.truncated} more not shown`}
            </span>
          </div>

          {/* Always above the results, never below. Someone reading three hits
              needs to know they came from four hosts out of fifteen before they
              conclude anything from the number. */}
          {coverage && <div className="panel-note is-unknown">{coverage}</div>}

          {result.matches.length === 0 && (
            <div className="panel-empty">
              {/* "Nothing was sampled" and "nothing matched" are different
                  answers, and so is "the hosts were sampled but neither probe
                  ran on them" — that last one has a sample and would otherwise
                  be told to turn on background checking it already has on. */}
              {nothingSampled ? (
                // Was: "Turn on background checking, or open a server" — advice
                // that is wrong on the day it matters most, because background
                // checking was already ON and the vault was locked underneath
                // it. SweepEmpty asks the sampler what is actually stopping it
                // and offers the one control that fixes that, which for a
                // locked vault is the unlock prompt rather than a settings tab.
                <SweepEmpty
                  subject="Nothing has been sampled yet."
                  busy={sweeping}
                  onCheckNow={() => void sweepNow()}
                  note="Servers are still matched by name above — everything else here comes from the sweep."
                />
              ) : (
                <>
                  <p className="panel-empty-title">
                    Nothing matched on the servers that could be searched.
                  </p>
                  <p className="panel-empty-body">
                    Try a shorter term — this searches unit names, listening ports, distributions
                    and server names.
                  </p>
                </>
              )}
            </div>
          )}

          {/* The key must be unique per row, not merely descriptive: two sockets
              with the same protocol and port on different addresses share
              kind, server and label. */}
          {result.matches.map((m, i) => (
            <Row key={matchKey(m, i)} m={m} onOpen={onOpen} />
          ))}
        </div>
      )}
    </PanelShell>
  )
}
