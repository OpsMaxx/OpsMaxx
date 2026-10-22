import fs from 'node:fs/promises'
import path from 'node:path'
import type { Duplex } from 'node:stream'
// Default imports: ssh2 is CommonJS and Node's lexer cannot see `utils` as a
// named export, which kills the packaged app on launch (tests/esmExternals).
import ssh2 from 'ssh2'
import type { Attributes, ClientChannel, SFTPWrapper } from 'ssh2'
// @ts-expect-error ssh2 does not export its SFTP class or type this path; see sftpOverStream.
import sftpProtocol from 'ssh2/lib/protocol/SFTP.js'
import { release, type PooledConnection } from './ssh'
import { shellQuote } from '../../shared/curl'

/**
 * A folder on THIS machine, mounted on the server the session is connected to.
 *
 * Reverse sshfs: the server runs `sshfs -o slave` over an exec channel on the
 * session's own connection, and this file is the SFTP server on the other end
 * of that channel. ssh2's SFTP server runs in Node, so no local `sftp-server`
 * binary is involved and it works the same on Windows.
 *
 * The server is the untrusted side here. Everything it can do to this machine
 * goes through the handlers below, which is why read-only is enforced HERE and
 * not by `-o ro` on the mount: a remote root can remount, or skip sshfs and
 * speak SFTP on the channel directly. Design note: docs/10-internal/reverse-mount-spike.md.
 */

const { STATUS_CODE, OPEN_MODE, flagsToString } = ssh2.utils.sftp
const { SFTP } = sftpProtocol

const WRITE_FLAGS =
  OPEN_MODE.WRITE | OPEN_MODE.APPEND | OPEN_MODE.CREAT | OPEN_MODE.TRUNC | OPEN_MODE.EXCL

/**
 * ssh2's SFTP state machine, driven over any byte stream instead of an SSH
 * subsystem channel.
 *
 * It already "emulates enough of Channel" (its own comment): all it calls on
 * the transport is `_protocol.channelData` to send and `channelClose` to end,
 * and it is fed with `push()`. An infinite window means ssh2 never holds data
 * back; the real channel underneath does its own flow control.
 */
export function sftpOverStream(stream: Duplex, server: boolean): SFTPWrapper {
  const outgoing = { id: 0, state: 'open', window: Infinity, packetSize: Infinity }
  const transport = {
    _protocol: {
      _remoteIdentRaw: null,
      channelData: (_id: number, data: Buffer) => stream.write(data),
      channelClose: () => {
        outgoing.state = 'closed'
        stream.end()
      }
    }
  }
  const sftp = new SFTP(transport, { type: 'sftp', incoming: {}, outgoing }, { server })
  stream.on('data', (d: Buffer) => sftp.push(d))
  stream.on('end', () => sftp.push(null))
  stream.on('close', () => {
    outgoing.state = 'closed'
    sftp.emit('close')
  })
  if (!server) sftp._init()
  return sftp as SFTPWrapper
}

class Denied extends Error {
  code = 'EACCES'
}

/**
 * A remote path as segments under the share root, or null if it leaves it.
 *
 * Lexical only, and stricter than POSIX: `..` above the root is refused rather
 * than clamped, so an escape attempt fails loudly instead of quietly landing on
 * the root. Symlinks are the other half — see `locate`.
 */
export function confine(remote: string): string[] | null {
  if (remote.includes('\0')) return null
  const segs: string[] = []
  for (const seg of remote.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (segs.length === 0) return null
      segs.pop()
      continue
    }
    // A separator to the LOCAL filesystem hidden inside one remote segment.
    if (seg.includes('\\') || (process.platform === 'win32' && seg.includes(':'))) return null
    segs.push(seg)
  }
  return segs
}

function inside(root: string, p: string): boolean {
  return p === root || p.startsWith(root + path.sep)
}

