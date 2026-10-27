import { useEffect, useRef, useState } from 'react'
import { GitMerge, AlertTriangle } from 'lucide-react'
import type { AddyStatusDevice, ConflictCopy } from '../../../../shared/addy'
import { approvalShowing } from '../../hooks/useClickOutside'
import { deferConflict, pruneDeferred, useAddyUi } from '../../store/addy'
import { errorText } from '../../lib/connectionError'
import { collectionName as nameOf } from './collectionNames'

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
   * attention tile keeps counting it, and the dialog comes back next launch —
   * or sooner, from "Review now" on Sync & devices, which is why this lives in
   * a store the panel can reach rather than in this component.
   */
  const deferred = useAddyUi((s) => s.deferredConflicts)
  /** The roster, so the copy that was set aside can be named by the machine
   *  that made it. `undefined` until it arrives, and on a preload that has no
   *  `status` call at all — see `madeBy`. */
  const [devices, setDevices] = useState<AddyStatusDevice[] | undefined>(undefined)

  // Kept as it was when the read fails. `conflicts()` reaches the relay, and a
  // relay that is down for a minute is not a reason to close a dialog somebody
  // is reading.
  const refresh = async (): Promise<void> => {
    const list = await window.opsmaxx?.addy.conflicts().catch(() => undefined)
    if (list === undefined) return
    setConflicts(list)
    pruneDeferred(list.map((c) => c.id))
  }
  /** Why the last button press did not work. It used to fail silently. */
  const [actError, setActError] = useState<string | null>(null)
  /** The master password the set-aside vault was made with. Held only while
   *  this dialog is on that conflict. */
  const [otherPassword, setOtherPassword] = useState('')
  const dialog = useRef<HTMLDivElement>(null)
  const later = useRef<HTMLButtonElement>(null)

  /**
   * READ ON EVERY STATUS PUSH AND EVERY RETURN TO THE WINDOW, not once.
   *
   * It used to fetch when the app opened and never again, so a conflict that
   * a sync pass found an hour later was counted by the panel's attention tile
   * and never offered here until the next launch. Every pass ends with a
   * status push, which is exactly when a new one can have appeared; focus
   * covers somebody who went to the other machine and came back.
   */
  useEffect(() => {
    void refresh()
    // Optional, like every other bridge read on this screen: a window whose
    // preload predates this method must still show the chooser. Failing to
    // name a device is a worse dialog, not a broken one.
    void window.opsmaxx?.addy?.status?.().then(
      (s) => setDevices(s.devices),
      () => undefined
    )
    const off = window.opsmaxx?.addy?.onStatus?.((s) => {
      if (s.devices !== undefined) setDevices(s.devices)
      void refresh()
    })
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      off?.()
      window.removeEventListener('focus', onFocus)
    }
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
      if (e.key === 'Escape' && !approvalShowing()) deferConflict(currentId)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [currentId])

  /**
   * FOCUS GOES IN, STAYS IN, AND COMES BACK. `aria-modal` promises all three
   * and the dialog did none: focus stayed on whatever was behind it, so Tab
   * walked the app underneath a modal that covered it.
   *
   * It lands on Decide later, the one button that writes nothing.
   */
  const open = currentId !== undefined
  useEffect(() => {
    if (!open) return undefined
    const before = document.activeElement as HTMLElement | null
    return () => before?.focus?.()
  }, [open])
  useEffect(() => {
    if (currentId === undefined) return undefined
    setActError(null)
    later.current?.focus()
    const onTab = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || !dialog.current) return
      const all = [...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled])')]
      if (all.length === 0) return
      const first = all[0]
      const last = all[all.length - 1]
      const at = document.activeElement
      const inside = at instanceof Node && dialog.current.contains(at)
      if (!inside || (e.shiftKey && at === first)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      } else if (!e.shiftKey && at === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onTab)
    return () => document.removeEventListener('keydown', onTab)
  }, [currentId])

  useEffect(() => setOtherPassword(''), [currentId])

  if (!current) return null

  const act = (run: () => Promise<unknown>): void => {
    setBusy(true)
    setActError(null)
    void run()
      .then(refresh, (err: unknown) => setActError(errorText(err)))
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
      <div className="conflict" ref={dialog}>
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
          If you are not sure, <strong>Decide later</strong> leaves both exactly where they are.
          It comes back the next time OpsMaxx opens, or sooner from <strong>Review now</strong> on
          Sync &amp; devices.
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
          {/* The vault cannot be shown or concatenated — it is ciphertext under
              a master password — so choosing a whole copy was the only offer,
              and on the evening a machine joined that meant throwing away one
              machine's credentials. Opened with the password it was made
              with, its entries can be added to the vault in use by id. */}
          {current.collection === 'vault' && current.losing !== undefined && (
            <form
              className="conflict-vault-merge"
              onSubmit={(e) => {
                e.preventDefault()
                act(() =>
                  window.opsmaxx!.addy.mergeVaultCopy(current.id, otherPassword).then((r) => {
                    if (!r.ok) throw new Error(r.error)
                  })
                )
              }}
            >
              <label className="fine" htmlFor="conflict-vault-password">
                Or add the set-aside copy&apos;s entries to the vault in use. Enter the master
                password that copy was made with (if both machines used the same one, it is that
                one). Nothing in use is replaced: identical entries are skipped, and one that
                differs is added as &ldquo;(other copy)&rdquo;. The vault in use must be unlocked.
              </label>
              <input
                id="conflict-vault-password"
                type="password"
                autoComplete="off"
                value={otherPassword}
                onChange={(e) => setOtherPassword(e.target.value)}
                disabled={busy}
              />
              <button className="btn" type="submit" disabled={busy || otherPassword === ''}>
                Add its entries to this vault
              </button>
            </form>
          )}
          {/* The way out. Nothing is written and nothing is lost: the copy
              stays on the relay and this comes back. */}
          <button
            ref={later}
            className="btn ghost"
            disabled={busy}
            onClick={() => deferConflict(current.id)}
          >
            Decide later
          </button>
        </div>
        {actError !== null && (
          <div className="conflict-problem" role="alert">
            <AlertTriangle size={15} aria-hidden />
            <span>That did not finish: {actError}</span>
          </div>
        )}

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
