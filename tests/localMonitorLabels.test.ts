import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseWindowsMetrics } from '../src/shared/localMetricsWindows'

const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const PANEL = read('../src/renderer/src/components/panel/WorkspacePanel.tsx')
const VIEW = read('../src/renderer/src/components/panel/MonitorView.tsx')

/**
 * Two labels that were right on Linux by accident.
 *
 * Found the first time this ran on real Windows hardware: the Monitor tab of a
 * local shell said "OS: linux" directly above a kernel line reading "Microsoft
 * Windows 11 Pro", and labelled the disk figures "Used disk (/)" on a machine
 * that has no `/`.
 *
 * The numbers were right in both cases. The collector reads $env:SystemDrive
 * and always did; what was wrong was the app telling the user which machine and
 * which volume it had measured.
 */

describe('the local machine’s OS', () => {
  it('is read rather than assumed', () => {
    expect(PANEL).not.toMatch(/os: 'linux'/)
    expect(PANEL).toMatch(/os: localPlatformName\(\)/)
  })

  it('recognises all three platforms', () => {
    expect(PANEL).toMatch(/\/Windows\/i\.test\(ua\)/)
    expect(PANEL).toMatch(/\/Mac OS X\|Macintosh\/i\.test\(ua\)/)
    expect(PANEL).toMatch(/\/Linux\|X11\/i\.test\(ua\)/)
  })

  it('falls through to a name rather than to a wrong OS', () => {
    // An unrecognised user agent must not become "linux" again.
    expect(PANEL).toMatch(/return 'this machine'/)
  })
})

describe('which volume the disk figures are for', () => {
  it('comes from the collector, not from the view', () => {
    expect(VIEW).toMatch(/Used disk \(\$\{m\.host\.diskRoot \?\? '\/'\}\)/)
  })

  it('is the system drive on Windows', () => {
    const sample = parseWindowsMetrics(
      JSON.stringify({
        cpu: 5,
        memTotalKb: 1024,
        memFreeKb: 512,
        diskRoot: 'D:',
        diskTotal: 1000,
        diskFree: 400,
        netRx: 1,
        netTx: 2
      })
    )
    expect(sample?.diskRoot).toBe('D:')
  })

  it('falls back to C: rather than to a POSIX root', () => {
    const sample = parseWindowsMetrics(
      JSON.stringify({ cpu: 1, memTotalKb: 10, memFreeKb: 5, diskTotal: 10, diskFree: 5 })
    )
    expect(sample?.diskRoot).toBe('C:')
  })

  it('still reports no inodes and no load average', () => {
    // Windows has neither, and a zero would be a specific claim about an idle
    // machine rather than an absent measurement.
    const sample = parseWindowsMetrics(
      JSON.stringify({ cpu: 1, memTotalKb: 10, memFreeKb: 5, diskTotal: 10, diskFree: 5 })
    )
    expect(sample?.inodePct).toBeNull()
    expect(sample?.load1).toBeNull()
  })
})
