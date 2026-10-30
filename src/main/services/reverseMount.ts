import fs from 'node:fs/promises'
import { constants as fsc, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { app } from 'electron'
// Default imports: ssh2 is CommonJS and Node's lexer cannot see `utils` as a
// named export, which kills the packaged app on launch (tests/esmExternals).
import ssh2 from 'ssh2'
import type { Attributes, ClientChannel, SFTPWrapper } from 'ssh2'
// @ts-expect-error ssh2 does not export its SFTP class or type this path; see sftpOverStream.
import sftpProtocol from 'ssh2/lib/protocol/SFTP.js'
import { liveServerConnection, onServerSession, release, type PooledConnection } from './ssh'
import { getCachedServer } from './mcpDataCache'
import { atomicWriteFileSync } from './atomicWrite'
import { mt } from './locale'
import { shellQuote } from '../../shared/curl'
import {
  MOUNT_EXIT,
  explainMountFailure,
  mountpointProblem,
  normalizeMountpoint,
  parseShares,
  serverIdentity,
  sharesProblem,
  type LocalShare,
  type MountReply,
  type MountStatus,
  type MountsView,
  type ShareView
} from '../../shared/localMounts'

/**
 * A folder on THIS machine, mounted on a server it is connected to.
 *
 * Reverse sshfs: the server runs `sshfs -o passive` over an exec channel on the
 * server's pooled connection, and this file is the SFTP server on the other end
 * of that channel. ssh2's SFTP server runs in Node, so no local `sftp-server`
 * binary is involved.
 *
 * The server is the untrusted side here. Everything it can do to this machine
 * goes through the handlers below, which is why read-only is enforced HERE and
 * not by `-o ro` on the mount: a remote root can remount, or skip sshfs and
 * speak SFTP on the channel directly. Design note: docs/10-internal/reverse-mount-spike.md.
 *
 * This module imports ssh.ts and never the other way round: ssh.ts is in the
 * MCP bridge's import closure, and no agent path may reach a mount
 * (tests/reverseMountNotExposed.test.ts). `wireFolderShares` connects the two.
 */

const { STATUS_CODE, OPEN_MODE } = ssh2.utils.sftp
const { SFTP } = sftpProtocol

const WRITE_FLAGS =
  OPEN_MODE.WRITE | OPEN_MODE.APPEND | OPEN_MODE.CREAT | OPEN_MODE.TRUNC | OPEN_MODE.EXCL

/** OpenSSH's sftp-server clamps a READ to this, and so does this one. */
export const MAX_READ = 256 * 1024
/** Open files and directories per share. sshfs keeps a handful; thousands is an attack. */
export const MAX_HANDLES = 256
/** Requests waiting for the queue, per share. Past this the channel is closed. */
export const MAX_PENDING = 1024

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

/**
 * Whether `p` is `root` or under it. By `path.relative`, not by prefix: a
 * prefix test against `root + sep` refuses everything when the share IS the
 * filesystem root, whose realpath already ends in a separator (`/`, `C:\`).
 */
export function inside(root: string, p: string): boolean {
  const rel = path.relative(root, p)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}

const isLink = (p: string): Promise<boolean> =>
  fs.lstat(p).then(
    (st) => st.isSymbolicLink(),
    () => false
  )

/**
 * The local path for a remote one, with every symlink resolved and checked.
 *
 * Component by component, so every link on the way is resolved and must land
 * inside. A link that cannot be resolved is refused the same way as one that
 * resolves outside: answering "no such file" for one and "permission denied"
 * for the other would tell the server whether a path on this machine exists.
 *
 * The leaf is resolved too unless the op acts on the link itself (lstat,
 * readlink, remove, rename). A dangling leaf link is refused for the same
 * reason, and because creating through it would write wherever it points.
 */
async function locate(root: string, remote: string, followLeaf: boolean): Promise<string> {
  const segs = confine(remote)
  if (!segs) throw new Denied()
  if (segs.length === 0) return root
  let parent = root
  for (const seg of segs.slice(0, -1)) {
    const next = path.join(parent, seg)
    let real: string
    try {
      real = await fs.realpath(next)
    } catch (err) {
      if (await isLink(next)) throw new Denied()
      throw err
    }
    if (!inside(root, real)) throw new Denied()
    parent = real
  }
  const leaf = path.join(parent, segs[segs.length - 1])
  if (!followLeaf) return leaf
  try {
    const real = await fs.realpath(leaf)
    if (!inside(root, real)) throw new Denied()
    return real
  } catch (err) {
    if (err instanceof Denied) throw err
    if (await isLink(leaf)) throw new Denied()
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return leaf
    throw err
  }
}

function toAttrs(st: import('node:fs').Stats): Attributes {
  return {
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    // A link's size is the length of its target, and the target is a path on
    // this machine: its length alone says how long the account name is. The
    // server reads the target through READLINK, rewritten, so it needs no size.
    size: st.isSymbolicLink() ? 0 : st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000)
  }
}

