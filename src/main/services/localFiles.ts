import { basename, join, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import { createReadStream, createWriteStream } from 'node:fs'
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
import type { WebContents } from 'electron'
import type { SftpEntry, SftpResult, SftpUploadSummary } from '../../shared/ssh'

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
  try {
    return { ok: true, data: await readFile(path, 'utf8') }
  } catch (err) {
    return { ok: false, error: msg(err) }
  }
}

export async function localFilesWrite(path: string, content: string): Promise<SftpResult> {
  try {
    await writeFile(path, content, 'utf8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: msg(err) }
  }
}

export async function localFilesMkdir(path: string): Promise<SftpResult> {
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
  try {
    await rename(from, to)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: msg(err) }
  }
}

export async function localFilesDelete(path: string, dir: boolean): Promise<SftpResult> {
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
  const uploaded: string[] = []
  const failed: { name: string; error: string }[] = []

  for (let i = 0; i < localPaths.length; i++) {
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
      await copyWithProgress(from, to, st.size, send)
      uploaded.push(name)
    } catch (err) {
      failed.push({ name, error: msg(err) })
    }
  }

  return {
    ok: failed.length === 0,
    error: failed.length ? `${failed[0].name}: ${failed[0].error}` : undefined,
    data: { uploaded, failed }
  }
}

function copyWithProgress(
  from: string,
  to: string,
  total: number,
  onStep: (transferred: number, total: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    let transferred = 0
    let reported = 0
    const read = createReadStream(from)
    const write = createWriteStream(to)
    const fail = (err: Error): void => {
      read.destroy()
      write.destroy()
      // A half-written destination is worse than none: the view would show a
      // file that looks copied.
      void rm(to, { force: true }).finally(() => reject(err))
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
    write.on('finish', () => resolve())
    read.pipe(write)
  })
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