/**
 * The local path for a remote one, with every symlink resolved and checked.
 *
 * The parent is always resolved, so `link/x` cannot reach through a link that
 * points out of the share. The leaf is resolved too unless the op acts on the
 * link itself (lstat, readlink, remove, rename). A dangling leaf link is
 * refused outright: creating through it would write wherever it points.
 */
async function locate(root: string, remote: string, followLeaf: boolean): Promise<string> {
  const segs = confine(remote)
  if (!segs) throw new Denied(`${remote} is outside the share`)
  if (segs.length === 0) return root
  const parent = await fs.realpath(path.join(root, ...segs.slice(0, -1)))
  if (!inside(root, parent)) throw new Denied(`${remote} is outside the share`)
  const leaf = path.join(parent, segs[segs.length - 1])
  if (!followLeaf) return leaf
  try {
    const real = await fs.realpath(leaf)
    if (!inside(root, real)) throw new Denied(`${remote} is outside the share`)
    return real
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    const dangling = await fs.lstat(leaf).then(
      () => true,
      () => false
    )
    if (dangling) throw new Denied(`${remote} is a link to nowhere`)
    return leaf
  }
}

function toAttrs(st: import('node:fs').Stats): Attributes {
  return {
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000)
  }
}

function statusFor(err: unknown): number {
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'ENOENT' || code === 'ENOTDIR') return STATUS_CODE.NO_SUCH_FILE
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return STATUS_CODE.PERMISSION_DENIED
  return STATUS_CODE.FAILURE
}

type Handle =
  | { kind: 'file'; fh: fs.FileHandle }
  | { kind: 'dir'; dir: string; names: string[] }

export interface Share {
  /** The local directory, from `shareRoot`. Nothing outside it is reachable. */
  root: string
  readOnly: boolean
}

/** The share's root with its own symlinks resolved, which `locate` compares against. */
export async function shareRoot(dir: string): Promise<string> {
  const root = await fs.realpath(dir)
  if (!(await fs.stat(root)).isDirectory()) throw new Error(`${dir} is not a folder`)
  return root
}

/**
 * Answer SFTP requests on `sftp` from the files under `share.root`.
 *
 * Requests are handled ONE AT A TIME. That is the confinement guarantee, not a
 * convenience: `locate` checks a path and the op then opens it, and if the
 * remote could slip a rename between the two it could swap a checked directory
 * for a link out of the share.
 * ponytail: serial queue caps throughput at one op in flight; openat2 with
 * RESOLVE_BENEATH (Linux only, not in Node) is the upgrade if that matters.
 */
