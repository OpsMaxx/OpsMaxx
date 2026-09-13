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
 * Copy the diagnostics, open the issue form, say so. One click.
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

  window.opsmaxx?.clipboard.write(text)
  window.open(ISSUES_URL, '_blank', 'noopener,noreferrer')
  toast('Diagnostics copied to your clipboard. Paste them into the issue form that just opened.', 'ok')
}