/**
 * A status code and a FIXED message for it. Never `err.message`: a Node error
 * carries the full local path, `/Users/<name>/…`, and the server would read it.
 */
const STATUS_TEXT: Record<number, string> = {
  [STATUS_CODE.NO_SUCH_FILE]: 'No such file',
  [STATUS_CODE.PERMISSION_DENIED]: 'Permission denied',
  [STATUS_CODE.FAILURE]: 'Failure'
}

function statusFor(err: unknown): number {
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'ENOENT' || code === 'ENOTDIR') return STATUS_CODE.NO_SUCH_FILE
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return STATUS_CODE.PERMISSION_DENIED
  return STATUS_CODE.FAILURE
}

/** Absent on Windows, where nothing in a folder can block an open this way. */
const NONBLOCK = (fsc as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0

/** SFTP open flags as the numeric ones `open(2)` takes; ssh2's string table lacks most write combinations. */
export function openFlags(f: number): number {
  const access =
    f & OPEN_MODE.READ && f & OPEN_MODE.WRITE ? fsc.O_RDWR : f & OPEN_MODE.WRITE ? fsc.O_WRONLY : fsc.O_RDONLY
  return (
    access |
    (f & OPEN_MODE.CREAT ? fsc.O_CREAT : 0) |
    (f & OPEN_MODE.TRUNC ? fsc.O_TRUNC : 0) |
    (f & OPEN_MODE.EXCL ? fsc.O_EXCL : 0) |
    (f & OPEN_MODE.APPEND ? fsc.O_APPEND : 0)
  )
}

/**
 * A link's target as the server may see it: relative, and only if it stays in
 * the share.
 *
 * `readlink` hands over the literal target, and an absolute one is a path on
 * THIS machine — on macOS that includes the account name. A target that lands
 * inside the share is rewritten relative to the link, which is also the only
 * form that resolves on the server's side of the mount. One that lands outside
 * is refused, whether or not it exists.
 */
export async function shareLinkTarget(root: string, link: string): Promise<string> {
  const raw = await fs.readlink(link)
  const dir = path.dirname(link)
  const lexical = path.resolve(dir, raw)
  let landed: string | null = inside(root, lexical) ? lexical : null
  if (!landed) {
    // An alias of a path inside (macOS's /var for /private/var) is still inside.
    const real = await fs.realpath(lexical).catch(() => null)
    if (real && inside(root, real)) landed = real
  }
  if (!landed) throw new Denied()
  const rel = path.relative(landed === lexical ? dir : await fs.realpath(dir), landed)
  return rel.split(path.sep).join('/') || '.'
}

type Handle =
  | { kind: 'file'; fh: fs.FileHandle; append: boolean }
  | { kind: 'dir'; remote: string; dir: string; names: string[] }

export interface Share {
  /** The local directory, from `shareRoot`. Nothing outside it is reachable. */
  root: string
  readOnly: boolean
}

/** The share's root with its own symlinks resolved, which `locate` compares against. */
export async function shareRoot(dir: string): Promise<string> {
  const root = await fs.realpath(dir)
  if (!(await fs.stat(root)).isDirectory()) throw new Error('not a folder')
  return root
}

/**
 * ONE queue for every share, so requests are handled one at a time across all
 * of them. That is the confinement guarantee, not a convenience: `locate`
 * checks a path and the op then opens it, and if anything could run between
 * the two — a rename on this share, or the same folder shared twice and
 * renamed through the other — a checked directory could be swapped for a link
 * out of the share.
 * ponytail: one op in flight for the whole app caps throughput; openat2 with
 * RESOLVE_BENEATH (Linux only, not in Node) or per-root queues with fd-relative
 * opens are the upgrade if that ever matters.
 */
let queue: Promise<void> = Promise.resolve()

/**
 * Answer SFTP requests on `sftp` from the files under `share.root`.
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
  const roomForHandle = (): void => {
    if (handles.size >= MAX_HANDLES) throw new Error('too many handles')
  }

  let pending = 0
  let closed = false
  const serial = (reqid: number, op: () => Promise<void>): void => {
    if (closed) return
    // A server that queues faster than this machine answers is not sshfs.
    // Hanging up is the only answer that does not grow without limit.
    if (++pending > MAX_PENDING) {
      closed = true
      sftp.end()
      return
    }
    queue = queue.then(async () => {
      try {
        if (!closed) await op()
      } catch (err) {
        const code = statusFor(err)
        if (!closed) sftp.status(reqid, code, STATUS_TEXT[code])
      } finally {
        pending--
      }
    })
  }
  const writes = (reqid: number, op: () => Promise<void>): void =>
    serial(reqid, async () => {
      if (share.readOnly) throw new Denied()
      await op()
    })
  const ok = (reqid: number): void => {
    sftp.status(reqid, STATUS_CODE.OK)
  }
  const fileOf = (handle: Buffer): fs.FileHandle => {
    const h = getHandle(handle)
    if (h?.kind !== 'file') throw new Error('bad handle')
    return h.fh
  }
  const appending = (handle: Buffer): boolean => {
    const h = getHandle(handle)
    return h?.kind === 'file' && h.append
  }

  sftp.on('REALPATH', (reqid, p) =>
    serial(reqid, async () => {
      const segs = confine(p)
      if (!segs) throw new Denied()
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
      const target = await shareLinkTarget(root, await locate(root, p, false))
      sftp.name(reqid, [{ filename: target, longname: target, attrs: {} as Attributes }])
    })
  )

  sftp.on('OPEN', (reqid, p, flags, attrs) =>
    serial(reqid, async () => {
      if (share.readOnly && flags & WRITE_FLAGS) throw new Denied()
      roomForHandle()
      const target = await locate(root, p, true)
      // Regular files only. A FIFO or a device would block the open, or the
      // first read, forever — and with ONE queue for every share that stalls
      // all of them. O_NONBLOCK is the belt to that brace, for anything that
      // turns into one between the check and the open.
      // ponytail: a file on a hung network volume inside a share still stalls
      // every share, because the queue is global; per-root queues with
      // fd-relative opens are the upgrade if that matters.
      const st = await fs.lstat(target).catch(() => null)
      if (st && !st.isFile()) throw new Denied()
      const fh = await fs.open(target, openFlags(flags) | NONBLOCK, attrs?.mode ?? 0o644)
      sftp.handle(reqid, newHandle({ kind: 'file', fh, append: (flags & OPEN_MODE.APPEND) !== 0 }))
    })
  )
  sftp.on('READ', (reqid, handle, offset, length) =>
    serial(reqid, async () => {
      const fh = fileOf(handle)
      const want = Math.min(length, MAX_READ)
      const buf = Buffer.alloc(want)
      const { bytesRead } = await fh.read(buf, 0, want, offset)
      if (bytesRead === 0) sftp.status(reqid, STATUS_CODE.EOF)
      else sftp.data(reqid, buf.subarray(0, bytesRead))
    })
  )
  sftp.on('FSTAT', (reqid, handle) =>
    serial(reqid, async () => {
      sftp.attrs(reqid, toAttrs(await fileOf(handle).stat()))
    })
  )
  sftp.on('CLOSE', (reqid, handle) =>
    serial(reqid, async () => {
      const h = getHandle(handle)
      if (!h) throw new Error('bad handle')
      handles.delete(handle.readUInt32BE(0))
      if (h.kind === 'file') await h.fh.close()
      ok(reqid)
    })
  )
  sftp.on('OPENDIR', (reqid, p) =>
    serial(reqid, async () => {
      roomForHandle()
      const dir = await locate(root, p, true)
      sftp.handle(reqid, newHandle({ kind: 'dir', remote: p, dir, names: await fs.readdir(dir) }))
    })
  )
  sftp.on('READDIR', (reqid, handle) =>
    serial(reqid, async () => {
      const h = getHandle(handle)
      if (h?.kind !== 'dir') throw new Error('bad handle')
      // Resolved again on every call, and it must still be the same folder.
      // Between two READDIRs the server can rename the opened directory away
      // and put a link to somewhere outside in its place; the names were read
      // at OPENDIR, but the sizes and times below are read now.
      if ((await locate(root, h.remote, true)) !== h.dir) throw new Denied()
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
      // An append handle writes at the end, whatever offset was sent — as
      // OpenSSH's sftp-server does. pwrite() honours the offset on macOS even
      // under O_APPEND, so the offset is dropped rather than trusted.
      await fileOf(handle).write(data, 0, data.length, appending(handle) ? null : offset)
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
      await applyAttrs(fileOf(handle), attrs)
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
    closed = true
    for (const h of handles.values()) if (h.kind === 'file') void h.fh.close().catch(() => {})
    handles.clear()
  })
}

// ------------------------------------------------------------ the saved shares

/**
 * Shares live in their own per-machine file, never on the server record.
 *
 * The record syncs to the user's other devices and rides inside every backup.
 * A share names a folder on THIS computer, and one synced or restored onto
 * another machine would mount that machine's folder — read-write, on connect —
 * on a server nobody chose to give it to. This file is not in the backup
 * payload, not in any addy collection and not exported; backup.ts lists it
 * only so "delete all data" removes it.
 */
const SHARES_FILE = (): string => path.join(app.getPath('userData'), 'opsmaxx-folder-shares.json')

interface StoredShare extends LocalShare {
  /** `serverIdentity` of the server when the share was saved or re-enabled. */
  identity: string
}

let store: Map<string, StoredShare[]> | null = null

function loadStore(): Map<string, StoredShare[]> {
  if (store) return store
  store = new Map()
  try {
    const raw = JSON.parse(readFileSync(SHARES_FILE(), 'utf8')) as { servers?: Record<string, unknown> }
    for (const [serverId, list] of Object.entries(raw.servers ?? {})) {
      const parsed = parseShares(list)
      const identities = new Map(
        (Array.isArray(list) ? list : []).map((s) => [
          (s as { id?: unknown }).id,
          (s as { identity?: unknown }).identity
        ])
      )
      const shares = parsed
        .map((s) => ({ ...s, mountpoint: normalizeMountpoint(s.mountpoint), identity: identities.get(s.id) }))
        .filter((s): s is StoredShare => typeof s.identity === 'string')
      if (shares.length) store.set(serverId, shares)
    }
  } catch {
    /* no file yet, or unreadable: no shares */
  }
  return store
}

function saveStore(): void {
  atomicWriteFileSync(SHARES_FILE(), JSON.stringify({ version: 1, servers: Object.fromEntries(loadStore()) }, null, 2))
}

/** For tests: forget what was loaded, so the next read comes from disk. */
export function resetShareStoreForTests(): void {
  store = null
}

function currentIdentity(serverId: string): string | null {
  const s = getCachedServer(serverId)
  return s ? serverIdentity(s) : null
}

function sharesOf(serverId: string): StoredShare[] {
  return loadStore().get(serverId) ?? []
}

function isStale(serverId: string, share: StoredShare): boolean {
  return share.identity !== currentIdentity(serverId)
}

export function sharesFor(serverId: string): ShareView[] {
  return sharesOf(serverId).map((s) => {
    const { identity: _identity, ...share } = s
    return { ...share, stale: isStale(serverId, s) }
  })
}

const sameMount = (a: LocalShare, b: LocalShare): boolean =>
  a.localDir === b.localDir && a.mountpoint === b.mountpoint && a.readOnly === b.readOnly

/**
 * Save a server's shares, stamped with the identity the editor saved the
 * server under, and bring live mounts in line: what was removed or changed is
 * unmounted, what is new or changed and set to mount on connect is mounted if
 * a terminal is open.
 */
export async function setShares(serverId: string, next: LocalShare[], identity: string): Promise<MountReply> {
  const problem = sharesProblem(next)
  if (problem) return { ok: false, error: problem.message }
  const before = sharesOf(serverId)
  const stamped = next.map((s) => ({ ...s, mountpoint: normalizeMountpoint(s.mountpoint), identity }))
  if (stamped.length) loadStore().set(serverId, stamped)
  else loadStore().delete(serverId)
  saveStore()

  const byPoint = mounts.get(serverId)
  for (const was of before) {
    const now = stamped.find((s) => s.id === was.id)
    const m = byPoint?.get(was.mountpoint)
    if (m && (!now || !sameMount(was, now))) await teardown(m)
  }
  // An edit is a fresh decision: a setup failure recorded against the old
  // version of a share does not hold the new one back.
  for (const m of [...(mounts.get(serverId)?.values() ?? [])]) {
    const now = stamped.find((s) => s.id === m.share.id)
    if (m.status.state === 'failed' && (!now || !sameMount(m.share, now))) await teardown(m)
  }
  emit(serverId)
  const conn = liveServerConnection(serverId)
  if (conn) {
    for (const s of stamped) {
      const was = before.find((b) => b.id === s.id)
      if (s.autoMount && (!was || !sameMount(was, s))) void mountShare(serverId, conn, s.id, false)
    }
  }
  return { ok: true }
}

/** Accept the server's current address for every share on it. */
export function reenableShares(serverId: string): void {
  const identity = currentIdentity(serverId)
  if (!identity) return
  const list = sharesOf(serverId)
  if (!list.length) return
  loadStore().set(
    serverId,
    list.map((s) => ({ ...s, identity }))
  )
  saveStore()
  emit(serverId)
  const conn = liveServerConnection(serverId)
  if (conn) autoMount(serverId, conn)
}

// ---------------------------------------------------------------- the mounts

type FailureKind = 'setup' | 'dropped' | 'unmount'

interface Mount {
  key: string
  serverId: string
  share: StoredShare
  status: MountStatus
  /** Why it failed. A `setup` failure is not retried until someone asks. */
  kind?: FailureKind
  /** The mount script's exit code, when that is how it failed. */
  exitCode?: number | null
  conn: PooledConnection | null
  channel: ClientChannel | null
  /** Set by teardown, and checked by mountShare after every await. */
  cancelled: boolean
  /** Ends whatever mountShare is waiting on, so a teardown does not wait out a 15s check. */
  wake: () => void
  /** The reference on `conn` has been handed back. */
  released: boolean
}

const mounts = new Map<string, Map<string, Mount>>()
let changed: (serverId: string, view: MountsView) => void = () => {}

export function onMountsChanged(cb: (serverId: string, view: MountsView) => void): void {
  changed = cb
}

export function listMounts(serverId: string): MountStatus[] {
  return [...(mounts.get(serverId)?.values() ?? [])].map((m) => ({ ...m.status }))
}

export function mountsView(serverId: string): MountsView {
  return { connected: liveServerConnection(serverId) !== null, shares: sharesFor(serverId), mounts: listMounts(serverId) }
}

function emit(serverId: string): void {
  changed(serverId, mountsView(serverId))
}

/** After a data save: a server whose address just changed now shows its shares as stale. */
export function refreshShareViews(): void {
  for (const serverId of loadStore().keys()) emit(serverId)
}

/**
 * Mount and teardown of one mount point run one at a time, in order. A teardown
 * asked for while a mount is still being set up waits for it and then undoes
 * it, so a mount that lands after its terminal closed is still unmounted, and a
 * late unmount cannot remove a newer mount at the same path.
 */
const locks = new Map<string, Promise<unknown>>()
function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn)
  const tail = run.catch(() => undefined)
  locks.set(key, tail)
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key)
  })
  return run
}

