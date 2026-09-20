import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import type { AuditEntry } from '../../shared/mcp'
import type { AuditIntegrity } from '../../shared/mcp'
import { appendLogLine } from './logAppend'
import { redactOutput } from './secretRedaction'
import { getSecret, setSecret, MACHINE_ONLY_SECRET_PREFIX } from './secrets'

// Append-only JSON-lines file. Never rewritten in place (only appended to),
// so a crash mid-write can corrupt at most the last line rather than the
// whole history. Entries never carry secret material — every free-text field
// is redacted before it is written, not just before it is displayed.
const FILE = join(app.getPath('userData'), 'opsmaxx-ai-audit.jsonl')

/** Exported so retention prunes THIS file rather than a second copy of the
 *  name. Two places spelling a filename is how one of them gets it wrong. */
export const AUDIT_LOG_PATH = FILE

const uid = (): string => `audit-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`

// ---------------------------------------------------------------------------
// TAMPER EVIDENCE
// ---------------------------------------------------------------------------
// This file is what SECURITY.md offers as the record of what an AI agent did on
// somebody's servers, and it was a plain 0600 JSONL that anything running as the
// user could rewrite or truncate with nothing noticing. The rows are now
// hash-chained and the head is pinned outside the file.
//
// The chain is the roster's, reused rather than invented: addy's device roster
// is `prev_hash`-linked for the same reason, and its `(pinSeq, pinHead)`
// anti-rollback pin exists against the same attack — a store that answers with
// a shorter history than it was given.
//
// WHAT IT CATCHES. Editing any retained row, removing rows from the middle or
// the end, and replacing the file wholesale (the pinned seq runs ahead of
// anything in the new one).
//
// WHAT IT DOES NOT, AND THIS IS NOT A GAP TO BE CLOSED LATER. The pin lives in
// the OS secure store, and an attacker running AS THE USER can reach that store
// too — it is the user's keychain and they are the user. Nothing on this
// machine can be kept from them; what changes is that rewriting history is no
// longer editing a text file, it is editing a text file AND recomputing a chain
// AND rewriting a keychain entry, which is a different class of act and one a
// careless or automated tamper does not perform. Evidence, not proof. Anyone
// who needs proof needs the rows shipped off the machine, and that is a
// different feature with a different threat model.
const HEAD_SECRET_ID = `${MACHINE_ONLY_SECRET_PREFIX}audit-head`

interface ChainedRow extends AuditEntry {
  /** Monotonic, never reset. A pin whose seq is ahead of every row in the file
   *  is how a wholesale replacement announces itself. */
  seq: number
  /**
   * The hash of the row before this one, carried IN the row.
   *
   * Not merely recomputed from the neighbour while walking the file, because
   * the first row still present has no neighbour — retention drops the ones
   * before it — and a check that skips the first row is a check that invites
   * every edit to be made there. With the link inside the row, every row
   * verifies on its own.
   */
  p: string
  /** SHA-256 over this row's own JSON, `p` and `seq` included. */
  h: string
}

interface Head {
  seq: number
  h: string
  /** The seq of the FIRST row still in the file. Retention drops old rows from
   *  the front legitimately, so without this a prune and a front-truncation are
   *  the same event. `pruneAudit` moves it; nothing else does. */
  floorSeq: number
}

const GENESIS = 'audit-chain-v1'

function rowHash(row: Omit<ChainedRow, 'h'>): string {
  // Over the serialised row rather than field by field: a field added later is
  // then covered without anyone remembering to add it here, which is the
  // failure mode of every hand-listed signing input. `p` is inside `row`, so
  // one hash covers both the contents and the link.
  return createHash('sha256').update(JSON.stringify(row)).digest('hex')
}

function readHead(): Head | null {
  try {
    const raw = getSecret(HEAD_SECRET_ID)
    return raw ? (JSON.parse(raw) as Head) : null
  } catch {
    return null
  }
}

function writeHead(head: Head): void {
  try {
    setSecret(HEAD_SECRET_ID, JSON.stringify(head))
  } catch (err) {
    // The row is already on disk. A pin that could not be updated makes the
    // NEXT verification say "cannot tell", which is the honest answer, and is
    // better than losing the row to make the bookkeeping tidy.
    console.error('[audit] could not update the chain head:', err)
  }
}

/** Every line, parsed, with unparseable ones kept as holes so a corrupt line is
 *  not silently the same as a missing one. */
