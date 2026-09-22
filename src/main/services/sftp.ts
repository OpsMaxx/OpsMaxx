import type { WebContents } from 'electron'
import { basename, join, posix } from 'node:path'
import { statSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import type { Client, SFTPWrapper, FileEntry, Stats } from 'ssh2'
import { acquire, release, type PooledConnection } from './ssh'
import { reserveLocalFile, safeLocalName, tempName } from './transferName'
import type {
  SftpDownloadSummary,
  SftpEntry,
  SftpResult,
  SftpUploadSummary,
  SshConnectConfig
} from '../../shared/ssh'

interface Conn {
  conn: PooledConnection
  sftp: SFTPWrapper
  /** The record revision this handle was opened against. See Server.rev. */
  rev?: number
}

// One cached SFTP connection per server id. Opened lazily on first operation.
const conns = new Map<string, Conn>()

function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)))
  })
}

async function ensure(key: string, cfg: SshConnectConfig): Promise<SFTPWrapper> {
  const existing = conns.get(key)
  // The key is the server id, so it survives an edit that makes this cached
  // handle wrong -- and the fresh cfg the caller went to the trouble of
  // building was then discarded. `rev` is what tells the two apart. Without
  // this the file browser kept listing the filesystem of the machine the
  // record used to name, however many times the user reopened it.
  if (existing && existing.rev === cfg.rev) return existing.sftp
  if (existing) sftpDisconnect(key)
  // Shares the terminal's authenticated connection, so browsing files never
  // triggers a second login.
  const conn = await acquire(cfg)
  const client = conn.client
  const sftp = await openSftp(client)
  client.on('close', () => conns.delete(key))
  conns.set(key, { conn, sftp, rev: cfg.rev })
  return sftp
}

function permString(entry: FileEntry): string {
  // longname looks like: -rw-r--r--   1 user group   1234 May  8 12:00 name
  const first = entry.longname?.split(/\s+/)[0]
  if (first && first.length >= 10) return first
  const m = entry.attrs.mode & 0o777
  return m.toString(8).padStart(4, '0')
}

function mapEntry(e: FileEntry): SftpEntry {
  const mode = e.attrs.mode
  const isDir = (mode & 0o170000) === 0o040000
  const isLink = (mode & 0o170000) === 0o120000
  return {
    name: e.filename,
    dir: isDir,
    link: isLink,
    size: e.attrs.size,
    mtime: e.attrs.mtime * 1000,
    perms: permString(e)
  }
}

export async function sftpConnect(key: string, cfg: SshConnectConfig): Promise<SftpResult<{ home: string }>> {
  try {
    const sftp = await ensure(key, cfg)
    const home = await new Promise<string>((resolve) => {
      sftp.realpath('.', (err, abs) => resolve(err ? '/' : abs))
    })
    return { ok: true, data: { home } }
  } catch (err) {
    return { ok: false, error: msg(err) }
  }
}

export async function sftpList(key: string, path: string): Promise<SftpResult<SftpEntry[]>> {
  const conn = conns.get(key)
  if (!conn) return { ok: false, error: 'not connected' }
  return new Promise((resolve) => {
    conn.sftp.readdir(path, (err, list) => {
      if (err) return resolve({ ok: false, error: err.message })
      const entries = list
        .map(mapEntry)
        .filter((e) => e.name !== '.' && e.name !== '..')
        .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
      resolve({ ok: true, data: entries })
    })
  })
}

export async function sftpRead(key: string, path: string): Promise<SftpResult<string>> {
  const conn = conns.get(key)
  if (!conn) return { ok: false, error: 'not connected' }
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const stream = conn.sftp.createReadStream(path)
    stream.on('data', (c: Buffer) => chunks.push(c))
    stream.on('error', (e: Error) => resolve({ ok: false, error: e.message }))
    stream.on('end', () => resolve({ ok: true, data: Buffer.concat(chunks).toString('utf8') }))
  })
}

export async function sftpWrite(key: string, path: string, content: string): Promise<SftpResult> {
  const conn = conns.get(key)
  if (!conn) return { ok: false, error: 'not connected' }
  return new Promise((resolve) => {
    conn.sftp.writeFile(path, content, (err) =>
      resolve(err ? { ok: false, error: err.message } : { ok: true })
    )
  })
}