function releaseMount(m: Mount): void {
  if (m.released || !m.conn) return
  m.released = true
  release(m.conn)
}

function exec(conn: PooledConnection, cmd: string): Promise<ClientChannel> {
  return new Promise((resolve, reject) => conn.client.exec(cmd, (err, ch) => (err ? reject(err) : resolve(ch))))
}

/** Run a short command and wait for it, but never longer than `ms`. */
async function run(conn: PooledConnection, cmd: string, ms = 8000): Promise<{ code: number; stderr: string }> {
  const ch = await exec(conn, cmd)
  let stderr = ''
  ch.stderr.on('data', (d: Buffer) => {
    if (stderr.length < 4000) stderr += d.toString()
  })
  ch.resume()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ch.close()
      resolve({ code: -1, stderr: 'timed out' })
    }, ms)
    ch.on('close', (code: number | null) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stderr })
    })
  })
}

/**
 * The mount point as a shell word. `~/x` becomes `"$HOME"/'x'`: quoting the
 * whole thing would make the tilde literal, and not quoting it is how a
 * folder name becomes a command.
 */
function mountpointWord(mp: string): string {
  return mp.startsWith('~/') ? `"$HOME"/${shellQuote(mp.slice(2))}` : shellQuote(mp)
}

/**
 * Everything the server runs, as one `sh -c`.
 *
 * Nothing before the `exec` may write to stdout: stdout IS the SFTP stream, and
 * a stray byte there fails the INIT. Diagnostics go to stderr, and the failures
 * the script can name itself exit with MOUNT_EXIT codes that
 * `explainMountFailure` turns into a sentence and a fix.
 *
 * `-o slave` was renamed `-o passive` in sshfs 3.7.2; older ones only know the
 * old name. libfuse 3 mounts over a non-empty folder without complaint and
 * hides what was in it, so that is refused here. A mount point left behind by
 * an sshfs that lost its connection ("Transport endpoint is not connected") is
 * cleared first, or nothing can be mounted there again.
 */
