import { useCallback, useState } from 'react'
import { RefreshCw, Check, AlertTriangle } from 'lucide-react'
import { clsx } from '../../lib/format'

/**
 * "Check now", and a statement of what it did.
 *
 * Three panels had a button with this label that collected nothing. They
 * called `fleet:facts` and `fleet:access` — both PURE CACHE READS — so the
 * click re-read what was already in memory, re-rendered it unchanged, and
 * looked broken. The estate's facts sit behind an hourly schedule that a
 * requested sweep did not clear, so even the sweep those panels hoped for
 * skipped exactly the data they display.
 *
 * `collectNow` clears the schedules and sweeps. This component exists because
 * the other half of the bug is presentational: a collection that changed
 * nothing and a collection that never happened look identical unless the UI
 * says which. So it reports, every time, in one line — and the three panels
 * share it rather than each inventing their own idea of feedback.
 */

type Phase =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'done'; servers: number; answered: number; at: number }
  | { kind: 'refused'; message: string }

interface CheckNowButtonProps {
  /** Which servers to collect. Empty or omitted means the whole estate. */
  serverIds?: readonly string[]
  /** Re-read the panel's own data once the sweep has landed. */
  onCollected?: () => void | Promise<void>
  /** Solid only where it is the one thing left to do — an empty table. */
  primary?: boolean
  disabled?: boolean
  /** What this collects, for the tooltip: "facts", "keys and access". */
  collects: string
}

export function CheckNowButton({
  serverIds,
  onCollected,
  primary = false,
  disabled = false,
  collects
}: CheckNowButtonProps): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const working = phase.kind === 'working'

  const run = useCallback(async (): Promise<void> => {
    setPhase({ kind: 'working' })
    const bridge = window.opsmaxx?.fleet
    // The bridge can genuinely be missing a method: the renderer hot-reloads
    // while the process keeps the preload it booted with, so a method added
    // this session is undefined for the rest of it.
    if (!bridge || typeof bridge.collectNow !== 'function') {
      setPhase({
        kind: 'refused',
        message: 'Restart OpsMaxx to use this — the window is newer than the process behind it.'
      })
      return
    }
    try {
      const r = await bridge.collectNow(serverIds ? [...serverIds] : undefined)
      if (!r?.swept) {
        setPhase({
          kind: 'refused',
          message:
            r?.reason === 'disabled'
              ? 'Fleet sampling is switched off, so nothing was collected. Turn it on in Settings.'
              : 'No servers are being sampled in this workspace, so there was nothing to collect.'
        })
        return
      }
      await onCollected?.()
      setPhase({
        kind: 'done',
        servers: r.servers,
        answered: r.answered ?? r.servers,
        at: Date.now()
      })
    } catch (e) {
      setPhase({
        kind: 'refused',
        message: e instanceof Error ? e.message : 'The check could not be run.'
      })
    }
  }, [serverIds, onCollected])

  return (
    <div className="check-now">
      <button
        className={primary ? 'btn primary sm' : 'btn ghost sm'}
        disabled={disabled || working}
        onClick={() => void run()}
        title={`Collects ${collects} from every selected server now, ignoring the hourly schedule.`}
      >
        <RefreshCw size={13} className={clsx(working && 'spin')} />
        {working ? 'Checking…' : 'Check now'}
      </button>

      {/**
       * The result, in words.
       *
       * `aria-live` because this is the answer to "did that do anything", and
       * a sighted user gets it by watching the line appear. The icon is never
       * the only carrier.
       */}
      {phase.kind !== 'idle' && !working && (
        <span
          className={clsx('check-now-said', phase.kind === 'refused' && 'warn')}
          aria-live="polite"
        >
          {phase.kind === 'done' ? (
            /**
             * What answered, and what did not. "Collected from 5 servers" on
             * an estate where all five refused looks like success and is the
             * same lie as a button that does nothing — so the shortfall is
             * named whenever there is one.
             */
            phase.answered === phase.servers ? (
              <>
                <Check size={12} />
                Collected from {phase.servers} {phase.servers === 1 ? 'server' : 'servers'}
              </>
            ) : (
              <span className="check-now-said warn">
                <AlertTriangle size={12} />
                {phase.answered === 0
                  ? `No server answered — ${phase.servers === 1 ? 'it' : 'none of the ' + phase.servers} could be reached`
                  : `Collected from ${phase.answered} of ${phase.servers}; the rest did not answer`}
              </span>
            )
          ) : (
            <>
              <AlertTriangle size={12} />
              {phase.message}
            </>
          )}
        </span>
      )}
    </div>
  )
}
