import { describe, it, expect } from 'vitest'
import { platform } from 'node:process'
import { execFileSync } from 'node:child_process'
import {
  DARWIN_METRICS_CMD,
  darwinCpu,
  darwinDisk,
  darwinInodes,
  darwinLoad,
  darwinMemory,
  darwinNetwork,
  darwinUptime,
  parseDarwinMetrics
} from '../src/shared/localMetricsDarwin'
import {
  WINDOWS_PS_SCRIPT,
  WINDOWS_METRICS_CMD,
  encodePowerShell,
  parseWindowsMetrics
} from '../src/shared/localMetricsWindows'

/**
 * The macOS and Windows collectors.
 *
 * The local monitor refused to run off Linux because the procfs collector
 * produced, on a Mac, one honest set of nulls and one plausible wrong number:
 * `df` reports the whole APFS container as the total, so a volume at 40%
 * capacity read as 3.7% full, and `df -iP` printed the block columns again so
 * the inode figure was the disk figure wearing a different label.
 *
 * These fixtures are real output from a real machine. The wrong numbers are
 * pinned as much as the right ones — the disk case especially, because it is
 * the one that looked fine.
 */

// From `vm_stat` on a 36 GiB Mac.
const VMSTAT = [
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages free:                               31224.',
  'Pages active:                            482108.',
  'Pages inactive:                          492145.',
  'Pages speculative:                         6029.',
  'Pages throttled:                              0.',
  'Pages wired down:                        334000.',
  'Pages purgeable:                            156.',
  'File-backed pages:                       245232.',
  'Pages stored in compressor:             3471416.',
  'Pages occupied by compressor:            968539.'
]

describe('macOS: CPU', () => {
  it('takes the SECOND top sample, not the first', () => {
    // The first is cumulative since boot — on a box up for a week that is a
    // number about last Tuesday.
    const lines = [
      'CPU usage: 11.57% user, 12.14% sys, 76.27% idle',
      'CPU usage: 12.74% user, 11.76% sys, 75.49% idle'
    ]
    expect(darwinCpu(lines)).toBeCloseTo(24.51, 2)
  })

  it('is 100 minus idle, not user plus sys', () => {
    // user + sys does not account for everything top counts, and the
    // remainder would be silently dropped.
    expect(darwinCpu(['CPU usage: 10.00% user, 5.00% sys, 80.00% idle'])).toBeCloseTo(20, 5)
  })

  it('is null when top said nothing', () => {
    expect(darwinCpu([])).toBeNull()
    expect(darwinCpu(['something else entirely'])).toBeNull()
  })
})

describe('macOS: disk — the number that made this necessary', () => {
  const LINE = '/dev/disk3s3s1   482797652  18017788  27163300    40%    /'

  it('reports what df and Finder report, not used-over-container', () => {
    const d = darwinDisk(LINE)
    // 40% is what `df` itself prints in its Capacity column.
    expect(d.diskPct as number).toBeCloseTo(39.9, 1)
  })

  it('is emphatically not the old answer', () => {
    // used / total on APFS, which is what the procfs parser computed: 3.7%.
    const d = darwinDisk(LINE)
    expect(d.diskPct as number).toBeGreaterThan(30)
  })

  it('counts the total as what this volume can actually reach', () => {
    const d = darwinDisk(LINE)
    expect(d.diskTotal).toBe((18017788 + 27163300) * 1024)
  })

  it('is null on a line it cannot read', () => {
    expect(darwinDisk(undefined).diskPct).toBeNull()
    expect(darwinDisk('nonsense').diskPct).toBeNull()
  })
})

describe('macOS: inodes', () => {
  it('reads the columns -P was hiding', () => {
    // macOS df prints iused/ifree by default; `-P` suppresses them, which is
    // how "macOS ignores -i" became the accepted story.
    const line = '/dev/disk3s3s1   482797652  18017788  27145624    40%  426704 271456240    0%   /'
    expect(darwinInodes(line) as number).toBeCloseTo(0.157, 2)
  })

  it('is null rather than a guess when the row is not that shape', () => {
    expect(darwinInodes('/dev/disk3s3s1 482797652 18017788 27163300 40% /')).toBeNull()
    expect(darwinInodes(undefined)).toBeNull()
  })
})

describe('macOS: memory', () => {
  it('is Activity Monitor’s "Memory Used" — active + wired + compressed', () => {
    const m = darwinMemory(VMSTAT, 38654705664)
    expect(m.memUsed).toBe((482108 + 334000 + 968539) * 16384)
    expect(m.memPct as number).toBeCloseTo(75.6, 1)
  })

  it('does not count file-backed pages as a separate pool', () => {
    // They are already inside active and inactive. Adding them counts a large
    // slice of memory twice and reports the machine as emptier than it is.
    const m = darwinMemory(VMSTAT, 38654705664)
    expect(m.memUsed).not.toBe((482108 + 334000 + 968539 + 245232) * 16384)
    expect(m.memCache).toBeNull()
  })

  it('is null, never zero, when vm_stat did not run', () => {
    const m = darwinMemory([], null)
    expect(m.memPct).toBeNull()
    expect(m.memAvailable).toBeNull()
  })
})

