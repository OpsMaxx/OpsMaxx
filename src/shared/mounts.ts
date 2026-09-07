// Item 47, step 2: every filesystem, not just `/`.
//
// `metrics.ts` runs `df -kP /` and `df -iP /`. That was brevity, not policy,
// and it means a full `/var` or `/data` never reaches the disk alert, the
// forecast or the agent -- on the servers where those are separate volumes,
// which is most of the ones anybody cares about.
//
// ---------------------------------------------------------------------------
// THREE THINGS `df` DOES THAT A NAIVE READER GETS WRONG, all measured
// ---------------------------------------------------------------------------
//
//  1. `-l` DOES NOT EXCLUDE tmpfs. It means "local filesystems", and tmpfs and
//     overlay are local. The roadmap's `df -kPl` would have returned every
//     pseudo-filesystem on the box. Types are excluded by NAME, from `-T`,
//     which both GNU coreutils and busybox support.
//
//  2. A tmpfs AT 100% IS NORMAL. Debian 12 mounts a 4 KB tmpfs on
//     /proc/scsi with one inode, one used, `IUse% 100%`. Every container and
//     every systemd host has several of these. A rule that alarmed on a full
//     filesystem without excluding them would fire on every server, for ever,
//     from the first sweep.
//
//  3. THE SAME FILESYSTEM APPEARS MANY TIMES. Alpine's `df` lists /dev/vda1
//     three times -- /etc/resolv.conf, /etc/hostname, /etc/hosts -- because
//     bind mounts are separate rows for one device. Summing them triples the
//     estate's apparent disk, and alerting per row alerts three times.

/** Types that are not storage anybody can fill up, or that are somebody
 *  else's. Excluded by TYPE because the device name is not reliable: `shm`
 *  and `tmpfs` are both tmpfs, and a device called `overlay` is not always
 *  an overlay. */
export const PSEUDO_FS = new Set([
  'tmpfs',
  'devtmpfs',
  'ramfs',
  'overlay',
  'squashfs',
  'proc',
  'sysfs',
  'cgroup',
  'cgroup2',
  'devpts',
  'mqueue',
  'debugfs',
  'tracefs',
  'securityfs',
  'pstore',
  'bpf',
  'configfs',
  'fusectl',
  'hugetlbfs',
  'nsfs',
  'autofs',
  'binfmt_misc',
  'efivarfs',
  'iso9660',
  // Docker Desktop's bind-mount type. Found by running the wired probe rather
  // than by reading: a container on macOS reports `fakeowner` at 98% full,
  // which is the HOST's disk showing through, and it ranked as the worst
  // mount on the "server".
  'fakeowner',
  // The same class from the other virtualisation stacks.
  'virtiofs',
  '9p',
  'vboxsf',
  'grpcfuse'
])

// A DENYLIST, and it cannot be complete. That is the right way round: an
// unknown type is INCLUDED, because a server this app has never seen might be
// running xfs, btrfs, zfs or something newer, and silently dropping a real
// filesystem hides a disk filling up. A wrongly-included one shows up as a
// visible oddity on screen; a wrongly-excluded one shows up as an outage.

export interface DiskMount {
  device: string
  type: string
  mount: string
  totalKb: number
  usedKb: number
  /** From df's own Capacity column, not recomputed: df rounds its own way and
   *  a number that disagreed with `df` on the server would be indefensible. */
  usedPercent: number
  inodesTotal: number | null
  inodesUsedPercent: number | null
}

interface Row {
  device: string
  type: string
  mount: string
  a: number
  b: number
  pct: number
}

/** `df -PT` output: `Filesystem Type <n> <n> <n> Capacity% Mounted-on`. The
 *  mount point may contain spaces, so it is everything after the percentage. */
function parseDfRows(text: string): Row[] {
  const out: Row[] = []
  const lines = text.split('\n')
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '' || /^Filesystem\b/.test(line)) continue
    const m = /^(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/.exec(line)
    if (!m) continue
    out.push({
      device: m[1],
      type: m[2],
      a: Number(m[3]),
      b: Number(m[4]),
      pct: Number(m[6]),
      mount: m[7].trim()
    })
  }
  return out
}

/**
 * Every real filesystem, once each.
 *
 * DEDUPED BY DEVICE, keeping the SHORTEST mount path. Bind mounts put one
 * device under several paths and `/` is the one an operator means; reporting
 * `/etc/hosts` as a filesystem at 61% would be true and useless.
 */
export function parseMounts(blocksText: string, inodesText = ''): DiskMount[] {
  const inodesBy = new Map<string, Row>()
  for (const r of parseDfRows(inodesText)) inodesBy.set(r.mount, r)

  const byDevice = new Map<string, DiskMount>()
  for (const r of parseDfRows(blocksText)) {
    if (PSEUDO_FS.has(r.type)) continue
    const ino = inodesBy.get(r.mount)
    const m: DiskMount = {
      device: r.device,
      type: r.type,
      mount: r.mount,
      totalKb: r.a,
      usedKb: r.b,
      usedPercent: r.pct,
      inodesTotal: ino ? ino.a : null,
      inodesUsedPercent: ino ? ino.pct : null
    }
    const seen = byDevice.get(r.device)
    // Shortest path wins, and `/` is shortest of all.
    if (!seen || m.mount.length < seen.mount.length) byDevice.set(r.device, m)
  }
  return [...byDevice.values()].sort((a, b) => a.mount.localeCompare(b.mount))
}

/**
 * The one mount that goes into the series.
 *
 * Item A's warning about the storage budget is why this exists: forty mounts
 * sampled per server is the 5x trap. Mounts are facts; the WORST of them is
 * the number worth a time series, because "is this server running out of
 * disk" is answered by whichever filesystem fills first.
 *
 * Null for a server with no real filesystems at all -- which is not zero
 * percent, it is a `df` nobody could read.
 */
export function worstMount(mounts: DiskMount[]): DiskMount | null {
  if (mounts.length === 0) return null
  return [...mounts].sort((a, b) => b.usedPercent - a.usedPercent)[0]
}

/** The same, for inodes, and separately: the filesystem closest to full is
 *  very often NOT the one closest to running out of inodes. A mail spool or a
 *  build cache runs out of inodes at 30% used. */
export function worstInodeMount(mounts: DiskMount[]): DiskMount | null {
  const known = mounts.filter((m) => m.inodesUsedPercent !== null)
  if (known.length === 0) return null
  return known.sort((a, b) => (b.inodesUsedPercent ?? 0) - (a.inodesUsedPercent ?? 0))[0]
}
