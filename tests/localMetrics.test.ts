import { describe, it, expect } from 'vitest'
import { platform } from 'node:process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { localMetricsSample } from '../src/main/services/localMetrics'
import { METRICS_CMD, METRICS_CMD_FIRST, parseMetrics } from '../src/main/services/metrics'

/**
 * Live metrics for this machine.
 *
 * The collector is the SSH one, unchanged — same script, same parser. What is
 * new is only where it runs, and the one decision worth pinning is that it
 * refuses to run where its assumptions do not hold.
 */

describe('the platform gate', () => {
  it.runIf(platform !== 'linux')('refuses rather than reporting wrong numbers', async () => {
    const r = await localMetricsSample('test-key')
    expect(r.ok).toBe(false)
    if (r.ok) return
    // Names the reason, because "unavailable" alone reads as a bug.
    expect(r.error).toMatch(/\/proc/)
    expect(r.error).toMatch(/look right and are not/)
  })

  it.runIf(platform === 'linux')('collects on the platform it was written for', async () => {
    const r = await localMetricsSample('test-key-linux')
    expect(r.ok).toBe(true)
  })
})

describe('what the local sampler runs', () => {
  it('uses the same script and parser as the SSH path', () => {
    const src = readFileSync(join(__dirname, '..', 'src/main/services/localMetrics.ts'), 'utf8')
    // A second collector would be a second thing that can disagree with the
    // parser, and the parser is where every "absent is null, not zero" rule is.
    expect(src).toMatch(/METRICS_CMD_FIRST/)
    expect(src).toMatch(/parseMetrics\(/)
    expect(src).not.toMatch(/\/proc\/stat/)
  })

  /**
   * The branch lives in main's IPC handler, never inside metrics.ts.
   * services/mcpServer.ts imports metricsSample, so a branch there would pull
   * localExec into the agent-facing import closure — see
   * tests/localTerminalNotExposed.test.ts, which is what actually enforces it.
   */
  it('keeps the local branch out of metrics.ts', () => {
    const metrics = readFileSync(join(__dirname, '..', 'src/main/services/metrics.ts'), 'utf8')
    expect(metrics).not.toMatch(/localExec|isLocalTarget|localMetrics/)
  })
})

describe('the parser, on output the collector actually produces', () => {
  // Captured from a Linux host, with addresses and names replaced. The numbers
  // are what matter: this is the arithmetic that reported a macOS volume at
  // 61% capacity as 3.7% full, because APFS calls the whole container the
  // total. On Linux df's columns mean what the parser assumes.
  const LINUX = [
    '__CPU__',
    'cpu  100 0 100 800 0 0 0 0 0 0',
    'cpu  200 0 200 1600 0 0 0 0 0 0',
    '__MEM__',
    'MemTotal:       12247944 kB',
    'MemAvailable:    9041232 kB',
    '__DISK__',
    '/dev/sda1 202051056 30616192 171418480 16% /',
    '__INODE__',
    '/dev/sda1 26083328 364835 25718493 2% /',
    '__LOAD__',
    '0.33 0.58 0.58 1/1234 5678'
  ].join('\n')

  it('reports the percentage df itself reports', () => {
    const { data } = parseMetrics(LINUX, null)
    // df's Capacity column, read rather than recomputed — so this figure and
    // `df -h` on the same host cannot drift apart. It used to be derived as
    // used/total, which under-reports every filesystem with reserved blocks.
    expect(data.diskPct).toBe(16)
    // Inodes are their own figure and must not echo the disk one.
    expect(data.inodePct).toBeCloseTo(1.4, 1)
    expect(data.inodePct).not.toBe(data.diskPct)
  })

  it('reads memory as total minus available', () => {
    const { data } = parseMetrics(LINUX, null)
    expect(data.memPct).toBeCloseTo(26.2, 1)
  })

  it('takes load from the first column', () => {
    expect(parseMetrics(LINUX, null).data.load1).toBe(0.33)
  })

  /**
   * The rule the whole module is built around, and the reason the platform
   * gate exists rather than a best-effort read.
   *
   * diskPct is in this list now. It used to parse to 0 with `diskTotal: 0` as
   * the "was this measured" signal, read through a `diskTotal > 0` guard. That
   * worked where it was applied — the two alert paths checked it — but the
   * fleet sampler stored the 0 as a capacity-trend point, the MCP bridge
   * reported "Disk: 0.0%" to an agent, and two panels printed it. 0% is the
   * most reassuring number this field can hold, so it is the worst default.
   */
  it('emits null, not zero, for a section that is not there', () => {
    const { data } = parseMetrics('__CPU__\n__MEM__\n__DISK__\n', null)
    expect(data.cpu).toBeNull()
    expect(data.memPct).toBeNull()
    expect(data.diskPct).toBeNull()
    expect(data.inodePct).toBeNull()
    expect(data.load1).toBeNull()
  })

  it('still reports a real disk reading as a number', () => {
    const { data } = parseMetrics(LINUX, null)
    expect(typeof data.diskPct).toBe('number')
  })
})

describe('the script itself', () => {
  it('asks for a sleep only on the first sample', () => {
    expect(METRICS_CMD_FIRST).toMatch(/sleep/)
    // Every later poll diffs against the one before it, which is free and a
    // more representative window.
    expect(METRICS_CMD).not.toMatch(/sleep/)
  })
})
