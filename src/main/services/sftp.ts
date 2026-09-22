import type { WebContents } from 'electron'
import { basename, join, posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import type { Client, SFTPWrapper, FileEntry } from 'ssh2'
import { acquire, release, type PooledConnection } from './ssh'
import { reserveLocalFile, safeLocalName } from './transferName'
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
  /** This transfer's own channel, once open. */
  ch?: SFTPWrapper
  /**
   * Rejects the moment the transfer is cancelled.
   *
   * Every wait inside a transfer is raced against it, because ending a channel
   * only SENDS a close: the requests in flight fail when the server answers
   * it, and on a stalled link that is never. Without the race, Cancel on a
   * dead connection would sit there as long as the connection did, and so
   * would everything queued behind it.
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
    stop,
    cancel: () => {
      t.cancelled = true
      t.ch?.end()
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

/**
 * A channel of this transfer's own, on the server's existing connection.
 *
 * Not the cached one every other call on the key uses. ssh2's fastPut and
 * fastGet take no abort signal, so Cancel works by closing the channel under
 * them — and the cached channel is also carrying the external editor's
 * auto-save and the inline editor's writes, both of which truncate before they
 * write. Closing THAT one could leave a half-saved config on the server.
 */
async function channelFor(conn: Conn, t: Transfer): Promise<SFTPWrapper> {
  const ch = await Promise.race([
    openSftp(conn.conn.client).then((c) => {
      // Cancelled while it was opening: nothing will ever end it otherwise.
      if (t.cancelled) c.end()
      return c
    }),
    t.stop
  ])
  t.ch = ch
  return ch
}

/** Stop the transfer running on this key. Anything queued is the view's. */
export function sftpCancel(key: string): void {
  running.get(key)?.cancel()
}

// A temporary name beside the target. Dot-prefixed and unmistakable, so one
// left behind by a cut connection is recognisable for what it is.
function partialName(dir: string, name: string): string {
  return remoteJoin(dir, `.${name}.opsmaxx-partial-${randomUUID()}`)
}

// Move a finished upload over its target. posix-rename replaces in one step;
// a server without the extension gets the target removed first, because plain
// SFTP rename refuses to replace an existing file.
function replace(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (err?: Error | null): void => (err ? reject(err) : resolve())
    try {
      sftp.ext_openssh_rename(from, to, done)
    } catch {
      sftp.unlink(to, (err) => {
        if (err && (err as { code?: number }).code !== 2) return reject(err)
        sftp.rename(from, to, done)
      })
    }
  })
}

// Remove a remote file this transfer created, giving up after a few seconds:
// a Cancel on a stalled link has to come back, and says what it left instead.
// "No such file" is success — the rename may have landed first.
function removeRemote(sftp: SFTPWrapper, path: string): Promise<boolean> {
  return Promise.race([
    new Promise<boolean>((resolve) =>
      sftp.unlink(path, (err) => resolve(!err || (err as { code?: number }).code === 2))
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000))
  ])
}

// Uploads local files into a remote directory, one at a time so progress is
// meaningful and a failure part-way through still reports what did land.
//
// Each file goes to a temporary name and is renamed over the target only once
// it is complete, so a cancelled or failed upload never leaves the target
// truncated — the file that was there before is untouched until the last step.
export async function sftpUpload(
  wc: WebContents,
  key: string,
  localPaths: string[],
  remoteDir: string
): Promise<SftpResult<SftpUploadSummary>> {
  const conn = conns.get(key)
  if (!conn) return { ok: false, error: 'not connected' }
  if (running.has(key)) return BUSY
  const t = begin(key)

  const uploaded: string[] = []
  const failed: { name: string; error: string }[] = []
  let leftover: string | undefined

  try {
    const ch = await channelFor(conn, t)
    for (let i = 0; i < localPaths.length && !t.cancelled; i++) {
      const local = localPaths[i]
      const name = basename(local)
      const send = progressSender(wc, key, name, i + 1, localPaths.length, 'up')
      let tmp: string | undefined
      try {
        // Directories would need a recursive walk; refuse them explicitly rather
        // than failing later with an opaque EISDIR.
        if (statSync(local).isDirectory()) throw new Error('folders cannot be uploaded yet')
        send(0, statSync(local).size)
        tmp = partialName(remoteDir, name)
        await Promise.race([xfer(ch, 'put', local, tmp, send), t.stop])
        await Promise.race([replace(ch, tmp, remoteJoin(remoteDir, name)), t.stop])
        uploaded.push(name)
      } catch (err) {
        // The temporary file is this upload's, whatever went wrong. After a
        // cancel its own channel is closing, so the cached one removes it.
        const sftp = t.cancelled ? conns.get(key)?.sftp : ch
        if (tmp && !(sftp && (await removeRemote(sftp, tmp)))) leftover = tmp
        if (t.cancelled) break
        failed.push({ name, error: msg(err) })
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
    data: { uploaded, failed, cancelled: t.cancelled || undefined, leftover }
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
      try {
        target = await reserveLocalFile(localDir, name)
        // fastGet opens its destination by path with 'w', which follows a
        // symlink. So it writes to a fresh name nobody can predict, and the
        // finished file is renamed over the placeholder — a rename replaces
        // whatever is at that path, even a link swapped in meanwhile, rather
        // than writing through it.
        tmp = join(localDir, `.${name}.opsmaxx-partial-${randomUUID()}`)
        const send = progressSender(wc, key, remoteName, i + 1, remotePaths.length, 'down')
        await Promise.race([xfer(ch, 'get', remotePaths[i], tmp, send), t.stop])
        await rename(tmp, target)
        saved.push(basename(target))
      } catch (err) {
        // Both files are ours: the placeholder reserveLocalFile created, and
        // the partial download beside it. Retried because on Windows fastGet
        // may still hold the partial open for a moment after a cancel, and
        // guarded because a file that will not go must not end the batch.
        for (const p of [tmp, target]) if (p) await rm(p, { force: true, maxRetries: 3 }).catch(() => {})
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
    data: { saved, failed, cancelled: t.cancelled || undefined }
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
