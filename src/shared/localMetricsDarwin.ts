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
 * container shares. Dividing used by it reported a volume at 40% capacity as
 * 3.7% full — a plausible wrong number, which is worse than an absent one.
 *
 * Used over used-plus-available is the fill of the space this volume can
 * actually reach. It is what `df`'s own Capacity column shows and what Finder
 * shows, and on a non-shared filesystem it is identical to used over total.
 */
export function darwinDisk(line: string | undefined): {
  diskPct: number | null
  diskUsed: number
  diskTotal: number
} {
  const cols = (line ?? '').trim().split(/\s+/)
  if (cols.length < 5) return { diskPct: null, diskUsed: 0, diskTotal: 0 }
  const usedKb = num(cols[2])
  const availKb = num(cols[3])
  if (usedKb === null || availKb === null) return { diskPct: null, diskUsed: 0, diskTotal: 0 }
  const reachable = usedKb + availKb
  return {
    diskPct: reachable > 0 ? (usedKb / reachable) * 100 : null,
    diskUsed: usedKb * 1024,
    diskTotal: reachable * 1024
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
