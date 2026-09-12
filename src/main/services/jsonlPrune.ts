import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { retainedLines } from '../../shared/jsonlRetention'

/**
 * Apply the retention horizon to one append-only JSON-lines log.
 *
 * THE APPEND-ONLY PROPERTY IS THE POINT, AND PRUNING MUST NOT COST IT. Each of
 * these files is documented as never rewritten in place, so that a crash
 * mid-write corrupts at most the last line rather than the whole history. A
 * prune that opens the file for writing and truncates it gives that up: a crash
 * during the rewrite loses everything, and it loses it during the one operation
 * that touches every line.
 *
 * So the survivors are written to a sibling and renamed over the original.
 * `rename` within a filesystem is atomic, so at every instant a reader sees
 * either the whole old file or the whole new one, and a crash leaves one of the
 * two rather than a half-written log. This is the same manoeuvre the remote
 * wrapper uses for its `rc` file, for the same reason.
 *
 * Returns how many lines went, or null if the file was left alone.
 */
export function pruneJsonl(file: string, now = Date.now()): number | null {
  try {
    // THE SAME ANSWER appendLogLine GIVES, to the same question. It refuses a
    // symlink at a log path; this read THROUGH one and then renamed over it, so
    // between them a link planted at an audit log meant every append was refused
    // (losing every row, quietly) and then the next daily sweep copied the
    // link TARGET's contents into the real file. Two modules disagreeing about
    // whether a path is the log is how the disagreement becomes the bug.
    //
    // lstat before existsSync, and not after: existsSync stats THROUGH a link,
    // so a dangling one reads as "no file here" and would be returned as a
    // no-op rather than reported.
    if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Refusing to prune ${file}: it is a symlink, not the log file.`)
    }
    if (!existsSync(file)) return null
    const raw = readFileSync(file, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    const { kept, dropped } = retainedLines(lines, { now })
    // Nothing to do is the overwhelmingly common case, and it must not rewrite
    // the file: a rename a day for no reason is a needless chance to lose one.
    if (dropped === 0) return null

    // A PREDICTABLE PATH MUST BE CREATED, NEVER ADOPTED. `${file}.pruning` is
    // guessable by anything running as this user, and `writeFileSync` on it
    // FOLLOWS a symlink and truncates whatever is at the far end -- so a
    // pre-created link turns a prune of an audit log into a write of that log's
    // contents to a destination somebody else chose. The `mode` does not save
    // it either: 0600 is applied only when the file is CREATED, which is the
    // same gap runDir.ts's writeSecretFile covers with an explicit chmod.
    //
    // So the path is cleared first -- `rmSync` unlinks a symlink rather than
    // following it, and `force` makes the normal case (nothing there) silent --
    // and then created exclusively. `wx` is O_CREAT|O_EXCL: it refuses an
    // existing file AND an existing symlink, dangling or not. Losing the race
    // between the two therefore means this throws and the log is left alone,
    // never that the write lands somewhere else. Same choice as
    // openvpnManagement's non-recursive mkdirSync, for the same reason.
    // `recursive` as well as `force`: without it a DIRECTORY planted at this
    // path makes rmSync throw EISDIR, which the catch below logs and rethrows
    // nothing from — and retention for this one log then never runs again, for
    // the life of the install. Same-uid precondition, so hardening rather than a
    // hole, but it is one word.
    const tmp = `${file}.pruning`
    rmSync(tmp, { force: true, recursive: true })
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      writeFileSync(fd, kept.length ? `${kept.join('\n')}\n` : '')
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, file)
    return dropped
  } catch (err) {
    // A log that cannot be pruned keeps growing, which is the state it was in
    // before this existed. Failing the app's startup over it would be worse.
    console.error(`[retention] could not prune ${file}:`, err)
    try {
      // `rmSync` rather than existsSync-then-unlink: existsSync stats through a
      // symlink and so reports a dangling one as absent, which would leave the
      // thing that caused the failure sitting in the way of every later prune.
      rmSync(`${file}.pruning`, { force: true, recursive: true })
    } catch {
      /* the temp file is not worth a second failure */
    }
    return null
  }
}