export function mountScript(mp: string, readOnly: boolean): string {
  const e = MOUNT_EXIT
  return [
    `export LC_ALL=C`,
    `mp=${mountpointWord(mp)}`,
    `command -v sshfs >/dev/null 2>&1 || exit ${e.noSshfs}`,
    `[ -e /dev/fuse ] || exit ${e.noFuse}`,
    `[ -r /dev/fuse ] && [ -w /dev/fuse ] || exit ${e.fuseDenied}`,
    `case "$(stat -- "$mp" 2>&1)" in *'not connected'*) fusermount3 -uz -- "$mp" 2>/dev/null || fusermount -uz "$mp" 2>/dev/null;; esac`,
    `mkdir -p -- "$mp" >&2 || exit ${e.mkdirFailed}`,
    `[ -z "$(ls -A -- "$mp" 2>/dev/null)" ] || exit ${e.notEmpty}`,
    `o=slave; sshfs -h 2>&1 | grep -q passive && o=passive`,
    `exec sshfs -f -o "$o" -o idmap=user -o fsname=opsmaxx${readOnly ? ' -o ro' : ''} :/ "$mp"`
  ].join('\n')
}

/** Unmount if mounted, and exit 0 only if the mount point is not a mount afterwards. */
export function unmountScript(mp: string): string {
  // -z: lazy, so a shell sitting inside the mount does not keep it pinned.
  return `mp=${mountpointWord(mp)}; fusermount3 -uz -- "$mp" 2>/dev/null || fusermount -uz "$mp" 2>/dev/null; ! mountpoint -q -- "$mp"`
}

