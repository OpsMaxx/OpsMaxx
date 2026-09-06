import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  KERNEL_MARKERS,
  buildKernelStatusCommand,
  compareKernelVersions,
  kernelReport,
  parseKernelStatus
} from '../src/shared/kernelStatus'

// Item 46's kernel row, measured on a REAL Ubuntu 24.04.4 host that was itself
// pending a reboot: running 6.8.0-136-generic with 6.8.0-138-generic installed.
//
// The recorded output contains both traps this parser exists to avoid, which is
// why it could be built honestly at all. Everything asserted here comes from
// that file; nothing is reconstructed from documentation.

const CONTAINER = readFileSync(
  fileURLToPath(new URL('./fixtures/host/kernel/debian12-container-no-kernel.txt', import.meta.url)),
  'utf8'
)

const FIX = readFileSync(
  fileURLToPath(new URL('./fixtures/host/kernel/ubuntu-2404-pending-reboot.txt', import.meta.url)),
  'utf8'
)

describe('against the real host', () => {
  it('reads the running kernel and the two that are installed', () => {
    const s = parseKernelStatus(FIX)
    expect(s.running).toBe('6.8.0-136-generic')
    expect(s.installed).toEqual(['6.8.0-136-generic', '6.8.0-138-generic'])
  })

  // Trap 1: the real output contains
  //   linux-image-unsigned-6.8.0-136-generic  unknown ok not-installed
  // -- a version-bearing name on a package this host does not have.
  it('does not count a package dpkg says is not installed', () => {
    expect(FIX).toContain('unknown ok not-installed')
    expect(parseKernelStatus(FIX).installed).toHaveLength(2)
    expect(parseKernelStatus(FIX).installed.join(' ')).not.toContain('unsigned')
  })

  // Trap 2: `linux-image-virtual` IS installed and is not a kernel. Its version
  // (6.8.0-138.138) tracks what it wants, not what is on disk.
  it('does not count the meta package as an installed kernel', () => {
    expect(FIX).toContain('linux-image-virtual 6.8.0-138.138 install ok installed')
    expect(parseKernelStatus(FIX).installed).not.toContain('virtual')
    // And the newest is a real image, not the meta's version.
    expect(kernelReport(parseKernelStatus(FIX), false).newest).toBe('6.8.0-138-generic')
  })

  it('reads what /boot actually holds', () => {
    expect(parseKernelStatus(FIX).onBoot).toEqual(['6.8.0-136-generic', '6.8.0-138-generic'])
  })

  // `ls -1` sorts lexically, and the host confirmed what that does: `sort` puts
  // `6.8.0-99-generic` AFTER `6.8.0-136-generic`. So the order /boot arrives in
  // is not the order these belong in, and the newest would be read as -99.
  // CONSTRUCTED: this host has no -99 kernel to record.
  it('re-orders /boot, whose listing is lexical and therefore wrong', () => {
    const out = [
      KERNEL_MARKERS.running,
      '6.8.0-99-generic',
      KERNEL_MARKERS.boot,
      '/boot/vmlinuz-6.8.0-100-generic',
      '/boot/vmlinuz-6.8.0-99-generic'
    ].join('\n')
    expect(parseKernelStatus(out).onBoot).toEqual(['6.8.0-99-generic', '6.8.0-100-generic'])
  })

  // The marker is NOT read here: `hostFacts` already reads it on both package
  // families, and two readers of one fact is one of them drifting. It is handed
  // in, and it outranks the comparison.
  it('leads with the restart hostFacts recorded, naming the kernel that is waiting', () => {
    const r = kernelReport(parseKernelStatus(FIX), true)
    expect(r.verdict).toBe('reboot-needed')
    expect(r.detail).toContain('6.8.0-136-generic')
    expect(r.detail).toContain('6.8.0-138-generic')
    expect(r.detail).toContain('restart is required')
  })

  // A restart can be required for `libc6` with no new kernel at all -- which is
  // the measured host's other two packages. Saying "a newer kernel is waiting"
  // there would send somebody looking for one that is not there.
  it('does not blame a kernel when nothing newer is installed', () => {
    const only136 = FIX.replace(
      'linux-image-6.8.0-138-generic 6.8.0-138.138 install ok installed\n',
      ''
    )
    const r = kernelReport(parseKernelStatus(only136), true)
    expect(r.verdict).toBe('reboot-needed')
    expect(r.detail).toContain('not a newer kernel')
  })

  it('sees that it was talking to a dpkg host', () => {
    expect(parseKernelStatus(FIX).dpkg).toBe(true)
  })
})

