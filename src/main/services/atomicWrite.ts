import { closeSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The one place that writes a local file's FRESH CONTENTS temp-then-rename.
//
// `grep -rn renameSync src/` finds four other call sites, in three modules, and
// none of them is this operation — which is the point of saying so, because each
// was checked before this sentence was written rather than assumed:
//
//   * `jsonlPrune.ts` PRUNES rather than writes: its temp file holds the log
//     minus the rows retention dropped, so the contents are derived from the
//     destination instead of handed in, and it spells the same clear-then-
//     create-exclusively dance out itself (the two comments are deliberately
//     each other's mirror).
//   * `history.ts` (~1431) renames a `.bak.tmp` onto the `.bak`, but the bytes
//     in it are written by SQLITE'S OWN backup API against a path it opened —
//     nothing here has a string of data to write, so there is nothing for this
//     helper to take.
//   * `history.ts` (~1322) and `backup.ts` (~593) MOVE a corrupt file aside to
//     `${path}.corrupt-<ts>`. A move is not a write: no new contents exist at
//     all, and the whole point is to preserve the old ones as evidence.
//
// Renames that are not `renameSync` at all, so the grep above does not see them
// and neither does this helper: `backupTargets.ts` moves a `.part` onto its final
// name on a REMOTE destination through an sftp/io adapter, and sftp.ts and
// dbshell.ts rename something the user asked to rename on a remote host. No local
// file and no `node:fs` in any of them.
//
// ---------------------------------------------------------------------------
// SIXTEEN WRITERS HAD THE SAME TWO GAPS, SO THEY GET ONE FIX RATHER THAN 16
// ---------------------------------------------------------------------------
// CONTRIBUTING.md rule 4 mandates temp-then-rename so a crash cannot truncate a
// user's data, and every writer obeyed it — as
// `writeFileSync(tmp, data, { mode: 0o600 })` then `renameSync(tmp, real)`.
// Between them those sixteen files hold: the SSH and RDP known-host pins, the
// workspace password verifiers, the MCP session token hashes, the credential
// proxy's forwarding rules and the approval records of the rules engine, the
// access-group policy, the command lines this app will run, the encrypted vault
// itself, which environment variable is fed by which vault entry, the whole
// server list, the runbook notes, the updater and startup preferences, the MCP
// client configs with a live bearer token in them — and, in backup.ts, the
// RESTORE path that writes four of those same files back. Sixteen copies of a
// gap in sixteen modules is how fifteen of them stay open after the first is
// fixed — which is the same argument logAppend.ts makes for appends, and this is
// its other half.
//
// The count is `grep -rln "import { atomicWriteFileSync }" src/`, and it has
// already moved twice: rdpTrust.ts and runbooks.ts each carried a hand-rolled
// copy of this sequence that had drifted by a word, and vault.ts and
// main/index.ts's rules write were converted after that. Recount rather than
// trust the number above — the list of what they hold is the part worth reading
// either way.
//
// GAP ONE — `mode` applies only when the file is CREATED. A temp file that is
// already there keeps the permissions it already had, and the rename then
// carries that mode onto the real file: a 0644 `${file}.tmp` left behind by a
// crashed earlier version, or pre-created by anything else running as this user,
// silently publishes the trust store it was supposed to protect. runDir.ts's
// `writeSecretFile` covers the same gap with an explicit chmod and says so;
// history.ts's `restrictPermissions` chmods the store for the same reason.
//
// GAP TWO — `writeFileSync` FOLLOWS A SYMLINK. Every one of these temp paths is
// fixed and guessable, so a link planted at one is written THROUGH — and then
// renamed over the real file, which means the attacker both chose where the
// contents went and what the app reads back as its own trust decisions.
//
// A PREDICTABLE PATH MUST BE CREATED, NEVER ADOPTED, which is the same answer
// jsonlPrune.ts, runbooks.ts and rdpTrust.ts reached independently: clear the
// path (`rmSync` unlinks a symlink rather than following it, and `force` keeps
// the normal case — nothing there — silent), then create it exclusively. `wx` is
// O_CREAT|O_EXCL, which refuses an existing file AND an existing symlink,
// dangling or not. Losing the race therefore means this THROWS and the real file
// is left alone, never that the write lands somewhere somebody else chose.
//
// `recursive` as well as `force` on the rmSync: without it a DIRECTORY planted
// at the temp path makes rmSync throw EISDIR, and for the callers that swallow
// their write failure that would mean the file never saves again for the life of
// the install. Same-uid precondition, so hardening rather than a hole, but it is
// one word.

/**
 * Write `data` to `file` atomically: the real file is either its previous
 * contents or the complete new contents, and never half of either.
 *
 * `mode` is the mode the real file ends up with OR NARROWER, per the process
 * umask: the temp file is created with `openSync(..., 'wx', mode)` and open(2)
 * masks that, so `mode 0o644` yields 0600 under `umask 077` and 0444 under
 * `umask 0200`. Measured. It is a parameter rather than a constant because the
 * rename is what installs it — a caller that needs a file another process must
 * read says so here instead of re-implementing the sequence. Every current
 * caller wants 0600, and masking can only ever CLEAR bits — so the property the
 * mode is here for, that nothing reaches a group or the world, holds under every
 * umask, and no current caller can be published wider than it asked. What a
 * hostile-enough umask can still take is the owner's own access: 0600 lands 0400
 * under `umask 0200`, measured. Nothing in this app sets a umask, and 0400 still
 * reads, so no caller today is affected — but a caller that passes something
 * WIDER than 0600 because another process must read the file is the one that
 * must not assume it got what it asked for.
 *
 * `tmpPath` defaults to `${file}.tmp`; `.opsmaxx-tmp` is the convention where
 * the file sits in a directory this app does not own (see clientConfig.ts, and
 * shared/compose.ts for the remote equivalent).
 *
 * THROWS, deliberately — including when something is already at `tmpPath` and
 * cannot be cleared. Callers keep whatever error handling they had: most of
 * these are preference writes that swallow, because a hardening change that
 * makes a settings save break the user's action is worse than the gap it closed.
 */
export function atomicWriteFileSync(
  file: string,
  data: string,
  mode = 0o600,
  tmpPath = `${file}.tmp`
): void {
  // The temp path is CLEARED before it is created, so if it is also the real
  // path the rmSync deletes the file this call was supposed to replace and the
  // caller's data is gone before the open. No current caller can reach this —
  // every tmpPath is `${file}.tmp` or `${file}.opsmaxx-tmp` — which is exactly
  // why it is worth one line now rather than after a future caller defaults the
  // argument wrong.
  //
  // `resolve` so the textual variants of one path are caught too (`x` vs `./x`,
  // a trailing slash, a `..` segment). It deliberately stops there: equal after
  // resolve is not the same as "same file", because a symlink, a hard link or a
  // case-insensitive volume can still point two different strings at one inode,
  // and deciding THAT needs a stat of both — a syscall, and a racy answer. The
  // attacker case is already covered: `wx` below refuses a path it did not
  // create. This guard is for the caller mistake.
  if (resolve(tmpPath) === resolve(file)) {
    throw new Error('atomicWriteFileSync: tmpPath must not be the file itself')
  }
  rmSync(tmpPath, { force: true, recursive: true })
  const fd = openSync(tmpPath, 'wx', mode)
  try {
    // Write to the DESCRIPTOR, not the path: the path was resolved once by the
    // exclusive open and this does not resolve it again, so there is no window
    // in which the thing being written is not the thing that was created.
    writeFileSync(fd, data)
  } finally {
    closeSync(fd)
  }
  renameSync(tmpPath, file)
}
