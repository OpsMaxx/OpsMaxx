import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  ROTATION_MARKERS,
  ROTATION_STALE_DAYS,
  buildLogRotationCommand,
  parseJournalSize,
  parseJournalUsage,
  parseLogRotation,
  parseRotationState,
  rotationHeadline
} from '../src/shared/logRotation'

// Whether the logs on a host are actually being trimmed. Recorded from a real
// Ubuntu 24.04 server (systemd 255) through the command this builds; its
// hostname and machine id were replaced, and nothing else was touched.

const FIX = readFileSync(
  fileURLToPath(new URL('./fixtures/host/rotation/ubuntu-2404.txt', import.meta.url)),
  'utf8'
)
const NOW = Date.UTC(2026, 8, 6, 20, 0, 0)
const report = (): ReturnType<typeof parseLogRotation> => parseLogRotation(FIX, NOW)

describe('the logrotate state file', () => {
  // FINDING 1. The dates are NOT zero padded: `2026-9-6-0:0:2`. That is neither
  // ISO nor anything Date.parse reads correctly, so the fields are parsed as
  // numbers rather than handed to it.
  it('reads a date with no leading zeros anywhere', () => {
    expect(FIX).toContain('"/var/log/syslog" 2026-9-6-0:0:2')
    const f = parseRotationState('"/var/log/syslog" 2026-9-6-0:0:2')
    expect(f).toHaveLength(1)
    expect(f[0].lastMs).toBe(Date.UTC(2026, 8, 6, 0, 0, 2))
  })

  it('reads every entry the real host had', () => {
    expect(report().files).toHaveLength(21)
    expect(report().files.map((f) => f.path)).toContain('/var/log/auth.log')
  })

  // The header line is not an entry, and neither is anything else that is not
  // a quoted path followed by that date shape.
  it('ignores the version header and anything malformed', () => {
    expect(parseRotationState('logrotate state -- version 2')).toEqual([])
    expect(parseRotationState('"/var/log/x" not-a-date')).toEqual([])
    expect(parseRotationState('/var/log/x 2026-9-6-0:0:2')).toEqual([])
  })

  // A file that stopped being rotated is how a disk fills quietly.
  it('names the ones that have not rotated in a fortnight', () => {
    const old = Date.UTC(2026, 7, 1, 0, 0, 0)
    const r = parseLogRotation(
      `${ROTATION_MARKERS.state}\n"/var/log/fresh" 2026-9-6-0:0:2\n"/var/log/stuck" 2026-8-1-0:0:0\n`,
      NOW
    )
    expect(r.stale.map((f) => f.path)).toEqual(['/var/log/stuck'])
    expect(r.stale[0].lastMs).toBe(old)
    expect(ROTATION_STALE_DAYS).toBe(14)
  })

  it('finds nothing stale on the host that was rotating normally', () => {
    expect(report().stale).toEqual([])
  })
})

describe('the journal ceiling, which is the point', () => {
  // FINDING 2. `journalctl --disk-usage` answers with a size and stops. The
  // configured cap on the measured host was `#SystemMaxUse=` -- commented out.
  // The effective number exists in exactly one place: a line journald writes to
  // its own journal at startup.
  it('takes the ceiling from journald’s own announcement', () => {
    const r = report()
    expect(r.journal.usedBytes).toBe(207_932_621)
    expect(r.journal.maxBytes).toBe(4 * 1024 ** 3)
    expect(Math.round(r.journalPct ?? 0)).toBe(5)
  })

  // The command asks for the last few and the parser takes the last, because
  // journald announces this at every restart and the older ones are stale.
  it('uses the most recent announcement when there are several', () => {
    expect(FIX.match(/System Journal/g)!.length).toBeGreaterThan(1)
    const u = parseJournalUsage(
      'take up 10.0M in the file system',
      'is 1.0M, max 100.0M, 99M free\nis 2.0M, max 250.0M, 248M free\n'
    )
    expect(u.maxBytes).toBe(250 * 1024 ** 2)
  })

  it('reads journald’s own size spellings', () => {
    expect(parseJournalSize('198.3M')).toBe(Math.round(198.3 * 1024 ** 2))
    expect(parseJournalSize('4.0G')).toBe(4 * 1024 ** 3)
    expect(parseJournalSize('512K')).toBe(512 * 1024)
    expect(parseJournalSize('900')).toBe(900)
    expect(parseJournalSize('lots')).toBeNull()
  })

  // FINDING 3, and the most dangerous available wrong answer. A cap this build
  // could not read is UNREAD, not absent -- journald always has one, and an
  // unset SystemMaxUse means it computed a default from the filesystem.
  it('never says a journal with no readable ceiling is unlimited', () => {
    const r = parseLogRotation(
      `${ROTATION_MARKERS.usage}\nArchived and active journals take up 198.3M in the file system.\n${ROTATION_MARKERS.cap}\n`,
      NOW
    )
    expect(r.journal.usedBytes).not.toBeNull()
    expect(r.journal.maxBytes).toBeNull()
    // No percentage is invented from a ceiling nobody read.
    expect(r.journalPct).toBeNull()
    const h = rotationHeadline(r)
    expect(h).toContain('not unlimited, it is unread')
    expect(h).not.toMatch(/\d+% of the ceiling/)
  })

  // A size with no scale is not an answer: 198 MB of 4 GB is nothing, and 198
  // MB of 256 MB is a journal about to drop what somebody was looking for.
  it('never prints a size without its ceiling', () => {
    expect(rotationHeadline(report())).toContain('% of the ceiling')
  })
})

describe('whether anything is rotating at all', () => {
  const withLr = (present: string, timer: string): ReturnType<typeof parseLogRotation> =>
    parseLogRotation(`${ROTATION_MARKERS.logrotate}\n${present}\n${timer}\n`, NOW)

  it('separates installed-and-scheduled from installed-and-idle', () => {
    expect(withLr('yes', 'active').logrotate).toBe('running')
    expect(withLr('yes', 'inactive').logrotate).toBe('installed-not-scheduled')
    expect(rotationHeadline(withLr('yes', 'inactive'))).toContain('not running on its own')
  })

  it('says when it is not installed, and when it could not be read', () => {
    expect(withLr('no', '').logrotate).toBe('absent')
    expect(rotationHeadline(withLr('no', ''))).toContain('nothing here is trimming')
    expect(parseLogRotation('', NOW).logrotate).toBe('unknown')
    expect(rotationHeadline(parseLogRotation('', NOW))).toContain('could not be read')
  })
})

describe('the command', () => {
  it('never escalates and lets each section fail alone', () => {
    const c = buildLogRotationCommand()
    expect(c).not.toContain('sudo')
    for (const m of Object.values(ROTATION_MARKERS)) expect(c).toContain(m)
  })

  // Debian moved the state file under a directory; RHEL keeps it as a file.
  it('looks for the state file in both places', () => {
    const c = buildLogRotationCommand()
    expect(c).toContain('/var/lib/logrotate/status')
    expect(c).toContain('/var/lib/logrotate.status')
  })

  // The ceiling is not in any config file, so it is read from journald's log.
  it('asks journald’s own journal for the ceiling', () => {
    expect(buildLogRotationCommand()).toContain('journalctl -u systemd-journald')
    expect(buildLogRotationCommand()).toContain('System Journal')
  })
})
