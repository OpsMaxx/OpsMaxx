import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { appendLogLine } from './logAppend'
import { redactOutput } from './secretRedaction'
import type { DebugStatus } from '../../shared/debug'

// The trace a bug reporter chooses to record, so that a report can say what the
// app DID and not only what it is.
//
// ---------------------------------------------------------------------------
// WHY THIS IS NOT THE BUNDLE shared/diagnostics.ts ARGUES AGAINST
// ---------------------------------------------------------------------------
// That file's header describes an earlier design of the bug report that
// collected a bundle — remote readings, a file on disk, a retention window —
// and says every hard problem it had came from holding text it did not author.
// It is right, and the `Diagnostics` type it guards is unchanged: still
// versions, counts and booleans, still nothing that needs a redaction pass.
//
// This is a SECOND artefact beside it, and it differs on every axis that made
// the old one bad. It is off by default. It exists only after an explicit
// switch, and the rail shows that it is recording for as long as it does. It is
// deleted when that switch is thrown, so it holds one reproduction rather than
// a history. It is shown to the user in full before it can be saved, and it is
// saved rather than copied. The app never transmits it.
//
// The thing it does NOT claim is to be safe by construction. It carries error
// text, and error text names hosts: `getaddrinfo ENOTFOUND db.internal.example`
// survives `redactOutput` whole, because no rule can tell a hostname from a
// word. That is why the preview is a GATE on the path that saves it rather than
// the courtesy it is for the diagnostics block, and why no string in the UI may
// describe this file the way that block is described.
//
// ---------------------------------------------------------------------------
// WHAT IS RECORDED, AND WHAT IS DELIBERATELY NOT
// ---------------------------------------------------------------------------
// Three sources, all of them boundaries the app already crosses, none of them a
// log statement somebody has to remember to write:
//
//  - every `ipcMain.handle` call, by CHANNEL NAME, duration and outcome. Never
//    the ARGUMENTS — see `installIpcDebugTap` below.
//  - renderer errors, over `debug:event`.
//  - main's own `console.error`/`console.warn`, teed while a session is open.
//    auditLog.ts already notes those go to a console nobody reads in a packaged
//    app; this is where they finally land.
//
// Every line still goes through `redactOutput` before it is written, because
// CONTRIBUTING's rule is to redact at the writer and an error string is exactly
// the kind of text that rule exists for.

const FILE = join(app.getPath('userData'), 'opsmaxx-debug.jsonl')

/** Exported so the bundle, the tests and SECURITY.md's table all name the same
 *  file. Two places spelling a filename is how one of them gets it wrong. */
export const DEBUG_LOG_PATH = FILE

/**
 * A hard stop, not a rotation.
 *
 * `jsonlPrune`/`jsonlRetention` drop the OLDEST lines, which is the right rule
 * for the four audit files — records somebody asks about a year later — and
 * exactly the wrong one here: the setup is what explains the failure, so the
 * beginning of a reproduction is the half worth keeping. Past this the file
 * stops growing and the bundle header says it was cut, which is honest and much
 * smaller than rotation.
 *
 * ponytail: hard stop at 8 MB, ring-buffer the middle if real reports hit it.
 */
const DEBUG_LOG_MAX_BYTES = 8 * 1024 * 1024

/** One console line cannot be allowed to spend the whole budget. */
const FIELD_CAP = 2000

// ---------------------------------------------------------------------------
// The flag
// ---------------------------------------------------------------------------
// Kept here rather than in a gate module of its own beside localGate.ts and
// accessWriteGate.ts. Those exist because their flag has MANY consumers — every
// `local:*` handler reads one, both access handlers read the other — so the
// copy has to live somewhere neither of them owns. This flag has exactly one
// consumer, `debugRecord` twenty lines down, and a third file that must agree
// with this one about a boolean would be the cost without the reason.
//
// The DEFAULT is what those two files are worth reading for. `localGate.ts`
// treats an absent key as ON; this one, like `accessWriteGate.ts`, treats it as
// OFF, and for the sharper version of that file's reason: what a capture nobody
// switched on produces is a file of hostnames and error text that nobody agreed
// to. Only the exact boolean `true` counts — absent, null, a string, a truthy
// number are all somebody NOT having made the decision.

let enabled = false
let startedAt: string | null = null
/** Bytes written, seeded from the file itself on first use so the bound
 *  survives the restart a reproduction may need. `null` means not yet read. */
