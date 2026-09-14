import { useApp } from '../store/app'
import type { ReportOs } from '../../../shared/debug'

/**
 * The bug form, and nothing but the two fields the app already knows.
 *
 * WHAT IS STILL FORBIDDEN HERE, AND WHY
 *
 * Never a pre-filled `?body=`. The report describes this installation and, when
 * debug mode was on, what it did — and a query string puts all of that in the
 * browser's address bar, its history and any proxy log on the way. GitHub also
 * truncates long URLs, so the END of a block is the part that would silently go
 * missing, which for the diagnostics block is `[config]` — the half four bugs
 * needed. The file the report is saved to has neither problem and no length
 * limit, which is why it is an attachment.
 *
 * WHAT CHANGED, AND WHY IT DOES NOT WEAKEN THAT
 *
 * `version` and `os` now travel in the URL. They are two short strings the app
 * already prints on its own Settings screen, they are bounded by construction —
 * a semver and one of three literals — and neither is a payload. The reason a
 * block cannot go in a URL is its length and its contents; a version number has
 * neither property. tests/reportBug.test.tsx pins the rule that follows from
 * that: `template`, `version` and `os` are the only keys permitted, ever.
 *
 * The URL is also the TEMPLATE now rather than `/issues/new/choose`. GitHub
 * prefills an issue form's fields by their `id`, and only on this path — the
 * chooser takes no parameters. Landing on the chooser also asked every reporter
 * to first classify their own bug, which is a question the button they pressed
 * has already answered.
 *
 * Kept here rather than beside `RELEASES_URL` in main/services/updater.ts: that
 * constant is read by the update flow in the main process, this one by the
 * renderer, and the renderer cannot import from main.
 */
export const ISSUES_BASE = 'https://github.com/OpsMaxx/OpsMaxx/issues/new'

/** The template filename, which is also what `?template=` names. */
export const ISSUE_TEMPLATE = 'bug_report.yml'

export function issueUrl(version: string, os: ReportOs): string {
  const q = new URLSearchParams({ template: ISSUE_TEMPLATE, version, os })
  return `${ISSUES_BASE}?${q.toString()}`
}

/**
 * Open the report dialog.
 *
 * It used to do the whole thing on the press: write a file into the downloads
 * folder, copy the text, open the form. That cost one click and bought three
 * problems — a file nobody agreed to, a toast that claimed the file had been
 * saved whenever nothing had thrown (including when the user cancelled the save
 * dialog), and no way to carry a log because the app did not keep one.
 *
 * So the press now opens a dialog instead, and the extra press it costs is the
 * consent the old path skipped. Both entry points — the activity rail and the
 * command palette — call THIS, so neither can drift from the other.
 */
export function reportBug(): void {
  useApp.getState().setModal('report-bug')
}
