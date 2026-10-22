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
import {
  MOUNT_EXIT,
  explainMountFailure,
  mountpointProblem,
  parseShares,
  type LocalShare,
  type MountReply,
  type MountStatus
} from '../../shared/localMounts'

/**
 * A folder on THIS machine, mounted on the server the session is connected to.
 *
 * Reverse sshfs: the server runs `sshfs -o passive` over an exec channel on the
 * server's pooled connection, and this file is the SFTP server on the other end
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
    // A link's size is the length of its target, and the target is a path on
    // this machine: its length alone says how long the account name is. The
    // server reads the target through READLINK, rewritten, so it needs no size.
    size: st.isSymbolicLink() ? 0 : st.size,
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

/**
 * A link's target as the server may see it: relative, and only if it stays in
 * the share.
 *
 * `readlink` hands over the literal target, and an absolute one is a path on
 * THIS machine — on macOS that includes the account name. A target that lands
 * inside the share is rewritten relative to the link, which is also the only
 * form that resolves on the server's side of the mount. One that lands outside
 * is refused: the server gets nothing it could not already list.
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
  if (!landed) throw new Denied('That link points outside the share')
  const rel = path.relative(landed === lexical ? dir : await fs.realpath(dir), landed)
  return rel.split(path.sep).join('/') || '.'
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
      const target = await shareLinkTarget(root, await locate(root, p, false))
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

// ---------------------------------------------------------------- the mounts

/**
 * Mounts are per SERVER, not per terminal: two panes on one server share one
 * mount, and it lives while any terminal to that server is open. ssh.ts reports
 * session starts and ends; index.ts wires them to `autoMount` and
 * `unmountServer`. This module is not imported by ssh.ts on purpose — that
 * would put it in the MCP bridge's import closure, and no agent path may reach
 * a mount (tests/reverseMountNotExposed.test.ts).
 */
interface Mount {
  status: MountStatus
  conn: PooledConnection | null
  channel: ClientChannel | null
  /** Set once teardown has begun or the channel has gone, so neither runs twice. */
  closed: boolean
}

const mounts = new Map<string, Map<string, Mount>>()
let changed: (serverId: string, list: MountStatus[]) => void = () => {}

/** Saved shares per server, from the data file. See `syncShares`. */
let saved = new Map<string, LocalShare[]>()
/** Folders the OS dialog handed back this run. See `allowLocalDir`. */
const picked = new Set<string>()

export function onMountsChanged(cb: (serverId: string, list: MountStatus[]) => void): void {
  changed = cb
}

export function listMounts(serverId: string): MountStatus[] {
  return [...(mounts.get(serverId)?.values() ?? [])].map((m) => ({ ...m.status }))
}

function emit(serverId: string): void {
  changed(serverId, listMounts(serverId))
}

/**
 * Read the saved shares out of the data blob, the way the other main-side
 * consumers of it do (see the `data:save` handler). Auto-mount reads THIS, not
 * whatever a caller passes, and mcpDataCache never sees the field at all.
 */
export function syncShares(data: unknown): void {
  const next = new Map<string, LocalShare[]>()
  const servers = (data as { servers?: unknown } | null)?.servers
  if (Array.isArray(servers)) {
    for (const s of servers) {
      if (!s || typeof s !== 'object') continue
      const r = s as Record<string, unknown>
      const shares = parseShares(r.shares)
      if (typeof r.id === 'string' && shares.length) next.set(r.id, shares)
    }
  }
  saved = next
}

/** A folder the user just chose in the OS dialog. */
export function notePickedFolder(dir: string): void {
  picked.add(dir)
}

/**
 * Only folders the person chose — in the OS dialog this run, or saved on this
 * server's record — can be mounted. A path the renderer simply names is not
 * one of them, the same rule the download folder follows in index.ts.
 */
function allowLocalDir(serverId: string, dir: string): boolean {
  return picked.has(dir) || !!saved.get(serverId)?.some((s) => s.localDir === dir)
}

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

export function unmountScript(mp: string): string {
  // -z: lazy, so a shell sitting inside the mount does not keep it pinned.
  return `mp=${mountpointWord(mp)}; fusermount3 -uz -- "$mp" 2>/dev/null || fusermount -uz "$mp"`
}

/**
 * Mount one share on the server `conn` is connected to.
 *
 * Never throws: the outcome is in the reply and in the mount's status, which is
 * what the Files view lists. A share already mounted or mounting at that mount
 * point is left alone, which is what makes auto-mount safe to call on every
 * connect of every pane.
 */