let written: number | null = null
let events = 0
let truncated = false
/** Lines the cap or a refused append cost us. Reported, never silent. */
let dropped = 0

export function isDebugLogEnabled(): boolean {
  return enabled
}

function size(): number {
  if (written !== null) return written
  try {
    written = existsSync(FILE) ? statSync(FILE).size : 0
  } catch {
    written = 0
  }
  return written
}

/**
 * One line into the trace, or nothing at all.
 *
 * Never throws. `appendLogLine` refuses a symlink and a file owned by another
 * uid, both rightly, and neither refusal is worth taking down the operation the
 * line was about — a logger that can fail the app is worse than no logger. The
 * loss is counted instead and surfaces in the bundle header.
 */
export function debugRecord(event: string, fields?: Record<string, unknown>): void {
  if (!enabled) return
  if (size() >= DEBUG_LOG_MAX_BYTES) {
    truncated = true
    return
  }
  let line: string
  try {
    line = `${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`
  } catch {
    // A circular object or a BigInt in `fields`. The event name is still worth
    // having, and it is the caller's bug rather than a reason to lose the row.
    line = `${JSON.stringify({ t: new Date().toISOString(), event, note: 'unserialisable fields' })}\n`
  }
  // Redact the SERIALISED line rather than each field: `[REDACTED]` carries no
  // quote and no backslash, so it cannot break the JSON it is substituted into,
  // and one pass over one string cannot miss a field somebody added later.
  line = redactOutput(line)
  try {
    appendLogLine(FILE, line)
    written = size() + Buffer.byteLength(line)
    events += 1
  } catch {
    dropped += 1
  }
}

// ---------------------------------------------------------------------------
// The IPC tap
// ---------------------------------------------------------------------------

/**
 * Record every `ipcMain.handle` call: which channel, how long, and whether it
 * threw. This is the whole of the instrumentation, and it replaces log
 * statements at 302 call sites with one wrapper.
 *
 * NEVER THE ARGUMENTS. They carry passwords, passphrases, key material and
 * vault contents. Leaving them out is what keeps this file tolerable in the
 * same way the `Diagnostics` type is kept tolerable — by shape, rather than by
 * trusting a filter over text nobody bounded.
 *
 * Three facts make patching the method acceptable here rather than merely
 * convenient, and all three are facts about THIS repo:
 *
 *  1. `ipcMain` is imported in src/main/index.ts and nowhere else under
 *     src/main, and all 302 registrations are module-scope statements in that
 *     one file. Installed as the first thing that file does, this provably
 *     precedes every one of them. Move a handler into a feature module and that
 *     stops being true — which is what tests/ipcDebugTap.test.ts pins.
 *  2. The per-keystroke channels are `ipcMain.on`, not `handle`: `ssh:write`,
 *     `ssh:resize`, `local:write`, `local:ack`, `local:resize` (index.ts:1036,
 *     1075-1094). Tapping `handle` therefore excludes every hot path BY
 *     CONSTRUCTION, which is the difference between a 40 KB trace and one that
 *     hits the cap in a minute of typing. That is load-bearing, not luck.
 *  3. The alternative that is not "edit 302 call sites" is wrapping in preload,
 *     and it is worse: preload has no single `invoke` helper to wrap, and every
 *     event would need a second IPC hop back to main to be written.
 *
 * `debug:` channels are skipped, or the call that reports the trace's size
 * appends to the trace it is reporting on.
 *
 * The wrapper awaits only a thenable, so a synchronous handler stays
 * synchronous, and it rethrows unchanged: this observes the IPC surface, it
 * does not change it.
 */
export function installIpcDebugTap(): void {
  const real = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = ((channel: string, listener: (...args: unknown[]) => unknown): void => {
    if (channel.startsWith('debug:')) return real(channel, listener as never)
    return real(channel, ((...args: unknown[]) => {
      if (!enabled) return listener(...args)
      const t0 = Date.now()
      const done = (ok: boolean, err?: unknown): void =>
        debugRecord('ipc', {
          ch: channel,
          ms: Date.now() - t0,
          ok,
          ...(err === undefined ? {} : { error: String(err).slice(0, FIELD_CAP) })
        })
      let out: unknown
      try {
        out = listener(...args)
      } catch (err) {
        done(false, err)
        throw err
      }
      if (out instanceof Promise || (typeof out === 'object' && out !== null && 'then' in out)) {
        return (out as Promise<unknown>).then(
          (v) => {
            done(true)
            return v
          },
          (err: unknown) => {
            done(false, err)
            throw err
          }
        )
      }
      done(true)
      return out
    }) as never)
  }) as typeof ipcMain.handle
}