function mountsOf(serverId: string): Map<string, Mount> {
  let byPoint = mounts.get(serverId)
  if (!byPoint) mounts.set(serverId, (byPoint = new Map()))
  return byPoint
}

/**
 * Mount one saved share on the server `conn` is connected to.
 *
 * Never throws: the outcome is in the reply and in the mount's status, which is
 * what the UI shows. A share already mounted or mounting is left alone, which
 * is what makes auto-mount safe on every pane's connect. A share that failed
 * during setup — no sshfs, no /dev/fuse, the mount point not empty — is not
 * tried again automatically; `manual` is someone pressing Retry.
 */
export function mountShare(
  serverId: string,
  conn: PooledConnection,
  shareId: string,
  manual: boolean
): Promise<MountReply> {
  const share = sharesOf(serverId).find((s) => s.id === shareId)
  if (!share) return Promise.resolve({ ok: false, error: mt('main.reverseMount.shareNotSaved') })
  if (isStale(serverId, share))
    return Promise.resolve({
      ok: false,
      error: mt('main.reverseMount.serverChanged'),
      fix: mt('main.reverseMount.serverChangedFix')
    })
  const problem = mountpointProblem(share.mountpoint)
  if (problem) return Promise.resolve({ ok: false, error: problem })
  // Against the connection this would ride, not only the record: a terminal
  // opened while the record named another host is still connected to that
  // host, whatever the record says now.
  if (!conn.dialledAs || serverIdentity(conn.dialledAs) !== share.identity)
    return Promise.resolve({
      ok: false,
      error: mt('main.reverseMount.terminalElsewhere'),
      fix: mt('main.reverseMount.terminalElsewhereFix')
    })

  const key = `${serverId}\0${share.mountpoint}`
  return locked(key, async (): Promise<MountReply> => {
    const byPoint = mountsOf(serverId)
    const existing = byPoint.get(share.mountpoint)
    if (existing) {
      const live = existing.status.state === 'mounted' || existing.status.state === 'mounting'
      if (live && existing.share.localDir === share.localDir) return { ok: true }
      if (live) return { ok: false, error: mt('main.reverseMount.mountpointInUse', { mountpoint: share.mountpoint }) }
      if (!manual && existing.kind === 'setup' && existing.share.id === share.id)
        return { ok: false, error: existing.status.error, fix: existing.status.fix }
      byPoint.delete(share.mountpoint)
    }

    const m: Mount = {
      key,
      serverId,
      share,
      status: { shareId: share.id, localDir: share.localDir, mountpoint: share.mountpoint, readOnly: share.readOnly, state: 'mounting' },
      conn,
      channel: null,
      cancelled: false,
      released: false,
      wake: () => {}
    }
    const woken = new Promise<'cancelled'>((resolve) => (m.wake = () => resolve('cancelled')))
    // Held from before the first await, so nothing can destroy the connection
    // under a mount that is still being set up. releaseMount hands it back
    // exactly once, whichever path ends the mount.
    conn.refs++
    byPoint.set(share.mountpoint, m)
    emit(serverId)

    const cancelled: MountReply = { ok: false, error: mt('main.reverseMount.lastTerminalClosed') }
    const fail = (reply: MountReply, kind: FailureKind): MountReply => {
      m.kind = kind
      m.status = { ...m.status, state: 'failed', error: reply.error, fix: reply.fix }
      try {
        m.channel?.close()
      } catch {
        /* already closed */
      }
      releaseMount(m)
      emit(serverId)
      return reply
    }

    let root: string
    try {
      root = await shareRoot(share.localDir)
    } catch {
      return fail({ ok: false, error: mt('main.reverseMount.localDirGone', { dir: share.localDir }) }, 'setup')
    }
    if (m.cancelled) return cancelled

    const opening = exec(conn, `sh -c ${shellQuote(mountScript(share.mountpoint, share.readOnly))}`)
    const opened = await Promise.race([opening.then((ch) => ({ ch }), () => null), woken])
    if (opened === 'cancelled') {
      // A channel that opens after this gave up is closed the moment it does.
      void opening.then((ch) => ch.close(), () => undefined)
      return cancelled
    }
    if (!opened) return fail({ ok: false, error: mt('main.reverseMount.noChannel') }, 'dropped')
    const channel = opened.ch
    m.channel = channel
    if (m.cancelled) return cancelled

    let stderr = ''
    channel.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString()
    })
    serveShare(sftpOverStream(channel as unknown as Duplex, true), { root, readOnly: share.readOnly })
    const ended = new Promise<number | null>((resolve) => channel.on('close', (code: number | null) => resolve(code)))

    // sshfs sends INIT before it mounts, so being spoken to is not proof of a
    // mount. The kernel's mount table is.
    const check = `mp=${mountpointWord(share.mountpoint)}; for i in $(seq 100); do mountpoint -q -- "$mp" && exit 0; sleep 0.1; done; exit 1`
    // Only what the server's setup said is a setup failure: the script's own
    // exit codes, or sshfs refusing the mount. A channel that closed with no
    // exit status, or a check that ran out of time or lost its connection, is
    // the connection going away, and a reconnect tries again.
    type Outcome = MountReply & { kind?: FailureKind; exitCode?: number | null }
    const dropped = (error: string): Outcome => ({ ok: false, error, kind: 'dropped' })
    const outcome: Outcome | MountReply = await Promise.race([
      run(conn, check, 15000).then(
        (r): Outcome =>
          r.code === 0
            ? { ok: true }
            : dropped(stderr.trim().slice(0, 400) || mt('main.reverseMount.mountTimedOut', { mountpoint: share.mountpoint })),
        (): Outcome => dropped(mt('main.reverseMount.connectionClosed'))
      ),
      ended.then(
        (code): Outcome =>
          code === null || code === undefined
            ? dropped(mt('main.reverseMount.closedWhileMounting'))
            : { ...explainMountFailure(code, stderr, conn.username, mt), kind: 'setup', exitCode: code }
      ),
      woken.then(() => cancelled)
    ])
    if (m.cancelled) return cancelled
    if (!outcome.ok) {
      m.exitCode = (outcome as Outcome).exitCode
      return fail(outcome, (outcome as Outcome).kind ?? 'setup')
    }

    m.status = { ...m.status, state: 'mounted' }
    emit(serverId)
    void ended.then(() => {
      // Closed under a live mount: the connection dropped or sshfs died. A
      // reconnect mounts it again; this is not a setup failure.
      if (m.cancelled || m.status.state !== 'mounted') return
      fail({ ok: false, error: mt('main.reverseMount.mountStopped') }, 'dropped')
    })
    return { ok: true }
  })
}

