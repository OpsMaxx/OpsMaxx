import { useEffect, useState } from 'react'
import { Monitor, RefreshCw } from 'lucide-react'
import { clsx } from '../../lib/format'
import { useApp } from '../../store/app'
import { LOCAL_TARGET } from '../../../../shared/execTarget'
import {
  filterByProto,
  protoCounts,
  type ListeningPortsInfo,
  type ProtoFilter
} from '../../../../shared/listeningPorts'
import type { NetworkInfo } from '../../../../shared/network'

/**
 * This machine, in the fleet overview.
 *
 * Deliberately NOT a row in the fleet inventory or an entry in the sampler.
 * The sampler writes what it finds into the durable history store keyed by
 * server id, and it is the thing the MCP bridge reads back — so a synthetic
 * entry there would put this laptop's facts into the estate's permanent record
 * and onto a surface local targets are kept off by construction. Instead the
 * card asks for what it shows, on mount, exactly as the per-server monitor
 * asks for its own on-demand facts. See shared/execTarget.ts and
 * tests/localHostPanels.test.tsx.
 *
 * The consequence worth knowing: this is a snapshot, not a live poll. That is
 * the right trade for a card whose contents — what is installed, what is
 * listening — change when somebody deploys rather than every two seconds.
 */
export function LocalHostCard(): React.JSX.Element | null {
  // Absence means enabled, matching main's own copy in services/localGate.ts.
  const enabled = useApp((s) => s.settings.localTerminalEnabled !== false)
  const [net, setNet] = useState<NetworkInfo | { error: string } | null>(null)
  const [ports, setPorts] = useState<ListeningPortsInfo | { error: string } | null>(null)
  const [nonce, setNonce] = useState(0)
  const [busy, setBusy] = useState(false)
  // TCP by default, for the reason the per-server card uses: it is what a
  // terminal shows, and a panel that disagrees with the terminal on the same
  // machine reads as wrong even when it is right.
  const [proto, setProto] = useState<ProtoFilter>('tcp')

  useEffect(() => {
    if (!enabled) return
    let live = true
    setBusy(true)
    const api = window.opsmaxx?.fleet
    void Promise.all([
      // `network`, not `facts`: the sampler's facts are keyed by server id and
      // read from the durable store, which is precisely where this machine does
      // not belong. The on-demand probes take a target and already accept a
      // local one.
      api?.network?.(LOCAL_TARGET)?.catch((e: unknown) => ({
        error: e instanceof Error ? e.message : String(e)
      })),
      api?.listeningPorts?.(LOCAL_TARGET)?.catch((e: unknown) => ({
        error: e instanceof Error ? e.message : String(e)
      }))
    ]).then(([n, p]) => {
      if (!live) return
      setNet((n as NetworkInfo | { error: string }) ?? null)
      setPorts((p as ListeningPortsInfo | { error: string }) ?? null)
      setBusy(false)
    })
    return () => {
      live = false
    }
  }, [enabled, nonce])

  // Off is off: no row, rather than a row that reports a refusal. The switch is
  // a statement about whether this machine is a target at all.
  if (!enabled) return null

  const portList = ports !== null && 'ports' in ports ? ports : null
  const netInfo = net !== null && 'interfaces' in net ? net : null

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div
        className="row"
        style={{ marginBottom: 12, alignItems: 'baseline', gap: 'var(--sp-3)' }}
      >
        <Monitor size={14} className="faint" />
        <span className="sidebar-title">This machine</span>
        <span className="spacer" style={{ flex: 1 }} />
        <button
          className="btn sm"
          disabled={busy}
          onClick={() => setNonce((n) => n + 1)}
          title="Read again"
        >
          <RefreshCw size={12} /> {busy ? 'Reading…' : 'Refresh'}
        </button>
      </div>

      <div className="col" style={{ gap: 6 }}>
        {netInfo !== null && netInfo.interfaces.length > 0 && (
          <div className="row" style={{ alignItems: 'baseline', gap: 'var(--sp-3)' }}>
            <span className="faint" style={{ fontSize: 11, minWidth: 96 }}>
              Addresses
            </span>
            <span className="col" style={{ gap: 2 }}>
              {netInfo.interfaces.map((iface) => (
                <span key={iface.name} className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                  <span className="mono faint" style={{ fontSize: 11, minWidth: 70 }}>
                    {iface.name}
                  </span>
                  <span className="mono selectable">
                    {iface.addresses.map((a) => a.address).join('  ')}
                  </span>
                </span>
              ))}
            </span>
          </div>
        )}

        <div className="row" style={{ alignItems: 'baseline', gap: 'var(--sp-3)' }}>
          <span className="faint" style={{ fontSize: 11, minWidth: 96 }}>
            Listening
          </span>
          <span className="col" style={{ gap: 2 }}>
            {portList === null && <span className="faint">{busy ? 'Reading…' : 'Not read yet'}</span>}
            {portList !== null && portList.ports.length === 0 && (
              <span className="faint">Nothing is listening.</span>
            )}
            {portList !== null && portList.ports.length > 0 && (
              <div className="segment" style={{ marginBottom: 4 }}>
                {(['tcp', 'udp', 'all'] as const).map((f) => (
                  <button
                    key={f}
                    className={clsx('seg-btn', proto === f && 'active')}
                    onClick={() => setProto(f)}
                  >
                    {f === 'all' ? 'All' : f.toUpperCase()}{' '}
                    <span className="count">{protoCounts(portList.ports)[f]}</span>
                  </button>
                ))}
              </div>
            )}
            {portList !== null && filterByProto(portList.ports, proto).length === 0 && (
              <span className="faint">
                Nothing is listening on {proto === 'all' ? 'this machine' : proto.toUpperCase()}.
              </span>
            )}
            {portList && filterByProto(portList.ports, proto).map((p) => (
              <span
                key={`${p.proto}-${p.address}-${p.port}`}
                className="row"
                style={{ gap: 8, alignItems: 'baseline' }}
              >
                <span className="mono selectable" style={{ minWidth: 54 }}>
                  {p.port}
                </span>
                <span className="faint" style={{ fontSize: 11, minWidth: 28 }}>
                  {p.proto}
                </span>
                <span className="mono faint" style={{ fontSize: 11, minWidth: 110 }}>
                  {p.address}
                </span>
                {/* An em dash, not a blank: "we could not see the owner" and
                    "nothing owns this" are different claims. */}
                <span className="mono">{p.process ?? '—'}</span>
              </span>
            ))}
            {portList?.partialOwners && (
              <span className="faint" style={{ fontSize: 11 }}>
                Some owning processes need elevated privileges to see. Every listening socket is
                listed.
              </span>
            )}
          </span>
        </div>

        {/* Said rather than hidden. A card that silently shows less on one OS
            teaches people to distrust it on every OS. */}
        {ports !== null && 'error' in ports && (
          <span className="faint" style={{ fontSize: 11 }}>
            Ports could not be read: {ports.error}
          </span>
        )}
        {net !== null && 'error' in net && (
          <span className="faint" style={{ fontSize: 11 }}>
            Addresses could not be read: {net.error}
          </span>
        )}
      </div>
    </div>
  )
}
