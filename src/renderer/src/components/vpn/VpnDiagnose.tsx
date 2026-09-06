import { useState } from 'react'
import { AlertTriangle, Check, CircleSlash, Loader2 } from 'lucide-react'

import type {
  VpnCheckStatus,
  VpnDiagnoseCheck,
  VpnDiagnoseRefusal,
  VpnDiagnoseResult
} from '../../../../shared/vpn'
import { bridgeHas } from '../../lib/bridge'

// The connectivity checklist on the VPN card.
//
// WHY THERE IS A FORM AND NOT A BUTTON. The probe opens a TCP connection to a
// host and port through the operator's tunnel, and there is no address this app
// may pick on their behalf -- a default would be OpsMaxx deciding to talk to
// a third party over somebody's VPN. So the target is typed, and a probe with
// the fields empty still runs: the handshake check needs no target, and
// "connected" with a three-minute-old handshake is the single most useful thing
// this card can tell somebody.
//
// A SKIPPED ROW IS GREY, NOT GREEN. `skipped` means the check did not run and
// always carries its reason. Colouring it like a pass would be the checklist
// telling somebody a question was answered when it was not asked, which is
// worse than having no checklist.

const ROW_LABEL: Record<VpnDiagnoseCheck['name'], string> = {
  handshake: 'Handshake',
  dns: 'DNS through the tunnel',
  tcp: 'TCP reach',
  ipv6: 'IPv6 outside the tunnel',
  server: 'Reaching the VPN server'
}

/** Milliseconds for the probes, seconds for the handshake's age -- the units
 *  are what each check measured, so the label says which. */
function elapsedLabel(c: VpnDiagnoseCheck): string | null {
  if (c.elapsed === undefined) return null
  if (c.name === 'handshake') return `${c.elapsed}s ago`
  return `${c.elapsed} ms`
}

function StatusIcon({ status }: { status: VpnCheckStatus }): React.JSX.Element {
  if (status === 'ok') return <Check size={13} style={{ color: 'var(--ok)' }} />
  if (status === 'failed') return <AlertTriangle size={13} style={{ color: 'var(--danger)' }} />
  return <CircleSlash size={13} style={{ color: 'var(--text-muted)' }} />
}

function isRefusal(r: VpnDiagnoseResult | VpnDiagnoseRefusal): r is VpnDiagnoseRefusal {
  return 'unsupported' in r
}

/**
 * `showTarget` is false for an engine whose probe may only be pointed at the
 * profile's own remotes. Rendering fields the probe ignores would be an input
 * that silently does nothing, which is worse than no input.
 */
export function VpnDiagnose({
  id,
  showTarget = true
}: {
  id: string
  showTarget?: boolean
}): React.JSX.Element | null {
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<VpnDiagnoseResult | VpnDiagnoseRefusal | null>(null)

  // An older preload has no such method. Rendering a button that cannot do
  // anything is worse than rendering nothing.
  if (!bridgeHas(window.opsmaxx?.vpn as Record<string, unknown> | undefined, 'diagnose')) {
    return null
  }

  const run = async (): Promise<void> => {
    setBusy(true)
    // Cleared first: a stale checklist beside a running probe reads as this
    // probe's answer.
    setRes(null)
    try {
      const n = Number.parseInt(port, 10)
      const r = await window.opsmaxx?.vpn.diagnose(id, {
        host: host.trim() || undefined,
        port: Number.isFinite(n) && n > 0 ? n : undefined
      })
      setRes(r ?? { id, unsupported: 'The probe returned nothing.' })
    } catch {
      setRes({ id, unsupported: 'The probe could not be run.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="col" style={{ gap: 6 }}>
      <span className="field-label">Diagnose</span>
      <div className="row" style={{ gap: 6 }}>
        {showTarget && (
          <input
            className="input"
            style={{ flex: 1, minWidth: 0 }}
            placeholder="Host or address on the far side"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            disabled={busy}
          />
        )}
        {showTarget && (
          <input
            className="input"
            style={{ width: 76 }}
            placeholder="Port"
            inputMode="numeric"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            disabled={busy}
          />
        )}
        <button className="btn" onClick={() => void run()} disabled={busy}>
          {busy ? <Loader2 size={13} className="spin" /> : null}
          {busy ? 'Probing' : 'Run'}
        </button>
      </div>
      <span className="faint" style={{ fontSize: 11 }}>
        {showTarget
          ? 'Everything is sent through the tunnel from inside this app: the name is resolved by the tunnel’s own DNS server, never the host resolver. Leave both empty to check only the handshake.'
          : 'This checks whether this machine can reach the server addresses already stored on this profile. It will not connect anywhere else, and it does not validate the server’s certificate.'}
      </span>

      {res !== null && isRefusal(res) && (
        <div className="row" style={{ gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
          <CircleSlash size={13} />
          <span>{res.unsupported}</span>
        </div>
      )}

      {res !== null && !isRefusal(res) && (
        <div className="col" style={{ gap: 4 }}>
          {res.checks.map((c) => (
            <div key={c.name} className="row" style={{ gap: 6, alignItems: 'flex-start' }}>
              <StatusIcon status={c.status} />
              <div className="col" style={{ gap: 1, minWidth: 0 }}>
                <div className="row" style={{ gap: 6 }}>
                  <span style={{ fontSize: 12 }}>{ROW_LABEL[c.name]}</span>
                  {elapsedLabel(c) !== null && (
                    <span className="faint mono" style={{ fontSize: 11 }}>
                      {elapsedLabel(c)}
                    </span>
                  )}
                </div>
                {/* Present on every row, including the passing ones. A checklist
                    whose green rows say nothing teaches people the words only
                    matter when something breaks. */}
                <span className="faint" style={{ fontSize: 11 }}>
                  {c.detail}
                </span>
              </div>
            </div>
          ))}
          {res.latencyMs !== undefined && (
            <span className="faint" style={{ fontSize: 11 }}>
              {/* Named for what was measured. It includes the peer's forwarding
                  and the far service's accept, so calling it a round trip would
                  be a stronger claim than the number supports. */}
              TCP connect took {res.latencyMs} ms through the tunnel.
            </span>
          )}
        </div>
      )}
    </div>
  )
}
