import { basename, dirname, join, resolve as resolvePath, sep } from 'node:path'
import { homedir } from 'node:os'
import { createReadStream, createWriteStream, realpathSync } from 'node:fs'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type { SftpDownloadSummary, SftpEntry, SftpResult, SftpUploadSummary } from '../../shared/ssh'
import { reserveLocalFile, safeLocalName } from './transferName'

/**
 * The Files view, backed by this machine's own filesystem.
 *
 * Answers exactly the contract sftp.ts answers — same `SftpResult`, same
 * `SftpEntry`, same sort order — so the Files view needs no branch of its own.
 * What it cannot be is a swapped exec function: SFTP is a protocol, not a
 * command, so this is a parallel implementation rather than a different
 * transport under the same one.
 *
 * ── Why this module is quarantined ──────────────────────────────────────────
 *
 * It reads and writes arbitrary paths on this machine, which is strictly more
 * than the local terminal can do in one call and for the same stakes: the
 * vault file, the policy store and the audit log are all files on this disk.
 * So it is kept off the agent-facing surfaces the same way localExec and
 * localPty are — by reachability, not by a capability check.
 *
 * tests/localTerminalNotExposed.test.ts walks the import closure of
 * mcpServer.ts and everything under src/cli and fails if this module's
 * basename appears in it. The dispatch lives in main's renderer-facing IPC
 * handlers and nowhere else.
 */

/**
 * The app's own data directory, which this module refuses to touch.
 *
 * The header above names the stakes: the vault file, the policy store and the
 * audit log are all files on this disk, and every constraint this app
 * advertises is enforced by one of them. A Files view that can rewrite the
 * policy store is a Files view that can grant itself anything, and one that can
 * truncate the audit log can do it unobserved.
 *
 * Nobody edits these through a file browser on purpose — they are the app's
 * internal state, not the user's documents — so refusing them costs nothing
 * real and removes the one path from "browse my own machine" to "edit the thing
 * that decides what is allowed".
 *
 * Injected rather than read from `electron` at import time: this module is
 * imported directly by its tests, and pulling in `app` would make every one of
 * them need a stubbed Electron. Absent means no restriction, which is the right
 * default for a test that is writing into a temp directory.
 */
let protectedRoot: string | null = null

export function setLocalFilesProtectedRoot(dir: string): void {
  protectedRoot = canonical(dir)
}

/**
 * A path reduced to what it actually points at.
 *
 * `resolve()` alone is not enough, and the first version of this guard learned
 * that the hard way — three separate bypasses, all confirmed against the real
 * module:
 *
 *   1. A SYMLINK. `resolve` normalises `..` and makes a path absolute; it does
 *      not follow links. A link in a writable directory pointing at the
 *      protected tree resolved to the link's own path and sailed through.
 *   2. A path whose LEAF does not exist yet — every create and every write to a
 *      new file — cannot be realpath'd directly, so a naive realpath would
 *      throw and the caller would have to fall back to the unsafe form.
 *
 * So: walk up to the nearest ancestor that exists, realpath THAT (which
 * resolves every link along the way), then re-append the part that does not
 * exist yet. A symlinked parent is followed; a not-yet-created leaf is fine.
 */
function canonical(input: string): string {
  const start = resolvePath(input)
  const missing: string[] = []
  let cur = start
  for (;;) {
    try {
      const real = realpathSync(cur)
      return missing.length === 0 ? real : join(real, ...missing.slice().reverse())
    } catch {
      const parent = dirname(cur)
      // Reached the filesystem root without finding anything that exists.
      if (parent === cur) return start
      missing.push(basename(cur))
      cur = parent
    }
  }
}

/**
 * Case folded as well as compared exactly.
 *
 * This is a DENY rule, so the safe direction is to refuse more rather than
 * less. macOS and Windows are case-insensitive by default — `<userData>` and
 * `<userdata>` are the same file, and a case-sensitive `startsWith` refused the
 * first and happily read and wrote the second. Both are also configurable per
 * volume in both directions, so rather than branch on platform (and be wrong on
 * a case-sensitive APFS volume or a case-insensitive Linux mount) this refuses
 * a match under either comparison. The cost is refusing a genuinely distinct
 * path that differs only in case, inside the app's own data directory — which
 * is not a thing anyone has.
 */
