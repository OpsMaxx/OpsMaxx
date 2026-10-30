import { useEffect, useRef, useState } from 'react'
import { GitMerge, AlertTriangle } from 'lucide-react'
import type { AddyStatusDevice, ConflictCopy } from '../../../../shared/addy'
import { approvalShowing } from '../../hooks/useClickOutside'
import { deferConflict, pruneDeferred, useAddyUi } from '../../store/addy'
import { errorText } from '../../lib/connectionError'
import { collectionName as nameOf } from './collectionNames'
import { t as tr, useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'

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
  if (devices === undefined) return tr('addy.conflict.madeByUnknown', { short })
  const found = devices.find((d) => d.id === hex)
  if (found === undefined) {
    // On the account once, not now. Worth saying: it is the strongest reason
    // there is to look at this copy before deleting it.
    return tr('addy.conflict.madeByGone', { short })
  }
  if (found.self) return tr('addy.conflict.madeBySelf')
  return tr('addy.conflict.madeBy', { label: found.label, short })
}

export function ConflictChooser(): React.JSX.Element | null {
  const [conflicts, setConflicts] = useState<ConflictCopy[]>([])
  const [busy, setBusy] = useState(false)
  const t = useT()
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
        <h2 id="conflict-title">{t('addy.conflict.title', { what: nameOf(current.collection) })}</h2>
        {/* WHAT HAPPENED, FOR SOMEBODY WHO HAS NEVER HEARD THE WORD CONFLICT.
            The old opening sentence was "Both copies are here now", which
            assumes the reader already knows there are two and why. */}
        {current.reason === 'bulk-removal' ? (
          <p className="fine">
            <Trans i18nKey="addy.conflict.bulkRemoval" components={{ strong: <strong /> }} />
          </p>
        ) : (
          <p className="fine">
            <Trans i18nKey="addy.conflict.both" components={{ strong: <strong /> }} />
          </p>
        )}
        <p className="fine">
          <Trans i18nKey="addy.conflict.nothingLost" components={{ strong: <strong /> }} />
        </p>

        {current.problem && (
          <div className="conflict-problem" role="alert">
            <AlertTriangle size={15} aria-hidden />
            {/* Shown rather than hidden: a conflict that vanishes from the
                list is a decision nobody gets to make, and the data is still
                on the relay costing quota.
                It also says what the greyed-out button means. A disabled
                control with no reason beside it reads as a broken dialog. */}
            <span>{t('addy.conflict.unreadable', { problem: current.problem })}</span>
          </div>
        )}

        <div className="conflict-pair">
          <section>
            <h3>
              <span>{t('addy.conflict.inUse')}</span>
              {/* Not "what is on the relay": a person is being asked about
                  their own data, and the relay is an implementation detail
                  they have no way to check. This copy is the one already
                  written to disk here -- `sync.ts` writes the winner before it
                  publishes the loser -- and the one every other device
                  converges on, so keeping it changes nothing anywhere. */}
              <span className="conflict-when">{t('addy.conflict.everyDevice')}</span>
            </h3>
            <pre>{preview(current.winning, current.collection)}</pre>
          </section>
          <section>
            <h3>
              <span>
                {from !== null ? t('addy.conflict.setAsideFrom', { from }) : t('addy.conflict.setAside')}
              </span>
              {/* Marked when it is only the relay's word: a copy kept by an
                  older OpsMaxx carries no sealed record of who made it, and
                  the relay can say anything. For the vault this line is the
                  whole basis of the choice, so it must not look checked. */}
              <span className="conflict-when">
                {current.reportedByRelay
                  ? t('addy.conflict.whenReported', { when: when(current.createdAt) })
                  : when(current.createdAt)}
              </span>
            </h3>
            <pre>{preview(current.losing, current.collection, current.reportedByRelay)}</pre>
          </section>
        </div>

        <div className="conflict-actions">
          <button
            className="btn"
            disabled={busy}
            onClick={() => act(() => window.opsmaxx!.addy.discardConflict(current.id))}
          >
            {t('addy.conflict.keepInUse')}
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
            {t('addy.conflict.replace')}
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
              {t('addy.conflict.keepBoth', { count: combined })}
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
                {t('addy.conflict.vaultMerge')}
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
                {t('addy.conflict.vaultMergeRun')}
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
            {t('addy.conflict.later')}
          </button>
        </div>
        {actError !== null && (
          <div className="conflict-problem" role="alert">
            <AlertTriangle size={15} aria-hidden />
            <span>{t('addy.conflict.failed', { error: actError })}</span>
          </div>
        )}

        {/* What is still waiting, not how many there ever were. Counting the
            ones already deferred told somebody who had put two off that there
            were still two to come after this. */}
        {left > 0 && <p className="fine">{t('addy.conflict.more', { count: left })}</p>}
      </div>
    </div>
  )
}

/** A readable summary. Full JSON, pretty-printed, capped: the user is
 *  comparing two things and a truncated one they cannot scroll is worse than
 *  no preview, but a megabyte of vault is not a comparison either. */
function preview(value: unknown, collection?: string, reportedByRelay?: boolean): string {
  if (value === undefined) return tr('addy.conflict.unreadableCopy')
  // THE VAULT TRAVELS AS CIPHERTEXT, by design — nothing in the sync path
  // opens it. Pretty-printing it offered the user two walls of base64 and
  // asked which one they preferred, which is not a question anybody can
  // answer. The time and the machine beside the set-aside copy are — and only
  // when they came from inside the sealed copy rather than from the relay.
  if (collection === 'vault') {
    const basis =
      reportedByRelay === undefined
        ? tr('addy.conflict.vaultInUse')
        : reportedByRelay
          ? tr('addy.conflict.vaultRelayOnly')
          : tr('addy.conflict.vaultSealed')
    return tr('addy.conflict.vaultHidden', { basis })
  }
  const text = JSON.stringify(value, null, 2)
  return text.length > 8000 ? text.slice(0, 8000) + '\n' + tr('addy.conflict.truncated') : text
}

function when(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}
