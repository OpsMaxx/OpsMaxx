import { app } from 'electron'
import { closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'

// electron-builder's portable target sets PORTABLE_EXECUTABLE_DIR to the folder
// the .exe was launched from. When present, keep all app data beside the
// executable instead of in %APPDATA%, so copying the exe carries the servers,
// vault and settings with it.
//
// This MUST be imported before any service module: they resolve their file
// paths from app.getPath('userData') at import time, and ES module imports run
// in declaration order.
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR

if (portableDir) {
  app.setPath('userData', join(portableDir, 'OpsMaxx-data'))
}

export const isPortable = !!portableDir

/**
 * Make sure the app's own data directory exists and is 0700.
 *
 * Everything sensitive this app keeps is in here: the secrets file, the vault,
 * known_hosts, the inspector's CA key, and four append-only 0600 logs. The
 * files carry their own modes; the DIRECTORY is what decides whether another
 * account on the machine can list them and — the reason logAppend.ts exists —
 * pre-create a file at one of their fixed, guessable paths before the app does.
 * Nothing set or checked this mode, so it was whatever the umask gave it,
 * usually 0755, and in portable mode that is a data directory sitting beside
 * the executable on whatever someone plugged in.
 *
 * CALLED FROM HERE, at module scope, and not from index.ts. Not a preference:
 * index.ts's service imports resolve their paths and in some cases write their
 * files while the module graph is still being evaluated, which is strictly
 * before the first statement of index.ts's own body runs. A call down there
 * would tighten the directory after the files were already in it. This module
 * is already imported first for exactly that reason (see above), so it is the
 * only place that is reliably before anything is created.
 *
 * NOTHING HERE MAY THROW. An exception at this module's scope means the window
 * never opens, which is far worse than a directory at 0755 — so every step is
 * wrapped and a failure is reported to the console and otherwise ignored.
 *
 * THAT INCLUDES RESOLVING THE DEFAULT. `dir` used to be a default PARAMETER —
 * `dir: string = app.getPath('userData')` — and a default parameter expression
 * is evaluated at the CALL SITE, outside this function's try. So the bare
 * `ensureUserDataDir()` below was the one step of the whole function that was
 * not covered, in the first-imported module of the app, and an `app.getPath`
 * that threw there was a launch failure with no window and nothing in the
 * console. It is resolved inside the try now, which covers every caller at once
 * rather than asking each one to wrap its own call.
 *
 * The failures that are survived rather than fixed:
 *
 *   * mkdir fails (read-only install directory, unwritable stick) — the app
 *     carries on and whichever service needs the directory reports its own
 *     error, as it did before this function existed.
 *   * chmod fails because the filesystem has no POSIX modes at all. FAT32 and
 *     exFAT are the likely case and portable mode is the likely place; there
 *     is nothing to set and nothing to be done about it.
 *   * chmod fails with EPERM because the directory belongs to somebody else.
 *     Also nothing to be done, and nothing worth refusing to start over.
 */
export function ensureUserDataDir(dirArg?: string): void {
  try {
    // Inside the try, deliberately. See the docstring.
    const dir = dirArg ?? app.getPath('userData')

    // `mode` applies only when the directory is created, and the umask masks
    // it even then — so the fchmod below is what actually holds an existing
    // directory at 0700. Same pair, and the same reason, as vpn/runDir.ts.
    mkdirSync(dir, { recursive: true, mode: 0o700 })

    // Windows has no POSIX modes worth the name: chmod there sets the
    // read-only attribute and nothing else, so calling it would not restrict
    // anybody and WOULD risk marking the data directory read-only. The ACL is
    // what applies, and %APPDATA% is already scoped to this user by the one
    // the profile is created with. Portable mode on Windows is the case this
    // genuinely leaves open — a data directory beside the exe on a removable
    // stick, which is usually exFAT and has no ACLs to set. Fixing that needs
    // an ACL written through icacls or SetNamedSecurityInfo, granting this SID
    // alone and breaking inheritance from the parent, plus a decision about
    // what to do when the volume cannot hold an ACL at all. Not built, and
    // stated rather than implied: this function hardens macOS and Linux.
    if (process.platform === 'win32') return

    // THE MODE GOES ON THE DESCRIPTOR, NOT THE PATH.
    //
    // This used to SKIP the chmod entirely when `dir` was a symlink, reasoning
    // that a linked data directory is a deliberate act — someone moved their
    // data to another volume — and that chmod follows the link, so tightening
    // would change a directory this app did not create.
    //
    // The reasoning does not survive the case it matters in, because the code
    // cannot tell those apart. "Somebody moved their data" and "somebody
    // pre-created this config path as a link to a 0777 directory they own,
    // before first launch" look identical from here: `mkdirSync(recursive)`
    // succeeds on the existing link either way, the chmod was skipped either
    // way, and in the second case the secrets file, the vault, known_hosts and
    // four plaintext logs are then written into a directory somebody else reads
    // at will. Turning the protection off in exactly the case where the
    // directory is not ours is the wrong way round.
    //
    // So: open the directory and fchmod the DESCRIPTOR. What gets secured is
    // what the app is actually going to write into — link or not — and the path
    // is not resolved a second time, so there is no window between the check
    // and the change. Same trick, and the same reason, as logAppend.ts's
    // fchmod on the log it is about to append to.
    //
    // O_DIRECTORY so that a path which is NOT a directory fails the open rather
    // than being chmodded; it does not exist on Windows, which is why this sits
    // below the early return above and not beside it.
    //
    // A deliberately linked target does now get tightened to 0700, which is a
    // change to something outside this app's tree, so it is still said out loud.
    if (lstatSync(dir).isSymbolicLink()) {
      console.warn(`[portable] ${dir} is a symlink; securing its target at 0700`)
    }

    const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY)
    try {
      fchmodSync(fd, 0o700)
    } finally {
      closeSync(fd)
    }
  } catch (err) {
    console.error('[portable] could not secure the data directory', err)
  }
}

// The last-resort error nets, registered HERE rather than in index.ts, and
// registered BEFORE the ensureUserDataDir() call below.
//
// index.ts had them, at the bottom of the file — which meant they were installed
// thousands of lines after the thing most worth catching. Every service import
// sits at the top of index.ts and ES module evaluation runs those to completion
// before the first statement of the importing module, so the one launch crash in
// this project's history that reached users — a SyntaxError while an ESM service
// module was being evaluated — happened while neither handler existed. The
// console got nothing and the window never opened. This module is already
// imported first, deliberately (see above), so nets registered here are up
// before any service module is evaluated.
//
// They were twenty lines BELOW the ensureUserDataDir() call, which left the
// first thing this module does uncovered by the nets whose entire job is to
// cover startup. Order matters more than placement here, so the call moved down
// rather than these moving up in spirit only.
//
// The behaviour is unchanged and the swallowing is the point: a failed
// child_process spawn or a rejected background promise must not take the app
// down with Electron's fatal error dialog. Nothing is written to disk — a crash
// net that touches the filesystem is a crash net that can throw — and both
// bodies are wrapped, because an exception raised inside a last-resort handler
// terminates the process outright.
process.on('uncaughtException', (err) => {
  try {
    console.error('[uncaughtException]', err)
  } catch {
    /* a console that cannot be written to is not worth dying for */
  }
})
process.on('unhandledRejection', (reason) => {
  try {
    console.error('[unhandledRejection]', reason)
  } catch {
    /* as above */
  }
})

ensureUserDataDir()