function within(target: string, root: string): boolean {
  const hit = (a: string, b: string): boolean => a === b || a.startsWith(b + sep)
  return hit(target, root) || hit(target.toLowerCase(), root.toLowerCase())
}

/** Whether a path lands inside the protected root, once it is really resolved. */
function isProtected(path: string): boolean {
  if (!protectedRoot) return false
  return within(canonical(path), protectedRoot)
}

const PROTECTED_MESSAGE =
  "This is OpsMaxx's own data directory. It holds the vault, the access policy and the audit log, and is not editable from the Files view."

/** Guard for every path this module takes. Returns a failed result, or null. */
function refuse(...paths: string[]): SftpResult<never> | null {
  return paths.some(isProtected) ? { ok: false, error: PROTECTED_MESSAGE } : null
}

/**
 * Whether a download may be written into `dir`. Null when it may.
 *
 * Two rules, for both halves of the Files view. The folder must be one the
 * native picker returned (`picked`, kept by main): the renderer names the
 * destination on every call, so without this it could name any directory on
 * the disk. And it must not be the app's own data directory, where a new file
 * with the right name is read as configuration — a server chooses its own file
 * names, and a folder can be picked by mistake. `refuse` resolves links, so a
 * picked folder that is a symlink into that directory is refused too.
 */
export function refuseDownloadDir(dir: string, picked: ReadonlySet<string>): SftpResult<never> | null {
  if (!picked.has(dir)) return { ok: false, error: 'Choose a folder to save into first.' }
  return refuse(dir)
}

/** Which keys the renderer opened against this machine rather than a server. */
const sessions = new Map<string, { cwd: string }>()

export function isLocalFileSession(key: string): boolean {
  return sessions.has(key)
}

export function localFilesConnect(key: string): SftpResult<{ home: string }> {
  const home = homedir()
  sessions.set(key, { cwd: home })
  return { ok: true, data: { home } }
}

export function localFilesDisconnect(key: string): void {
  sessions.delete(key)
}

export function localFilesDisposeAll(): void {
  sessions.clear()
}

/**
 * The ten-character string `ls -l` prints, rebuilt from the mode.
 *
 * The SSH side takes it from SFTP's `longname`, which is the remote `ls`
 * output. Producing the same shape here means the Files view renders one thing
 * rather than two, and an octal string beside a rwx string in the same column
 * would read as a different kind of value.
 */
function permString(mode: number, dir: boolean, link: boolean): string {
  const rwx = (bits: number): string =>
    `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 1 ? 'x' : '-'}`
  const kind = link ? 'l' : dir ? 'd' : '-'
  return `${kind}${rwx((mode >> 6) & 7)}${rwx((mode >> 3) & 7)}${rwx(mode & 7)}`
}

export async function localFilesList(path: string): Promise<SftpResult<SftpEntry[]>> {
  const refused = refuse(path)
  if (refused) return refused
  try {
    const names = await readdir(path)
    const entries: SftpEntry[] = []
    for (const name of names) {
      try {
        // lstat, not stat: a symlink is reported AS a symlink, which is what
        // SFTP's readdir attrs give and what the view draws an arrow for.
        const st = await lstat(join(path, name))
        const dir = st.isDirectory()
        const link = st.isSymbolicLink()
        entries.push({
          name,
          dir,
          link,
          size: st.size,
          mtime: st.mtimeMs,
          perms: permString(st.mode & 0o777, dir, link)
        })
      } catch {
        // One unreadable entry must not lose the directory. A listing missing
        // a row is recoverable; an error page where a folder should be is not.
      }
    }
    entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    return { ok: true, data: entries }
  } catch (err) {
    return { ok: false, error: msg(err) }
  }
}

export async function localFilesRead(path: string): Promise<SftpResult<string>> {
  const refused = refuse(path)
  if (refused) return refused
  try {
    return { ok: true, data: await readFile(path, 'utf8') }
  } catch (err) {
    return { ok: false, error: msg(err) }
  }
}

