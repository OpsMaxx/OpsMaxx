/**
 * Folders on this computer, mounted on a server (reverse sshfs).
 *
 * Shared between main, which runs the mount, and the renderer, which saves the
 * shares on the server record and shows their state. The protocol side lives in
 * src/main/services/reverseMount.ts; the design note is
 * docs/10-internal/reverse-mount-spike.md.
 */

/**
 * A share as this machine saves it.
 *
 * NOT on the server record. Server records sync between devices (addy) and
 * ride inside every backup, and a share names a folder on THIS computer: one
 * synced or restored onto another machine would mount that machine's folder
 * on a server nobody chose to give it to. Shares live in main's own
 * per-machine file instead, which nothing syncs, backs up or exports.
 */
export interface LocalShare {
  id: string
  /** Absolute path on this computer. */
  localDir: string
  /** On the server. `~/` means the login's home; a relative path is relative to it too. */
  mountpoint: string
  readOnly: boolean
  /** Mount it whenever a terminal to this server connects. */
  autoMount: boolean
}

/** A saved share as the renderer sees it. */
export interface ShareView extends LocalShare {
  /**
   * The server's address, port or account has changed since the share was
   * set up — by the user, a synced edit or an agent's update_server. A share
   * in this state does not mount until someone re-enables it.
   */
  stale: boolean
}

/** Everything the UI shows for one server. */
export interface MountsView {
  /** A terminal to this server is open, so there is a connection to mount over. */
  connected: boolean
  shares: ShareView[]
  mounts: MountStatus[]
}

/**
 * Who a share was given to: the account, address and port, or the cloud
 * target. Stored with each share and compared before every mount, so a server
 * record that now points somewhere else does not inherit the folder.
 */
export function serverIdentity(s: { host: string; port: number; username: string; cloud?: unknown }): string {
  return JSON.stringify([s.username, s.host, s.port, s.cloud ?? null])
}

export type MountState = 'mounting' | 'mounted' | 'unmounting' | 'failed'

export interface MountStatus {
  shareId: string
  localDir: string
  mountpoint: string
  readOnly: boolean
  state: MountState
  /** Set when `state` is `failed`: what went wrong, in a sentence. */
  error?: string
  /** What to do about it, when there is something to do. */
  fix?: string
}

export interface MountReply {
  ok: boolean
  error?: string
  fix?: string
}

/** `~/opsmaxx/<folder name>`, with the name reduced to something safe to type. */
export function defaultMountpoint(localDir: string): string {
  const name = localDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '')
  return `~/opsmaxx/${safe || 'folder'}`
}

/** Why a mount point cannot be used, or null if it can. */
export function mountpointProblem(mp: string): string | null {
  const t = mp.trim()
  if (!t) return 'Choose where to mount it on the server.'
  if (t !== mp) return 'The mount point starts or ends with a space.'
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(mp)) return 'The mount point has a control character in it.'
  if (mp.length > 1024) return 'The mount point is too long.'
  const bare = mp.replace(/\/+$/, '')
  if (bare === '' || bare === '~' || bare === '.' || bare === '..')
    return 'Mount into a folder of its own, not over the root or your home folder.'
  return null
}

/** Exit codes the mount script uses for the failures it can name itself. */
export const MOUNT_EXIT = {
  noSshfs: 127,
  noFuse: 126,
  fuseDenied: 125,
  notEmpty: 124,
  mkdirFailed: 123
} as const

/**
 * A failure as a sentence and a fix, from what the server said.
 *
 * `stderr` comes from the server and is shown as text, never interpreted. The
 * known cases are matched on the script's own exit codes first, because those
 * are ours, and on sshfs and fusermount wording only after.
 */
export function explainMountFailure(code: number | null, stderr: string, username: string): MountReply {
  const said = stderr.trim().slice(0, 400)
  switch (code) {
    case MOUNT_EXIT.noSshfs:
      return {
        ok: false,
        error: 'sshfs is not installed on this server.',
        fix: 'Install it on the server: sudo apt install sshfs (Debian, Ubuntu) or sudo dnf install fuse-sshfs (Fedora, RHEL).'
      }
    case MOUNT_EXIT.noFuse:
      return {
        ok: false,
        error: '/dev/fuse is not available on this server.',
        fix: 'Containers usually lack it. On a full machine, load the module with sudo modprobe fuse.'
      }
    case MOUNT_EXIT.fuseDenied:
      return {
        ok: false,
        error: `${username || 'This account'} is not allowed to use /dev/fuse on this server.`,
        // Distribution-specific: Ubuntu and Debian have no fuse group and leave
        // /dev/fuse open to everyone. And group membership is read when the
        // connection authenticates, which the pool keeps alive across tabs.
        fix:
          `Where /dev/fuse belongs to a fuse group (some older or hardened systems; not Ubuntu or Debian), add the account: ` +
          `sudo usermod -aG fuse ${username || '<user>'}. Then close every tab to this server, so the next one connects afresh.`
      }
    case MOUNT_EXIT.notEmpty:
      return {
        ok: false,
        error: 'The mount point already has files in it.',
        fix: 'Mounting over them would hide them. Choose an empty or new folder.'
      }
    case MOUNT_EXIT.mkdirFailed:
      return { ok: false, error: `Could not create the mount point on the server. ${said}`.trim() }
  }
  if (/operation not permitted|permission denied/i.test(said) && /fuse|mount/i.test(said)) {
    return {
      ok: false,
      error: 'The server refused the FUSE mount.',
      fix: 'This is what happens inside most containers, which cannot mount filesystems.'
    }
  }
  if (/modprobe fuse|fuse: device not found/i.test(said)) {
    return { ok: false, error: '/dev/fuse is not available on this server.', fix: 'Containers usually lack it.' }
  }
  return { ok: false, error: said || `sshfs stopped with code ${code ?? 'unknown'}.` }
}

/**
 * Saved shares from a server record on disk, keeping only well-formed ones.
 *
 * Main reads these from the saved data file to mount on connect, so this is a
 * boundary: a hand-edited record becomes "no share", not a half-valid one.
 */
export function parseShares(raw: unknown): LocalShare[] {
  if (!Array.isArray(raw)) return []
  const out: LocalShare[] = []
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue
    const r = s as Record<string, unknown>
    if (typeof r.id !== 'string' || typeof r.localDir !== 'string' || typeof r.mountpoint !== 'string') continue
    if (!r.localDir || mountpointProblem(r.mountpoint)) continue
    out.push({
      id: r.id,
      localDir: r.localDir,
      mountpoint: r.mountpoint,
      // Anything but an explicit false is read-only: the safe reading of a
      // damaged record.
      readOnly: r.readOnly !== false,
      autoMount: r.autoMount === true
    })
  }
  return out
}

/** Why these shares cannot be saved, and which one, or null. */
export function sharesProblem(shares: LocalShare[]): { shareId: string; message: string } | null {
  const seen = new Set<string>()
  for (const s of shares) {
    const p = mountpointProblem(s.mountpoint)
    if (p) return { shareId: s.id, message: p }
    if (seen.has(s.mountpoint)) return { shareId: s.id, message: `Two folders are shared at ${s.mountpoint}.` }
    seen.add(s.mountpoint)
  }
  return null
}
