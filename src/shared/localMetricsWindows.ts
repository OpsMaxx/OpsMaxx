import type { HostMetrics } from './ssh'

/**
 * The metrics collector for Windows.
 *
 * ── How it is run ──────────────────────────────────────────────────────────
 *
 * Every local read on Windows already goes through a POSIX shell — Git for
 * Windows or MSYS2 — because the shared collectors are written for the shell
 * `ssh host 'command'` lands in, and localExec refuses with a clear message
 * when there is none. This collector keeps that arrangement rather than
 * inventing a second exec path: sh runs `powershell.exe`, PowerShell answers.
 *
 * ── Why it emits JSON, and why the script is base64 ────────────────────────
 *
 * Text tables from PowerShell are localised, column-aligned and version
 * dependent; `ConvertTo-Json` is none of those. And the script travels through
 * two shells with different quoting rules, so it goes as `-EncodedCommand`:
 * UTF-16LE base64, whose alphabet cannot be misread by either. The readable
 * source is exported beside it so this file can still be read and tested as a
 * script rather than as a blob.
 *
 * ── What Windows does not have ─────────────────────────────────────────────
 *
 * No load average and no inodes. Both are null rather than approximated —
 * there is no Windows quantity that means what they mean, and the whole reason
 * this module exists is that a plausible wrong number is worse than an absent
 * one.
 */

/**
 * `Win32_PerfRawData` and not `Get-NetAdapterStatistics`.
 *
 * The RAW counter is cumulative bytes since boot, which is what `netRx`/`netTx`
 * mean everywhere else in this app. Its name says "PerSec" because it is the
 * input a rate is computed from, not because it is already one — reading it as
 * a rate is the classic mistake with this class, and it would report a busy
 * link as a machine that had transferred a few kilobytes since it booted.
 *
 * Loopback and the tunnel pseudo-adapters are excluded for the reason the
 * Linux collector excludes `lo`: traffic a machine sends to itself makes an
 * idle box look busy.
 */
export const WINDOWS_PS_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  '$os = Get-CimInstance Win32_OperatingSystem',
  '$cs = Get-CimInstance Win32_ComputerSystem',
  '$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average',
  '$sys = $env:SystemDrive',
  '$ld = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID=\'$sys\'" | Select-Object -First 1',
  '$net = Get-CimInstance Win32_PerfRawData_Tcpip_NetworkInterface | Where-Object { $_.Name -notmatch \'Loopback|isatap|Teredo|Pseudo\' }',
  '$rx = ($net | Measure-Object -Property BytesReceivedPersec -Sum).Sum',
  '$tx = ($net | Measure-Object -Property BytesSentPersec -Sum).Sum',
  '[pscustomobject]@{',
  '  cpu = $cpu',
  '  memTotalKb = $os.TotalVisibleMemorySize',
  '  memFreeKb = $os.FreePhysicalMemory',
  '  diskTotal = $ld.Size',
  '  diskFree = $ld.FreeSpace',
  '  netRx = $rx',
  '  netTx = $tx',
  '  bootIso = $(if ($os.LastBootUpTime) { $os.LastBootUpTime.ToString(\'o\') } else { $null })',
  '  hostname = $env:COMPUTERNAME',
  '  kernel = "$($os.Caption) $($os.Version)"',
  '  cores = $cs.NumberOfLogicalProcessors',
  '} | ConvertTo-Json -Compress'
].join('\n')

/** UTF-16LE base64, which is what `-EncodedCommand` expects. */
export function encodePowerShell(script: string): string {
  const utf16 = Buffer.from(script, 'utf16le')
  return utf16.toString('base64')
}

export const WINDOWS_METRICS_CMD = `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(
  WINDOWS_PS_SCRIPT
)}`

interface WindowsRaw {
  cpu?: number | null
  memTotalKb?: number | null
  memFreeKb?: number | null
  diskTotal?: number | null
  diskFree?: number | null
  netRx?: number | null
  netTx?: number | null
  bootIso?: string | null
  hostname?: string | null
  kernel?: string | null
  cores?: number | null
}

const finite = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

/**
 * The JSON object, or null when nothing usable came back.
 *
 * PowerShell writes errors to the same stream when a caller is not careful, so
 * the object is located rather than assumed to be the whole of stdout.
 */
export function parseWindowsRaw(text: string): WindowsRaw | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1))
    return value !== null && typeof value === 'object' ? (value as WindowsRaw) : null
  } catch {
    return null
  }
}

export function parseWindowsMetrics(text: string, now: number = Date.now()): HostMetrics {
  const r = parseWindowsRaw(text)
  const memTotalKb = finite(r?.memTotalKb)
  const memFreeKb = finite(r?.memFreeKb)
  const memTotal = memTotalKb === null ? 0 : memTotalKb * 1024
  const memAvailable = memFreeKb === null ? null : memFreeKb * 1024
  const memUsed = memTotal > 0 && memAvailable !== null ? Math.max(0, memTotal - memAvailable) : 0

  const diskTotal = finite(r?.diskTotal)
  const diskFree = finite(r?.diskFree)
  const diskUsed = diskTotal !== null && diskFree !== null ? Math.max(0, diskTotal - diskFree) : 0

  const boot = r?.bootIso ? Date.parse(r.bootIso) : NaN

  return {
    // `LoadPercentage` is a whole number already scaled 0-100. Absent — which
    // is what a CIM query answers on a machine that refused it — is null, not
    // an idle processor.
    cpu: finite(r?.cpu),
    // `LoadPercentage` is per SOCKET, not per core, so there is nothing here
    // that answers "is one core pinned".
    cpuCores: null,
    memPct: memTotal > 0 && memAvailable !== null ? (memUsed / memTotal) * 100 : null,
    memUsed,
    memTotal,
    memAvailable,
    memFree: memAvailable,
    // Windows does not publish a reclaimable-cache figure that means what
    // Linux's does.
    memCache: null,
    diskPct:
      diskTotal !== null && diskTotal > 0 && diskFree !== null
        ? (diskUsed / diskTotal) * 100
        : null,
    diskUsed,
    diskTotal: diskTotal ?? 0,
    // NTFS has an MFT rather than a fixed inode table, and nothing reports a
    // comparable exhaustion figure.
    inodePct: null,
    mounts: [],
    // No load average on Windows. Null, never zero: zero is a specific claim
    // about an idle machine.
    load1: null,
    netRx: finite(r?.netRx) ?? 0,
    netTx: finite(r?.netTx) ?? 0,
    uptime: Number.isFinite(boot) ? Math.max(0, Math.floor((now - boot) / 1000)) : 0,
    hostname: typeof r?.hostname === 'string' ? r.hostname : '',
    kernel: typeof r?.kernel === 'string' ? r.kernel.trim() : '',
    cores: finite(r?.cores) ?? 0,
    // Windows services are not systemd units and the panel's failed-unit list
    // means something specific. An empty list would read as "nothing failed".
    services: null,
    listeners: null,
    listenerSource: null
  }
}