function readRows(): Array<ChainedRow | null> {
  if (!existsSync(FILE)) return []
  return readFileSync(FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as ChainedRow
      } catch {
        return null
      }
    })
}

/**
 * Whether the log still matches its own chain and the pinned head.
 *
 * `unknown` is a real answer and not a soft failure: a fresh install has no
 * pin, and every install that existed before this shipped has rows that predate
 * the chain. Reporting those as tampering would make the indicator worthless on
 * the day it arrived.
 */
export function verifyAuditLog(): AuditIntegrity {
  const rows = readRows()
  const head = readHead()
  if (rows.length === 0) return { state: 'unknown', reason: 'The audit log is empty.' }

  const firstChained = rows.findIndex((r) => r && typeof r.h === 'string')
  const unchained = firstChained === -1 ? rows.length : firstChained
  if (firstChained === -1) {
    return {
      state: 'unknown',
      reason: `All ${rows.length} rows predate tamper detection, so nothing can be checked yet.`
    }
  }
  if (!head) {
    return { state: 'unknown', reason: 'No chain head is stored on this machine yet.' }
  }

  // Rows before the chain started are carried, not verified, and say so.
  let expectedPrev: string | null = null
  for (let i = firstChained; i < rows.length; i++) {
    const row = rows[i]
    if (!row) return { state: 'broken', reason: `Row ${i + 1} is not readable as a record.` }
    const { h, ...body } = row
    // The row against ITSELF first. This is what catches an edit to the oldest
    // row still present, which has no surviving predecessor to be checked
    // against and would otherwise be the one safe place to rewrite.
    if (rowHash(body) !== h) {
      return { state: 'broken', reason: `Entry ${i + 1} has been changed since it was written.` }
    }
    // Then against the one before, which is what catches a row being removed
    // or reordered rather than edited.
    if (expectedPrev !== null && body.p !== expectedPrev) {
      return { state: 'broken', reason: `Entry ${i + 1} does not follow the one before it.` }
    }
    expectedPrev = h
  }

  const last = rows[rows.length - 1]
  if (!last || last.h !== head.h || last.seq !== head.seq) {
    return {
      state: 'broken',
      reason: 'The most recent entry is not the one this machine last recorded — entries have been removed or replaced.'
    }
  }
  const firstSeq = rows[firstChained]!.seq
  if (typeof head.floorSeq === 'number' && firstSeq > head.floorSeq) {
    return {
      state: 'broken',
      reason: 'Entries are missing from the start of the log, beyond what retention removed.'
    }
  }
  return { state: 'ok', rows: rows.length, unverifiable: unchained }
}

/**
 * Move the floor after retention has legitimately dropped old rows.
 *
 * Called by the retention sweep, and by nothing else — which is the whole
 * point. A front-truncation that does not come through here leaves the floor
 * where it was, and `verifyAuditLog` then reports rows missing from the start.
 */
export function refreshAuditFloor(): void {
  const head = readHead()
  if (!head) return
  const rows = readRows()
  const first = rows.find((r) => r && typeof r.seq === 'number')
  if (!first) return
  writeHead({ ...head, floorSeq: first.seq })
}

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
  // The link to the row before, read from the pin rather than from the file:
  // the file is the thing being protected, so taking the previous hash out of
  // it would let a rewritten tail choose its own predecessor.
  const head = readHead()
  const seq = (head?.seq ?? 0) + 1
  const body = { ...full, seq, p: head?.h || GENESIS }
  const row: ChainedRow = { ...body, h: rowHash(body) }
  const h = row.h
  try {
    // `appendLogLine` rather than appendFileSync: the mode argument only
    // applies when the file is created, and the append flag follows a symlink.
    // See logAppend.ts — all four of this file's siblings had the same two.
    appendLogLine(FILE, `${JSON.stringify(row)}\n`)
    lastAppendError = null
    // AFTER the append, never before. A pin moved first and then an append that
    // refused would leave the head naming a row that is not in the file, which
    // reads as truncation — the app accusing itself of tampering because a disk
    // was full.
    writeHead({ seq, h, floorSeq: head?.floorSeq ?? seq })
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
        // `seq` and `h` are the chain's bookkeeping and not part of what an
        // audit row means, so they are dropped on the way out rather than
        // leaking into every consumer's idea of the shape.
        const { seq: _seq, h: _h, ...row } = JSON.parse(line) as ChainedRow
        entries.push(row as AuditEntry)
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
