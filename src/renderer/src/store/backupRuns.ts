import { useApp } from './app'
import { bridgeOn } from '../lib/bridge'

/**
 * An automatic backup counts as a backup.
 *
 * `backupDirty` is raised by persist.ts the moment stored data changes, and it
 * was lowered in exactly one place: the manual export button. So a user who
 * configured a scheduled destination got working, verified, retained backups
 * AND a permanent red "Backup out of date" in the status bar telling them to go
 * and make one by hand — which is precisely what scheduling it was meant to
 * stop. The flag is about whether a current backup exists, not about which
 * button produced it.
 *
 * Main announces only successful runs, so a destination that is failing keeps
 * the warning up. Replacing a nag with a false reassurance would be the worse
 * of the two bugs by some distance.
 *
 * Idempotent, and mounted once at app level, for the same reason the vault lock
 * watch is: a subscription scoped to whichever view happens to be open would
 * miss every run that lands while the user is somewhere else, which for a
 * six-hourly backup is almost all of them.
 */
let watching = false

export function startBackupRunWatch(): () => void {
  if (watching) return () => {}
  watching = true

  const off = bridgeOn('backup.onRan', window.opsmaxx?.backup?.onRan, (info) => {
    useApp.getState().setSettings({
      backupDirty: false,
      lastBackupAt: info.at,
      // Named, because "Last exported 20 minutes ago" is the wrong sentence for
      // a file the user did not export. Knowing WHERE it went is also the
      // difference between a reassurance and a fact they can go and check.
      lastBackupTo: info.destination
    })
  })

  return () => {
    off()
    watching = false
  }
}
