import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  writeFileSync
} from 'node:fs'

// The one place that appends a line to a long-lived 0600 log.
//
// ---------------------------------------------------------------------------
// FOUR WRITERS HAD THE SAME TWO GAPS, SO THEY GET ONE FIX RATHER THAN FOUR
// ---------------------------------------------------------------------------
// auditLog.ts, localSessionLog.ts, approvalLog.ts and credProxy.ts each wrote
// `appendFileSync(FILE, line, { mode: 0o600 })`, and between them those files
// hold: which tool an agent called against which workspace and server, which
// shells ran on this machine and from which directory (a path that spells the
// OS username), which command a human authorised on which host, and which
// credential was forwarded to which third-party host. Four copies of a gap in
// four modules is how three of them stay open after the first is fixed.
//
// GAP ONE — `mode` applies only when the file is CREATED. A file that already
// exists keeps the permissions it already had, for the rest of its life, and
// silently: created before the mode argument was added, restored from a
// tarball, or pre-created by anything else running as this user. runDir.ts's
// `writeSecretFile` covers the same gap with an explicit chmod and says so, and
// history.ts's `restrictPermissions` chmods the store for the same reason.
//
// GAP TWO — the append flag `'a'` FOLLOWS A SYMLINK. All four paths are fixed
// and guessable, so a link pre-created at one of them means every row after it
// is appended to a file somebody else chose, with no error anywhere.
//
// WHY NOT jsonlPrune.ts's `rmSync` then `openSync(path, 'wx')`. That is the
// right answer for `${file}.pruning`, a temp file that should not exist: clear
// the path, then refuse to adopt anything at it. Neither half survives here.
// These files legitimately DO exist — they are the history — so clearing the
// path first would delete the log this function was called to extend, and 'wx'
// (O_CREAT|O_EXCL) would refuse every append after the one that created it. An
// append target has to be opened, not claimed.

// O_NOFOLLOW makes the kernel fail the open with ELOOP when the final path
// component is a symlink — the same check as the lstat below, except that
// nothing can happen between it and the open. It does not exist on Windows, and
// `?? 0` there leaves the lstat as the only guard, so on Windows a link created
// in the window between the lstat and the open would still be followed. Narrow,
// and not worth a second mechanism: creating a symlink on Windows needs either a
// privilege or developer mode.
const APPEND_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0)

/**
 * Append `line` to `file`, creating it 0600 and forcing it back to 0600 if it
 * was already there at something wider.
 *
 * Refuses outright, rather than writing, when the path is a symlink or the file
 * is not this process's own (another uid, or more than one hard link).
 *
 * THROWS, deliberately. All four callers already wrap their append in a
 * try/catch, because a failed audit append must not take down the action the row
 * was about. That is also why the refusal is safe to raise: a log that cannot be
 * written loses a row, and a log appended through somebody else's symlink loses
 * the rows TO somebody else.
 *
 * Three of the four do nothing in that catch but `console.error`. auditLog.ts is
 * the exception and is the model for the others: it ALSO records the message in a
 * module-level flag, cleared by the next append that works, and exposes it as
 * `auditAppendFailure()` so a reader can be told appends are failing and why.
 *
 * A caller that wants that refusal to be VISIBLE has to say so itself, the way
 * auditLog.ts does. console.error alone has no reader in a packaged app.
 */
export function appendLogLine(file: string, line: string): void {
  // lstat, not stat: stat follows the link and reports the TARGET, so a link to
  // a file that does not exist yet reads as "nothing here" and the append would
  // then create it, at a path somebody else chose. `throwIfNoEntry: false`
  // because "not there yet" is the normal first call.
  if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`Refusing to append to ${file}: it is a symlink, not the log file.`)
  }
  const fd = openSync(file, APPEND_FLAGS, 0o600)
  try {
    // fchmod on the DESCRIPTOR, not chmod on the path: the path has been
    // resolved once already and this does not resolve it again, so there is no
    // window in which the thing being chmodded is not the thing being written
    // to. Swallowed on failure the way runDir.ts and history.ts swallow theirs —
    // a file that will not take the mode is still a file whose row is worth more
    // written than dropped, and on Windows modes are not this.
    if (process.platform !== 'win32') {
      // GAP THREE, and the reason the swallow below is not enough on its own.
      // Swallowing the fchmod is right for a filesystem with no POSIX modes —
      // and it is ALSO what happens when the file belongs to another uid, which
      // is not the same situation at all: there the mode cannot be set because
      // somebody else owns the file, and the rows are then appended into their
      // file, at the app's own predictable path, for as long as the install
      // lives. O_NOFOLLOW and the lstat stop a SYMLINK; neither of them looks at
      // who owns the thing at the end of the path, and neither sees a HARD link,
      // which reaches the same outcome with no link to lstat. fstat on the
      // descriptor already open answers both, and costs one syscall.
      //
      // `process.getuid` is undefined on Windows; that is unreachable inside
      // this branch, and the optional call is what makes that a fact rather than
      // a claim.
      const st = fstatSync(fd)
      const me = process.getuid?.()
      if (me !== undefined && st.uid !== me) {
        throw new Error(
          `Refusing to append to ${file}: it is owned by uid ${st.uid}, not this process (${me}).`
        )
      }
      if (st.nlink > 1) {
        throw new Error(
          `Refusing to append to ${file}: it has ${st.nlink} hard links, so it is not only the log.`
        )
      }
      try {
        fchmodSync(fd, 0o600)
      } catch {
        /* a permissions failure must not cost the row */
      }
    }
    // GAP FOUR. `writeSync` is ONE write(2) and returns how many bytes it took;
    // ignoring that truncates a record mid-JSON on a short write — ENOSPC on a
    // nearly full volume, an interrupting signal, a network-mounted userData —
    // and the next append then glues onto the fragment. Readers survive it (each
    // line is parsed in its own try/catch) and retention KEEPS an unparseable
    // line, so the damage is one lost row plus one unreadable line that outlives
    // every prune. `writeFileSync` loops until every byte lands, which is what
    // `appendFileSync` did here before this function existed; the fd was opened
    // O_APPEND, so it appends rather than truncating. Same form jsonlPrune.ts
    // already uses on a descriptor.
    writeFileSync(fd, line)
  } finally {
    closeSync(fd)
  }
}
