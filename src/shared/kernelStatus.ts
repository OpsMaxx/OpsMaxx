// Is the kernel that is running the newest one installed?
//
// ======================================================================
// MEASURED ON A REAL UBUNTU 24.04.4 HOST, WHICH WAS ITSELF PENDING A REBOOT
// ======================================================================
//
// The fixture is `tests/fixtures/host/kernel/ubuntu-2404-pending-reboot.txt`,
// recorded from a host running `6.8.0-136-generic` with `6.8.0-138-generic`
// installed beside it. Every rule below comes from that output, and TWO OF THE
// TRAPS APPEAR IN IT AT ONCE:
//
//  1. `dpkg-query -W 'linux-image-*'` LISTS PACKAGES THAT ARE NOT INSTALLED.
//     The real output contains
//
//         linux-image-unsigned-6.8.0-136-generic  unknown ok not-installed
//
//     -- a version-bearing name, on a package this host does not have. Counting
//     names would report four installed kernels where there are two. The status
//     field is the whole answer and it is checked exactly.
//
//  2. `linux-image-virtual 6.8.0-138.138 install ok installed` IS NOT A KERNEL.
//     It is a meta package that depends on one, and its version tracks the
//     newest kernel it wants rather than a kernel that exists on disk. Treating
//     it as an installed image would report a kernel that `/boot` does not have.
//     A kernel image carries its version IN ITS NAME; a meta package does not,
//     and that is the distinction used.
//
//  And a third thing the same host settled: `linux-image-generic` is NOT the
//  meta package everywhere. `dpkg-query` answered "no packages found matching
//  linux-image-generic" on a host whose meta is `linux-image-virtual`, so
//  nothing here may assume a meta package name.
//
// WHY THE COMPARISON IS NOT THE PRIMARY SIGNAL, AND WHY THIS FILE DOES NOT READ
// THE MARKER. Debian and Ubuntu already answer the restart question:
// `/var/run/reboot-required` is written by the package manager itself, and
// `.pkgs` names what asked for it -- on the measured host, `libc6`,
// `linux-base` and `linux-image-6.8.0-138-generic`. That is a statement by the
// tool that owns the fact and it beats an inference from version strings.
//
// `hostFacts.ts` ALREADY READS IT, on both families -- the marker file on
// Debian and `needs-restarting -r` on RHEL. So this file does not read it a
// second time: two readers of one fact is one of them drifting, and the one
// that already exists covers a family this one cannot. `kernelReport` is HANDED
// the answer instead, and its job is the part hostFacts does not do -- which
// kernel is running against which is installed, and that is a question the
// restart marker does not answer either way.
//
// ON RPM HOSTS THIS REPORTS UNKNOWN, DELIBERATELY. `rpm -q kernel` and
// `needs-restarting -r` were not measured -- there is no RHEL-family host here
// -- and an unverified parser standing between an operator and "you must
// reboot" is worse than saying it was not read. That is the same call
// `engineUpgrade` made about the installed set, for the same reason.

export const KERNEL_MARKERS = {
  running: '===SP-KERNEL-RUNNING===',
  boot: '===SP-KERNEL-BOOT===',
  dpkg: '===SP-KERNEL-DPKG===',
  dpkgArch: '===SP-KERNEL-DPKGARCH==='
} as const

/**
 * One round trip, and every section ends `|| true`.
 *
 * A host with no `/boot/vmlinuz-*`, no dpkg, or no reboot marker must still
 * return the sections that did answer -- a non-zero exit anywhere would
 * otherwise take the whole read with it, which is how a missing file becomes a
 * missing verdict.
 */
export function buildKernelStatusCommand(): string {
  return [
    `echo "${KERNEL_MARKERS.running}"; uname -r 2>/dev/null || true`,
    `echo "${KERNEL_MARKERS.boot}"; ls -1 /boot/vmlinuz-* 2>/dev/null || true`,
    `echo "${KERNEL_MARKERS.dpkg}"; dpkg-query -W -f='\${Package} \${Version} \${Status}\\n' 'linux-image-*' 2>/dev/null || true`,
    // RPM hosts answer nothing above. Asking dpkg's architecture is how the
    // parser knows it was talking to a dpkg host at all, rather than reading an
    // empty section as "no kernels installed".
    `echo "${KERNEL_MARKERS.dpkgArch}"; dpkg --print-architecture 2>/dev/null || true`
  ].join('; ')
}

function section(output: string, marker: string): string {
  const i = output.indexOf(marker)
  if (i === -1) return ''
  const rest = output.slice(i + marker.length)
  const next = rest.search(/^===SP-KERNEL-/m)
  return next === -1 ? rest : rest.slice(0, next)
}

/** A kernel image names its own version. `linux-image-virtual` does not, which
 *  is finding 2. */
const IMAGE_NAME = /^linux-image-(\d[\w.+-]*)$/

/** dpkg's own words for "this package is here". Anything else -- including
 *  `unknown ok not-installed`, which finding 1 is about -- is not. */
const INSTALLED_STATUS = 'install ok installed'

export interface KernelStatus {
  /** `uname -r`, or null when it could not be read. */
  running: string | null
  /** Kernel images dpkg says are installed, newest last. */
  installed: string[]
  /** Images actually present in /boot, newest last. */
  onBoot: string[]
  /**
   * Whether this host answered as a dpkg host at all.
   *
   * FALSE IS WHY THIS FIELD EXISTS. An RPM host runs every section above and
   * produces nothing, and an empty `installed` list read as "no kernels
   * installed" would be a confident wrong answer about a machine that simply
   * was not asked in its own language.
   */
  dpkg: boolean
}

