import { platform } from 'node:process'
import type { MetricsResult } from '../../shared/ssh'
import { localExec } from './localExec'
import { METRICS_CMD, METRICS_CMD_FIRST, parseMetrics, type CpuSnap } from './metrics'

/**
 * The metrics collector, pointed at this machine.
 *
 * Separate from metrics.ts rather than a branch inside it, and that is not a
 * style choice: `metricsSample` is imported by services/mcpServer.ts, so a
 * local branch in that module would pull localExec into the agent-facing
 * import closure and fail tests/localTerminalNotExposed.test.ts. The dispatch
 * lives in main's renderer-facing handler, and this module is only ever
 * reached from there.
 *
 * It runs the SAME script and the SAME parser as the SSH path. A second
 * collector for this machine would be a second thing that can disagree with
 * the parser, and the parser is where every "an absent section is null, not a
 * comfortable zero" rule lives.
 *
 * ── Linux only, and refused elsewhere ───────────────────────────────────────
 *
 * The obvious expectation is that the missing pieces come back absent off
 * Linux and the rest still answers. They do not, and it was measured rather
 * than assumed:
 *
 *   - CPU, memory, load and network read /proc, which macOS does not have.
 *     Those genuinely come back null, which is fine.
 *   - Disk does NOT. `df -kP /` is POSIX and runs, but the parser divides
 *     used by total, and APFS reports the whole container as the total — so
 *     a volume at 61% capacity was reported as 3.7% full. A plausible wrong
 *     number, not an absence.
 *   - Inodes are worse. macOS `df -iP` ignores `-i` altogether and prints the
 *     block columns again, so the inode figure was the disk figure wearing a
 *     different label.
 *
 * Two numbers that look right and are not is the failure this whole module
 * refuses elsewhere — `parse` goes out of its way to emit null rather than a
 * comfortable zero. So the platform is checked once, here, and a machine the
 * collector was not written for is told so instead of being measured wrongly.
 *
 * Writing a macOS collector is the real fix and a separate piece of work:
 * `top -l`, `vm_stat` and `sysctl` do not mean the same things as the procfs
 * counters these parsers were built against, and each needs its own parser
 * and its own tests.
 */

/** CPU is a delta between polls, so the previous snapshot has to survive. */
const cpuState = new Map<string, CpuSnap>()

/**
 * Collapses concurrent polls, as the SSH path does.
 *
 * Not for the same reason — there is no connection to spare here — but for the
 * CPU delta: two overlapping samples would both diff against the same previous
 * snapshot and the second would report a window that never happened.
 */
const inflight = new Map<string, Promise<MetricsResult>>()

export function localMetricsSample(key: string): Promise<MetricsResult> {
  if (platform !== 'linux') {
    return Promise.resolve({
      ok: false,
      error:
        `Live metrics are collected from /proc and from Linux \`df\` output, which ${platform === 'darwin' ? 'macOS' : 'this platform'} does not provide. ` +
        'Reading them here would report numbers that look right and are not.'
    })
  }
  const running = inflight.get(key)
  if (running) return running
  const p = run(key).finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

async function run(key: string): Promise<MetricsResult> {
  const prev = cpuState.get(key) ?? null
  // The first poll has nothing to diff against, so it pays for an in-command
  // sleep; every later one diffs against the poll before it, which is both
  // free and a more representative average.
  const r = await localExec(prev ? METRICS_CMD : METRICS_CMD_FIRST, 20_000)
  if (!r.ok && !r.stdout) {
    return { ok: false, error: r.error ?? r.stderr.split('\n')[0] ?? 'the collector did not run' }
  }
  // A non-zero exit is expected and not a failure: the script runs a dozen
  // reads and the last one decides the status, so a machine without `ss` exits
  // non-zero having answered everything else. The parser reports each absent
  // section on its own.
  const { data, snap } = parseMetrics(`${r.stdout}${r.stderr}`, prev)
  if (snap) cpuState.set(key, snap)
  return { ok: true, data }
}

export function localMetricsForget(key: string): void {
  cpuState.delete(key)
  inflight.delete(key)
}
