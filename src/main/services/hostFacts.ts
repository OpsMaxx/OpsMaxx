import type { HostFacts, HostFactsCollectOptions, PackageManager } from '../../shared/hostFacts'
import {
  buildInstalledPackagesCommand,
  parseInstalledPackages,
  type InstalledPackagesRead
} from '../../shared/installedPackages'
import {
  buildTimerDetailCommand,
  parseTimerDetail
} from '../../shared/systemdTimers'
import {
  buildStorageLayoutCommand,
  parseStorageLayout,
  type StorageLayout
} from '../../shared/storageLayout'
import {
  buildKernelStatusCommand,
  parseKernelStatus,
  type KernelStatus
} from '../../shared/kernelStatus'
import {
  buildSecurityListCommand,
  parseSecurityListOutput,
  type SecurityListProbe
} from '../../shared/securityUpdates'
import { FACTS_STATUS_MARKER, buildHostFactsCommand, parseHostFacts } from '../../shared/hostFacts'

// Reading host facts over SSH — roadmap item C, main-process half.
//
// Thin on purpose, the same way DockerReader is thin: the command building, the
// parsing and every allow-list live in shared/hostFacts.ts where they can be
// tested without an SSH connection. What lives here is the round trip and the
// failure classification.
//
// TWO THINGS THIS DOES NOT DO, both deliberate:
//
//  * It does not use metrics.ts's `exec`. That helper resolves on `close` and
//    DISCARDS the exit code, and exit status is the API for three of the probes
//    inside the collector — dnf signals updates with 100, zypper reboot-needed
//    with 102, and `needs-restarting -r` says "reboot owed" with 1. Those codes
//    are consumed inside the shell script, but the script's own status still
//    has to be visible here to tell "the shell ran and answered" from "the
//    shell never ran". sshExec returns `{ok, stdout, stderr, code}`; this uses
//    that.
//
//  * It never sends a second command built from the first one's output. The
//    package manager is detected on the host, inside the one script. Round-
//    tripping a value the host chose and interpolating it into a command is the
//    shape of the injection this app has already had once.
//
// THE THREE-WAY FAILURE CLASSIFICATION, copied from docker.ts because the
// lesson transfers: "could not reach the host", "the host answered but not with
// our output" and "the host answered and some probes could not see anything"
// have three different fixes, and collapsing them sends someone to the wrong
// machine. The third is not a failure at all here — it is a successful
// collection whose FactSourceReports say what was not visible, which is the
// whole point of the item.

/**
 * The exec shape this reader needs. Structural rather than an import of
 * sshExec, so tests can hand over a function and never open a connection —
 * the same reason FleetSamplerDeps takes its sampler by injection.
 */
export type HostFactsExec = (
  cfg: unknown,
  command: string,
  timeoutMs: number
) => Promise<{ ok: boolean; code?: number | null; stdout?: string; stderr?: string; error?: string }>

export interface HostFactsDeps {
  exec: HostFactsExec
  /** Injectable so a test can pin the clock that decides `stale-metadata`. */
  now?: () => number
}

export type HostFactsFailure =
  /** The transport failed: unreachable, refused, timed out, no credentials.
   *  Nothing was learned about the host and nothing should be inferred. */
  | 'unreachable'
  /** The command ran and its status block never arrived. A shell that is not
   *  POSIX, output truncated by the transport cap, or a host that closed the
   *  channel mid-write. Distinct from `unreachable` because the machine is
   *  fine and the fix is on this side. */
  | 'no-output'
  | 'unknown'

export type HostFactsProbe =
  | { ok: true; facts: HostFacts }
  | { ok: false; reason: HostFactsFailure; detail: string }

/**
 * How long the collector is given.
 *
 * Generous compared with a metrics sample, because `dnf -C check-update` walks
 * the whole cached repository set and takes seconds on a host with a dozen
 * repositories — and this runs hourly, not every two minutes, so a slow answer
 * costs almost nothing. Short enough that a wedged package manager cannot hold
 * an exec channel open on the connection a terminal may be typing over.
 */
export const HOST_FACTS_TIMEOUT_MS = 45_000

export class HostFactsReader {
  constructor(private readonly deps: HostFactsDeps) {}

