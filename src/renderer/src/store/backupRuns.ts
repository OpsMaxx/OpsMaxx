import { create } from 'zustand'
import { useApp } from './app'
import { useVaultPrompt } from './vaultPrompt'
import { bridgeOn } from '../lib/bridge'
import type { BackupSkipCode } from '../../../shared/backup'

/**
 * An automatic backup counts as a backup — and one that quietly stopped has to
 * say so.
 *
 * Two halves of the same problem. `backupDirty` is raised by persist.ts the
 * moment stored data changes, and it was lowered in exactly one place: the
 * manual export button, so a scheduled destination could never clear it. And
 * `backupTick` wrote the reason a due destination was skipped into a result
 * object that no caller read, so a schedule blocked by a locked vault was
 * indistinguishable from one that was working.
 *
 * The second is the worse of the two. A backup that is not running is the state
 * this feature exists to prevent, and the one it could least afford to keep to
 * itself.
 */

export interface BackupPause {
  destinationName: string
  reason: string
  since: number
  /** Machine-readable, so the status bar can offer the remedy rather than
   *  matching an English sentence nobody would think to keep stable. */
  code?: BackupSkipCode
}

interface BackupRunState {
  /** Destinations the schedule is currently declining to run. */
  paused: BackupPause[]
}

export const useBackupRuns = create<BackupRunState>(() => ({ paused: [] }))

/**
 * The file is the truth; the events are only a poke to re-read it.
 *
 * Both `backup:ran` and `backup:skipped` are transitions, and a UI driven by
 * transitions alone is wrong the moment one is missed — including the very
 * first render after a restart, when the interesting case (a vault that has
 * never been unlocked) is already true and nothing has happened yet. So this
 * re-reads the targets file, which carries the standing condition, and cannot
 * drift from what the panel shows.
 */
async function refresh(): Promise<void> {
  const file = await window.opsmaxx?.backup?.destinations?.()
  if (!file) return
  const skipped = file.skipped ?? {}
  const paused: BackupPause[] = []
  for (const dest of file.destinations) {
    const s = skipped[dest.id]
    // A destination with no interval is not "paused" — nobody asked it to run.
    if (s && dest.everyHours > 0) {
      paused.push({
        destinationName: dest.name,
        reason: s.reason,
        since: s.since,
        code: s.code
      })
    }
  }
  useBackupRuns.setState({ paused })
}

let watching = false

export function startBackupRunWatch(): () => void {
  if (watching) return () => {}
  watching = true

  const offRan = bridgeOn('backup.onRan', window.opsmaxx?.backup?.onRan, (info) => {
    useApp.getState().setSettings({
      backupDirty: false,
      lastBackupAt: info.at,
      // Named, because "Last exported 20 minutes ago" is the wrong sentence for
      // a file the user did not export, and the destination is what makes the
      // reassurance something they can go and check.
      lastBackupTo: info.destination
    })
    void refresh()
  })

  const offSkipped = bridgeOn('backup.onSkipped', window.opsmaxx?.backup?.onSkipped, () => {
    void refresh()
  })

  // And once now, because the condition that matters most is already true
  // before any event fires: the app has just started and nobody has unlocked
  // the vault.
  void refresh()

  return () => {
    offRan()
    offSkipped()
    watching = false
  }
}

/**
 * Offer the one action that restarts a paused schedule.
 *
 * Persistent Touch ID already exists and already stores the vault key across
 * restarts — but nothing ever RAISES it after a launch. The vault sits locked,
 * the scheduler declines (correctly: an unattended run must not put a dialog on
 * screen), and the user is never asked. So the convenience that was built to
 * solve exactly this never got the chance to.
 *
 * This is the chance. It runs from a click on the status bar — a person, acting
 * on something they just read — so the dialog is the answer to that click, not
 * an interruption. `VaultUnlockModal` raises Touch ID on its own when it opens,
 * which makes this one click and one fingerprint for somebody who took the
 * "across restarts" offer.
 *
 * Nothing is retried here. The next tick is within five minutes and the
 * destination was never marked as attempted, so it runs on its own; kicking it
 * by hand would be a second code path for the same thing.
 */
export async function offerUnlockForBackups(): Promise<void> {
  await useVaultPrompt.getState().request('Scheduled backups are waiting on the vault.')
  await refresh()
}