export async function localFilesWrite(path: string, content: string): Promise<SftpResult> {
  const refused = refuse(path)
  if (refused) return refused
  try {
    await writeFile(path, content, 'utf8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: msg(err) }
  }
}

export async function localFilesMkdir(path: string): Promise<SftpResult> {
  const refused = refuse(path)
  if (refused) return refused
  try {
    // Not recursive, matching SFTP's mkdir: "make this one" fails when the
    // parent is missing, and silently creating a chain hides a typed path.
    await mkdir(path)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: msg(err) }
  }
}

export async function localFilesRename(from: string, to: string): Promise<SftpResult> {
  const refused = refuse(from, to)
  if (refused) return refused
  try {
    await rename(from, to)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: msg(err) }
  }
}

export async function localFilesDelete(path: string, dir: boolean): Promise<SftpResult> {
  const refused = refuse(path)
  if (refused) return refused
  try {
    // rmdir, not rm -r. SFTP's rmdir refuses a directory with anything in it,
    // and the Files view's confirmation is written for one thing going away.
    // A recursive delete behind the same button would remove a tree the user
    // was told was a folder.
    if (dir) await rmdir(path)
    else await unlink(path)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: msg(err) }
  }
}

/**
 * Copies files into a directory on this machine.
 *
 * Emits the same `sftp:progress` events the upload path does, so the Files
 * view's progress bar is one component. Streamed rather than read-then-written
 * because the same multi-GB archive argument applies to a local copy.
 */
export async function localFilesUpload(
  wc: WebContents,
  key: string,
  localPaths: string[],
  destDir: string
): Promise<SftpResult<SftpUploadSummary>> {
  /**
   * Both ends, not just the destination.
   *
   * The first version checked `destDir` only, which stopped a copy INTO the
   * protected tree and did nothing about a copy OUT of it — so
   * `localFilesUpload(wc, key, ['<userData>/vault.json'], '/tmp')` returned
   * `{ok: true}` and put the vault somewhere with no protection at all. Reading
   * a file out is exactly as much of a disclosure as editing it in place.
   */
  const refused = refuse(destDir, ...localPaths)
  if (refused) return refused
  const copy = startCopy(key)
  if (!copy) return BUSY
  const { signal } = copy
  const uploaded: string[] = []
  const failed: { name: string; error: string }[] = []
  const leftover: string[] = []

  for (let i = 0; i < localPaths.length && !signal.aborted; i++) {
    const from = localPaths[i]
    const name = basename(from)
    const to = join(destDir, name)
    const send = (transferred: number, total: number): void => {
      if (!wc.isDestroyed()) {
        wc.send('sftp:progress', { key, name, transferred, total, index: i + 1, count: localPaths.length })
      }
    }
    try {
      const st = await stat(from)
      // Directories would need a recursive walk; refused explicitly rather
      // than failing later with an opaque EISDIR, as the SSH path does.
      if (st.isDirectory()) throw new Error('folders cannot be copied yet')
      // Copying a file onto itself truncates it to nothing, and the Files view
      // cannot tell that the source it was handed is already the destination.
      if (resolvePath(from) === resolvePath(to)) {
        throw new Error('that file is already in this folder')
      }
      send(0, st.size)
      await copyWithProgress(from, to, st.size, send, signal)
      uploaded.push(name)
    } catch (err) {
      const partial = (err as { leftover?: string }).leftover
      if (partial) leftover.push(partial)
      if (!signal.aborted) failed.push({ name, error: msg(err) })
    }
  }
  endCopy(key, copy)

  return {
    ok: failed.length === 0 && !signal.aborted,
    error: failed.length ? `${failed[0].name}: ${failed[0].error}` : undefined,
    data: { uploaded, failed, cancelled: signal.aborted || undefined, leftover: leftover.length ? leftover : undefined }
  }
}

/**
 * "Download" from this machine: a copy into a folder the user picked.
 *
 * The same rules as the SSH path apply, because the view is one component and
 * the user should not have to know which half answered: names are cleaned, and
 * a file already in the folder is never replaced (transferName.ts).
 */