/**
 * Take a mount down: close the channel (sshfs exits and libfuse unmounts),
 * then unmount whatever is left and check. Serialised with the mount itself, so
 * one still being set up is finished first and then undone.
 */
function teardown(m: Mount, keepSetupFailure = false): Promise<void> {
  m.cancelled = true
  m.wake()
  return locked(m.key, async () => {
    const byPoint = mounts.get(m.serverId)
    const current = byPoint?.get(m.share.mountpoint) === m
    const forget = (): void => {
      if (byPoint?.get(m.share.mountpoint) === m) byPoint.delete(m.share.mountpoint)
      if (byPoint?.size === 0) mounts.delete(m.serverId)
    }
    if (m.status.state === 'failed' && m.released) {
      // Nothing on the server to undo. A setup failure stays listed, so the
      // reason is still there after the last tab closes and Retry stays manual.
      if (!(keepSetupFailure && m.kind === 'setup')) forget()
      if (current) emit(m.serverId)
      return
    }
    if (current) {
      m.status = { ...m.status, state: 'unmounting', error: undefined, fix: undefined }
      emit(m.serverId)
    }
    const conn = m.conn
    const channel = m.channel
    if (channel) {
      const gone = new Promise<void>((resolve) => {
        channel.once('close', () => resolve())
        setTimeout(resolve, 3000)
      })
      try {
        channel.close()
      } catch {
        /* already closed */
      }
      await gone
    }
    let failed: string | null = null
    if (conn && !m.released) {
      try {
        const r = await run(conn, unmountScript(m.share.mountpoint))
        if (r.code !== 0) failed = r.stderr.trim().slice(0, 400) || mt('main.reverseMount.stillMounted')
      } catch {
        // The connection is gone; nothing on the server can be reached. A
        // stale mount point left there is cleared by the next mount.
      }
    }
    releaseMount(m)
    if (failed) {
      m.kind = 'unmount'
      m.status = { ...m.status, state: 'failed', error: mt('main.reverseMount.unmountFailed', { mountpoint: m.share.mountpoint, detail: failed }).trim() }
    } else forget()
    emit(m.serverId)
  })
}