export async function mountShare(serverId: string, conn: PooledConnection, share: LocalShare): Promise<MountReply> {
  const problem = mountpointProblem(share.mountpoint)
  if (problem) return { ok: false, error: problem }
  if (!allowLocalDir(serverId, share.localDir))
    return { ok: false, error: 'Choose the folder again: only folders picked in the folder dialog can be shared.' }

  const byPoint = mounts.get(serverId) ?? new Map<string, Mount>()
  mounts.set(serverId, byPoint)
  const existing = byPoint.get(share.mountpoint)
  if (existing && existing.status.state !== 'failed') {
    if (existing.status.localDir === share.localDir) return { ok: true }
    return { ok: false, error: `${share.mountpoint} is already in use by ${existing.status.localDir}.` }
  }

  const mount: Mount = {
    status: {
      shareId: share.id,
      localDir: share.localDir,
      mountpoint: share.mountpoint,
      readOnly: share.readOnly,
      state: 'mounting'
    },
    conn: null,
    channel: null,
    closed: false
  }
  byPoint.set(share.mountpoint, mount)
  emit(serverId)

  const fail = (reply: MountReply): MountReply => {
    if (byPoint.get(share.mountpoint) === mount) {
      mount.status = { ...mount.status, state: 'failed', error: reply.error, fix: reply.fix }
      emit(serverId)
    }
    return reply
  }

  let root: string
  try {
    root = await shareRoot(share.localDir)
  } catch {
    return fail({ ok: false, error: `${share.localDir} is not a folder on this computer any more.` })
  }

  let channel: ClientChannel
  try {
    channel = await exec(conn, `sh -c ${shellQuote(mountScript(share.mountpoint, share.readOnly))}`)
  } catch (err) {
    return fail({ ok: false, error: `The server would not start sshfs: ${(err as Error).message}` })
  }
  // Held for as long as the mount lives, so the terminal that started it can
  // close without destroying the connection under the unmount.
  conn.refs++
  mount.conn = conn
  mount.channel = channel
  let stderr = ''
  channel.stderr.on('data', (d: Buffer) => {
    if (stderr.length < 4000) stderr += d.toString()
  })

  serveShare(sftpOverStream(channel as unknown as Duplex, true), { root, readOnly: share.readOnly })

  const ended = new Promise<MountReply>((resolve) =>
    channel.on('close', (code: number | null) => {
      const reply = explainMountFailure(code, stderr, conn.username)
      if (!mount.closed) {
        mount.closed = true
        mount.conn = null
        release(conn)
        if (mount.status.state === 'mounted')
          reply.error = `The mount stopped. ${stderr.trim() ? reply.error : 'The connection to the server closed.'}`
        fail(reply)
      }
      resolve(reply)
    })
  )

  // sshfs sends INIT before it mounts, so being spoken to is not proof of a
  // mount. The kernel's mount table is.
  const check = `mp=${mountpointWord(share.mountpoint)}; for i in $(seq 100); do mountpoint -q -- "$mp" && exit 0; sleep 0.1; done; exit 1`
  const mounted = run(conn, check).then(
    (r): MountReply =>
      r.code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `${share.mountpoint} did not appear as a mount.` },
    (err): MountReply => ({ ok: false, error: (err as Error).message })
  )
  const outcome = await Promise.race([mounted, ended])
  if (outcome.ok && !mount.closed) {
    mount.status = { ...mount.status, state: 'mounted' }
    emit(serverId)
    return outcome
  }
  if (!mount.closed) await teardown(serverId, mount, true)
  return fail(outcome.ok ? { ok: false, error: 'sshfs stopped as soon as it started.' } : outcome)
}

/**
 * Unmount first, then close the channel. Closing alone makes sshfs exit, but an
 * sshfs that loses its transport can leave the mount point answering
 * "Transport endpoint is not connected" until someone unmounts it.
 */
async function teardown(serverId: string, mount: Mount, keepEntry: boolean): Promise<void> {
  const byPoint = mounts.get(serverId)
  if (!keepEntry && byPoint?.get(mount.status.mountpoint) === mount) {
    byPoint.delete(mount.status.mountpoint)
    if (byPoint.size === 0) mounts.delete(serverId)
    emit(serverId)
  }
  if (mount.closed) return
  mount.closed = true
  const conn = mount.conn
  mount.conn = null
  if (!conn) return
  try {
    await run(conn, unmountScript(mount.status.mountpoint))
  } catch {
    /* the connection is already gone; nothing on the server can be reached */
  }
  try {
    mount.channel?.close()
  } catch {
    /* already closed by sshfs exiting */
  }
  release(conn)
}

export async function unmountShare(serverId: string, mountpoint: string): Promise<boolean> {
  const mount = mounts.get(serverId)?.get(mountpoint)
  if (!mount) return false
  await teardown(serverId, mount, false)
  return true
}

/** Every mount on a server, for when its last terminal closes or the app quits. */
export function unmountServer(serverId: string): Promise<void[]> {
  return Promise.all([...(mounts.get(serverId)?.values() ?? [])].map((m) => teardown(serverId, m, false)))
}

export function unmountAll(): Promise<void[][]> {
  return Promise.all([...mounts.keys()].map((id) => unmountServer(id)))
}

/**
 * Mount this server's auto-mount shares, quietly: a failure lands in the
 * mount's status for the Files view to show, never in a toast, so a server
 * without sshfs does not complain on every reconnect.
 */
export function autoMount(serverId: string, conn: PooledConnection): void {
  for (const share of saved.get(serverId) ?? []) {
    if (share.autoMount) void mountShare(serverId, conn, share)
  }
}
