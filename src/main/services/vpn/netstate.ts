import { execFile } from 'node:child_process'
import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { networkInterfaces, uptime } from 'node:os'
import { join } from 'node:path'
import { VpnError } from './errors'
import { runIdSegment, vpnRunRoot } from './runDir'
import type { DnsSnapshot, DnsSpec } from './dns/index'
import type { RouteSnapshot, RouteSpec } from './routing/index'

// System mode changes state that lives in the kernel and in system daemons,
// not in this process. That state outlives us: a `kill -9` leaves the routes
// and the resolver exactly as they were, and nothing on the machine knows they
// were ours. This module is the record that makes them ours — a JSON snapshot
// written into the run directory *before* the first change, and a startup pass
// that reverts every snapshot no live run still claims (E09, E10, E14).
//
// Ordering is the whole point. Write-then-apply means a crash in the gap
// leaves a snapshot describing changes that were never made, and reverting
// those is a no-op. Apply-then-write means a crash in the gap leaves changes
// nobody recorded, and those are permanent.

const FILE_MODE = 0o600
const DIR_MODE = 0o700
export const NETSTATE_FILE = 'netstate.json'

// `uptime()` has second granularity and the two readings are taken minutes or
// days apart, so the boot instant derived from them wobbles. Anything inside
// this window is the same boot.
const BOOT_TOLERANCE_MS = 30_000

export interface PrivilegedResult {
  code: number
  /** Both are absent — not empty — when the channel cannot see that stream at
   *  all, and which of the two happens is PER PLATFORM rather than universal.
   *  The distinction is load-bearing either way: an empty string reads as "it
   *  said nothing", which is a different fact from "we could not hear it", and
   *  `firstOutputLine` is what turns the second case into a message (the command
   *  and its exit status) instead of a sentence that stops at its colon.
   *
   *  `stdout` is absent on EVERY route. No elevator populates it — see
   *  `elevatedNetContext` in drivers/wireguard.ts, which returns code and stderr
   *  and nothing else. These commands put their complaints on stderr and nothing
   *  here wants their output, so this is "never captured", not "not capturable". */
  stdout?: string
  /** `stderr` arrives on Linux and macOS, and only Windows is left out.
   *
   *  Linux: pkexec and sudo FORK the command, so its pipes are ours and the text
   *  is the command's own — verified, and the routing manager classifies on it.
   *
   *  macOS: `do shell script` raises an AppleScript error carrying the exit
   *  status and a message, and that reaches osascript's own stderr. Whether the
   *  message is the command's stderr or AppleScript's generic stand-in is
   *  UNVERIFIED under the `with administrator privileges` form this elevator
   *  uses — that form cannot be run without the authentication dialog, so it
   *  could not be measured. So it is here to be READ and nothing branches on its
   *  content; `parseOsascriptFailure` in elevation/darwin.ts has the measurement
   *  and its limits.
   *
   *  Windows: absent, always. ShellExecute gives the elevated process no handles
   *  to redirect, so there is nothing to capture, and the appliers that need to
   *  know whether a route was already there read the route table instead of
   *  waiting for a sentence that never comes. */
  stderr?: string
}

export interface PrivilegedOptions {
  /** Only honoured when the context sets `supportsStdin`. macOS needs it:
   *  `scutil` takes its commands on stdin and has no argv equivalent. */
  stdin?: string
  timeoutMs?: number
}

/** What the routing and DNS managers are handed so they can change the system
 *  without knowing how the elevation happened. This module never elevates by
 *  itself — the elevation module owns that surface, and keeping it in one
 *  place is what makes it auditable. */
export interface NetApplyContext {
  runId: string
  /** The run's 0700 scratch directory. Root can read it, which is how a file
   *  reaches a privileged command without going through a shell. */
  runDir: string
  runPrivileged(cmd: string, args: string[], opts?: PrivilegedOptions): Promise<PrivilegedResult>
  /** True when `runPrivileged` honours `opts.stdin`. Declared rather than
   *  sniffed: a channel that silently drops stdin would apply nothing and
   *  report success, which is the failure mode this whole module exists to
   *  prevent. */
  supportsStdin?: boolean
}

export interface ReadResult {
  code: number
  stdout: string
  stderr: string
}

/** An unprivileged read of some system table. Never rejects: every caller is
 *  inspecting a facility that may simply not exist on this host (`resolvectl`
 *  on a non-systemd box, `netsh` outside Windows), and "not available" is an
 *  answer, not an exception. */
