import { app, dialog, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { diagnosticsText } from './diagnostics'
import type { DiagnosticsProbes } from './diagnostics'
import { debugStatus, readDebugTrace } from './debugLog'
import type { DebugBundle, ReportOs, SaveResult } from '../../shared/debug'

// The report a bug reporter attaches: what this install IS, from
// services/diagnostics.ts, plus what it DID, from services/debugLog.ts.
//
// WHAT IS NOT IN HERE, AND WHY
//
// Not the four audit JSONLs. `opsmaxx-ai-audit.jsonl` holds which tool an agent
// called against which workspace and which server, `opsmaxx-job-approvals.jsonl`
// which command a human authorised on which host, `opsmaxx-local-sessions.jsonl`
// which shells ran here and from which directory, and
// `opsmaxx-credproxy-audit.jsonl` which credential was forwarded to which
// third-party host. For "the tunnel panel renders empty" all four are noise, and
// they are the rows SECURITY.md offers as the record of what an AI agent did on
// somebody's servers. A debug report should carry what the reproduction
// produced, not the estate's history. If one of them ever turns out to be needed
// it belongs behind its own checkbox, off by default, labelled with what it
// attaches — not folded in here where nobody chose it.
//
// Keeping them out also keeps this module's import closure trivial, which is
// what lets tests/diagnosticsImports.test.ts guard it: this file is now the
// thing that leaves the machine, so it inherits that guard.
//
// SAVED, NEVER COPIED. The diagnostics block may go to a clipboard because it
// is safe by construction. This may not: it carries hostnames and error text,
// and CONTRIBUTING.md already draws exactly this line for long logs — an
// attachment is inert, while pasted text renders as Markdown and is read by
// automation.

export function reportOs(): ReportOs {
  if (process.platform === 'win32') return 'Windows'
  if (process.platform === 'darwin') return 'macOS'
  return 'Linux'
}

export function buildDebugBundle(probes: DiagnosticsProbes): DebugBundle {
  const status = debugStatus()
  const trace = readDebugTrace()

  const head = [
    'OpsMaxx bug report',
    `generated: ${new Date().toISOString()}`,
    status.startedAt === null
      ? 'debug trace: none — debug mode was not on for this report'
      : `debug trace: from ${status.startedAt}, ${trace.length} events`,
    ...(status.truncated ? ['                cut at the 8 MB cap — earliest events kept'] : []),
    ...(status.dropped > 0 ? [`                ${status.dropped} lines could not be written`] : []),
    ''
  ]

  const body = [
    diagnosticsText(probes, null).trimEnd(),
    '',
    '[trace]',
    // Indented by two spaces for `formatDiagnostics`'s reason: a line-based
    // reader has to be able to tell a continuation from a field, and a JSON
    // line that began with `[` would otherwise read as a section heading.
    ...(trace.length === 0 ? ['  (empty)'] : trace.map((l) => `  ${l}`))
  ]

  return {
    text: `${[...head, ...body].join('\n')}\n`,
    version: app.getVersion(),
    os: reportOs(),
    events: trace.length,
    truncated: status.truncated
  }
}

/**
 * Write it where the user says, and report what actually happened.
 *
 * The shape is `backupExport`'s (services/backup.ts), and so is the reason for
 * it. The path this replaces built a Blob, clicked a detached anchor and
 * returned `true` whenever nothing threw — so a user who cancelled Electron's
 * save dialog was still told the file had been saved to their downloads, and
 * `revokeObjectURL` fired synchronously after the click could race the download
 * that had not started. A real dialog and a real `writeFileSync` have a real
 * answer, which is the only kind the toast can repeat.
 *
 * 0600 for the same reason the four audit logs are: it holds hostnames.
 */
export async function saveDebugBundle(text: string): Promise<SaveResult> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const stamp = new Date().toISOString().slice(0, 10)
  const chosen = await dialog.showSaveDialog(win, {
    title: 'Save OpsMaxx bug report',
    defaultPath: join(app.getPath('downloads'), `opsmaxx-bug-report-${stamp}.txt`),
    filters: [{ name: 'Text', extensions: ['txt'] }]
  })
  if (chosen.canceled || !chosen.filePath) return { ok: false, cancelled: true }
  try {
    writeFileSync(chosen.filePath, text, { mode: 0o600 })
    return { ok: true, path: chosen.filePath }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
