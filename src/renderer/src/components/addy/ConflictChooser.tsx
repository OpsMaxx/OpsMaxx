import { useEffect, useState } from 'react'
import { GitMerge, AlertTriangle } from 'lucide-react'
import type { AddyStatusDevice, ConflictCopy } from '../../../../shared/addy'
import { approvalShowing } from '../../hooks/useClickOutside'

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
  apiCollections: 'your HTTP collections',
  apiWorkspace: 'your HTTP environments and variables',
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

/**
 * Which machine made the copy that was set aside.
 *
 * `ConflictCopy.device` is the `pub_sign` of the device that wrote the losing
 * copy and it was read by nothing, so the dialog called that copy "from
 * another device" — which is WRONG in the commonest case there is. The first
 * sync after pairing takes `sync.ts`'s `!known` branch: this machine has data
 * the account has never seen, it adopts the account's copy, and the copy it
 * sets aside is ITS OWN. Somebody looking at two versions of their servers on
 * the evening they paired was told the one they recognised came from the other
 * machine.
 *
 * So it is named from the roster instead. The roster is the only thing that
 * can name it -- the relay holds no key and nothing else on the account knows
 * what a device is called.
 *
 * `devices` is `undefined` until the status read comes back, and can stay that
 * way on a build whose preload has no `status` call. That case says nothing
 * rather than guessing: an unnamed key beats a wrong machine.
 */
function madeBy(hex: string, devices: AddyStatusDevice[] | undefined): string | null {
  if (hex === '') return null
  const short = hex.slice(0, 8)
  if (devices === undefined) return `made by the device ${short}`
  const found = devices.find((d) => d.id === hex)
  if (found === undefined) {
    // On the account once, not now. Worth saying: it is the strongest reason
    // there is to look at this copy before deleting it.
    return `made by a device that is no longer on this account (${short})`
  }
  if (found.self) return 'made by this machine'
  return `made by ${found.label} (${short})`
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
  /** The roster, so the copy that was set aside can be named by the machine
   *  that made it. `undefined` until it arrives, and on a preload that has no
   *  `status` call at all — see `madeBy`. */
  const [devices, setDevices] = useState<AddyStatusDevice[] | undefined>(undefined)

  const refresh = async (): Promise<void> => {
    const list = await window.opsmaxx?.addy.conflicts()
    setConflicts(list ?? [])
  }

  useEffect(() => {
    void refresh()
    // Optional, like every other bridge read on this screen: a window whose
    // preload predates this method must still show the chooser. Failing to
    // name a device is a worse dialog, not a broken one.
    void window.opsmaxx?.addy?.status?.().then(
      (s) => setDevices(s.devices),
      () => undefined
    )
  }, [])

  const current = conflicts.find((c) => !deferred.includes(c.id))
  const currentId = current?.id

  /**
   * ESCAPE LEAVES IT FOR LATER, because that is the one action here that
   * writes nothing.
   *
   * A modal with `aria-modal` and no way to dismiss it from the keyboard is a
   * trap, and the three buttons that DO dismiss it all destroy a copy. So the
   * key every person presses to get out of a dialog does the harmless thing
   * rather than nothing at all.
   */
  useEffect(() => {
    if (currentId === undefined) return undefined
    const onKey = (e: KeyboardEvent): void => {
      // An approval paints above this chooser, so an Escape then was meant for
      // it; see useClickOutside.
      if (e.key === 'Escape' && !approvalShowing()) setDeferred((d) => [...d, currentId])
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [currentId])

  if (!current) return null

  const act = (run: () => Promise<unknown>): void => {
    setBusy(true)
    void run()
      .then(refresh)
      .finally(() => setBusy(false))
  }

  const bothArrays = Array.isArray(current.losing) && Array.isArray(current.winning)
  const combined = bothArrays
    ? (current.winning as unknown[]).length + (current.losing as unknown[]).length
    : 0
  const from = madeBy(current.device, devices)
  const left = conflicts.filter((c) => !deferred.includes(c.id)).length - 1

  return (
    <div
      className="conflict-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="conflict-title"
    >
      <div className="conflict">
        <GitMerge size={26} aria-hidden className="conflict-icon" />
        <h2 id="conflict-title">Two versions of {nameOf(current.collection)}</h2>
        {/* WHAT HAPPENED, FOR SOMEBODY WHO HAS NEVER HEARD THE WORD CONFLICT.
            The old opening sentence was "Both copies are here now", which
            assumes the reader already knows there are two and why. */}
        <p className="fine">
          Two of your machines changed this before they had synced with each other, so OpsMaxx
          kept both rather than picking one and telling nobody. It is already using the version
          marked <strong>In use now</strong>; the other has been set aside, waiting for this.
        </p>
        <p className="fine">
          Nothing is lost yet and nothing is written until you press one of the buttons below.{' '}
          <strong>
            Whichever version you keep, the other is deleted from the relay and cannot be brought
            back.
          </strong>{' '}
          If you are not sure, <strong>Decide later</strong> leaves both exactly where they are and
          brings this back next time.
        </p>

        {current.problem && (
          <div className="conflict-problem" role="alert">
            <AlertTriangle size={15} aria-hidden />
            {/* Shown rather than hidden: a conflict that vanishes from the
                list is a decision nobody gets to make, and the data is still
                on the relay costing quota.
                It also says what the greyed-out button means. A disabled
                control with no reason beside it reads as a broken dialog. */}
            <span>
              The copy that was set aside cannot be opened on this device: {current.problem}. That
              is why it cannot be chosen here — it is sealed under a key this machine does not
              hold, and another of your devices may still be able to read it. Keeping the version
              in use deletes it.
            </span>
          </div>
        )}

        <div className="conflict-pair">
          <section>
            <h3>
              <span>In use now</span>
              {/* Not "what is on the relay": a person is being asked about
                  their own data, and the relay is an implementation detail
                  they have no way to check. This copy is the one already
                  written to disk here -- `sync.ts` writes the winner before it
                  publishes the loser -- and the one every other device
                  converges on, so keeping it changes nothing anywhere. */}
              <span className="conflict-when">on every device</span>
            </h3>
            <pre>{preview(current.winning, current.collection)}</pre>
          </section>
          <section>
            <h3>
              <span>Set aside{from !== null ? `, ${from}` : ''}</span>
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
            Keep the version in use (delete the other copy)
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
              {/* The count, because "keep both" over two lists that overlap
                  produces duplicates, and a person who expected a merge should
                  see the size of what they are about to get before they press
                  it rather than after. */}
              Keep both ({combined} entries, duplicates and all)
            </button>
          )}
          {/* The way out. Nothing is written and nothing is lost: the copy
              stays on the relay and this comes back. */}
          <button className="btn ghost" disabled={busy} onClick={() => setDeferred((d) => [...d, current.id])}>
            Decide later
          </button>
        </div>

        {/* What is still waiting, not how many there ever were. Counting the
            ones already deferred told somebody who had put two off that there
            were still two to come after this. */}
        {left > 0 && <p className="fine">{left} more to decide after this one.</p>}
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