export function serveShare(sftp: SFTPWrapper, share: Share): void {
  // Synchronous on purpose: a request that arrives before its listener is
  // attached is answered OP_UNSUPPORTED by ssh2, and sshfs gives up on it.
  const root = share.root

  const handles = new Map<number, Handle>()
  let nextHandle = 1
  const newHandle = (h: Handle): Buffer => {
    const id = nextHandle++
    handles.set(id, h)
    const buf = Buffer.alloc(4)
    buf.writeUInt32BE(id)
    return buf
  }
  const getHandle = (buf: Buffer): Handle | undefined =>
    buf.length === 4 ? handles.get(buf.readUInt32BE(0)) : undefined

  let queue: Promise<void> = Promise.resolve()
  const serial = (reqid: number, op: () => Promise<void>): void => {
    queue = queue.then(() =>
      op().catch((err) => {
        sftp.status(reqid, statusFor(err), (err as Error).message)
      })
    )
  }
  const writes = (reqid: number, op: () => Promise<void>): void =>
    serial(reqid, async () => {
      if (share.readOnly) throw new Denied('This share is read-only')
      await op()
    })
  const ok = (reqid: number): void => {
    sftp.status(reqid, STATUS_CODE.OK)
  }

  sftp.on('REALPATH', (reqid, p) =>
    serial(reqid, async () => {
      const segs = confine(p)
      if (!segs) throw new Denied(`${p} is outside the share`)
      const name = '/' + segs.join('/')
      sftp.name(reqid, [{ filename: name, longname: name, attrs: {} as Attributes }])
    })
  )
  sftp.on('STAT', (reqid, p) =>
    serial(reqid, async () => {
      sftp.attrs(reqid, toAttrs(await fs.stat(await locate(root, p, true))))
    })
  )
  sftp.on('LSTAT', (reqid, p) =>
    serial(reqid, async () => {
      sftp.attrs(reqid, toAttrs(await fs.lstat(await locate(root, p, false))))
    })
  )
  sftp.on('READLINK', (reqid, p) =>
    serial(reqid, async () => {
      const target = await fs.readlink(await locate(root, p, false))
      sftp.name(reqid, [{ filename: target, longname: target, attrs: {} as Attributes }])
    })
  )

  sftp.on('OPEN', (reqid, p, flags, attrs) =>
    serial(reqid, async () => {
      if (share.readOnly && flags & WRITE_FLAGS) throw new Denied('This share is read-only')
      const mode = flagsToString(flags)
      if (!mode) throw new Error(`Unsupported open flags ${flags}`)
      const fh = await fs.open(await locate(root, p, true), mode, attrs?.mode ?? 0o644)
      sftp.handle(reqid, newHandle({ kind: 'file', fh }))
    })
  )
  sftp.on('READ', (reqid, handle, offset, length) =>
    serial(reqid, async () => {
      const h = getHandle(handle)
      if (h?.kind !== 'file') throw new Error('Bad handle')
      const buf = Buffer.alloc(length)
      const { bytesRead } = await h.fh.read(buf, 0, length, offset)
      if (bytesRead === 0) sftp.status(reqid, STATUS_CODE.EOF)
      else sftp.data(reqid, buf.subarray(0, bytesRead))
    })
  )
  sftp.on('FSTAT', (reqid, handle) =>
    serial(reqid, async () => {
      const h = getHandle(handle)
      if (h?.kind !== 'file') throw new Error('Bad handle')
      sftp.attrs(reqid, toAttrs(await h.fh.stat()))
    })
  )
  sftp.on('CLOSE', (reqid, handle) =>
    serial(reqid, async () => {
      const h = getHandle(handle)
      if (!h) throw new Error('Bad handle')
      handles.delete(handle.readUInt32BE(0))
      if (h.kind === 'file') await h.fh.close()
      ok(reqid)
    })
  )
  sftp.on('OPENDIR', (reqid, p) =>
    serial(reqid, async () => {
      const dir = await locate(root, p, true)
      sftp.handle(reqid, newHandle({ kind: 'dir', dir, names: await fs.readdir(dir) }))
    })
  )
  sftp.on('READDIR', (reqid, handle) =>
    serial(reqid, async () => {
      const h = getHandle(handle)
      if (h?.kind !== 'dir') throw new Error('Bad handle')
      const batch = h.names.splice(0, 100)
      if (batch.length === 0) return void sftp.status(reqid, STATUS_CODE.EOF)
      const entries = []
      for (const filename of batch) {
        // lstat, not stat: a link is listed as a link, and listing one that
        // points outside the share reveals only its own metadata.
        const st = await fs.lstat(path.join(h.dir, filename)).catch(() => null)
        if (st) entries.push({ filename, longname: filename, attrs: toAttrs(st) })
      }
      sftp.name(reqid, entries)
    })
  )

  // Everything below changes something, and is refused on a read-only share
  // before a path is even looked at.
  sftp.on('WRITE', (reqid, handle, offset, data) =>
    writes(reqid, async () => {
      const h = getHandle(handle)
      if (h?.kind !== 'file') throw new Error('Bad handle')
      await h.fh.write(data, 0, data.length, offset)
      ok(reqid)
    })
  )
  const applyAttrs = async (target: string | fs.FileHandle, attrs: Attributes): Promise<void> => {
    const on = typeof target === 'string' ? null : target
    if (attrs.size !== undefined) await (on ? on.truncate(attrs.size) : fs.truncate(target as string, attrs.size))
    if (attrs.mode !== undefined) await (on ? on.chmod(attrs.mode) : fs.chmod(target as string, attrs.mode))
    if (attrs.atime !== undefined && attrs.mtime !== undefined)
      await (on ? on.utimes(attrs.atime, attrs.mtime) : fs.utimes(target as string, attrs.atime, attrs.mtime))
    // uid/gid are not applied: chown on this machine is not the remote's to ask for.
  }
  sftp.on('SETSTAT', (reqid, p, attrs) =>
    writes(reqid, async () => {
      await applyAttrs(await locate(root, p, true), attrs)
      ok(reqid)
    })
  )
  sftp.on('FSETSTAT', (reqid, handle, attrs) =>
    writes(reqid, async () => {
      const h = getHandle(handle)
      if (h?.kind !== 'file') throw new Error('Bad handle')
      await applyAttrs(h.fh, attrs)
      ok(reqid)
    })
  )
  sftp.on('MKDIR', (reqid, p, attrs) =>
    writes(reqid, async () => {
      await fs.mkdir(await locate(root, p, false), attrs?.mode ?? 0o755)
      ok(reqid)
    })
  )
  sftp.on('RMDIR', (reqid, p) =>
    writes(reqid, async () => {
      await fs.rmdir(await locate(root, p, false))
      ok(reqid)
    })
  )
  sftp.on('REMOVE', (reqid, p) =>
    writes(reqid, async () => {
      await fs.unlink(await locate(root, p, false))
      ok(reqid)
    })
  )
  sftp.on('RENAME', (reqid, from, to) =>
    writes(reqid, async () => {
      await fs.rename(await locate(root, from, false), await locate(root, to, false))
      ok(reqid)
    })
  )
  // SYMLINK and EXTENDED have no listener, so ssh2 answers OP_UNSUPPORTED. A
  // link the remote made is the one thing that would let it point a path out
  // of the share and then race a check, so it does not get to make one.

  sftp.on('close', () => {
    for (const h of handles.values()) if (h.kind === 'file') void h.fh.close().catch(() => {})
    handles.clear()
  })
}