  /**
   * The security-update LIST -- item 46's row, on demand rather than sampled.
   *
   * Deliberately not folded into the hourly collector. The counts belong there;
   * the list is tens of rows per host that nobody is looking at most of the
   * time, and paying for it on every host every hour to have it read once a
   * month is the wrong trade.
   *
   * Same timeout as the collector, and for the same reason: `dnf -C` walks the
   * cached repository set and takes seconds on a host with a dozen repos.
   */
  async securityList(cfg: unknown): Promise<SecurityListProbe> {
    try {
      const r = await this.deps.exec(cfg, buildSecurityListCommand(), HOST_FACTS_TIMEOUT_MS)
      // A transport failure is not a host answer. "No security updates" for a
      // connection that never opened is the fabrication this file exists to
      // avoid.
      if (!r.ok) return { ok: false, detail: r.error ?? 'could not reach the server' }
      const merged = (r.stderr ?? '') === '' ? (r.stdout ?? '') : `${r.stdout ?? ''}\n${r.stderr}`
      return parseSecurityListOutput(merged)
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
  }

  /**
   * Which kernel is running against which are installed.
   *
   * ASKED FOR RATHER THAN SAMPLED, like `securityList` above and for the same
   * reason: it answers a question somebody is looking at a row and asking, and
   * the hourly sweep already carries the restart flag that says whether it
   * matters. `rebootRequired` is passed back in by the caller from the facts it
   * already has -- this does not read that file a second time.
   */
  async kernel(cfg: unknown): Promise<KernelStatus | { error: string }> {
    try {
      const r = await this.deps.exec(cfg, buildKernelStatusCommand(), HOST_FACTS_TIMEOUT_MS)
      // A transport failure is not a host answer, and "no kernels installed"
      // for a connection that never opened is the fabrication this file exists
      // to avoid.
      if (!r.ok) return { error: r.error ?? 'could not reach the server' }
      const merged = (r.stderr ?? '') === '' ? (r.stdout ?? '') : `${r.stdout ?? ''}\n${r.stderr}`
      return parseKernelStatus(merged)
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }

  /**
   * Disks, filesystems, LVM and software RAID.
   *
   * Asked for rather than sampled, like `kernel` and `securityList`: a
   * partition table does not change between hourly sweeps, and this is the read
   * behind a row somebody has clicked.
   */
  async storage(cfg: unknown): Promise<StorageLayout | { error: string }> {
    try {
      const r = await this.deps.exec(cfg, buildStorageLayoutCommand(), HOST_FACTS_TIMEOUT_MS)
      // A transport failure is not a host answer. "No filesystems" for a
      // connection that never opened is the fabrication this file exists to
      // avoid.
      if (!r.ok) return { error: r.error ?? 'could not reach the server' }
      const merged = (r.stderr ?? '') === '' ? (r.stdout ?? '') : `${r.stdout ?? ''}\n${r.stderr}`
      return parseStorageLayout(merged)
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }

  /**
   * One timer, and the service it activates.
   *
   * BOTH, because a timer can fire perfectly every day into a service that
   * fails every time -- which the test host had two live examples of. Reading
   * only the timer answers "is it scheduled" when the question is "is it
   * working".
   */
  async timer(
    cfg: unknown,
    timerUnit: string,
    serviceUnit: string
  ): Promise<{ timer: Record<string, string>; service: Record<string, string> } | { error: string }> {
    let command: string
    try {
      command = buildTimerDetailCommand(timerUnit, serviceUnit)
    } catch {
      // The names are interpolated into a shell command, so a name that is not
      // one is refused here rather than escaped.
      return { error: 'that is not a systemd unit name' }
    }
    try {
      const r = await this.deps.exec(cfg, command, HOST_FACTS_TIMEOUT_MS)
      if (!r.ok) return { error: r.error ?? 'could not reach the server' }
      const merged = (r.stderr ?? '') === '' ? (r.stdout ?? '') : `${r.stdout ?? ''}\n${r.stderr}`
      return parseTimerDetail(merged)
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }

  /**
   * Every package this host has installed.
   *
   * Takes the MANAGER rather than probing for one: `read()` above already
   * establishes it, runs on the same clock, and a second detection here is a
   * second thing to keep in step.
   */
  async packages(cfg: unknown, manager: PackageManager | null): Promise<InstalledPackagesRead> {
    const command = buildInstalledPackagesCommand(manager)
    // No manager, or one this build has no query for. Not an empty inventory.
    if (command === null) {
      return { ok: false, detail: 'this host has no package manager this build can query' }
    }
    try {
      const r = await this.deps.exec(cfg, command, HOST_FACTS_TIMEOUT_MS)
      if (!r.ok) return { ok: false, detail: r.error ?? 'could not reach the server' }
      const merged = (r.stderr ?? '') === '' ? (r.stdout ?? '') : `${r.stdout ?? ''}\n${r.stderr}`
      return parseInstalledPackages(merged)
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
  }

  async read(cfg: unknown, opts: HostFactsCollectOptions = {}): Promise<HostFactsProbe> {
    const command = buildHostFactsCommand(opts)
    try {
      const r = await this.deps.exec(cfg, command, HOST_FACTS_TIMEOUT_MS)
      if (!r.ok) {
        // A transport failure is not a host failure. Saying "this host has no
        // package manager" when the SSH connection never opened would put a
        // fabricated inventory row in front of an operator.
        return { ok: false, reason: 'unreachable', detail: r.error ?? 'could not reach the server' }
      }
      // stderr is NOT merged into stdout here, unlike the Docker reader.
      //
      // Every probe in the collector redirects its own stderr to /dev/null, so
      // anything on stderr came from the shell or the transport and is not part
      // of the answer. Merging it would splice unclassified text into the value
      // region, where a `V `-prefixed line from a noisy shell profile would be
      // read as a fact.
      const stdout = r.stdout ?? ''
      const facts = parseHostFacts(stdout, (this.deps.now ?? Date.now)())
      // Neither the status block nor a single value line means the script never
      // ran — a non-POSIX shell, or output cut before anything was written.
      // Reported as its own failure rather than as a host with nine unknowns,
      // which would look like a real collection from a very unhelpful machine.
      if (!stdout.includes(FACTS_STATUS_MARKER) && !/^V /m.test(stdout)) {
        const detail = (r.stderr ?? '').trim().slice(0, 200) || 'the server returned no collector output'
        return { ok: false, reason: 'no-output', detail }
      }
      return { ok: true, facts }
    } catch (e) {
      return { ok: false, reason: 'unknown', detail: e instanceof Error ? e.message : String(e) }
    }
  }
}