// MEASURED in almalinux:9 containers on the test host. RPM treats the kernel as
// an "installonly" package, so two versions genuinely coexist -- this is a real
// configuration, not a contrived one.
describe('the RPM family, measured', () => {
  const TWO = readFileSync(
    fileURLToPath(new URL('./fixtures/host/kernel/almalinux9-two-kernels.txt', import.meta.url)),
    'utf8'
  )
  const CLEAN = readFileSync(
    fileURLToPath(new URL('./fixtures/host/kernel/almalinux9-no-kernel.txt', import.meta.url)),
    'utf8'
  )

  it('reads both installed kernels and knows which family answered', () => {
    const s = parseKernelStatus(TWO)
    expect(s.family).toBe('rpm')
    expect(s.dpkg).toBe(false)
    expect(s.installed).toEqual([
      '5.14.0-687.39.1.el9_8.x86_64',
      '5.14.0-687.42.1.el9_8.x86_64'
    ])
  })

  // THE query finding: `rpm -qa 'kernel*'` returns EIGHT rows for two kernels,
  // because kernel-core, kernel-modules and kernel-modules-core match too --
  // and `kernel-core-5.14.0-…` even has the `kernel-` prefix.
  it('asks rpm for the package name exactly, not for a glob', () => {
    const cmd = buildKernelStatusCommand()
    expect(cmd).toContain('rpm -q kernel')
    expect(cmd).not.toContain("rpm -qa 'kernel*'")
    expect(cmd).not.toContain('rpm -qa "kernel*"')
  })

  // `needs-restarting -r` was measured on this family -- exit 1 when a reboot
  // is required, exit 0 when not -- and is deliberately NOT run here, because
  // `hostFacts` already runs it and takes its exit code. Two readers of one
  // fact is one of them drifting, which is the rule the Debian side follows.
  it('does not run needs-restarting, which hostFacts already owns', () => {
    expect(buildKernelStatusCommand()).not.toContain('needs-restarting')
  })

  // The restart answer is handed in for RPM exactly as it is for dpkg.
  it('takes the restart answer from its caller on this family too', () => {
    const s = parseKernelStatus(TWO)
    expect(kernelReport(s, true).verdict).toBe('reboot-needed')
    expect(kernelReport(s, false).verdict).not.toBe('reboot-needed')
  })

  // `package kernel is not installed` matches nothing, which is right: a
  // container owns no kernel.
  it('reads a container with no kernel package as unknown, not as up to date', () => {
    const s = parseKernelStatus(CLEAN)
    expect(s.installed).toEqual([])
    expect(kernelReport(s, null).verdict).toBe('unknown')
  })

  // The running kernel here is the Docker host's Ubuntu one, so it is genuinely
  // not among the rpm kernels -- and that is a real state on a host whose
  // kernel came from outside the package manager.
  it('refuses to guess when the running kernel is not one it lists', () => {
    const s = parseKernelStatus(TWO)
    // Restart outranks it, so ask the question with the restart absent.
    const r = kernelReport(s, null)
    expect(r.verdict).toBe('unknown')
    expect(r.detail).toContain('not among the kernels')
    expect(r.detail).toContain('cannot be answered from here')
  })

  // MEASURED: `rpm -qa 'kernel*'` in the same container, verbatim. EIGHT rows
  // for TWO kernels, because kernel-core, kernel-modules and
  // kernel-modules-core all match -- and `kernel-core-5.14.0-…` even carries
  // the `kernel-` prefix, so prefix-matching does not save you. The digit after
  // the dash is what separates a version from a sub-package name.
  //
  // It is also REVERSE SORTED, which makes it the ordering case as well: parsed
  // in file order the newest kernel would be read as -687.39.
  it('excludes sub-packages and re-orders, against the glob output itself', () => {
    const glob = readFileSync(
      fileURLToPath(new URL('./fixtures/host/kernel/almalinux9-rpm-qa-glob.txt', import.meta.url)),
      'utf8'
    )
    expect(glob.trim().split('\n')).toHaveLength(9) // marker + 8 rows
    const s = parseKernelStatus(`${glob}\n${KERNEL_MARKERS.rpmName}\nx86_64\n`)
    expect(s.installed).toEqual([
      '5.14.0-687.39.1.el9_8.x86_64',
      '5.14.0-687.42.1.el9_8.x86_64'
    ])
    expect(s.installed.join(' ')).not.toContain('modules')
    expect(s.installed.join(' ')).not.toContain('core')
  })

  // rpm's own labelCompare gave -1 for all four of these, matching dpkg.
  it('orders rpm versions the way rpm does', () => {
    for (const [a, b] of [
      ['5.14.0-687.39.1.el9_8', '5.14.0-687.42.1.el9_8'],
      ['5.14.0-99.el9', '5.14.0-100.el9'],
      ['5.14.0-687.9.1.el9_8', '5.14.0-687.10.1.el9_8'],
      ['1.0~rc1', '1.0']
    ]) {
      expect(compareKernelVersions(a, b), `${a} < ${b}`).toBeLessThan(0)
    }
  })
})

