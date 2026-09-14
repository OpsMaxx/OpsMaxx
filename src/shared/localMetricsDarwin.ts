import type { HostMetrics } from './ssh'

/**
 * The metrics collector for macOS.
 *
 * The Linux collector reads /proc, and macOS does not have one. Pointing it at
 * a Mac produced worse than nothing — CPU, memory, load and network came back
 * null, which is honest, and DISK came back a plausible wrong number, which is
 * not. So the local monitor refused to run off Linux at all, and the local
 * terminal had no Monitor tab.
 *
 * This is the collector that was named as the real fix. Every number below is
 * derived from a source that means on macOS what the procfs counter means on
 * Linux — and where there is no such source, the field is null rather than
 * approximated. The two places that matters are called out where they happen.
 *
 * The same discipline as every other collector here: no `set -e`, every read
 * conditional, section markers printed from shell literals nothing read from
 * the system ever touches, and no sudo anywhere. Everything it reads is
 * readable by the logged-in user.
 */

export const DARWIN_MARKERS = {
  cpu: '__CPU__',
  load: '__LOAD__',
  ncpu: '__NCPU__',
  memTotal: '__MEMTOTAL__',
  vmstat: '__VMSTAT__',
  disk: '__DISK__',
  mounts: '__MOUNTS__',
  net: '__NET__',
  inode: '__INODE__',
  boot: '__BOOT__',
  host: '__HOST__',
  kernel: '__KERNEL__'
} as const

/**
 * `top -l 2` on purpose.
 *
 * The FIRST sample `top` prints is cumulative since boot, which on a machine
 * that has been up for a week is a number about last Tuesday. The second is a
 * delta over the interval between them, which is the reading a monitor wants.
 * `-n 0` asks for no process rows and `-s 0` for no added delay, so the cost is
 * one sampling interval rather than a configurable wait.
 *
 * This is also why the macOS path keeps no CPU snapshot between polls the way
 * the Linux one does: `top` computes the delta itself.
 */
export const DARWIN_METRICS_CMD = [
  'export LC_ALL=C',
  `echo ${DARWIN_MARKERS.cpu}`,
  "top -l 2 -n 0 -s 0 2>/dev/null | grep '^CPU usage' || true",
  `echo ${DARWIN_MARKERS.load}`,
  'sysctl -n vm.loadavg 2>/dev/null || true',
  `echo ${DARWIN_MARKERS.ncpu}`,
  'sysctl -n hw.ncpu 2>/dev/null || true',
  `echo ${DARWIN_MARKERS.memTotal}`,
  'sysctl -n hw.memsize 2>/dev/null || true',
  `echo ${DARWIN_MARKERS.vmstat}`,
  'vm_stat 2>/dev/null || true',
  `echo ${DARWIN_MARKERS.disk}`,
  'df -kP / 2>/dev/null | tail -1 || true',
  `echo ${DARWIN_MARKERS.mounts}`,
  'df -kP 2>/dev/null || true',
  `echo ${DARWIN_MARKERS.inode}`,
  // WITHOUT -P, and that is the whole point. macOS `df` reports the inode
  // columns by default and the POSIX format suppresses them, which is how
  // `df -iP` came to be read as "macOS ignores -i" — it does not ignore it,
  // `-P` drops what it asked for. One line, parsed defensively, because -P is
  // also what guarantees a long device name does not wrap.
  'df -k / 2>/dev/null | tail -1 || true',
  `echo ${DARWIN_MARKERS.net}`,
  'netstat -ib 2>/dev/null || true',
  `echo ${DARWIN_MARKERS.boot}`,
  'sysctl -n kern.boottime 2>/dev/null || true',
  `echo ${DARWIN_MARKERS.host}`,
  'hostname 2>/dev/null || true',
  `echo ${DARWIN_MARKERS.kernel}`,
  'uname -sr 2>/dev/null || true'
].join('\n')

const section = (text: string, marker: string): string[] => {
  const start = text.indexOf(marker)
  if (start === -1) return []
  const from = text.indexOf('\n', start)
  if (from === -1) return []
  const rest = text.slice(from + 1)
  const next = rest.search(/^__[A-Z]+__$/m)
  return (next === -1 ? rest : rest.slice(0, next)).split('\n').filter((l) => l.trim() !== '')
}

