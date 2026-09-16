// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { stubBridge } from './setup/renderer'
import { useApp } from '../src/renderer/src/store/app'
import { startBackupRunWatch } from '../src/renderer/src/store/backupRuns'

/**
 * A backup that ran on its own is still a backup.
 *
 * `backupDirty` goes up in persist.ts the moment stored data changes, and it
 * came down in exactly one place: the manual export button. So the user who did
 * the right thing — configured a destination and a schedule, and stopped
 * thinking about it — got working, verified, retained backups AND a permanent
 * red "Backup out of date" telling them to go and make one by hand. That is the
 * opposite of what scheduling is for, and it is how a warning becomes one
 * nobody reads.
 *
 * The flag is about whether a current backup EXISTS, not about which button
 * produced it.
 */

const SRC = (p: string): string => readFileSync(resolve(__dirname, '..', p), 'utf8')

let deliver: ((info: { at: string; destination: string }) => void) | null = null
/** The watch is a module singleton, mounted once by App in the real thing. Each
 *  test gets a fresh one, or the second would find the guard already set and
 *  quietly subscribe to nothing. */
let stop: (() => void) | null = null

const watch = (): void => {
  stop = startBackupRunWatch()
}

afterEach(() => {
  stop?.()
  stop = null
})

beforeEach(() => {
  deliver = null
  stubBridge({
    backup: {
      onRan: (cb: (info: { at: string; destination: string }) => void) => {
        deliver = cb
        return () => undefined
      }
    }
  })
  useApp.setState((st) => ({
    settings: { ...st.settings, backupDirty: true, lastBackupAt: null, lastBackupTo: null }
  }))
})

describe('a run that lands while nobody is looking', () => {
  it('clears the warning', () => {
    watch()
    deliver?.({ at: '2026-09-16T09:00:00.000Z', destination: 'Off-site folder' })
    expect(useApp.getState().settings.backupDirty).toBe(false)
  })

  it('records when, and where it went', () => {
    watch()
    deliver?.({ at: '2026-09-16T09:00:00.000Z', destination: 'Off-site folder' })
    const s = useApp.getState().settings
    expect(s.lastBackupAt).toBe('2026-09-16T09:00:00.000Z')
    // The name is the difference between a reassurance and a fact the user can
    // go and check — and "Last exported" is the wrong sentence for a file they
    // never exported.
    expect(s.lastBackupTo).toBe('Off-site folder')
  })
})

describe('what must NOT clear it', () => {
  /**
   * Main announces successes only. Lowering the flag for a failed run would
   * replace a nag with a false reassurance, which is by some distance the worse
   * of the two bugs: the user stops looking at exactly the moment there is
   * something to look at.
   */
  it('only a successful run is announced at all', () => {
    const main = SRC('src/main/index.ts')
    const i = main.indexOf('const announceBackupRan')
    expect(i).toBeGreaterThan(-1)
    expect(main.slice(i, i + 400)).toContain('if (!report.ok) return')
  })

  it('is announced from the scheduled path and the Run button alike', () => {
    const main = SRC('src/main/index.ts')
    // The scheduler, which is the whole point...
    expect(main).toContain('announceBackupRan(report)')
    // ...and it reaches the handler at all, which needed the report threading
    // through `onRun` — the line of log text it used to get said nothing a
    // caller could act on.
    expect(SRC('src/main/services/backup.ts')).toContain(
      'handlers.onRun?.(describeRun(r), r)'
    )
  })
})

describe('the watch is mounted where runs actually happen', () => {
  // A six-hourly backup almost never lands while somebody has the Backup page
  // open, so a subscription scoped to that panel would miss nearly every run.
  it('is started at app level, beside the vault lock watch', () => {
    const app = SRC('src/renderer/src/App.tsx')
    expect(app).toContain('startBackupRunWatch()')
  })

  it('does not stack a second subscription', () => {
    watch()
    const captured = deliver
    const second = startBackupRunWatch()
    // The second call is a no-op, so the first subscription is still the live
    // one rather than having been replaced by a duplicate.
    expect(deliver).toBe(captured)
    second()
  })
})

describe('a manual export still says it was an export', () => {
  it('clears the destination name rather than leaving a stale one', () => {
    // Otherwise a hand-made backup inherits the wording of whatever scheduled
    // run happened last, and the banner names a folder the file is not in.
    expect(SRC('src/renderer/src/components/settings/BackupPanel.tsx')).toContain(
      'lastBackupTo: null'
    )
  })

  it('reads differently depending on which one it was', () => {
    const panel = SRC('src/renderer/src/components/settings/BackupPanel.tsx')
    expect(panel).toContain('Last backed up ${when(settings.lastBackupAt)} to ${settings.lastBackupTo}')
    expect(panel).toContain('Last exported ${when(settings.lastBackupAt)}')
  })
})

describe('the nag points somewhere useful', () => {
  // "Make one by hand" was the only advice on offer, to a user whose complaint
  // is having to make one by hand.
  it('mentions the schedule as the way out', () => {
    expect(SRC('src/renderer/src/components/settings/BackupPanel.tsx')).toMatch(
      /set up a destination below to have one written on a schedule/
    )
  })
})

describe('an unattended run still needs its passphrase', () => {
  /**
   * Not a defect, and stated here so it is not mistaken for one. A scheduled
   * run encrypts with a vault entry, so it cannot run while the vault is
   * locked — the passphrase cannot live in the settings blob, because that blob
   * travels inside every bundle the destination receives.
   *
   * The consequence is real and worth knowing: lock the vault, or restart the
   * app and never unlock it, and scheduled backups quietly stop. `backupTick`
   * records the skip rather than pretending, and deliberately does not mark the
   * destination as attempted, so it runs as soon as the vault opens.
   */
  it('skips rather than guesses, and does not push the next run out', () => {
    const svc = SRC('src/main/services/backup.ts')
    const i = svc.indexOf('const { password, skipped, code } = scheduledPassphrase(dest)')
    expect(i).toBeGreaterThan(-1)
    const body = svc.slice(i, i + 1500)
    expect(body).toContain('result.skipped[dest.id] = reason')
    // Not marked as attempted: a locked vault clears on its own, and pushing
    // the next attempt a full period out because the user happened to be
    // locked at the tick would turn an hourly backup into a daily one.
    expect(body).toContain('continue')
  })

  // And it is written down, which is the half that was missing. The reason went
  // into a result object no caller read, so a schedule blocked by a locked
  // vault was indistinguishable from one that was working.
  it('records the skip where something can read it', () => {
    const svc = SRC('src/main/services/backup.ts')
    expect(svc).toContain('export function recordSkip')
    expect(svc).toContain("if (recordSkip(dest.id, reason, now, code ?? 'other'))")
  })
})