export function readCommand(
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number }
): Promise<ReadResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: opts?.timeoutMs ?? 10_000, windowsHide: true, maxBuffer: 1 << 22 },
      (err, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : String(stdout ?? '')
        const errOut = typeof stderr === 'string' ? stderr : String(stderr ?? '')
        if (!err) return resolve({ code: 0, stdout: out, stderr: errOut })
        const code = typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1
        resolve({ code, stdout: out, stderr: errOut || err.message })
      }
    )
  })
}

export interface NetPlan {
  /** The tunnel interface everything here hangs off. Recorded so a snapshot
   *  for a device that no longer exists can be discarded rather than replayed
   *  against whatever now happens to hold that name. */
  interfaceName: string
  routes?: RouteSpec[]
  dns?: DnsSpec
}

export interface NetStateFile {
  version: 1
  runId: string
  platform: NodeJS.Platform
  interfaceName: string
  /** Epoch ms. Only ever compared against `bootAt`, never trusted on its own:
   *  a wall clock can go backwards. */
  appliedAt: number
  /** Epoch ms of the boot this snapshot was taken during, derived from
   *  `os.uptime()`. Monotonic within a boot and different across boots, which
   *  is what lets a reboot invalidate the route half of the snapshot. */
  bootAt: number
  routes?: RouteSnapshot
  dns?: DnsSnapshot
}

export function netStateDir(runId: string, root: string = vpnRunRoot()): string {
  return join(root, runIdSegment(runId))
}

export function netStatePath(runId: string, root: string = vpnRunRoot()): string {
  return join(netStateDir(runId, root), NETSTATE_FILE)
}

/** Epoch ms of the current boot. */
export function bootTime(now: number = Date.now()): number {
  return now - Math.round(uptime() * 1000)
}

export function isFromCurrentBoot(state: NetStateFile, now: number = Date.now()): boolean {
  return Math.abs(state.bootAt - bootTime(now)) <= BOOT_TOLERANCE_MS
}

export async function writeNetState(
  state: NetStateFile,
  root: string = vpnRunRoot()
): Promise<string> {
  const dir = netStateDir(state.runId, root)
  await mkdir(dir, { recursive: true, mode: DIR_MODE })
  await chmod(dir, DIR_MODE).catch(() => {})
  const file = join(dir, NETSTATE_FILE)
  // The mode argument applies only when the file is created, so an existing
  // file keeps whatever permissions it already had without the second chmod.
  await writeFile(file, JSON.stringify(state, null, 2), { mode: FILE_MODE })
  await chmod(file, FILE_MODE).catch(() => {})
  return file
}

/** Shape-checked rather than cast: this file is read at startup, possibly
 *  after an upgrade, and a half-written one from a crash mid-write must not
 *  turn into a route deletion against `undefined`. */
export function parseNetState(text: string): NetStateFile | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.version !== 1) return null
  if (typeof o.runId !== 'string' || !o.runId) return null
  if (typeof o.platform !== 'string') return null
  if (typeof o.interfaceName !== 'string') return null
  if (typeof o.appliedAt !== 'number' || typeof o.bootAt !== 'number') return null
  return raw as NetStateFile
}

export async function readNetState(
  runId: string,
  root: string = vpnRunRoot()
): Promise<NetStateFile | null> {
  try {
    return parseNetState(await readFile(netStatePath(runId, root), 'utf8'))
  } catch {
    return null
  }
}

export async function clearNetState(runId: string, root: string = vpnRunRoot()): Promise<void> {
  await rm(netStatePath(runId, root), { force: true }).catch(() => {})
}

interface Managers {
  route: typeof import('./routing/index')
  dns: typeof import('./dns/index')
}

// Loaded on demand so the platform modules can import `readCommand` and
// `NetApplyContext` from here without a circular module evaluation.
async function managers(): Promise<Managers> {
  const [route, dns] = await Promise.all([import('./routing/index'), import('./dns/index')])
  return { route, dns }
}