const num = (v: string | undefined): number | null => {
  if (v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Busy percentage from `top`'s last CPU line.
 *
 * Taken as 100 minus idle rather than user plus sys, because those two do not
 * account for everything `top` counts and the remainder would be silently
 * dropped.
 */
export function darwinCpu(lines: string[]): number | null {
  const last = lines[lines.length - 1]
  if (!last) return null
  const idle = last.match(/([\d.]+)%\s+idle/)
  if (!idle) return null
  const v = Number(idle[1])
  if (!Number.isFinite(v)) return null
  return Math.max(0, Math.min(100, 100 - v))
}

/** `{ 3.95 6.26 6.86 }` — the one-minute figure. */
export function darwinLoad(lines: string[]): number | null {
  const m = lines[0]?.match(/([\d.]+)/)
  return m ? num(m[1]) : null
}

/**
 * Memory, from `vm_stat` page counts and `hw.memsize`.
 *
 * USED is active + wired + compressed, which is exactly what Activity Monitor
 * calls "Memory Used" — App Memory, Wired, Compressed. That definition is
 * chosen over any of the plausible alternatives for one reason: it is the
 * number a Mac user can check this against, and a monitor that disagrees with
 * Activity Monitor on the same machine reads as broken even when its own
 * arithmetic is defensible.
 *
 * Available is the remainder, so the pair means the same thing as the Linux
 * path's `MemTotal - MemAvailable`.
 *
 * What is deliberately NOT counted is `File-backed pages`. It looks like
 * Linux's reclaimable page cache and is not a separate pool — those pages are
 * already inside active and inactive — so adding them counts a large slice of
 * memory twice and reports a machine as emptier than it is.
 *
 * Worth knowing when comparing with a Linux host: macOS COMPRESSES before it
 * swaps, and compressed pages are held rather than available. A Mac under load
 * reads higher here than a Linux box doing the same work, and that is a fact
 * about the machine rather than a difference in method.
 */
export function darwinMemory(
  vmstat: string[],
  totalBytes: number | null
): Pick<HostMetrics, 'memPct' | 'memUsed' | 'memTotal' | 'memAvailable' | 'memFree' | 'memCache'> {
  const pageSize = num(vmstat[0]?.match(/page size of (\d+) bytes/)?.[1]) ?? 4096
  const pages = (name: string): number | null => {
    const line = vmstat.find((l) => l.startsWith(`${name}:`))
    return line ? num(line.replace(/[^\d]/g, '')) : null
  }
  const active = pages('Pages active')
  const wired = pages('Pages wired down')
  const compressed = pages('Pages occupied by compressor')
  const free = pages('Pages free')

  // Null, not zero: a vm_stat that did not run is not a machine with no memory.
  if (totalBytes === null || active === null || wired === null) {
    return {
      memPct: null,
      memUsed: 0,
      memTotal: totalBytes ?? 0,
      memAvailable: null,
      memFree: null,
      memCache: null
    }
  }

  const used = (active + wired + (compressed ?? 0)) * pageSize
  const available = Math.max(0, totalBytes - used)
  return {
    memPct: totalBytes > 0 ? Math.min(100, (used / totalBytes) * 100) : null,
    memUsed: used,
    memTotal: totalBytes,
    memAvailable: available,
    memFree: free === null ? null : free * pageSize,
    // No honest equivalent. macOS's file-backed pages are not a separate
    // reclaimable pool the way Linux's page cache is — they are already
    // counted inside active and inactive — so reporting them as a cache column
    // would both double-count and answer a different question.
    memCache: null
  }
}

/**
 * Disk, and the reason this whole module exists.
 *
 * `df` on APFS reports the CONTAINER as the total, which every volume in that
 * container shares. Dividing THIS VOLUME's used by it reported a machine at 97%
 * full as 3.7% — a plausible wrong number, which is worse than an absent one.
 *
 * THE FIX FOR THAT WAS ALSO WRONG, in the same direction, and it survived
 * because its own comment named the condition it needed and never checked it:
 * "used over used-plus-available ... on a non-shared filesystem is identical to
 * used over total". Every modern macOS is a SHARED filesystem. `/` is the
 * sealed System volume and everything of the user's lives on the Data volume
 * beside it, in one container, sharing one pool of free space. So for `/`,
 * `used + available` is this volume's 17 GiB plus the CONTAINER's 13 GiB free,
 * and the 391 GiB the Data volume is holding is invisible to the sum. Measured
 * on a 500 GB MacBook with 12.6 GiB genuinely left:
 *
 *     df -kP /   →  482797652 blocks, 18017788 used, 13266020 avail, 58%
 *     reported   →  "30.0 GiB disk, 17.2 GiB used (57%)"
 *     truth      →  460 GiB disk, 12.6 GiB free, 97% full
 *
 * A 500 GB disk reported as a 30 GiB disk is the part a user notices. The part
 * that matters more is that 57% reads as half empty on a machine that is about
 * to run out, so no disk alert fires and the capacity forecast has nothing to
 * forecast.
 *
 * WHAT IS ACTUALLY TRUE OF A SHARED CONTAINER: the total is the container, and
 * the only number that means anything to whoever is about to write a file is
 * what is AVAILABLE. Everything else is used -- by this volume, by its
 * siblings, by APFS itself -- and which of them is holding it does not change
 * whether the next write fits. So used is `total - available`, which is
 * `df`'s Size and Avail columns and nothing derived. That is the figure Finder
 * and About This Mac show, and it agrees with the Capacity column of the DATA
 * volume, which is the one row of `df` that describes the machine.
 *
 * It is deliberately NOT `df`'s Capacity column for `/`, which is 58% here. The
 * app agreeing with `df /` was never the goal; agreeing with how full the disk
 * is, was. On Linux -- one filesystem, no shared container -- the two coincide,
 * which is why the SSH probe reads the Capacity column and this does not.
 */
export function darwinDisk(line: string | undefined): {
  diskPct: number | null
  diskUsed: number
  diskTotal: number
  diskCapacity: number
} {
  const cols = (line ?? '').trim().split(/\s+/)
  const nothing = { diskPct: null, diskUsed: 0, diskTotal: 0, diskCapacity: 0 }
  if (cols.length < 5) return nothing
  const totalKb = num(cols[1])
  const availKb = num(cols[3])
  // `usedKb` is read and deliberately not used for the fill: on a shared
  // container it is one volume's share and always understates the disk. It is
  // still parsed, because a line where it is missing is a line this cannot
  // trust at all.
  const usedKb = num(cols[2])
  if (totalKb === null || availKb === null || usedKb === null) return nothing
  if (totalKb <= 0 || availKb > totalKb) return nothing
  const usedOfContainer = totalKb - availKb
  return {
    diskPct: (usedOfContainer / totalKb) * 100,
    diskUsed: usedOfContainer * 1024,
    diskTotal: totalKb * 1024,
    // The same number as diskTotal, and now for a defensible reason rather than
    // a coincidence: the percentage above is a share OF the container, so the
    // container is what it is a percentage of. On Linux the two differ, because
    // there diskTotal is df's raw Size and the percentage excludes the blocks
    // reserved for root.
    diskCapacity: totalKb * 1024
  }
}

/**
 * Bytes in and out, from `netstat -ib`.
 *
 * One row per interface PER ADDRESS FAMILY, every one carrying the same
 * cumulative counters, so summing the output multiplies every interface by
 * however many addresses it has. Only the `<Link#N>` row is counted, which is
 * the interface itself and appears exactly once.
 *
 * `lo0` is excluded for the reason the Linux collector excludes it: loopback
 * traffic is this machine talking to itself and counting it makes an idle
 * laptop look busy.
 */
export function darwinNetwork(lines: string[]): { netRx: number; netTx: number } {
  let netRx = 0
  let netTx = 0
  const seen = new Set<string>()
  for (const l of lines) {
    const cols = l.trim().split(/\s+/)
    if (cols.length < 10) continue
    const name = cols[0]
    if (name === 'Name' || name === 'lo0' || seen.has(name)) continue
    if (!/^<Link#\d+>$/.test(cols[2])) continue
    const rx = num(cols[6])
    const tx = num(cols[9])
    if (rx === null || tx === null) continue
    seen.add(name)
    netRx += rx
    netTx += tx
  }
  return { netRx, netTx }
}

/**
 * Inodes, from the columns `-P` was hiding.
 *
 * APFS allocates inodes dynamically, so this is very nearly always ~0% and
 * cannot run out the way an ext4 filesystem can. It is reported anyway rather
 * than nulled, because "0% of inodes used" is a true statement and an absent
 * figure is one a reader has to go and check somewhere else.
 *
 * Parsed defensively: without `-P` there is no POSIX guarantee that a long
 * device name keeps the row on one line, so anything that does not yield two
 * plausible counts is null rather than a guess.
 */
export function darwinInodes(line: string | undefined): number | null {
  const cols = (line ?? '').trim().split(/\s+/)
  if (cols.length < 8) return null
  const used = num(cols[5])
  const free = num(cols[6])
  if (used === null || free === null) return null
  const total = used + free
  return total > 0 ? (used / total) * 100 : null
}

/** `{ sec = 1788485225, usec = 31219 } Fri Sep …` → seconds since that. */
export function darwinUptime(lines: string[], now: number): number {
  const sec = num(lines[0]?.match(/sec\s*=\s*(\d+)/)?.[1])
  if (sec === null) return 0
  return Math.max(0, Math.floor(now / 1000 - sec))
}

export function parseDarwinMetrics(text: string, now: number = Date.now()): HostMetrics {
  const vmstat = section(text, DARWIN_MARKERS.vmstat)
  const mem = darwinMemory(vmstat, num(section(text, DARWIN_MARKERS.memTotal)[0]))
  const disk = darwinDisk(section(text, DARWIN_MARKERS.disk)[0])
  const net = darwinNetwork(section(text, DARWIN_MARKERS.net))

  return {
    cpu: darwinCpu(section(text, DARWIN_MARKERS.cpu)),
    // `top` reports the machine, not each core. Null rather than an invented
    // split: "one core pinned" is a real question and this cannot answer it.
    cpuCores: null,
    ...mem,
    ...disk,
    inodePct: darwinInodes(section(text, DARWIN_MARKERS.inode)[0]),
    mounts: [],
    load1: darwinLoad(section(text, DARWIN_MARKERS.load)),
    ...net,
    uptime: darwinUptime(section(text, DARWIN_MARKERS.boot), now),
    hostname: section(text, DARWIN_MARKERS.host)[0] ?? '',
    kernel: section(text, DARWIN_MARKERS.kernel)[0] ?? '',
    cores: num(section(text, DARWIN_MARKERS.ncpu)[0]) ?? 0,
    // launchd is not systemd. Reporting an empty unit list would say this Mac
    // has no failed services, which is a claim rather than an absence.
    services: null,
    listeners: null,
    listenerSource: null
  }
}
