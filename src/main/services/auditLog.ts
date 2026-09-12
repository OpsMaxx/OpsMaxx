import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { AuditEntry } from '../../shared/mcp'
import { appendLogLine } from './logAppend'
import { redactOutput } from './secretRedaction'

// Append-only JSON-lines file. Never rewritten in place (only appended to),
// so a crash mid-write can corrupt at most the last line rather than the
// whole history. Entries never carry secret material — every free-text field
// is redacted before it is written, not just before it is displayed.
const FILE = join(app.getPath('userData'), 'opsmaxx-ai-audit.jsonl')

/** Exported so retention prunes THIS file rather than a second copy of the
 *  name. Two places spelling a filename is how one of them gets it wrong. */
export const AUDIT_LOG_PATH = FILE

const uid = (): string => `audit-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`

// WHY A FLAG AND NOT JUST THE console.error BELOW.
//
// `appendLogLine` refuses a symlink at this path, and a file owned by another
// uid. Both refusals are right, and both are INVISIBLE: the catch below writes
// to a console that nobody reads in a packaged Electron app. An install in
// either state writes zero audit rows from then on while `listAudit` keeps
// returning the rows from before, so the AI audit view does not look broken, it
// looks quiet — which is the worst of the available failure modes for the one
// file SECURITY.md offers as the record of what an AI agent did on somebody's
// servers.
//
// So the last failure is remembered here, and cleared by the next append that
// works. Deliberately a string and not a counter or a ring buffer: what a reader
// needs is "appends are failing, and here is why", and the reason does not vary
// while the cause is in place.
let lastAppendError: string | null = null

/**
 * Why audit appends are currently failing, or null if the last one worked.
 *
 * Nothing renders this yet — the renderer is where it belongs and this is the
 * main process. The reader is `aiMcp:listAudit` in main/index.ts, which today
 * returns `listAudit(limit)` alone: returning this alongside it, and showing it
 * above the audit list, is the whole of the remaining work.
 */
export function auditAppendFailure(): string | null {
  return lastAppendError
}

export function recordAudit(entry: Omit<AuditEntry, 'id' | 'timestamp'>): AuditEntry {
  const full: AuditEntry = {
    id: uid(),
    timestamp: new Date().toISOString(),
    ...entry,
    action: redactOutput(entry.action),
    error: entry.error ? redactOutput(entry.error) : entry.error
  }
  try {
    // `appendLogLine` rather than appendFileSync: the mode argument only
    // applies when the file is created, and the append flag follows a symlink.
    // See logAppend.ts — all four of this file's siblings had the same two.
    appendLogLine(FILE, `${JSON.stringify(full)}\n`)
    lastAppendError = null
  } catch (err) {
    console.error('[audit] failed to append entry:', err)
    lastAppendError = err instanceof Error ? err.message : String(err)
  }
  return full
}

export function listAudit(limit = 500): AuditEntry[] {
  try {
    if (!existsSync(FILE)) return []
    const lines = readFileSync(FILE, 'utf8').split('\n').filter(Boolean)
    const entries: AuditEntry[] = []
    for (const line of lines.slice(-limit)) {
      try {
        entries.push(JSON.parse(line) as AuditEntry)
      } catch {
        /* skip a corrupt line rather than fail the whole read */
      }
    }
    return entries.reverse()
  } catch (err) {
    console.error('[audit] failed to read log:', err)
    return []
  }
}
