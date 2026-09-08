import { describe, expect, it } from 'vitest'
import {
  BACKUP_OVERDUE_PERIODS,
  assessBackups,
  type BackupDestination,
  type BackupRunReport
} from '../src/shared/backup'

const NOW = Date.UTC(2026, 8, 5, 12, 0, 0)
const H = 3600_000

const dest = (over: Partial<BackupDestination> = {}): BackupDestination =>
  ({ id: 'd1', name: 'offsite', kind: 'local', directory: '/b', everyHours: 24, ...over }) as BackupDestination

const report = (over: Partial<BackupRunReport> = {}): BackupRunReport =>
  ({
    ok: true,
    verified: true,
    destinationId: 'd1',
    destinationName: 'offsite',
    destinationKind: 'local',
    startedAt: new Date(NOW - H).toISOString(),
    finishedAt: new Date(NOW - H).toISOString(),
    ...over
  }) as BackupRunReport

describe('whether there is actually a backup', () => {
  it('is quiet when a recent run succeeded and was read back', () => {
    expect(assessBackups([dest()], { d1: report() }, NOW)).toEqual([])
  })

  it('alarms on a destination that has never produced one', () => {
    // Scheduled, switched on, and nothing has ever been written. The operator
    // believes they have backups; they have a setting.
    const [a] = assessBackups([dest()], {}, NOW)
    expect(a.reason).toBe('never')
    expect(a.level).toBe('alarm')
    expect(a.detail).toMatch(/never produced a backup/)
  })

  it('alarms when the last run failed', () => {
    const [a] = assessBackups([dest()], { d1: report({ ok: false, error: 'connection refused' }) }, NOW)
    expect(a.reason).toBe('failed')
    expect(a.detail).toMatch(/connection refused/)
  })

  it('judges lateness by the last SUCCESS, which is not what lastRunAt records', () => {
    // The trap this whole function exists around. `lastRunAt` advances on an
    // ATTEMPT — deliberately, so a broken destination is not retried every
    // minute — so a schedule whose every run fails looks perfectly current
    // through that field. Only the last successful report answers "do I have a
    // backup", and this reads that.
    const old = report({ finishedAt: new Date(NOW - 72 * H).toISOString() })
    const [a] = assessBackups([dest({ everyHours: 24 })], { d1: old }, NOW)
    expect(a.reason).toBe('overdue')
    expect(a.detail).toMatch(/72h ago/)
  })

  it('allows a missed period before it complains', () => {
    // OpsMaxx backs up only while it is running, so a daily schedule on a
    // laptop shut overnight is routinely late and that is not a fault.
    const late = report({ finishedAt: new Date(NOW - 30 * H).toISOString() })
    expect(assessBackups([dest({ everyHours: 24 })], { d1: late }, NOW)).toEqual([])
    expect(BACKUP_OVERDUE_PERIODS).toBe(2)
  })

  it('does not call an unscheduled destination overdue', () => {
    // Backing up by hand is a choice. Alarming about it would train somebody to
    // ignore this whole class of alert.
    const ancient = report({ finishedAt: new Date(NOW - 5000 * H).toISOString() })
    expect(assessBackups([dest({ everyHours: 0 })], { d1: ancient }, NOW)).toEqual([])
  })

  it('watches, rather than alarms, a run that was written but never read back', () => {
    // `verified` is true only when the bytes came back and matched. A write
    // nobody read back is probably fine and is not evidence, so it is not
    // silence either.
    const [a] = assessBackups([dest()], { d1: report({ verified: false }) }, NOW)
    expect(a.reason).toBe('unverified')
    expect(a.level).toBe('watch')
  })

  it('treats a report it cannot date as old, not as fresh', () => {
    const [a] = assessBackups([dest()], { d1: report({ finishedAt: 'not a date' }) }, NOW)
    expect(a.reason).toBe('overdue')
    expect(a.level).toBe('alarm')
  })

  it('reports each destination separately', () => {
    const out = assessBackups(
      [dest({ id: 'a', name: 'local' }), dest({ id: 'b', name: 'offsite' })],
      { a: report({ destinationId: 'a' }) },
      NOW
    )
    expect(out).toHaveLength(1)
    expect(out[0].destinationName).toBe('offsite')
  })
})
