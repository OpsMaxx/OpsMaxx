// The shapes the debug trace and the bug report cross the bridge in.
//
// Here rather than beside their implementations in main/services/ because the
// preload bundle and the renderer both need them and neither may import from
// main. The implementations are services/debugLog.ts (the trace) and
// services/debugBundle.ts (the report built from it).

/** What Settings and the report modal both show about the current capture. */
export interface DebugStatus {
  enabled: boolean
  /** When this capture began, or `null` if none has. */
  startedAt: string | null
  events: number
  bytes: number
  /** Whether the size cap stopped it, which the report header repeats. */
  truncated: boolean
  /** Lines a refused append cost. Reported rather than silent. */
  dropped: number
}

/** The dropdown labels in .github/ISSUE_TEMPLATE/bug_report.yml, exactly. A
 *  prefill that does not match one of them silently selects nothing. */
export type ReportOs = 'Windows' | 'macOS' | 'Linux'

export interface DebugBundle {
  text: string
  version: string
  os: ReportOs
  /** How many trace lines it carries. Zero is the honest answer for a report
   *  filed without ever turning debug mode on, and the modal says so. */
  events: number
  truncated: boolean
}

/**
 * What actually happened to the file.
 *
 * Three outcomes and not a boolean, because the path this replaces returned
 * `true` whenever nothing threw and then told the user their report had been
 * saved to their downloads when they had cancelled the dialog. A caller that
 * cannot tell "cancelled" from "written" cannot describe either one.
 */
export type SaveResult =
  | { ok: true; path: string }
  | { ok: false; cancelled: true }
  | { ok: false; error: string }
