import { useState } from 'react'
import { PackageCheck, TriangleAlert } from 'lucide-react'
import { planEngineUpgrade } from '../../../../shared/engineUpgrade'
import {
  ENGINE_REFUSAL_HELP,
  type EnginePrecheck,
  type EnginePrecheckProbe
} from '../../../../shared/enginePrecheck'
import type { PackageManager } from '../../../../shared/hostFacts'
import type { JobSpec } from '../../../../shared/jobs'

// Item 42's engine upgrade, on screen.
//
// THE PACKAGE BLOCK IS SHOWN, NOT PARSED, and this component is where that
// decision becomes visible: the operator reads what the package manager
// actually said and ticks a box to confirm docker-ce is installed. A parser for
// `dpkg-query` and `rpm -q` could be written; it could not be verified without
// a Linux host carrying Docker's packages, and an unverified parser standing
// between somebody and a SECOND container engine is worse than no parser.
//
// The caveats are not a formality. The first one is always what happens to the
// containers, because that is the thing an operator running this at four in the
// afternoon has not thought about.

export function EngineUpgradePanel({
  manager,
  read,
  onRun
}: {
  /** From host facts. `null` when they have not been collected, which is a
   *  refusal rather than a reason to guess at apt. */
  manager: PackageManager | null
  read: () => Promise<EnginePrecheckProbe>
  /**
   * Hands the spec upward. NOT a job launch of its own: an install with sudo
   * is elevated, the engine re-derives the plan from the spec and refuses a run
   * whose approval record disagrees, and a second launch path here would be a
   * second place for that record to be minted wrongly.
   */
  onRun?: (spec: JobSpec) => void
}): React.JSX.Element {
  const [probe, setProbe] = useState<EnginePrecheckProbe | null>(null)
  const [loading, setLoading] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  const current: EnginePrecheck | null = probe?.ok === true ? probe.precheck : null
  // `manager === null` means facts have not been collected. `planEngineUpgrade`
  // has no answer for that either, so it is refused as unchecked rather than
  // asked about apt on the chance the server runs Debian.
  const plan =
    manager === null
      ? { ok: false as const, refusal: 'unchecked' as const, caveats: [] as string[], spec: null }
      : planEngineUpgrade(manager, current, { precheckRead: confirmed })

  const check = async (): Promise<void> => {
    setLoading(true)
    // A fresh read invalidates a confirmation given against the old one.
    setConfirmed(false)
    try {
      setProbe(await read())
    } catch (e) {
      setProbe({ ok: false, detail: e instanceof Error ? e.message : String(e) })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ marginTop: 8 }}>
      <button className="btn ghost sm" disabled={loading} onClick={() => void check()}>
        <PackageCheck size={12} /> {probe === null ? 'Check the engine' : 'Check again'}
      </button>

      {probe !== null && !probe.ok && (
        <div className="s-note is-alarm">
          <TriangleAlert size={12} /> {probe.detail}
        </div>
      )}

      {current !== null && (
        <>
          {/* Verbatim, because nothing here interprets it. */}
          <pre className="mono" style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: '6px 0' }}>
            {current.packagesText === '' ? 'The package manager said nothing.' : current.packagesText}
          </pre>
          <label className="row" style={{ gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              aria-label="I have read the package list"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>I have read the above and docker-ce is installed on this server.</span>
          </label>
        </>
      )}

      {!plan.ok && plan.refusal !== null && (
        <div className="s-note state-unknown">{ENGINE_REFUSAL_HELP[plan.refusal]}</div>
      )}

      {plan.ok && (
        <>
          {plan.caveats.map((c) => (
            <div key={c} className="s-note warn">
              {c}
            </div>
          ))}
          <button
            className="btn primary sm"
            onClick={() => {
              if (plan.spec !== null) onRun?.(plan.spec)
            }}
          >
            Upgrade the engine
          </button>
        </>
      )}
    </div>
  )
}
