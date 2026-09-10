import { useEffect, useRef, useState } from 'react'
import { bridgeOn } from '../../lib/bridge'
import { clsx } from '../../lib/format'
import { useApp } from '../../store/app'
import type { FleetSweepProgress } from '../../../../shared/fleet'

/**
 * How far the running sweep has got.
 *
 * Every control in the monitor that starts a collection shares this, because
 * they were all inadequate in the same way: a 13px icon spinning inside a
 * ghost button, with the label unchanged. That is nearly invisible, and it
 * cannot say how much is left.
 *
 * How much is left is the part that matters here. The sweep asks servers ONE
 * AT A TIME on purpose — fifteen hosts behind two bastions would otherwise
 * open fifteen channels through two machines at once — and a host that has
 * gone away costs a 45-second timeout before the next is even tried. So a
 * five-server estate with two dead hosts runs for a minute and a half, and for
 * all of it the only feedback was a spinner. Hence the report: pressing the
 * button felt like nothing happened.
 */
export function SweepProgress({
  active,
  label
}: {
  /** True while THIS control is the one waiting. */
  active: boolean
  /** What is being collected, for the progress bar's accessible name. */
  label: string
}): React.JSX.Element | null {
  const [progress, setProgress] = useState<FleetSweepProgress | null>(null)
  const servers = useApp((s) => s.servers)

  /**
   * Subscribed only while this control is waiting.
   *
   * Sweep progress is broadcast to the whole window, and the scheduler starts
   * sweeps by itself every few minutes. Without this gate, three panels open
   * at once would all animate on a sweep nobody asked for — a bar that moves
   * unbidden reads as work the reader caused, which is worse than no bar.
   */
  const live = useRef(false)
  live.current = active
  useEffect(() => {
    if (!active) {
      setProgress(null)
      return
    }
    // Set before the first event so the click changes the screen in the frame
    // it happened in. Resolving targets and waiting out an in-flight sweep can
    // take a second on their own, and a button that looks unpressed for that
    // second is the whole complaint.
    setProgress({ done: 0, total: 0, serverId: null, phase: 'waiting' })
    return bridgeOn('fleet.onProgress', window.opsmaxx?.fleet?.onProgress, (p) => {
      if (live.current) setProgress(p)
    })
  }, [active])

  if (!active) return null
  const determinate = progress !== null && progress.total > 0 && progress.phase === 'sweeping'

  return (
    <div className="check-now-progress" role="status" aria-live="polite">
      <div
        className="check-now-bar"
        role="progressbar"
        aria-label={label}
        {...(determinate
          ? { 'aria-valuemin': 0, 'aria-valuemax': progress.total, 'aria-valuenow': progress.done }
          : {})}
      >
        <span
          className={clsx('check-now-fill', !determinate && 'indeterminate')}
          style={
            determinate
              ? { width: `${Math.round((progress.done / progress.total) * 100)}%` }
              : undefined
          }
        />
      </div>
      <span className="check-now-said">{describe(progress, servers)}</span>
    </div>
  )
}

/**
 * What the sweep is doing, in one line.
 *
 * Names the SERVER, not just a count. "3 of 5" on an estate that has been
 * stuck for forty seconds says nothing about why; "Asking Scanner01 — 3 of 5"
 * points straight at the host that is timing out, which on these screens is
 * usually the thing the reader wanted to know anyway.
 */
function describe(
  p: FleetSweepProgress | null,
  servers: readonly { id: string; name: string }[]
): string {
  // Its own sentence because it is the part that looks most like nothing
  // happening: a sweep started before this click can run for minutes, and this
  // request waits it out before its own begins.
  if (p === null || p.phase === 'waiting') return 'Waiting for the running check to finish…'
  if (p.phase === 'done' || p.total === 0) return 'Finishing up…'
  const name = servers.find((s) => s.id === p.serverId)?.name
  const counted = `${Math.min(p.done + 1, p.total)} of ${p.total}`
  return name ? `Asking ${name} — ${counted}` : `Collecting — ${counted}`
}