/**
 * Whether Retry for this share needs a connection made afresh: a fuse-group
 * failure, because group membership is read when a connection authenticates
 * and the pool keeps the old one alive.
 */
export function needsNewConnection(serverId: string, shareId: string): boolean {
  const m = [...(mounts.get(serverId)?.values() ?? [])].find((x) => x.share.id === shareId)
  return m?.status.state === 'failed' && m.exitCode === MOUNT_EXIT.fuseDenied
}

export async function unmountShare(serverId: string, mountpoint: string): Promise<boolean> {
  const m = mounts.get(serverId)?.get(mountpoint)
  if (!m) return false
  await teardown(m)
  return true
}

/** Every mount on a server, for when its last terminal closes. Setup failures stay listed. */
export function unmountServer(serverId: string): Promise<void[]> {
  return Promise.all([...(mounts.get(serverId)?.values() ?? [])].map((m) => teardown(m, true)))
}

/** Every mount everywhere, for quitting. */
export function unmountAll(): Promise<void[][]> {
  return Promise.all([...mounts.keys()].map((id) => unmountServer(id)))
}

/**
 * Mount this server's shares that are set to mount on connect, quietly: a
 * failure lands in the mount's status for the UI to show, never in a toast.
 * Stale shares and setup failures wait for someone to act.
 */
export function autoMount(serverId: string, conn: PooledConnection): void {
  for (const share of sharesOf(serverId)) {
    if (share.autoMount && !isStale(serverId, share)) void mountShare(serverId, conn, share.id, false)
  }
}

/** Mount when a terminal's shell is ready; unmount when the last one closes. */
export function wireFolderShares(): void {
  onServerSession((event, serverId, conn) => {
    if (event === 'ready' && conn) autoMount(serverId, conn)
    else if (event === 'closed') void unmountServer(serverId).then(() => emit(serverId))
    emit(serverId)
  })
}