// ---------------------------------------------------------------------------
// The console tee
// ---------------------------------------------------------------------------
// Installed while a session is open and removed when it closes, so an install
// with debug mode off runs the original functions with nothing in front of
// them. Idempotent: `original` being set is the flag, because both the start
// and the boot-resume path call this.
//
// Worth the six lines because `src/main/` already holds 69 `console.error` and
// `console.warn` calls that today write to a console nobody reads in a packaged
// app. This captures all of them without touching a single call site.

let original: { error: typeof console.error; warn: typeof console.warn } | null = null

function installConsoleTee(): void {
  if (original !== null) return
  const keep = { error: console.error, warn: console.warn }
  original = keep
  const tee =
    (level: 'error' | 'warn') =>
    (...args: unknown[]): void => {
      keep[level](...args)
      debugRecord('console', {
        level,
        message: args.map((a) => String(a)).join(' ').slice(0, FIELD_CAP)
      })
    }
  console.error = tee('error')
  console.warn = tee('warn')
}

function removeConsoleTee(): void {
  if (original === null) return
  console.error = original.error
  console.warn = original.warn
  original = null
}

// ---------------------------------------------------------------------------
// Session transitions
// ---------------------------------------------------------------------------

function start(): void {
  try {
    rmSync(FILE, { force: true })
  } catch {
    // Nothing to clear, or a path the append below is about to be refused at
    // anyway, which is where it gets noticed.
  }
  written = 0
  events = 0
  truncated = false
  dropped = 0
  enabled = true
  startedAt = new Date().toISOString()
  installConsoleTee()
  debugRecord('session-start', {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron ?? 'unknown'
  })
}

function stop(): void {
  debugRecord('session-stop', {})
  enabled = false
  removeConsoleTee()
}

/**
 * A session that was already on when the app started.
 *
 * It does NOT delete the file, and that is the point: reproducing a bug can
 * need a restart, and a capture that wiped itself on every launch would lose
 * exactly the reproduction it was switched on for. The marker line is what lets
 * a reader see the restart in the trace.
 */
function resume(): void {
  enabled = true
  installConsoleTee()
  debugRecord('session-resume', { version: app.getVersion() })
}

/**
 * The single entry point main calls, on boot and on every `data:save`.
 *
 * The transition rule lives here rather than at the two call sites because it
 * is a rule about the FILE — delete on a fresh switch-on, never on a restart —
 * and main should not have to hold that. There is deliberately no `debug:set`
 * channel either: the settings toggle already round-trips through `data:save`,
 * so one path detects the transition and it survives a restart for free.
 */
export function syncDebugLog(data: unknown, boot = false): void {
  const settings = (data as { settings?: { debugLogEnabled?: unknown } } | null)?.settings
  const wanted = settings?.debugLogEnabled === true
  if (boot) {
    if (wanted) resume()
    return
  }
  if (wanted === enabled) return
  if (wanted) start()
  else stop()
}

/** What the Settings row and the report modal both show. */
export function debugStatus(): DebugStatus {
  return { enabled, startedAt, events, bytes: size(), truncated, dropped }
}

/** The trace as written, for the bundle. Bounded by `DEBUG_LOG_MAX_BYTES`
 *  above, so reading it whole is safe by construction. */
export function readDebugTrace(): string[] {
  try {
    if (!existsSync(FILE)) return []
    return readFileSync(FILE, 'utf8')
      .split('\n')
      .filter((l) => l !== '')
  } catch {
    // An unreadable trace degrades to an empty one. Diagnostics are what
    // somebody reaches for when the app is already misbehaving, and the rest of
    // the bundle is still worth building.
    return []
  }
}

/** Delete it. The user's copy of their own hostnames is theirs to remove, and
 *  Settings offers the button. */
export function deleteDebugLog(): void {
  try {
    rmSync(FILE, { force: true })
  } catch {
    /* already gone, or not ours — either way there is nothing to report */
  }
  written = 0
  events = 0
  truncated = false
  dropped = 0
}

/** Test seam, for the module state the file itself cannot restore. */
export function resetDebugLogForTests(value = false): void {
  enabled = value
  startedAt = null
  written = null
  events = 0
  truncated = false
  dropped = 0
  removeConsoleTee()
}
