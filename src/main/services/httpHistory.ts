import { app, safeStorage } from 'electron'
import { lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from './atomicWrite'
import { appendLogLine } from './logAppend'
import { redactPatterns } from './secretRedaction'
import { secretsAvailable, secretsBackend } from './secretsBackend'
import { isValidId } from '../../shared/apiModel'
import {
  MAX_HISTORY_AGE_MS,
  MAX_HISTORY_ENTRIES,
  MAX_HISTORY_ENTRY_BYTES,
  historyInWorkspace,
  historyMatches,
  mapStringLeaves,
  sanitizeHistoryEntry,
  type HistoryEntry
} from '../../shared/httpHistory'

/**
 * The HTTP client's request history, kept in main.
 *
 * SEALED OR NOT WRITTEN AT ALL. Each line is `{"t": <epoch ms>, "enc": <base64
 * of safeStorage.encryptString(json)>}`, and the file is written only when the
 * OS offers a real keyring. Without one — no keyring, or Linux's `basic_text`,
 * which is a fixed-key obfuscation rather than a seal — history lives in this
 * process's memory for the session and is gone at quit. store.ts makes the
 * opposite trade (plaintext rather than nothing) because an install that cannot
 * save its servers cannot be used at all; history is optional, so the trade that
 * fits is secrets.ts's: refuse to persist (review SEC-H2).
 *
 * OUR OWN PRUNER, NOT `retainedLines`. That was built for audit logs: it keeps a
 * line it cannot read forever and the newest 100 regardless of age. Here a line
 * that fails to decrypt (a keychain reset) or has no readable time is DROPPED,
 * and the 30-day horizon holds for every entry.
 *
 * The entries are held decrypted in memory after the first read, in both modes,
 * so `list` is not 2,000 decrypts per page.
 * ponytail: the cache is bounded by the caps (2,000 × 64 KiB worst case); a
 * paged read from disk replaces it if that ever shows up in main's heap.
 *
 * No `ipcMain` here: the handlers are in main/index.ts, where the debug tap
 * sees them (tests/ipcDebugTap.test.ts).
 */

const FILE_NAME = 'opsmaxx-http-history.jsonl'
const historyFile = (): string => join(app.getPath('userData'), 'opsmaxx-http-history.jsonl')

/** Prune on every 50th append, as well as at load and on the retention sweep. */
const PRUNE_EVERY = 50

let entries: HistoryEntry[] | null = null
let appendsSincePrune = 0

/** True when history may touch disk: a real keyring, not `basic_text`. */
export function historySealed(): boolean {
  return secretsAvailable() && secretsBackend() !== 'basic_text'
}

function isSymlink(file: string): boolean {
  return lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() === true
}

function lineFor(entry: HistoryEntry): string {
  const enc = safeStorage.encryptString(JSON.stringify(entry)).toString('base64')
  return `${JSON.stringify({ t: entry.at, enc })}\n`
}

function decode(line: string): HistoryEntry | null {
  try {
    const row = JSON.parse(line) as { t?: unknown; enc?: unknown }
    if (typeof row.t !== 'number' || !Number.isFinite(row.t) || typeof row.enc !== 'string') return null
    const plain = safeStorage.decryptString(Buffer.from(row.enc, 'base64'))
    const entry = sanitizeHistoryEntry(JSON.parse(plain))
    return entry && entry.at === row.t ? entry : null
  } catch {
    return null
  }
}

/** Newest first, within the age and count caps. */
function retain(list: HistoryEntry[], now: number): HistoryEntry[] {
  return list
    .filter((e) => now - e.at <= MAX_HISTORY_AGE_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_HISTORY_ENTRIES)
}

/** Replace the file with `list`, or remove it when there is nothing to keep. */
function rewrite(list: HistoryEntry[]): void {
  if (!historySealed()) return
  const file = historyFile()
  if (list.length === 0) {
    rmSync(file, { force: true })
    return
  }
  // Oldest first on disk, so an append stays an append.
  atomicWriteFileSync(file, [...list].reverse().map(lineFor).join(''))
}

function load(now = Date.now()): HistoryEntry[] {
  if (entries) return entries
  let loaded: HistoryEntry[] = []
  let lines = 0
  const file = historyFile()
  // Never read through a link: whatever it points at is not our history.
  if (historySealed() && !isSymlink(file)) {
    try {
      const raw = readFileSync(file, 'utf8').split('\n').filter(Boolean)
      lines = raw.length
      loaded = raw.map(decode).filter((e): e is HistoryEntry => e !== null)
    } catch {
      /* no file yet */
    }
  }
  entries = retain(loaded, now)
  if (entries.length !== lines) {
    try {
      rewrite(entries)
    } catch (err) {
      console.error('[httpHistory] could not rewrite the history file:', err)
    }
  }
  return entries
}

/** Apply the horizon now. Called at launch with the other retention passes. */
export function pruneHistory(now = Date.now()): void {
  const before = load(now)
  entries = retain(before, now)
  appendsSincePrune = 0
  if (entries.length !== before.length) {
    try {
      rewrite(entries)
    } catch (err) {
      console.error('[httpHistory] prune failed:', err)
    }
  }
}

export function listHistory(opts: unknown): HistoryEntry[] {
  const o = (typeof opts === 'object' && opts !== null ? opts : {}) as Record<string, unknown>
  const limit =
    typeof o.limit === 'number' && Number.isFinite(o.limit) ? Math.min(Math.max(Math.floor(o.limit), 1), 500) : 100
  const before = typeof o.before === 'number' ? o.before : Infinity
  const query = typeof o.query === 'string' ? o.query.slice(0, 200) : ''
  // Filtered here rather than in the window, so a page is full of this
  // workspace's entries instead of whatever survives a filter afterwards.
  const workspaceId = isValidId(o.workspaceId) ? o.workspaceId : null
  const out: HistoryEntry[] = []
  for (const e of load()) {
    if (e.at >= before || !historyMatches(e, query)) continue
    if (workspaceId && !historyInWorkspace(e, workspaceId)) continue
    out.push(e)
    if (out.length >= limit) break
  }
  return out
}

/**
 * Store one entry. The renderer's redaction is not trusted: the entry is
 * rebuilt and redacted again, `redactPatterns` runs over every string, and an
 * entry over 64 KiB is refused. Resolves to whether it was kept.
 */
export function appendHistory(raw: unknown): boolean {
  const clean = sanitizeHistoryEntry(raw)
  if (!clean) return false
  const entry = mapStringLeaves(clean, redactPatterns)
  const line = JSON.stringify(entry)
  if (new TextEncoder().encode(line).length > MAX_HISTORY_ENTRY_BYTES) return false

  const list = load()
  // An id already kept is refused, not written twice: the file would then
  // hold two lines for one entry, and memory and disk would disagree.
  if (list.some((e) => e.id === entry.id)) return false
  // Newest first, by when it was sent: two sends can finish out of order, and
  // `list`'s `before` paging assumes the order.
  entries = [entry, ...list].sort((a, b) => b.at - a.at)
  if (historySealed()) {
    try {
      appendLogLine(historyFile(), lineFor(entry))
    } catch (err) {
      // A refused path (a symlink, another owner) loses the row on disk, not
      // in the session.
      console.error('[httpHistory] append refused:', err)
    }
  }
  if (++appendsSincePrune >= PRUNE_EVERY) pruneHistory()
  else if (entries.length > MAX_HISTORY_ENTRIES) entries = entries.slice(0, MAX_HISTORY_ENTRIES)
  return true
}

export function removeHistory(id: unknown): void {
  if (typeof id !== 'string') return
  const list = load()
  const next = list.filter((e) => e.id !== id)
  if (next.length === list.length) return
  entries = next
  rewrite(next)
}

/** Forget everything, and remove the file and anything beside it that a rewrite left. */
export function clearHistory(): void {
  entries = []
  appendsSincePrune = 0
  const dir = app.getPath('userData')
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (name.startsWith(FILE_NAME.replace(/\.jsonl$/, ''))) rmSync(join(dir, name), { force: true, recursive: true })
  }
}

/** For tests: drop the in-memory cache so the next call reads the disk again. */
export function resetHttpHistoryForTests(): void {
  entries = null
  appendsSincePrune = 0
}