export interface NetStateOptions {
  platform?: NodeJS.Platform
  root?: string
  now?: number
  /** Something went not-quite-right and the apply stands anyway. One sentence,
   *  already written for a person.
   *
   *  Only a DNS read-back that could not be taken reaches this today, and it has
   *  to reach *something*: a condition we decided not to fail on and then did not
   *  mention is the silent success `verify()` was added to kill, moved one level
   *  up. This module has no logger of its own — it is handed a privileged channel
   *  and nothing else — so the driver supplies the sink, which is the same
   *  `ctx.log(…, 'app')` the ipv6-leak warning already uses. Absent in the
   *  restore pass, which reports through `RestoreReport` instead. */
  onNote?: (message: string) => void
}

/** Snapshot, persist, then change — in that order, and never any other.
 *
 *  Returns the record that was written so the caller can hand it back to
 *  `revertNetState` on a clean stop. On failure the partial change is rolled
 *  back here and the snapshot is left on disk anyway, because a rollback that
 *  itself failed is exactly the case the startup pass is for. */
export async function applyNetState(
  plan: NetPlan,
  ctx: NetApplyContext,
  opts: NetStateOptions = {}
): Promise<NetStateFile> {
  const platform = opts.platform ?? process.platform
  const now = opts.now ?? Date.now()
  const { route, dns } = await managers()

  const state: NetStateFile = {
    version: 1,
    runId: ctx.runId,
    platform,
    interfaceName: plan.interfaceName,
    appliedAt: now,
    bootAt: bootTime(now)
  }

  if (plan.routes && plan.routes.length > 0) {
    const snap = await route.routeManagerFor(platform).snapshot()
    snap.planned = plan.routes
    state.routes = snap
  }
  if (plan.dns) {
    const snap = await dns.dnsManagerFor(platform).snapshot()
    snap.runId = ctx.runId
    snap.interfaceName = plan.dns.interfaceName
    snap.planned = plan.dns
    state.dns = snap
  }

  await writeNetState(state, opts.root)

  try {
    if (state.routes && plan.routes) await route.routeManagerFor(platform).apply(plan.routes, ctx)
    if (state.dns && plan.dns) {
      // One manager for both calls, not two: win32 recognises its own NRPT
      // rules by the tag it applied them under, and it learns that from the
      // context `apply` was handed.
      const manager = dns.dnsManagerFor(platform)
      await manager.apply(plan.dns, ctx)
      // A DNS command exiting 0 is not evidence the resolver took the change,
      // so it is read back — and the answer has three values, because rolling
      // back on the wrong two of them each breaks something different.
      //
      //   failed  — the resolver was read and it is still using the old servers.
      //             Rolled back: a tunnel whose queries go to the old server is
      //             the leak nobody notices, and calling it connected is what
      //             makes it one.
      //   skipped — the read itself did not happen. NOT rolled back. The tunnel
      //             is probably fine and we simply cannot see; tearing it down
      //             on our own blindness is a worse bug than the silent success
      //             this check replaced. It is still said out loud, because an
      //             unverified apply that reports nothing is that same bug
      //             wearing a different hat.
      const check = await manager.verify(plan.dns)
      if (check.status === 'failed') throw new VpnError('dns-not-applied', check.reason)
      // Unconditional: `reason` is required on the `skipped` variant of
      // `DnsVerification`, so there is no longer a shape that keeps the change
      // and says nothing. The `||` covers the one thing the type cannot —
      // a reason that is present but empty.
      if (check.status === 'skipped') {
        opts.onNote?.(
          check.reason ||
            'The DNS change could not be read back, so it was kept without being confirmed.'
        )
      }
    }
  } catch (e) {
    await revertNetState(state, ctx, opts).catch(() => {})
    throw e
  }
  return state
}

/** Undo everything in a snapshot. Idempotent and tolerant by construction: a
 *  route or rule that has already gone is the expected case, not an error. */
export async function revertNetState(
  state: NetStateFile,
  ctx: NetApplyContext,
  opts: NetStateOptions = {}
): Promise<void> {
  const platform = opts.platform ?? state.platform
  const { route, dns } = await managers()
  // DNS first: it is the change a user notices, and it is the one that keeps
  // resolving to tunnel-only servers long after the interface has gone.
  if (state.dns) await dns.dnsManagerFor(platform).revert(state.dns, ctx)
  if (state.routes) await route.routeManagerFor(platform).revert(state.routes, ctx)
}

export type RestorePartOutcome =
  | 'reverted'
  | 'none'
  | 'skipped-missing-interface'
  | 'skipped-stale-boot'
  | 'failed'

export interface RestoreReport {
  runId: string
  outcome: 'restored' | 'skipped' | 'failed'
  routes: RestorePartOutcome
  dns: RestorePartOutcome
  reason?: string
}