describe('macOS: network', () => {
  it('counts each interface once, from its Link row', () => {
    // netstat -ib prints one row per interface PER ADDRESS FAMILY, every one
    // carrying the same cumulative counters. Summing them multiplies each
    // interface by however many addresses it has.
    const lines = [
      'Name  Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll',
      'en0   1500  <Link#5>      aa:bb:cc:dd:ee:ff   100     0       1000      200     0       2000     0',
      'en0   1500  192.168.1     192.168.1.5         100     -       1000      200     -       2000     -',
      'en0   1500  fe80::        fe80::1             100     -       1000      200     -       2000     -'
    ]
    expect(darwinNetwork(lines)).toEqual({ netRx: 1000, netTx: 2000 })
  })

  it('excludes loopback', () => {
    // This machine talking to itself makes an idle laptop look busy.
    const lines = [
      'lo0   16384 <Link#1>                        79540990 0 30408766245 79540990 0 30408766245 0',
      'en0   1500  <Link#5>      aa:bb:cc:dd:ee:ff      100 0        1000      200 0        2000 0'
    ]
    expect(darwinNetwork(lines)).toEqual({ netRx: 1000, netTx: 2000 })
  })
})

describe('macOS: load', () => {
  it('takes the one-minute figure out of sysctl’s braces', () => {
    expect(darwinLoad(['{ 3.95 6.26 6.86 }'])).toBeCloseTo(3.95, 5)
  })

  it('is null when sysctl said nothing', () => {
    // Zero would be a claim about an idle machine.
    expect(darwinLoad([])).toBeNull()
  })
})

describe('macOS: uptime', () => {
  it('is measured from kern.boottime', () => {
    const line = '{ sec = 1788485225, usec = 31219 } Fri Sep  4 05:27:05 2026'
    expect(darwinUptime([line], 1788485225_000 + 3600_000)).toBe(3600)
  })

  it('is zero rather than negative when it cannot be read', () => {
    expect(darwinUptime([], Date.now())).toBe(0)
  })
})

describe('macOS: what the platform has no answer for', () => {
  it('reports no per-core split and no systemd units', () => {
    // `top` reports the machine, and launchd is not systemd. An empty unit
    // list would say this Mac has no failed services, which is a claim.
    const m = parseDarwinMetrics('')
    expect(m.cpuCores).toBeNull()
    expect(m.services).toBeNull()
  })
})

describe('macOS: on this machine', () => {
  it.runIf(platform === 'darwin')('agrees with df about the disk', () => {
    const out = execFileSync('sh', ['-c', DARWIN_METRICS_CMD], {
      encoding: 'utf8',
      maxBuffer: 8e6
    })
    const m = parseDarwinMetrics(out)
    const df = execFileSync('sh', ['-c', "df -kP / | tail -1 | awk '{print $5}'"], {
      encoding: 'utf8'
    })
    const capacity = Number(df.replace('%', '').trim())
    // Within a point of what df itself prints, which is the number a person
    // would check this against.
    expect(Math.abs((m.diskPct as number) - capacity)).toBeLessThan(1.5)
    expect(m.cores).toBeGreaterThan(0)
    expect(m.load1).not.toBeNull()
    expect(m.uptime).toBeGreaterThan(0)
  })
})

describe('Windows', () => {
  it('encodes the script the way -EncodedCommand expects', () => {
    // UTF-16LE base64. The script travels through two shells with different
    // quoting rules; this alphabet cannot be misread by either.
    const round = Buffer.from(encodePowerShell('echo hi'), 'base64').toString('utf16le')
    expect(round).toBe('echo hi')
    expect(WINDOWS_METRICS_CMD).toMatch(/^powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/)
  })

  it('reads the RAW counter, which is cumulative bytes', () => {
    // Its name says PerSec because it is the input a rate is computed FROM.
    // Reading it as a rate would report a busy link as a machine that had
    // moved a few kilobytes since it booted.
    expect(WINDOWS_PS_SCRIPT).toMatch(/Win32_PerfRawData_Tcpip_NetworkInterface/)
    expect(WINDOWS_PS_SCRIPT).not.toMatch(/Get-NetAdapterStatistics/)
  })

  it('excludes loopback and the tunnel pseudo-adapters', () => {
    expect(WINDOWS_PS_SCRIPT).toMatch(/Loopback\|isatap\|Teredo/)
  })

  it('parses a real-shaped reply', () => {
    const json = JSON.stringify({
      cpu: 17,
      memTotalKb: 33554432,
      memFreeKb: 8388608,
      diskTotal: 512110190592,
      diskFree: 204844076236,
      netRx: 91234567890,
      netTx: 12345678901,
      bootIso: '2026-09-04T05:27:05.0000000+00:00',
      hostname: 'DESKTOP-ABC',
      kernel: 'Microsoft Windows 11 Pro 10.0.26100',
      cores: 16
    })
    const m = parseWindowsMetrics(json, Date.parse('2026-09-04T06:27:05Z'))
    expect(m.cpu).toBe(17)
    expect(m.cores).toBe(16)
    expect(m.memPct as number).toBeCloseTo(75, 5)
    expect(m.diskPct as number).toBeCloseTo(60, 0)
    expect(m.uptime).toBe(3600)
    expect(m.hostname).toBe('DESKTOP-ABC')
  })

  it('reports null for what Windows does not have', () => {
    const m = parseWindowsMetrics('{"cores":8,"memTotalKb":100,"memFreeKb":50}')
    // No load average and no inode exhaustion. Null, never zero: zero is a
    // specific claim about an idle or empty machine.
    expect(m.load1).toBeNull()
    expect(m.inodePct).toBeNull()
    expect(m.cpuCores).toBeNull()
  })

  it('survives output that is not the object', () => {
    // PowerShell writes errors into the same stream when a caller is careless.
    expect(parseWindowsMetrics('').cores).toBe(0)
    expect(parseWindowsMetrics('some error text').cores).toBe(0)
    expect(parseWindowsMetrics('WARNING: x\n{"cores":4}').cores).toBe(4)
  })
})
