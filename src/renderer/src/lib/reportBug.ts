import { bridgeHas } from './bridge'
import { toast } from '../store/toast'

/**
 * The empty issue form, and it stays empty.
 *
 * Never a pre-filled `?body=` URL. The diagnostics block describes this
 * installation, and a query string puts it in the browser's address bar, its
 * history and any proxy log on the way. GitHub also truncates long URLs, so the
 * end of the block — the `[config]` section, which is the half four bugs needed
 * — is the part that would silently go missing. The clipboard has neither
 * problem and no length limit.
 *
 * Kept here rather than beside `RELEASES_URL` in main/services/updater.ts: that
 * constant is read by the update flow in the main process, this one by the
 * renderer, and the renderer cannot import from main. A shared module holding
 * one string for one caller would be a third file to keep in step with the repo
 * slug instead of a second.
 */
export const ISSUES_URL = 'https://github.com/OpsMaxx/OpsMaxx/issues/new/choose'

/**
 * Write the block to the user's downloads folder as a plain text file.
 *
 * The same blob-and-anchor the access review export uses, rather than
 * `dialog.saveJson`: that channel filters the picker to `.json` and asks for a
 * path, and this payload is neither JSON nor worth a second decision on a path
 * whose whole point is one press. `.txt` because `formatDiagnostics` writes
 * `key: value` lines under `[section]` headings — nothing that renders as
 * anything else.
 *
 * Returns whether the file was written, because every step here can fail in a
 * way the caller must not inherit: `createObjectURL` is absent in some embedded
 * webviews, and a click on a synthetic anchor is a no-op wherever downloads are
 * turned off. Neither is a reason to withhold the clipboard copy or the form,
 * so a failure is a `false` and a different sentence, never a thrown error.
 */
function saveDiagnosticsFile(text: string): boolean {
  try {
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `opsmaxx-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`
    a.click()
    URL.revokeObjectURL(url)
    return true
  } catch {
    return false
  }
}

/**
 * Save the diagnostics, copy them, open the issue form, say so. One click.
 *
 * Reporting a bug used to be seven steps across two applications, and the first
 * of them was knowing to look in Settings > Advanced. That is a path only
 * somebody who already knows the app can walk, which is the wrong half of the
 * user base for a bug report.
 *
 * WHY THIS PATH COPIES WITHOUT SHOWING A PREVIEW FIRST
 *
 * Settings and the crash card both put the text on screen before copying it,
 * and this one deliberately does not. The payload is safe by construction --
 * see the header of shared/diagnostics.ts -- versions, counts and booleans,
 * with no names, hostnames, addresses, paths, credentials or remote output
 * anywhere in the type. There is nothing in it to read and decide about, so a
 * preview here would buy the user no information and cost them the click that
 * is the entire point of this function.
 *
 * The one field that does carry text nobody here composed is the crash block,
 * and it cannot arrive on this path: `crash` is passed only by the error
 * boundary, which has its own button and already previews. If a future field
 * needs a redaction pass, it does not belong in the payload at all, and
 * tests/diagnosticsImports.test.ts is the guard on that.
 *
 * `bridgeHas` for the same reason every other caller uses it: under
 * `electron-vite dev` the running process keeps the preload bundle it booted
 * with, so a method added since then is undefined for the rest of the session.
 */
export async function reportBug(): Promise<void> {
  const api = window.opsmaxx?.diagnostics
  const text = bridgeHas(api as Record<string, unknown> | undefined, 'text')
    ? await api?.text().catch(() => null)
    : null

  // The form opens either way. A user who pressed this has a bug to report, and
  // failing to collect the version block is not a reason to leave them on the
  // screen the bug is on -- it is a reason to say the block is missing so they
  // can paste it by hand from Settings.
  if (text == null) {
    window.open(ISSUES_URL, '_blank', 'noopener,noreferrer')
    toast(
      'Could not collect your diagnostics. The issue form is open — Settings > Advanced has the text to paste in.',
      'error'
    )
    return
  }

  // The file first, then the clipboard, then the form — the order the user
  // needs them in. The download has to have started before the browser tab
  // takes the focus, and both copies are made because the issue template asks
  // for this block pasted inline while an attachment is the inert way to carry
  // a long one. Whichever the reporter reaches for, it is already there.
  const saved = saveDiagnosticsFile(text)
  window.opsmaxx?.clipboard.write(text)
  window.open(ISSUES_URL, '_blank', 'noopener,noreferrer')
  toast(
    saved
      ? 'Diagnostics saved to your downloads and copied to your clipboard. Attach the file or paste the text into the issue form that just opened.'
      : 'Diagnostics copied to your clipboard. Paste them into the issue form that just opened.',
    'ok'
  )
}