describe('ordering versions', () => {
  // Pinned against `dpkg --compare-versions` on the measured host. This is the
  // pair that makes a string comparison wrong: "99" > "100" lexically, so a
  // host on -99 with -100 installed would be told it is up to date.
  it('orders 99 before 100, which a string comparison does not', () => {
    expect(compareKernelVersions('6.8.0-99-generic', '6.8.0-100-generic')).toBeLessThan(0)
    expect('6.8.0-99-generic' < '6.8.0-100-generic').toBe(false)
  })

  it('agrees with dpkg on every pair that was measured', () => {
    // dpkg answered `lt` for all of these on the host.
    const lt: [string, string][] = [
      ['6.8.0-99-generic', '6.8.0-100-generic'],
      ['6.8.0-136', '6.8.0-138'],
      ['1.0~rc1', '1.0'],
      ['6.8.0-136.136', '6.8.0-138.138'],
      ['5.15.0-generic', '6.8.0-generic']
    ]
    for (const [a, b] of lt) {
      expect(compareKernelVersions(a, b), `${a} < ${b}`).toBeLessThan(0)
      expect(compareKernelVersions(b, a), `${b} > ${a}`).toBeGreaterThan(0)
    }
  })

  it('sorts a tilde before the release it precedes', () => {
    expect(compareKernelVersions('1.0~beta', '1.0~rc1')).toBeLessThan(0)
    expect(compareKernelVersions('6.8.0-1~exp', '6.8.0-1')).toBeLessThan(0)
  })

  // `~` sorts before ANY character, not just before the empty string. Without
  // that, `1.0~1` and `1.0a1` compare on `~` vs `a` by ordinary character order
  // and `~` (0x7E) would sort after every letter -- the opposite of Debian's
  // rule.
  it('sorts a tilde before a letter, not after it', () => {
    expect(compareKernelVersions('1.0~1', '1.0a1')).toBeLessThan(0)
    expect(compareKernelVersions('1.0a1', '1.0~1')).toBeGreaterThan(0)
  })

  it('is zero for the same version', () => {
    expect(compareKernelVersions('6.8.0-136-generic', '6.8.0-136-generic')).toBe(0)
  })
})

describe('what it refuses to conclude', () => {
  // CONSTRUCTED. The measured host has no removed-but-configured kernel, so
  // there is no recording of a VERSION-BEARING name that is not installed. The
  // shape is dpkg's own -- `deinstall ok config-files` is what a purged package
  // leaves behind -- and the point is that the NAME alone cannot be trusted
  // here: `linux-image-6.8.0-140-generic` looks exactly like an installed one.
  it('does not count a purged kernel whose name still carries a version', () => {
    const out = [
      KERNEL_MARKERS.running,
      '6.8.0-136-generic',
      KERNEL_MARKERS.dpkg,
      'linux-image-6.8.0-136-generic 6.8.0-136.136 install ok installed',
      'linux-image-6.8.0-140-generic 6.8.0-140.140 deinstall ok config-files',
      KERNEL_MARKERS.dpkgArch,
      'amd64'
    ].join('\n')
    const s = parseKernelStatus(out)
    expect(s.installed).toEqual(['6.8.0-136-generic'])
    expect(kernelReport(s, false).verdict).toBe('current')
  })

  const sect = (m: string, body: string): string => `${m}\n${body}\n`

  // An RPM host runs every section and produces nothing. An empty installed
  // list read as "no kernels installed" would be a confident wrong answer.
  it('says unknown when neither package manager answered', () => {
    const s = parseKernelStatus(sect(KERNEL_MARKERS.running, '5.14.0-427.el9.x86_64'))
    expect(s.family).toBeNull()
    const r = kernelReport(s, null)
    expect(r.verdict).toBe('unknown')
    expect(r.detail).toContain('Neither dpkg nor rpm answered')
    expect(r.detail).toContain('unknown rather than absent')
  })

  // The section ran and the file was absent: that IS an answer.
  it('reads an absent marker file as no restart pending', () => {
    const out =
      sect(KERNEL_MARKERS.running, '6.8.0-138-generic') +
      sect(KERNEL_MARKERS.dpkg, 'linux-image-6.8.0-138-generic 6.8.0-138.138 install ok installed') +
      sect(KERNEL_MARKERS.dpkgArch, 'amd64')
    expect(kernelReport(parseKernelStatus(out), false).verdict).toBe('current')
  })

  // A newer kernel on disk with no marker is a real state: it is waiting, and
  // saying "reboot required" would claim something the package manager did not.
  it('separates a newer kernel waiting from a restart the manager demanded', () => {
    const out =
      sect(KERNEL_MARKERS.running, '6.8.0-136-generic') +
      sect(
        KERNEL_MARKERS.dpkg,
        'linux-image-6.8.0-136-generic 6.8.0-136.136 install ok installed\nlinux-image-6.8.0-138-generic 6.8.0-138.138 install ok installed'
      ) +
      sect(KERNEL_MARKERS.dpkgArch, 'amd64')
    const r = kernelReport(parseKernelStatus(out), false)
    expect(r.verdict).toBe('newer-installed')
    expect(r.detail).toContain('has not recorded a restart as required')
  })

  // MEASURED, in a debian:12 container. It HAS dpkg -- `dpkg --print-architecture`
  // answers `arm64` -- and zero kernel packages, because a container does not
  // own a kernel. `uname -r` there reports the DOCKER VM's kernel and /boot is
  // empty, so every input looks plausible and the only honest verdict is that
  // the question was not answered.
  it('says unknown on a dpkg host that has no kernel packages at all', () => {
    const s = parseKernelStatus(CONTAINER)
    expect(s.dpkg).toBe(true)
    expect(s.installed).toEqual([])
    expect(s.onBoot).toEqual([])
    // The kernel it reports belongs to the machine underneath it.
    expect(s.running).not.toBeNull()
    const r = kernelReport(s, null)
    expect(r.verdict).toBe('unknown')
    expect(r.detail).toContain('unknown rather than no')
  })

  it('says unknown when the running kernel could not be read', () => {
    expect(kernelReport(parseKernelStatus(''), null).verdict).toBe('unknown')
  })
})