function remoteJoin(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`
}

// fastPut and fastGet stream the file in parallel chunks rather than buffering
// it in memory, so moving a multi-GB archive either way is fine.
function xfer(
  sftp: SFTPWrapper,
  way: 'put' | 'get',
  from: string,
  to: string,
  onStep: (transferred: number, total: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    let reported = 0
    const opts = {
      // step fires per chunk; throttled to 512 KiB so a large file does not
      // flood the renderer with IPC messages.
      step: (transferred: number, _chunk: number, total: number) => {
        if (transferred === total || transferred - reported >= 512 * 1024) {
          reported = transferred
          onStep(transferred, total)
        }
      }
    }
    const done = (err?: Error | null): void => (err ? reject(err) : resolve())
    if (way === 'put') sftp.fastPut(from, to, opts, done)
    else sftp.fastGet(from, to, opts, done)
  })
}

function progressSender(
  wc: WebContents,
  key: string,
  name: string,
  index: number,
  count: number,
  direction: 'up' | 'down'
): (transferred: number, total: number) => void {
  return (transferred, total) => {
    if (!wc.isDestroyed()) wc.send('sftp:progress', { key, name, transferred, total, index, count, direction })
  }
}

interface Transfer {
  cancelled: boolean
  /**
   * True while an upload is being swapped into place. That swap is the commit
   * point: once the old file has been moved aside, stopping half-way leaves the
   * user's file under a name they do not know. So a Cancel that lands then is
   * recorded, and the channel is closed only once the swap has finished.
   *
   * The price: on a link that stalls during the swap itself — two or three
   * renames, one round trip each — Cancel waits for it like everything else
   * on that connection. Accepted, because the alternative is abandoning the
   * user's file half-moved.
   */
  committing: boolean
  /** This transfer's own channel, once open. */
  ch?: SFTPWrapper
  /**
   * Rejects the moment the transfer is cancelled.
   *
   * Every wait inside a transfer — except the swap above — is raced against
   * it, because ending a channel only SENDS a close: the requests in flight
   * fail when the server answers it, and on a stalled link that is never.
   * Without the race, Cancel on a dead connection would sit there as long as
   * the connection did, and so would everything queued behind it.
   */
  stop: Promise<never>
  cancel: () => void
}

// The transfer running on each key. One at a time per key: the Files view
// queues the rest, and a second view on the same server is refused rather
// than allowed to take over the slot Cancel looks in.
const running = new Map<string, Transfer>()

const BUSY: SftpResult<never> = { ok: false, error: 'A transfer is already running here.' }

// Registered synchronously, before any await, so two calls cannot both see an
// empty slot.
function begin(key: string): Transfer {
  let reject!: (err: Error) => void
  const stop = new Promise<never>((_, r) => (reject = r))
  // Nothing may be racing it yet when a cancel lands.
  stop.catch(() => {})
  const t: Transfer = {
    cancelled: false,
    committing: false,
    stop,
    cancel: () => {
      t.cancelled = true
      if (!t.committing) t.ch?.end()
      reject(new Error('cancelled'))
    }
  }
  running.set(key, t)
  return t
}

function finish(key: string, t: Transfer): void {
  if (running.get(key) === t) running.delete(key)
  t.ch?.end()
}

const SESSION_LIMIT =
  'The server refused another SFTP channel (session limit). Close another Files tab or terminal on this server and try again.'

/**
 * A channel of this transfer's own, on the server's existing connection.
 *
 * Not the cached one every other call on the key uses. ssh2's fastPut and
 * fastGet take no abort signal, so Cancel works by closing the channel under
 * them — and the cached channel is also carrying the external editor's
 * auto-save and the inline editor's writes, both of which truncate before they
 * write. Closing THAT one could leave a half-saved config on the server.
 *
 * The cost is one more session on the connection, and sshd's MaxSessions
 * (10 by default) is shared with every terminal on it. A refusal is said as
 * that rather than as ssh2's "Channel open failure", and the transfer does not
 * fall back to the shared channel: that would bring back the problem above.
 */
async function channelFor(conn: Conn, t: Transfer): Promise<SFTPWrapper> {
  const ch = await Promise.race([
    openSftp(conn.conn.client).then(
      (c) => {
        // Cancelled while it was opening: nothing will ever end it otherwise.
        if (t.cancelled) c.end()
        return c
      },
      (err) => {
        throw /channel open failure/i.test(msg(err)) ? new Error(SESSION_LIMIT) : err
      }
    ),
    t.stop
  ])
  t.ch = ch
  return ch
}

/** Stop the transfer running on this key. Anything queued is the view's. */
export function sftpCancel(key: string): void {
  running.get(key)?.cancel()
}

const MISSING_CODE = 2 // SFTP status NO_SUCH_FILE
const isMissing = (err: unknown): boolean => (err as { code?: number } | null)?.code === MISSING_CODE

/**
 * The swap could not be completed or undone, so files are sitting under
 * temporary names. `keep` is every one of them: none may be cleaned up.
 */
class Stranded extends Error {
  constructor(
    message: string,
    readonly keep: string[]
  ) {
    super(message)
  }
}

const call = (run: (cb: (err?: Error | null) => void) => void): Promise<Error | null> =>
  new Promise((resolve) => run((err) => resolve(err ?? null)))

/**
 * Move a finished upload over its target. Resolves with any file it had to
 * leave behind.
 *
 * posix-rename replaces in one step. A server without the extension — Windows
 * OpenSSH, proftpd's mod_sftp — only has plain rename, which refuses to
 * replace an existing file. Deleting the target first and then renaming loses
 * both copies if the rename fails. So the old file is moved ASIDE, the upload
 * is renamed into place, and only then is the old one deleted; a failed rename
 * puts it back. If even that fails, both names are reported and nothing is
 * deleted.
 */
async function replace(sftp: SFTPWrapper, tmp: string, target: string, name: string): Promise<string[]> {
  try {
    const err = await call((cb) => sftp.ext_openssh_rename(tmp, target, cb))
    if (err) throw err
    return []
  } catch (err) {
    // ssh2 throws synchronously when the server lacks the extension; any
    // other error is a real failure of the rename itself.
    if (!/does not support/i.test(msg(err))) throw err
  }
  const old = remoteJoin(posix.dirname(target), tempName(name, 'old'))
  const aside = await call((cb) => sftp.rename(target, old, cb))
  if (aside && !isMissing(aside)) throw aside
  const hadOld = !aside
  const into = await call((cb) => sftp.rename(tmp, target, cb))
  if (!into) {
    if (hadOld && (await call((cb) => sftp.unlink(old, cb)))) return [old]
    return []
  }
  if (!hadOld) throw into
  const back = await call((cb) => sftp.rename(old, target, cb))
  if (!back) throw into
  throw new Stranded(
    `the upload could not be renamed over ${target}, and the old file could not be put back — the old file is at ${old} and the upload at ${tmp}`,
    [tmp, old]
  )
}

// Remove a remote file this transfer created, giving up after a few seconds:
// a Cancel on a stalled link has to come back, and says what it left instead.
// "No such file" is success — the rename may have landed first.
function removeRemote(sftp: SFTPWrapper, path: string): Promise<boolean> {
  return Promise.race([
    new Promise<boolean>((resolve) => sftp.unlink(path, (err) => resolve(!err || isMissing(err)))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000))
  ])
}

const DENIED_CODE = 3 // SFTP status PERMISSION_DENIED
const UNSUPPORTED_CODE = 8 // SFTP status OP_UNSUPPORTED

// An ssh2 callback that also carries a value, as a promise of [error, value].
function ask<T>(run: (cb: (err: Error | null | undefined, v: T) => void) => void): Promise<[Error | null, T]> {
  return new Promise((resolve) => run((err, v) => resolve([err ?? null, v])))
}

/** Where an upload goes, and how it gets there. */
interface UploadPlan {
  /** The file being replaced, with any symlinks to it followed. */
  target: string
  /** The temporary file the upload is written to, when not in place. */
  tmp?: string
  /** Why it cannot be replaced by a new copy; nothing is left open when set. */
  needs?: 'dir' | 'owner'
}

/**
 * Decide how an upload onto `path` will be written, before a byte is moved.
 *
 * Normally to a temporary file beside the target that `replace` swaps in when
 * it is complete. But a rename replaces a FILE, where the in-place write this
 * used to be did not, and three things that write kept are kept here:
 *
 *  - A symlink (sites-enabled/foo) is followed to the file it names, and that
 *    file is replaced — not the link, which a rename would turn into a regular
 *    file.
 *  - The new copy gets the old one's permissions, so deploy.sh stays 0755
 *    rather than the server's umask default, and its owner and group. When
 *    they cannot be given, the copy is not made: the file would silently
 *    become the uploader's. `needs: 'owner'`.
 *  - A writable file in a folder that is not writable cannot have a temporary
 *    file beside it. `needs: 'dir'`.
 *
 * Either `needs` goes back to the view, which asks before overwriting in
 * place and sends the file again with `inPlace`. The temporary file is created
 * empty here with `wx` and its attributes set on the handle, so every check
 * is done before the upload starts rather than after it has finished.
 */
async function planUpload(ch: SFTPWrapper, path: string, inPlace: boolean): Promise<UploadPlan> {
  let target = path
  let existing: Stats | undefined
  for (let hops = 0; ; hops++) {
    const [err, st] = await ask<Stats>((cb) => ch.lstat(target, cb))
    // Missing, or a dangling link: writing through it creates what it names,
    // which is what the in-place write did.
    if (err && isMissing(err)) break
    if (err) throw err
    if (!st.isSymbolicLink()) {
      existing = st
      break
    }
    if (hops === 40) throw new Error('too many levels of symbolic links')
    const [lerr, link] = await ask<string>((cb) => ch.readlink(target, cb))
    if (lerr) throw lerr
    target = posix.resolve(posix.dirname(target), link)
  }
  if (inPlace) return { target }

  const tmp = remoteJoin(posix.dirname(target), tempName(posix.basename(target)))
  const [oerr, handle] = await ask<Buffer>((cb) => ch.open(tmp, 'wx', cb))
  if (oerr) {
    if (existing && (oerr as { code?: number }).code === DENIED_CODE) return { target, needs: 'dir' }
    throw oerr
  }
  let needs: UploadPlan['needs']
  if (existing) {
    const old = existing
    // A server with no POSIX modes — some Windows OpenSSH builds — answers
    // these with OP_UNSUPPORTED. There is nothing to preserve there, so the
    // swap goes ahead; asking about every overwrite on such a server would
    // only teach people to click through. Anything else is a refusal, and
    // means the new copy would differ from the file it replaces.
    const refused = (err: Error | null): boolean => !!err && (err as { code?: number }).code !== UNSUPPORTED_CODE
    const chmod = await call((cb) => ch.fchmod(handle, old.mode & 0o7777, cb))
    const [serr, mine] = await ask<Stats>((cb) => ch.fstat(handle, cb))
    const chown =
      serr || (mine.uid === old.uid && mine.gid === old.gid)
        ? null
        : await call((cb) => ch.fchown(handle, old.uid, old.gid, cb))
    if (refused(chmod) || refused(serr) || refused(chown)) needs = 'owner'
  }
  await call((cb) => ch.close(handle, cb))
  if (needs) {
    await call((cb) => ch.unlink(tmp, cb))
    return { target, needs }
  }
  return { target, tmp }
}

// Uploads local files into a remote directory, one at a time so progress is
// meaningful and a failure part-way through still reports what did land.
//
// Each file goes to a temporary name and is swapped over the target only once
// it is complete, so a cancelled or failed upload never leaves the target
// truncated — the file that was there before is untouched until the last step.
// `inPlace` names the files the user has agreed may be overwritten directly
// instead, because planUpload found they cannot be swapped.
export async function sftpUpload(
  wc: WebContents,
  key: string,
  localPaths: string[],
  remoteDir: string,
  inPlace: string[] = []
): Promise<SftpResult<SftpUploadSummary>> {
  const conn = conns.get(key)
  if (!conn) return { ok: false, error: 'not connected' }
  // Every path below is resolved with posix.resolve, which falls back to THIS
  // machine's working directory for a relative one. The view always sends the
  // absolute directory it lists, so anything else is refused.
  if (!posix.isAbsolute(remoteDir)) return { ok: false, error: `${remoteDir} is not an absolute path on the server.` }
  if (running.has(key)) return BUSY
  const t = begin(key)

  const uploaded: string[] = []
  const failed: { name: string; error: string }[] = []
  const leftover: string[] = []
  const needsInPlace: { name: string; reason: 'dir' | 'owner' }[] = []
  const incomplete: string[] = []

  try {
    const ch = await channelFor(conn, t)
    for (let i = 0; i < localPaths.length && !t.cancelled; i++) {
      const local = localPaths[i]
      const name = basename(local)
      const send = progressSender(wc, key, name, i + 1, localPaths.length, 'up')
      let planning: Promise<UploadPlan> | undefined
      let plan: UploadPlan | undefined
      let put: Promise<void> | undefined
      try {
        // Directories would need a recursive walk; refuse them explicitly rather
        // than failing later with an opaque EISDIR.
        if (statSync(local).isDirectory()) throw new Error('folders cannot be uploaded yet')
        planning = planUpload(ch, remoteJoin(remoteDir, name), inPlace.includes(name))
        plan = await Promise.race([planning, t.stop])
        if (plan.needs) {
          needsInPlace.push({ name, reason: plan.needs })
          continue
        }
        send(0, statSync(local).size)
        put = xfer(ch, 'put', local, plan.tmp ?? plan.target, send)
        await Promise.race([put, t.stop])
        if (plan.tmp) {
          // Not raced against Cancel: see Transfer.committing.
          t.committing = true
          try {
            leftover.push(...(await replace(ch, plan.tmp, plan.target, posix.basename(plan.target))))
          } finally {
            t.committing = false
            if (t.cancelled) ch.end()
          }
        }
        uploaded.push(name)
      } catch (err) {
        if (err instanceof Stranded) leftover.push(...err.keep)
        else if (plan && !plan.tmp) {
          // Overwritten in place, as agreed, and stopped part-way.
          if (put) incomplete.push(plan.target)
        } else {
          // The temporary file is this upload's and nothing else holds the
          // data in it. After a cancel the transfer's own channel is closing,
          // so the cached one does the removing — and does it again once the
          // cut-off work settles, because an open already on the wire can
          // create the file after the first removal has run. That includes
          // planning, which creates the file before the upload starts.
          const remove = (partial: string): Promise<boolean> => {
            const sftp = t.cancelled ? conns.get(key)?.sftp : ch
            return sftp ? removeRemote(sftp, partial) : Promise.resolve(false)
          }
          const partial = plan?.tmp
          if (partial) {
            if (!(await remove(partial))) leftover.push(partial)
            const again = (): Promise<boolean> => remove(partial)
            if (t.cancelled) void put?.then(again, again)
          } else if (t.cancelled)
            void planning?.then(
              (p) => (p.tmp ? remove(p.tmp) : undefined),
              () => {}
            )
        }
        if (t.cancelled) break
        failed.push({ name, error: msg(err) })
      }
    }
  } catch (err) {
    if (!t.cancelled) return { ok: false, error: msg(err) }
  } finally {
    finish(key, t)
  }

  const some = <T,>(xs: T[]): T[] | undefined => (xs.length ? xs : undefined)
  return {
    ok: failed.length === 0 && !t.cancelled,
    error: failed.length ? `${failed[0].name}: ${failed[0].error}` : undefined,
    data: {
      uploaded,
      failed,
      cancelled: t.cancelled || undefined,
      leftover: some(leftover),
      needsInPlace: some(needsInPlace),
      incomplete: some(incomplete)
    }
  }
}

/**
 * Downloads remote files into a local folder the user picked.
 *
 * The folder is checked by the IPC handler against the ones the native picker
 * returned; this only ever creates files directly inside it. The names are the
 * server's, so each is cleaned by safeLocalName and reserved without replacing
 * anything already there (transferName.ts).
 */
export async function sftpDownload(
  wc: WebContents,
  key: string,
  remotePaths: string[],
  localDir: string
): Promise<SftpResult<SftpDownloadSummary>> {
  const conn = conns.get(key)
  if (!conn) return { ok: false, error: 'not connected' }
  if (running.has(key)) return BUSY
  const t = begin(key)

  const saved: string[] = []
  const failed: { name: string; error: string }[] = []
  const leftover: string[] = []

  try {
    const ch = await channelFor(conn, t)
    for (let i = 0; i < remotePaths.length && !t.cancelled; i++) {
      const remoteName = posix.basename(remotePaths[i])
      const name = safeLocalName(remoteName)
      if (!name) {
        failed.push({ name: remoteName, error: 'that name cannot be saved on this machine' })
        continue
      }
      let target: string | undefined
      let tmp: string | undefined
      let get: Promise<void> | undefined
      try {
        target = await reserveLocalFile(localDir, name)
        // fastGet opens its destination by path with 'w', which follows a
        // symlink. So it writes to a fresh name nobody can predict, and the
        // finished file is renamed over the placeholder — a rename replaces
        // whatever is at that path, even a link swapped in meanwhile, rather
        // than writing through it.
        tmp = join(localDir, tempName(name))
        const send = progressSender(wc, key, remoteName, i + 1, remotePaths.length, 'down')
        get = xfer(ch, 'get', remotePaths[i], tmp, send)
        await Promise.race([get, t.stop])
        await rename(tmp, target)
        saved.push(basename(target))
      } catch (err) {
        // Both files are ours: the placeholder reserveLocalFile created, and
        // the partial download beside it. Retried because on Windows fastGet
        // may still hold the partial open for a moment after a cancel, and
        // guarded because a file that will not go must not end the batch —
        // it is reported instead.
        for (const p of [tmp, target])
          if (p) await rm(p, { force: true, maxRetries: 3 }).catch(() => leftover.push(p))
        // A cancelled fastGet can still write to its file after the removal
        // above, until the channel close is answered. Once it settles, again.
        const partial = tmp
        if (t.cancelled && partial) {
          const again = (): Promise<void> => rm(partial, { force: true, maxRetries: 3 }).catch(() => {})
          void get?.then(again, again)
        }
        if (t.cancelled) break
        failed.push({ name: remoteName, error: msg(err) })
      }
    }
  } catch (err) {
    if (!t.cancelled) return { ok: false, error: msg(err) }
  } finally {
    finish(key, t)
  }

  return {
    ok: failed.length === 0 && !t.cancelled,
    error: failed.length ? `${failed[0].name}: ${failed[0].error}` : undefined,
    data: { saved, failed, cancelled: t.cancelled || undefined, leftover: leftover.length ? leftover : undefined }
  }
}

export async function sftpMkdir(key: string, path: string): Promise<SftpResult> {
  return op(key, (sftp, done) => sftp.mkdir(path, done))
}

export async function sftpRename(key: string, from: string, to: string): Promise<SftpResult> {
  return op(key, (sftp, done) => sftp.rename(from, to, done))
}

export async function sftpDelete(key: string, path: string, dir: boolean): Promise<SftpResult> {
  return op(key, (sftp, done) => (dir ? sftp.rmdir(path, done) : sftp.unlink(path, done)))
}

export function sftpDisconnect(key: string): void {
  const conn = conns.get(key)
  if (!conn) return
  {
    try {
      release(conn.conn)
    } catch {
      /* ignore */
    }
  }
  conns.delete(key)
}

export function sftpDisposeAll(): void {
  for (const k of [...conns.keys()]) sftpDisconnect(k)
}

function op(key: string, run: (sftp: SFTPWrapper, done: (err?: Error | null) => void) => void): Promise<SftpResult> {
  const conn = conns.get(key)
  if (!conn) return Promise.resolve({ ok: false, error: 'not connected' })
  return new Promise((resolve) => {
    run(conn.sftp, (err) => resolve(err ? { ok: false, error: err.message } : { ok: true }))
  })
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
