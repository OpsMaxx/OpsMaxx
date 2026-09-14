import { describe, it, expect, beforeEach, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { dialog } from 'electron'
import { buildDebugBundle, reportOs, saveDebugBundle } from '../src/main/services/debugBundle'
import {
  debugRecord,
  deleteDebugLog,
  resetDebugLogForTests,
  syncDebugLog
} from '../src/main/services/debugLog'
import { DIAGNOSTICS_HEADING } from '../src/shared/diagnostics'

// The report is the diagnostics block plus the trace, and the properties that
// matter are about the JOIN: the block is carried unchanged rather than
// reworded here, the trace is reported honestly including when it is empty or
// was cut, and the file that comes out says what actually happened to it.

const PROBES = {
  webhook: { enabled: false, hasUrl: false, notifyOnResolved: true },
  aiBridgeRunning: false
}

beforeEach(() => {
  resetDebugLogForTests()
  deleteDebugLog()
  vi.restoreAllMocks()
})

describe('what the report carries', () => {
  it('carries the diagnostics block unchanged', () => {
    const { text } = buildDebugBundle(PROBES)
    // Not reworded, not re-ordered, not filtered again. src/shared/diagnostics.ts
    // owns what that block says and this file may not have a second opinion.
    expect(text).toContain(DIAGNOSTICS_HEADING)
    expect(text).toContain('[config]')
    expect(text).toContain('[counts]')
  })

  it('says plainly when debug mode was never on', () => {
    const { text, events } = buildDebugBundle(PROBES)
    // Zero is the honest answer for a report filed without reproducing
    // anything, and it is the report the old button sent every single time.
    expect(events).toBe(0)
    expect(text).toContain('debug mode was not on')
    expect(text).toContain('(empty)')
  })

  it('carries the trace, indented so a JSON line cannot forge a section heading', () => {
    syncDebugLog({ settings: { debugLogEnabled: true } })
    debugRecord('ipc', { ch: 'ssh:connect', ms: 12, ok: false, error: 'ECONNREFUSED' })

    const { text, events } = buildDebugBundle(PROBES)

    expect(events).toBeGreaterThan(0)
    expect(text).toContain('[trace]')
    expect(text).toContain('  {')
    expect(text).toContain('ssh:connect')
    // A `key: value` reader has to be able to tell a continuation line from a
    // field, and a raw JSON line opening with `[` would read as a heading.
    for (const line of text.split('\n').filter((l) => l.startsWith('{'))) {
      expect(line, 'an unindented JSON line reached the report').toBe('')
    }
  })

  it('reports the version and OS the issue form will be prefilled with', () => {
    const { version, os } = buildDebugBundle(PROBES)
    expect(version).toBeTruthy()
    // One of the dropdown's own labels, verbatim, or GitHub selects nothing.
    expect(['Windows', 'macOS', 'Linux']).toContain(os)
    expect(os).toBe(reportOs())
  })

  it('does not carry the audit logs', () => {
    // opsmaxx-ai-audit.jsonl holds which tool an agent called against which
    // server, and opsmaxx-job-approvals.jsonl which command a human authorised
    // on which host. For "the tunnel panel renders empty" both are noise, and
    // they are the rows SECURITY.md offers as the record of what an AI did on
    // somebody's servers. Nobody chose to attach them, so they are not attached.
    const { text } = buildDebugBundle(PROBES)
    for (const section of ['[ai-audit]', '[local-sessions]', '[job-approvals]', '[credproxy-audit]'])
      expect(text).not.toContain(section)
  })
})

describe('what the save actually reports', () => {
  const target = join(tmpdir(), `opsmaxx-report-test-${process.pid}.txt`)

  it('writes the file and returns the path it wrote', async () => {
    rmSync(target, { force: true })
    vi.spyOn(dialog, 'showSaveDialog').mockResolvedValue({ canceled: false, filePath: target })

    const res = await saveDebugBundle('report body')

    expect(res).toEqual({ ok: true, path: target })
    expect(readFileSync(target, 'utf8')).toBe('report body')
  })

  it('writes it 0600, because it holds hostnames', async () => {
    if (process.platform === 'win32') return
    rmSync(target, { force: true })
    vi.spyOn(dialog, 'showSaveDialog').mockResolvedValue({ canceled: false, filePath: target })

    await saveDebugBundle('report body')

    expect(statSync(target).mode & 0o777).toBe(0o600)
  })

  it('reports CANCELLED as cancelled, and writes nothing', async () => {
    rmSync(target, { force: true })
    vi.spyOn(dialog, 'showSaveDialog').mockResolvedValue({ canceled: true, filePath: '' })

    const res = await saveDebugBundle('report body')

    // The path this replaced returned `true` whenever nothing threw, so a
    // cancelled save was reported to the user as a file in their downloads
    // folder that did not exist. A boolean could not tell the two apart; this
    // shape has to.
    expect(res).toEqual({ ok: false, cancelled: true })
    expect(existsSync(target)).toBe(false)
  })

  it('reports why when the write fails', async () => {
    vi.spyOn(dialog, 'showSaveDialog').mockResolvedValue({
      canceled: false,
      filePath: join(tmpdir(), 'no-such-directory-here', 'report.txt')
    })

    const res = await saveDebugBundle('report body')

    expect(res.ok).toBe(false)
    expect(res.ok === false && 'error' in res ? res.error : '').toBeTruthy()
  })
})