describe('the command', () => {
  it('never escalates', () => {
    expect(buildKernelStatusCommand()).not.toContain('sudo')
  })

  // A host with no /boot/vmlinuz-*, no dpkg or no marker must still return the
  // sections that did answer.
  it('lets every section fail without taking the others with it', () => {
    const cmd = buildKernelStatusCommand()
    // One per section: running, /boot, dpkg-query, dpkg arch, rpm -q, rpm arch.
    expect(cmd.split('|| true').length - 1).toBe(Object.keys(KERNEL_MARKERS).length)
    for (const m of Object.values(KERNEL_MARKERS)) expect(cmd).toContain(m)
  })

  // Nothing may assume the meta package's name: the measured host's is
  // `linux-image-virtual`, and `linux-image-generic` was "no packages found".
  it('asks dpkg for a glob rather than a guessed meta package', () => {
    expect(buildKernelStatusCommand()).toContain("'linux-image-*'")
    expect(buildKernelStatusCommand()).not.toContain('linux-image-generic')
  })
})

describe('the wiring', () => {
  const read = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
  const code = (rel: string): string =>
    read(rel)
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')

  // Two readers of one fact is one of them drifting. `hostFacts` already reads
  // the restart marker on BOTH package families; this read must not.
  it('does not read the reboot marker a second time, on either family', () => {
    const k = code('../src/shared/kernelStatus.ts')
    // Debian's flag file and RHEL's needs-restarting are BOTH hostFacts'.
    expect(k).not.toContain('reboot-required')
    expect(k).not.toContain('needs-restarting')
  })

  it('is asked for per row rather than added to the hourly sweep', () => {
    const main = code('../src/main/index.ts')
    expect(main).toContain("ipcMain.handle('fleet:kernel'")
    const svc = code('../src/main/services/hostFacts.ts')
    // The same shape as `securityList`: a transport failure is not a host
    // answer, and must not become "no kernels installed".
    expect(svc).toContain('async kernel(')
    expect(svc).toContain("return { error: r.error ?? 'could not reach the server' }")
  })

  // The panel passes the flag hostFacts already collected, rather than the
  // read inventing one.
  it('hands the restart flag in from the row', () => {
    const panel = code('../src/renderer/src/components/monitor/PatchPanel.tsx')
    expect(panel).toContain('loadKernel(r.serverId, r.rebootRequired ?? null)')
    expect(panel).toContain('kernelReport(res, rebootRequired)')
  })

  // A failed read rendered as an ordinary note reads as an all-clear.
  it('renders a failed read as an alarm, not as a verdict', () => {
    const panel = code('../src/renderer/src/components/monitor/PatchPanel.tsx')
    expect(panel).toContain("kernel.error !== undefined ? (")
    expect(panel).toContain("<div className=\"s-note is-alarm\">{kernel.error}</div>")
  })
})
