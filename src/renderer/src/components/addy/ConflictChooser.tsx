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
/**
 * What each collection is, in the words the app uses elsewhere.
 *
 * The heading printed the raw protocol id, so a user was asked about
 * `knownHosts`, `apiWorkspace` or `cicdConnections` — names from
 * `SYNCED_COLLECTIONS`, which exist so two implementations agree with each
 * other and not so anybody reads them.
 */
const COLLECTION_NAMES: Record<string, string> = {
  apiCollections: 'your saved APIs',
  apiWorkspace: 'the API client workspace',
  cicdConnections: 'your CI/CD connections',
  databases: 'your saved databases',
  deviceNames: 'what you call your devices',
  env: 'your environment variables',
  folders: 'your folders',
  httpChecks: 'your HTTP checks',
  knownHosts: 'your trusted SSH host keys',
  manifest: 'your provisioning manifest',
  monitorGroups: 'your monitor groups',
  servers: 'your servers',
  tunnels: 'your tunnels',
  vault: 'your vault',
  vpns: 'your VPN profiles',
  workspaces: 'your workspaces'
}

function nameOf(collection: string): string {
  return COLLECTION_NAMES[collection] ?? collection
}

export function ConflictChooser(): React.JSX.Element | null {
  const [conflicts, setConflicts] = useState<ConflictCopy[]>([])
  const [busy, setBusy] = useState(false)
  /**
   * Conflicts the user has chosen to leave for now.
   *
   * THIS DIALOG HAD NO WAY OUT. A full-screen modal over the whole app, no
   * close, no Escape, and three buttons that all wrote irreversibly — so
   * somebody who wanted to look at the other machine first, or who did not
   * understand two blobs of JSON, had to destroy one copy to get back to the
   * app. That is not a choice, it is a toll.
   *
   * Deferring changes nothing on the relay: the copy stays, the panel's
   * attention tile keeps counting it, and the dialog comes back next launch.
   */
  const [deferred, setDeferred] = useState<number[]>([])

  const refresh = async (): Promise<void> => {
    const list = await window.opsmaxx?.addy.conflicts()
    setConflicts(list ?? [])
  }

  useEffect(() => {
    void refresh()
  }, [])

  const current = conflicts.find((c) => !deferred.includes(c.id))
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
        <h2>Two devices changed {nameOf(current.collection)} at the same time</h2>
        <p className="fine">
          Both copies are here now. <strong>Whichever you choose, the other is deleted from the
          relay and cannot be brought back</strong> — so if you are not sure, leave it for later
          and look at the other machine first.
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
            <pre>{preview(current.winning, current.collection)}</pre>
          </section>
          <section>
            <h3>
              The copy from another device
              <span className="conflict-when">{when(current.createdAt)}</span>
            </h3>
            <pre>{preview(current.losing, current.collection)}</pre>
          </section>
        </div>

        <div className="conflict-actions">
          <button
            className="btn"
            disabled={busy}
            onClick={() => act(() => window.opsmaxx!.addy.discardConflict(current.id))}
          >
            Keep what is on the relay (delete the other copy)
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
            Replace it with the other copy
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
          {/* The way out. Nothing is written and nothing is lost: the copy
              stays on the relay and this comes back. */}
          <button className="btn ghost" disabled={busy} onClick={() => setDeferred((d) => [...d, current.id])}>
            Decide later
          </button>
        </div>

        {conflicts.length > 1 && <p className="fine">{conflicts.length - 1} more to decide.</p>}
      </div>
    </div>
  )
}

/** A readable summary. Full JSON, pretty-printed, capped: the user is
 *  comparing two things and a truncated one they cannot scroll is worse than
 *  no preview, but a megabyte of vault is not a comparison either. */
function preview(value: unknown, collection?: string): string {
  if (value === undefined) return 'Could not be read on this device.'
  // THE VAULT TRAVELS AS CIPHERTEXT, by design — nothing in the sync path
  // opens it. Pretty-printing it offered the user two walls of base64 and
  // asked which one they preferred, which is not a question anybody can
  // answer. The timestamps and the device name beside each copy are.
  if (collection === 'vault') {
    return (
      'Your vault is encrypted with your master password and cannot be shown here.\n' +
      'Choose by when each copy was made and which machine made it.'
    )
  }
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