export function parseKernelStatus(output: string): KernelStatus {
  const running = section(output, KERNEL_MARKERS.running).trim().split('\n')[0]?.trim() || null

  const onBoot = section(output, KERNEL_MARKERS.boot)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('/boot/vmlinuz-'))
    .map((l) => l.slice('/boot/vmlinuz-'.length))
    .sort(compareKernelVersions)

  const installed: string[] = []
  for (const line of section(output, KERNEL_MARKERS.dpkg).split('\n')) {
    const t = line.trim()
    if (t === '') continue
    // `<name> <version> <status...>`, and the status is the last three words.
    const parts = t.split(/\s+/)
    if (parts.length < 4) continue
    const status = parts.slice(-3).join(' ')
    if (status !== INSTALLED_STATUS) continue
    const m = parts[0].match(IMAGE_NAME)
    if (m === null) continue
    installed.push(m[1])
  }
  installed.sort(compareKernelVersions)

  const dpkg = section(output, KERNEL_MARKERS.dpkgArch).trim() !== ''

  return { running, installed, onBoot, dpkg }
}

/**
 * Order two kernel versions the way dpkg does.
 *
 * PINNED AGAINST `dpkg --compare-versions` ON THE MEASURED HOST, which answered
 * `6.8.0-99-generic lt 6.8.0-100-generic` and `1.0~rc1 lt 1.0`. The first is
 * why this cannot be a string comparison -- `"99" > "100"` lexically, and a
 * host on -99 with -100 installed would be told it is up to date. The second is
 * why `~` sorts BEFORE everything, including the empty string.
 */
export function compareKernelVersions(a: string, b: string): number {
  const A = splitVersion(a)
  const B = splitVersion(b)
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i]
    const y = B[i]
    if (x === undefined) return y === undefined ? 0 : tildeLead(y) ? 1 : -1
    if (y === undefined) return tildeLead(x) ? -1 : 1
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x < y ? -1 : 1
      continue
    }
    const xs = String(x)
    const ys = String(y)
    if (xs !== ys) return debianStrLess(xs, ys) ? -1 : 1
  }
  return 0
}

const tildeLead = (p: string | number): boolean => typeof p === 'string' && p.startsWith('~')

/** Digits and non-digits alternate, digits compared as numbers. */
function splitVersion(v: string): (string | number)[] {
  const out: (string | number)[] = []
  for (const m of v.matchAll(/(\d+)|(\D+)/g)) {
    out.push(m[1] !== undefined ? Number(m[1]) : m[2])
  }
  return out
}

/** `~` sorts before anything, which is what makes `1.0~rc1` older than `1.0`. */
function debianStrLess(a: string, b: string): boolean {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i]
    const y = b[i]
    if (x === y) continue
    if (x === undefined) return y !== '~'
    if (y === undefined) return x === '~'
    if (x === '~') return true
    if (y === '~') return false
    return x < y
  }
  return false
}

export type KernelVerdict = 'current' | 'reboot-needed' | 'newer-installed' | 'unknown'

export interface KernelReport {
  verdict: KernelVerdict
  running: string | null
  newest: string | null
  /** The sentence, already written for the operator. */
  detail: string
}

/**
 * What to tell somebody.
 *
 * `rebootRequired` is HANDED IN from `hostFacts`, which already reads the
 * marker on both package families -- see the header. It outranks the version
 * comparison because it is the tool that installed the thing saying a restart
 * is needed, and because it catches what a kernel comparison never would: the
 * measured host's `.pkgs` named `libc6` and `linux-base` beside the kernel.
 */
export function kernelReport(s: KernelStatus, rebootRequired: boolean | null): KernelReport {
  const newest = s.installed.length > 0 ? s.installed[s.installed.length - 1] : null
  const base = { running: s.running, newest }

  if (s.running === null) {
    return { ...base, verdict: 'unknown', detail: 'The running kernel could not be read.' }
  }
  if (rebootRequired === true) {
    return {
      ...base,
      verdict: 'reboot-needed',
      detail:
        newest !== null && compareKernelVersions(s.running, newest) < 0
          ? `This host is running ${s.running}, ${newest} is installed, and its package manager has recorded that a restart is required.`
          : `This host is running ${s.running} and its package manager has recorded that a restart is required. The reason is not a newer kernel — nothing newer than the running one is installed.`
    }
  }
  if (!s.dpkg) {
    return {
      ...base,
      verdict: 'unknown',
      // The RPM path was never measured. An unverified parser standing between
      // an operator and "you must reboot" is worse than saying it was not read.
      detail: `This host is running ${s.running}. Its installed kernels were not read: this build only knows how to ask dpkg, so on an RPM host the question is unanswered rather than answered no.`
    }
  }
  if (newest === null) {
    return {
      ...base,
      verdict: 'unknown',
      // Not "up to date": nothing was read, and an all-clear from a failed read
      // is the one answer that must never appear.
      detail: `This host is running ${s.running}. Its installed kernel packages could not be read, so whether a newer one is waiting is unknown rather than no.`
    }
  }
  if (compareKernelVersions(s.running, newest) < 0) {
    return {
      ...base,
      verdict: 'newer-installed',
      detail: `This host is running ${s.running} but ${newest} is installed. It will not be used until the next reboot, and the package manager has not recorded a restart as required.`
    }
  }
  return {
    ...base,
    verdict: 'current',
    detail: `This host is running ${s.running}, which is the newest kernel installed on it.`
  }
}