export interface RestoreOptions extends NetStateOptions {
  /** Runs the orphan reaper has decided are still real. Their state is left
   *  alone: reverting a live run's routes would break a working tunnel. */
  liveRunIds: string[]
  /** Elevation belongs to another module, so the context is supplied per
   *  orphan. Returning null skips that run and leaves its snapshot on disk
   *  for the next start — better a delayed restore than a lost one. */
  createContext(state: NetStateFile): Promise<NetApplyContext | null> | NetApplyContext | null
  interfaceExists?(name: string): boolean | Promise<boolean>
}

function defaultInterfaceExists(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(networkInterfaces(), name)
}

/** Called once at app start, before `sweepRunDirs`, and before any profile
 *  runs. This is what makes `kill -9` survivable: the routes and the resolver
 *  a killed run left behind get put back even though the process that made
 *  them is long gone (E09, E10, E14). */
export async function restoreOrphanedNetstate(opts: RestoreOptions): Promise<RestoreReport[]> {
  const root = opts.root ?? vpnRunRoot()
  const platform = opts.platform ?? process.platform
  const now = opts.now ?? Date.now()
  const live = new Set(opts.liveRunIds.map((id) => runIdSegment(id)))
  const exists = opts.interfaceExists ?? defaultInterfaceExists
  const reports: RestoreReport[] = []

  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return reports
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    let state: NetStateFile | null = null
    try {
      state = parseNetState(await readFile(join(root, entry.name, NETSTATE_FILE), 'utf8'))
    } catch {
      continue
    }
    if (!state) continue

    if (live.has(entry.name) || live.has(runIdSegment(state.runId))) {
      reports.push({ runId: state.runId, outcome: 'skipped', routes: 'none', dns: 'none', reason: 'run is still live' })
      continue
    }
    if (state.platform !== platform) {
      reports.push({
        runId: state.runId,
        outcome: 'skipped',
        routes: 'none',
        dns: 'none',
        reason: `snapshot was taken on ${state.platform}`
      })
      continue
    }

    const sameBoot = isFromCurrentBoot(state, now)
    const ifaceUp = state.interfaceName ? await exists(state.interfaceName) : true

    // Routes die with the interface and with the boot, so replaying a delete
    // against a name something else may now own is worse than doing nothing.
    // DNS is not tied to either: an NRPT rule and a rewritten resolv.conf both
    // survive a reboot, and a stale one is the actual leak.
    let routes: RestorePartOutcome = state.routes ? 'reverted' : 'none'
    if (state.routes && !sameBoot) routes = 'skipped-stale-boot'
    else if (state.routes && !ifaceUp) routes = 'skipped-missing-interface'

    const wantsRoutes = routes === 'reverted'
    const wantsDns = Boolean(state.dns)
    if (!wantsRoutes && !wantsDns) {
      reports.push({
        runId: state.runId,
        outcome: 'skipped',
        routes,
        dns: 'none',
        reason: routes === 'skipped-missing-interface' ? `interface ${state.interfaceName} is gone` : undefined
      })
      await clearNetState(state.runId, root)
      continue
    }

    let ctx: NetApplyContext | null = null
    try {
      ctx = await opts.createContext(state)
    } catch {
      ctx = null
    }
    if (!ctx) {
      reports.push({
        runId: state.runId,
        outcome: 'skipped',
        routes: 'none',
        dns: 'none',
        reason: 'no privileged channel was available'
      })
      continue
    }

    const partial: NetStateFile = {
      ...state,
      routes: wantsRoutes ? state.routes : undefined
    }
    try {
      await revertNetState(partial, ctx, { platform, root })
      reports.push({
        runId: state.runId,
        outcome: 'restored',
        routes,
        dns: wantsDns ? 'reverted' : 'none',
        reason: routes === 'skipped-missing-interface' ? `interface ${state.interfaceName} is gone` : undefined
      })
      await clearNetState(state.runId, root)
    } catch (e) {
      // Left on disk deliberately: an unrecoverable revert is worth retrying
      // at the next start rather than forgetting about.
      reports.push({
        runId: state.runId,
        outcome: 'failed',
        routes: wantsRoutes ? 'failed' : routes,
        dns: wantsDns ? 'failed' : 'none',
        reason: e instanceof Error ? e.message : String(e)
      })
    }
  }
  return reports
}