// ---------------------------------------------------------------- the mount

export interface ShareSpec {
  localDir: string
  /** On the server. Relative means relative to the login directory. */
  mountpoint: string
  readOnly: boolean
}

interface Mount {
  spec: ShareSpec
  conn: PooledConnection
  channel: ClientChannel
  closed: boolean
}

const mounts = new Map<string, Mount[]>()

function exec(conn: PooledConnection, cmd: string): Promise<ClientChannel> {
  return new Promise((resolve, reject) =>
    conn.client.exec(cmd, (err, ch) => (err ? reject(err) : resolve(ch)))
  )
}

async function run(conn: PooledConnection, cmd: string): Promise<{ code: number; stderr: string }> {
  const ch = await exec(conn, cmd)
  let stderr = ''
  ch.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
  ch.resume()
  return new Promise((resolve) => ch.on('close', (code: number | null) => resolve({ code: code ?? -1, stderr })))
}

/**
 * Everything the server runs, as one `sh -c`.
 *
 * Nothing before the `exec` may write to stdout: stdout IS the SFTP stream, and
 * a stray byte there fails the INIT. Diagnostics go to stderr. `-o slave` was
 * renamed `-o passive` in sshfs 3.7.2; older ones only know the old name.
 */
export function mountScript(mp: string, readOnly: boolean): string {
  const q = shellQuote(mp)
  return [
    `command -v sshfs >/dev/null || { echo 'sshfs is not installed on this server' >&2; exit 127; }`,
    `[ -r /dev/fuse ] && [ -w /dev/fuse ] || { echo '/dev/fuse is missing or this user cannot open it' >&2; exit 126; }`,
    `mkdir -p -- ${q} || exit 1`,
    `o=slave; sshfs -h 2>&1 | grep -q passive && o=passive`,
    `exec sshfs -f -o "$o" -o idmap=user -o fsname=opsmaxx${readOnly ? ' -o ro' : ''} :/ ${q}`
  ].join('\n')
}

