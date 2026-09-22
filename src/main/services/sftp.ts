import type { WebContents } from 'electron'
import { basename, posix } from 'node:path'
import { statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
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
}

// The transfer running on each key. One at a time: they share the channel, and
// the Files view queues the rest.
const running = new Map<string, Transfer>()

/**
 * Stop whatever is transferring on this key.
 *
 * ssh2's fastPut and fastGet take no abort signal, so the channel under them is
 * closed instead: every request in flight fails at once, the transfer's own
 * error path closes its handles, and the remote side stops reading or writing.
 * `cancellable` opens a fresh channel on the same SSH connection before the
 * transfer returns, so the next listing does not find a dead one.
 */
export function sftpCancel(key: string): void {
  const t = running.get(key)
  const conn = conns.get(key)
  if (!t || !conn) return
  t.cancelled = true
  conn.sftp.end()
}

async function cancellable<T>(key: string, conn: Conn, run: (t: Transfer) => Promise<T>): Promise<T> {
  const t: Transfer = { cancelled: false }
  running.set(key, t)
  try {
    return await run(t)
  } finally {
    running.delete(key)
    if (t.cancelled) {
      try {
        conn.sftp = await openSftp(conn.conn.client)
      } catch {
        // The connection went with the channel. Dropping the entry makes the
        // next call say "not connected", which the view's retry redials.
        sftpDisconnect(key)
      }
    }
  }
}

// Whether a remote path exists. Only "no such file" (SFTP status 2) counts as
// absent: any other failure is treated as present, because the answer decides
// whether a cancelled upload may delete the path.
function remoteExists(sftp: SFTPWrapper, path: string): Promise<boolean> {
  return new Promise((resolve) => sftp.stat(path, (err) => resolve(!err || (err as { code?: number }).code !== 2)))
}

// Uploads local files into a remote directory, one at a time so progress is
// meaningful and a failure part-way through still reports what did land.
export async function sftpUpload(
  wc: WebContents,
  key: string,
  localPaths: string[],
  remoteDir: string
): Promise<SftpResult<SftpUploadSummary>> {
  const conn = conns.get(key)
  if (!conn) return { ok: false, error: 'not connected' }

  const uploaded: string[] = []
  const failed: { name: string; error: string }[] = []

  // `partial` is the file a cancel interrupted, and whether it was there
  // before this upload.
  const { cancelled, partial } = await cancellable(key, conn, async (t) => {
    for (let i = 0; i < localPaths.length && !t.cancelled; i++) {
      const local = localPaths[i]
      const name = basename(local)
      const remote = remoteJoin(remoteDir, name)
      const send = progressSender(wc, key, name, i + 1, localPaths.length, 'up')
      let existed = true
      try {
        // Directories would need a recursive walk; refuse them explicitly rather
        // than failing later with an opaque EISDIR.
        if (statSync(local).isDirectory()) throw new Error('folders cannot be uploaded yet')
        existed = await remoteExists(conn.sftp, remote)
        send(0, statSync(local).size)
        await xfer(conn.sftp, 'put', local, remote, send)
        uploaded.push(name)
      } catch (err) {
        if (t.cancelled) return { cancelled: true, partial: { remote, existed } }
        failed.push({ name, error: msg(err) })
      }
    }
    return { cancelled: t.cancelled, partial: undefined }
  })

  let leftover: string | undefined
  if (partial) {
    // A half-written file looks like an uploaded one. It is removed only when
    // this upload created it: one that was already there held the user's data
    // until the overwrite they approved, and deleting it is not ours to do.
    const sftp = conns.get(key)?.sftp
    const removed =
      !partial.existed &&
      !!sftp &&
      (await new Promise<boolean>((resolve) => sftp.unlink(partial.remote, (err) => resolve(!err))))
    if (!removed) leftover = partial.remote
  }

  return {
    ok: failed.length === 0 && !cancelled,
    error: failed.length ? `${failed[0].name}: ${failed[0].error}` : undefined,
    data: { uploaded, failed, cancelled: cancelled || undefined, leftover }
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

  const saved: string[] = []
  const failed: { name: string; error: string }[] = []

  const cancelled = await cancellable(key, conn, async (t) => {
    for (let i = 0; i < remotePaths.length && !t.cancelled; i++) {
      const remoteName = posix.basename(remotePaths[i])
      const name = safeLocalName(remoteName)
      if (!name) {
        failed.push({ name: remoteName, error: 'that name cannot be saved on this machine' })
        continue
      }
      let target: string | undefined
      try {
        target = await reserveLocalFile(localDir, name)
        const send = progressSender(wc, key, remoteName, i + 1, remotePaths.length, 'down')
        await xfer(conn.sftp, 'get', remotePaths[i], target, send)
        saved.push(basename(target))
      } catch (err) {
        // A partial local file looks like a finished download, and this one
        // is ours: reserveLocalFile created it moments ago.
        if (target) await rm(target, { force: true })
        if (t.cancelled) return true
        failed.push({ name: remoteName, error: msg(err) })
      }
    }
    return t.cancelled
  })

  return {
    ok: failed.length === 0 && !cancelled,
    error: failed.length ? `${failed[0].name}: ${failed[0].error}` : undefined,
    data: { saved, failed, cancelled: cancelled || undefined }
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
