import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import {
  DEBUG_LOG_PATH,
  debugRecord,
  debugStatus,
  deleteDebugLog,
  isDebugLogEnabled,
  readDebugTrace,
  resetDebugLogForTests,
  syncDebugLog
} from '../src/main/services/debugLog'

// The trace is the half of a bug report that says what the app DID. It is also
// the half that is not safe by construction — it carries error text, and an
// error names what it failed to reach — so the properties worth pinning are
// about what it REFUSES to do: nothing at all while it is off, no secret in it
// when it is on, and no unbounded growth either way.

const on = (): void => syncDebugLog({ settings: { debugLogEnabled: true } })
const off = (): void => syncDebugLog({ settings: { debugLogEnabled: false } })

beforeEach(() => {
  resetDebugLogForTests()
  deleteDebugLog()
})

describe('the flag', () => {
  it('is off until somebody says the exact boolean', () => {
    expect(isDebugLogEnabled()).toBe(false)
    for (const settings of [{}, { debugLogEnabled: undefined }, { debugLogEnabled: 'yes' }, { debugLogEnabled: 1 }]) {
      syncDebugLog({ settings })
      // Absent, null, a string, a truthy number — none of them is somebody
      // having made the decision, and what a capture nobody switched on
      // produces is a file of hostnames nobody agreed to.
      expect(isDebugLogEnabled()).toBe(false)
    }
  })

  it('writes nothing whatsoever while it is off', () => {
    debugRecord('ipc', { ch: 'ssh:connect' })
    expect(existsSync(DEBUG_LOG_PATH)).toBe(false)
  })

  it('records a session marker when it goes on, and one when it goes off', () => {
    on()
    debugRecord('ipc', { ch: 'ssh:connect', ok: true })
    off()
    const kinds = readDebugTrace().map((l) => (JSON.parse(l) as { event: string }).event)
    expect(kinds[0]).toBe('session-start')
    expect(kinds.at(-1)).toBe('session-stop')
  })

  it('stops writing the moment it goes off', () => {
    on()
    off()
    const before = readDebugTrace().length
    debugRecord('ipc', { ch: 'ssh:connect' })
    expect(readDebugTrace().length).toBe(before)
  })
})

describe('the session boundary', () => {
  it('clears the file when the switch is thrown, so a report carries one reproduction', () => {
    on()
    debugRecord('ipc', { ch: 'first-session' })
    off()
    expect(readDebugTrace().some((l) => l.includes('first-session'))).toBe(true)

    on()
    expect(readDebugTrace().some((l) => l.includes('first-session'))).toBe(false)
  })

  it('does NOT clear it on a restart, because reproducing can need one', () => {
    on()
    debugRecord('ipc', { ch: 'before-restart' })
    // What boot does: the flag is still true in the persisted blob, and main
    // reads it before the renderer's first data:save. A capture that wiped
    // itself on every launch would lose the reproduction it was on for.
    resetDebugLogForTests()
    syncDebugLog({ settings: { debugLogEnabled: true } }, true)

    const trace = readDebugTrace()
    expect(trace.some((l) => l.includes('before-restart'))).toBe(true)
    expect(trace.some((l) => l.includes('session-resume'))).toBe(true)
  })
})

describe('what a line may contain', () => {
  it('redacts a secret before it is written, not before it is shown', () => {
    on()
    debugRecord('console', { level: 'error', message: 'spawn failed: PGPASSWORD=hunter2 psql' })
    // Redact at the writer: the stored copy is already clean, so a reader of
    // the file on disk is in the same position as a reader of the report.
    const raw = readFileSync(DEBUG_LOG_PATH, 'utf8')
    expect(raw).not.toContain('hunter2')
    expect(raw).toContain('[REDACTED]')
  })

  it('leaves a hostname standing, which is why the report is previewed', () => {
    on()
    debugRecord('ipc', { ch: 'ssh:connect', error: 'getaddrinfo ENOTFOUND db-prod.internal.example' })
    // No rule can tell a host from a word, so this survives on purpose and the
    // dialog that sends it says so rather than promising a filter it does not
    // have.
    expect(readFileSync(DEBUG_LOG_PATH, 'utf8')).toContain('db-prod.internal.example')
  })

  it('stays one JSON line per event even when a field carries newlines', () => {
    on()
    debugRecord('console', { level: 'error', message: 'line one\nline two\nline three' })
    for (const line of readDebugTrace()) expect(() => JSON.parse(line) as unknown).not.toThrow()
  })

  it('keeps the event when the fields cannot be serialised', () => {
    on()
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => debugRecord('ipc', circular)).not.toThrow()
    expect(readDebugTrace().some((l) => l.includes('unserialisable'))).toBe(true)
  })
})

describe('the bounds', () => {
  it('is written 0600, because it holds hostnames', () => {
    if (process.platform === 'win32') return
    on()
    debugRecord('ipc', { ch: 'x' })
    expect(statSync(DEBUG_LOG_PATH).mode & 0o777).toBe(0o600)
  })

  it('stops at the cap instead of growing without bound, and says it was cut', () => {
    on()
    // Past 8 MB. Seeded through the file rather than by writing eight million
    // bytes, because the cap is read from the file's real size — which is what
    // makes it survive the restart above.
    writeFileSync(DEBUG_LOG_PATH, 'x'.repeat(9 * 1024 * 1024), { mode: 0o600 })
    resetDebugLogForTests(true)

    debugRecord('ipc', { ch: 'over-the-cap' })

    expect(readFileSync(DEBUG_LOG_PATH, 'utf8')).not.toContain('over-the-cap')
    expect(debugStatus().truncated).toBe(true)
  })

  it('never throws when the file cannot be appended to', () => {
    on()
    // A logger that can fail the app is worse than no logger: `appendLogLine`
    // refuses a symlink and a file owned by another uid, both rightly, and
    // neither is worth taking down the operation the line was about.
    deleteDebugLog()
    writeFileSync(DEBUG_LOG_PATH, '')
    expect(() => debugRecord('ipc', { ch: 'x' })).not.toThrow()
  })
})

describe('the user owns the file', () => {
  it('deletes it on request, and says there is nothing left', () => {
    on()
    debugRecord('ipc', { ch: 'x' })
    expect(existsSync(DEBUG_LOG_PATH)).toBe(true)

    deleteDebugLog()

    expect(existsSync(DEBUG_LOG_PATH)).toBe(false)
    expect(debugStatus().bytes).toBe(0)
  })
})