export function unmountScript(mp: string): string {
  const q = shellQuote(mp)
  // -z: lazy, so a shell sitting inside the mount does not keep it pinned.
  return `fusermount3 -uz ${q} 2>/dev/null || fusermount -uz ${q}`
}

/** Mount `spec.localDir` on the server `conn` is connected to. */
export async function mountShare(sessionId: string, conn: PooledConnection, spec: ShareSpec): Promise<void> {
  if (!spec.mountpoint.trim()) throw new Error('A mount point is required')
  if ((mounts.get(sessionId) ?? []).some((m) => m.spec.mountpoint === spec.mountpoint))
    throw new Error(`${spec.mountpoint} is already mounted in this session`)
  const root = await shareRoot(spec.localDir)

  const channel = await exec(conn, `sh -c ${shellQuote(mountScript(spec.mountpoint, spec.readOnly))}`)
  // Held for as long as the mount lives, so closing the terminal that started
  // it does not destroy the connection before the unmount has run.
  conn.refs++
  const mount: Mount = { spec, conn, channel, closed: false }
  let stderr = ''
  channel.stderr.on('data', (d: Buffer) => (stderr += d.toString()))

  serveShare(sftpOverStream(channel as unknown as Duplex, true), { root, readOnly: spec.readOnly })
  mounts.set(sessionId, [...(mounts.get(sessionId) ?? []), mount])
  const ended = new Promise<never>((_, reject) =>
    channel.on('close', (code: number | null) => {
      if (!mount.closed) {
        mount.closed = true
        release(conn)
        forget(sessionId, mount)
      }
      reject(new Error(stderr.trim() || `sshfs exited with code ${code}`))
    })
  )
  ended.catch(() => {})

  try {
    // sshfs sends INIT before it mounts, so being spoken to is not proof of a
    // mount. The kernel's mount table is.
    const check = `for i in $(seq 50); do mountpoint -q ${shellQuote(spec.mountpoint)} && exit 0; sleep 0.1; done; exit 1`
    const mounted = run(conn, check).then((r) => {
      if (r.code !== 0) throw new Error(stderr.trim() || `${spec.mountpoint} did not appear as a mount`)
    })
    await Promise.race([mounted, ended])
  } catch (err) {
    await teardown(sessionId, mount)
    throw err
  }
}

function forget(sessionId: string, mount: Mount): void {
  const rest = (mounts.get(sessionId) ?? []).filter((m) => m !== mount)
  if (rest.length) mounts.set(sessionId, rest)
  else mounts.delete(sessionId)
}

async function teardown(sessionId: string, mount: Mount): Promise<void> {
  forget(sessionId, mount)
  if (mount.closed) return
  mount.closed = true
  try {
    // Unmount FIRST. Closing the channel alone makes sshfs exit, but a
    // foreground sshfs that loses its transport can leave the mount point
    // answering "Transport endpoint is not connected" until someone unmounts it.
    await run(mount.conn, unmountScript(mount.spec.mountpoint))
  } catch {
    /* the connection is already gone; nothing on the server can be reached */
  }
  try {
    mount.channel.close()
  } catch {
    /* already closed by sshfs exiting */
  }
  release(mount.conn)
}

export async function unmountShare(sessionId: string, mountpoint: string): Promise<boolean> {
  const mount = (mounts.get(sessionId) ?? []).find((m) => m.spec.mountpoint === mountpoint)
  if (!mount) return false
  await teardown(sessionId, mount)
  return true
}

/** Every mount a session made, for when the session closes. */
export function unmountSession(sessionId: string): void {
  for (const m of mounts.get(sessionId) ?? []) void teardown(sessionId, m)
}