export async function localFilesDownload(
  wc: WebContents,
  key: string,
  sources: string[],
  destDir: string
): Promise<SftpResult<SftpDownloadSummary>> {
  const refused = refuse(destDir, ...sources)
  if (refused) return refused
  const copy = startCopy(key)
  if (!copy) return BUSY
  const { signal } = copy
  const saved: string[] = []
  const failed: { name: string; error: string }[] = []
  const leftover: string[] = []

  for (let i = 0; i < sources.length && !signal.aborted; i++) {
    const from = sources[i]
    const shown = basename(from)
    const name = safeLocalName(shown)
    if (!name) {
      failed.push({ name: shown, error: 'that name cannot be saved here' })
      continue
    }
    const send = (transferred: number, total: number): void => {
      if (!wc.isDestroyed()) {
        const index = i + 1
        wc.send('sftp:progress', { key, name: shown, transferred, total, index, count: sources.length, direction: 'down' })
      }
    }
    let to: string | undefined
    try {
      const st = await stat(from)
      if (st.isDirectory()) throw new Error('folders cannot be downloaded yet')
      to = await reserveLocalFile(destDir, name)
      send(0, st.size)
      await copyWithProgress(from, to, st.size, send, signal)
      saved.push(basename(to))
    } catch (err) {
      // The empty placeholder reserveLocalFile created is ours to remove. A
      // failure to remove it must not end the batch; it is reported instead.
      const place = to
      if (place) await rm(place, { force: true }).catch(() => leftover.push(place))
      const partial = (err as { leftover?: string }).leftover
      if (partial) leftover.push(partial)
      if (!signal.aborted) failed.push({ name: shown, error: msg(err) })
    }
  }
  endCopy(key, copy)

  return {
    ok: failed.length === 0 && !signal.aborted,
    error: failed.length ? `${failed[0].name}: ${failed[0].error}` : undefined,
    data: { saved, failed, cancelled: signal.aborted || undefined, leftover: leftover.length ? leftover : undefined }
  }
}

// The copy running on each key, so the Files view's Cancel can stop it. One
// per key: a second one would take the slot Cancel looks in.
const copying = new Map<string, AbortController>()

const BUSY: SftpResult<never> = { ok: false, error: 'A transfer is already running here.' }

function startCopy(key: string): AbortController | null {
  if (copying.has(key)) return null
  const c = new AbortController()
  copying.set(key, c)
  return c
}

function endCopy(key: string, c: AbortController): void {
  if (copying.get(key) === c) copying.delete(key)
}

export function localFilesCancel(key: string): void {
  copying.get(key)?.abort()
}

function copyWithProgress(
  from: string,
  to: string,
  total: number,
  onStep: (transferred: number, total: number) => void,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Cancelled while the caller was still stat-ing: open nothing at all.
    if (signal.aborted) return reject(new Error('cancelled'))
    let transferred = 0
    let reported = 0
    /**
     * Written beside the destination and renamed over it only when complete.
     *
     * Writing to `to` directly truncated it the moment the stream opened, so a
     * cancel or a failure part-way removed — or left half of — a file the user
     * had only agreed to replace with a finished copy. The temporary name is
     * created with `wx`, so it is certainly this call's, and it is the only
     * thing `fail` ever removes.
     */
    const tmp = join(dirname(to), `.${basename(to)}.opsmaxx-partial-${randomUUID()}`)
    // An abort destroys the read side with an AbortError, which lands in `fail`.
    const read = createReadStream(from, { signal })
    const write = createWriteStream(tmp, { flags: 'wx' })
    const fail = (err: Error): void => {
      read.destroy()
      write.destroy()
      // A temporary file that will not go is named on the error, so the
      // caller can report it rather than leave it to be found.
      void rm(tmp, { force: true })
        .catch(() => Object.assign(err, { leftover: tmp }))
        .then(() => reject(err))
    }
    read.on('data', (c: Buffer | string) => {
      transferred += typeof c === 'string' ? Buffer.byteLength(c) : c.length
      // Throttled to 512 KiB like the SSH path, so a large file does not flood
      // the renderer with IPC messages.
      if (transferred === total || transferred - reported >= 512 * 1024) {
        reported = transferred
        onStep(transferred, total)
      }
    })
    read.on('error', fail)
    write.on('error', fail)
    write.on('finish', () => {
      rename(tmp, to).then(resolve, fail)
    })
    read.pipe(write)
  })
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
