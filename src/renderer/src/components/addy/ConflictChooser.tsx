import { useEffect, useState } from 'react'
import { GitMerge, AlertTriangle } from 'lucide-react'
import type { ConflictCopy } from '../../../../shared/addy'

/**
 * Two versions of the same thing, and a person deciding.
 *
 * SHOWS BOTH COPIES, not just the one that lost. A chooser that showed only
 * the loser would be asking somebody to decide against something they cannot
 * see -- and the commonest right answer is not "keep one" but "these differ in
 * one entry and I want both", which needs the pair on screen.
 *
 * The third button exists for that. "Keep both" is not a merge algorithm and
 * does not pretend to be: it concatenates two lists and lets the user delete
 * what they do not want afterwards, which is a worse outcome than a real merge
 * and a much better one than silently losing an entry.
 */
export function ConflictChooser(): React.JSX.Element | null {
  const [conflicts, setConflicts] = useState<ConflictCopy[]>([])
  const [busy, setBusy] = useState(false)

  const refresh = async (): Promise<void> => {
    const list = await window.opsmaxx?.addy.conflicts()
    setConflicts(list ?? [])
  }

  useEffect(() => {
    void refresh()
  }, [])

  const current = conflicts[0]
  if (!current) return null

  const act = (run: () => Promise<unknown>): void => {
    setBusy(true)
    void run()
      .then(refresh)
      .finally(() => setBusy(false))
  }

  const bothArrays = Array.isArray(current.losing) && Array.isArray(current.winning)

  return (
    <div className="conflict-scrim" role="dialog" aria-modal="true">
      <div className="conflict">
        <GitMerge size={26} aria-hidden className="conflict-icon" />
        <h2>Two devices changed “{current.collection}” at the same time</h2>
        <p className="fine">
          Neither version was thrown away. Pick the one to keep, or keep both and tidy up
          afterwards.
        </p>

        {current.problem && (
          <div className="conflict-problem" role="alert">
            <AlertTriangle size={15} aria-hidden />
            {/* Shown rather than hidden: a conflict that vanishes from the
                list is a decision nobody gets to make, and the data is still
                on the relay costing quota. */}
            <span>This copy could not be opened on this device: {current.problem}</span>
          </div>
        )}

        <div className="conflict-pair">
          <section>
            <h3>What is on the relay now</h3>
            <pre>{preview(current.winning)}</pre>
          </section>
          <section>
            <h3>
              The copy from another device
              <span className="conflict-when">{when(current.createdAt)}</span>
            </h3>
            <pre>{preview(current.losing)}</pre>
          </section>
        </div>

        <div className="conflict-actions">
          <button
            className="btn"
            disabled={busy}
            onClick={() => act(() => window.opsmaxx!.addy.discardConflict(current.id))}
          >
            Keep what is on the relay
          </button>
          <button
            className="btn"
            disabled={busy || current.losing === undefined}
            onClick={() =>
              act(() =>
                window.opsmaxx!.addy.resolveConflict(current.id, current.collection, current.losing)
              )
            }
          >
            Keep the other copy
          </button>
          {/* Only where both sides are lists. Offering "keep both" for two
              objects would mean inventing a merge, and a merge invented in a
              dialog is one nobody can predict. */}
          {bothArrays && (
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                act(() =>
                  window.opsmaxx!.addy.resolveConflict(current.id, current.collection, [
                    ...(current.winning as unknown[]),
                    ...(current.losing as unknown[])
                  ])
                )
              }
            >
              Keep both
            </button>
          )}
        </div>

        {conflicts.length > 1 && <p className="fine">{conflicts.length - 1} more to decide.</p>}
      </div>
    </div>
  )
}

/** A readable summary. Full JSON, pretty-printed, capped: the user is
 *  comparing two things and a truncated one they cannot scroll is worse than
 *  no preview, but a megabyte of vault is not a comparison either. */
function preview(value: unknown): string {
  if (value === undefined) return 'Could not be read on this device.'
  const text = JSON.stringify(value, null, 2)
  return text.length > 8000 ? text.slice(0, 8000) + '\n… (truncated)' : text
}

function when(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}
