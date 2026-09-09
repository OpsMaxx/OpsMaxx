import { execFile } from 'node:child_process'
import type {
  TailscaleSpec,
  VpnEngineInfo,
  VpnProfile,
  VpnStartResult,
  VpnStats,
  VpnStatus,
  VpnValidation,
  VpnValidationIssue
} from '../../../../shared/vpn'
import type { VpnDriver, VpnDriverContext } from '../driver'
import { VpnError } from '../errors'
import { resolveSystem } from '../binaries'

/**
 * Tailscale, ATTACHED rather than supervised.
 *
 * Every other driver here owns a process: it spawns an engine, watches it, and
 * kills it on stop. This one must not. `tailscaled` is a machine-wide daemon
 * that the user installed deliberately, that has its own updater and login
 * flow, and that other software on the machine depends on — an ssh session in
 * another terminal, a mounted share, a running deploy. Killing it because a
 * panel in this app was closed would take all of that down.
 *
 * So the lifecycle is inverted:
 *
 *   start()  reads `tailscale status --json` and reports what it finds. If the
 *            backend is not running or not logged in, it says so and offers the
 *            login URL; it never starts the daemon.
 *   stop()   forgets our polling. It is a detach, not `tailscale down`.
 *   reap()   is absent: there are no orphans of ours to sweep, because we never
 *            spawned anything.
 *
 * What this driver is FOR, then, is visibility: is the tailnet up, which peers
 * exist, and are any of them the hosts in this workspace. That is worth having
 * on its own — and it is emphatically NOT a fix for a name that will not
 * resolve. Once the tailnet is up, MagicDNS is configured in the OS resolver
 * and `getaddrinfo` finds those names without this app's involvement.
 *
 * ── The macOS trap, which is the reason this file reads carefully ──────────
 *
 * The App Store build of Tailscale is a SINGLE executable that decides whether
 * to open its GUI window or behave as a command-line tool by sniffing
 * environment variables — Tailscale's own documentation names SHLVL, TERM,
 * TERM_PROGRAM and PS1. An Electron app inherits none of them. So spawning it
 * for `status --json` would open the Tailscale window instead of returning
 * JSON, and it would do that ONLY in a packaged app: `electron-vite dev`
 * started from a terminal inherits those variables and works. A bug that
 * passes every local test and fails for every user.
 *
 * `TAILSCALE_BE_CLI=1` is the documented escape hatch, and it is set on every
 * invocation here including the version probe during resolution — which spawns
 * the binary too, and would otherwise open the window before this driver ran
 * at all.
 */

/** Forces command-line behaviour out of the App Store build. See the header. */
const CLI_ENV = { TAILSCALE_BE_CLI: '1' } as const

/**
 * `/Applications`, allowed for this engine only.
 *
 * The App Store client keeps its CLI inside the app bundle, which is outside
 * the standard allowlist — so without this the only variant half the macOS
 * install base has is unreachable. Passed per call rather than added to the
 * global roots on purpose: `/Applications` is user-writable, and making it
 * acceptable for OpenVPN or WireGuard would be a real loosening of a control
 * those engines are deliberately behind.
 */
const DARWIN_ROOTS = ['/Applications']

/** What `tailscale status --json` gives us, reduced to what is used. */
export interface TailscaleStatus {
  BackendState?: string
  Self?: { DNSName?: string; TailscaleIPs?: string[]; Online?: boolean }
  Peer?: Record<
    string,
    { DNSName?: string; HostName?: string; TailscaleIPs?: string[]; Online?: boolean; OS?: string }
  >
  AuthURL?: string
  Health?: string[]
  MagicDNSSuffix?: string
}

/** One device on the tailnet, as the UI shows it. */
export interface TailscalePeer {
  name: string
  host: string
  online: boolean
  os?: string
}

interface Live {
  id: string
  status: VpnStatus
  timer: ReturnType<typeof setInterval> | null
  peers: TailscalePeer[]
}

const live = new Map<string, Live>()
let engine: VpnEngineInfo | null = null

/** Status is polled rather than streamed: the CLI has no watch mode we can
 *  rely on across variants, and a device list is not a per-second fact. */
const POLL_MS = 15_000

function run(bin: string, args: string[], timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      execFile(
        bin,
        args,
        {
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 8 << 20,
          // Every invocation, not just the ones that look risky.
          env: { ...process.env, ...CLI_ENV }
        },
        (err, stdout, stderr) => {
          // A non-zero exit still carries usable JSON for some subcommands, so
          // stdout wins when there is any; the error is only the fallback.
          if (stdout && stdout.trim()) return resolve(stdout)
          if (err) return reject(new Error(stderr?.trim() || err.message))
          resolve(stdout)
        }
      )
    } catch (e) {
      // ENOEXEC and friends throw out of spawn rather than reaching the
      // callback. A hang is also a real outcome here — a `/usr/local/bin`
      // symlink to the App Store bundle hangs with no output (tailscale#3805)
      // — which is what the timeout above is for.
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

async function locate(spec: TailscaleSpec): Promise<VpnEngineInfo> {
  return resolveSystem('tailscale', {
    binaryPath: spec.binaryPath,
    confirmed: spec.confirmed,
    extraRoots: process.platform === 'darwin' ? DARWIN_ROOTS : undefined,
    probeEnv: CLI_ENV
  })
}

export function peersFrom(status: TailscaleStatus): TailscalePeer[] {
  const suffix = status.MagicDNSSuffix ? `.${status.MagicDNSSuffix}.` : null
  return Object.values(status.Peer ?? {})
    .map((p) => {
      // The DNSName is fully qualified and trailing-dotted. The short name is
      // what the user types and what MagicDNS resolves, so that is what is
      // shown — falling back to the hostname the peer reported.
      const dns = p.DNSName ?? ''
      const short =
        suffix && dns.endsWith(suffix)
          ? dns.slice(0, -suffix.length)
          : dns.replace(/\.$/, '') || (p.HostName ?? '')
      return {
        // `||` and not `??`: an empty DNSName and an empty HostName are both
        // things a peer can report, and `??` would have taken the empty string
        // and shown a row with no name at all.
        name: short || p.HostName || 'unknown',
        // The address, not the name: this is what a connection would dial, and
        // it works whether or not MagicDNS is enabled on this tailnet.
        host: p.TailscaleIPs?.[0] ?? '',
        online: p.Online === true,
        os: p.OS
      }
    })
    .filter((p) => p.host !== '')
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
}

/**
 * The backend state, mapped onto this app's vocabulary.
 *
 * `NeedsLogin` and `NeedsMachineAuth` are not errors in the sense the other
 * drivers use the word — nothing failed, the user simply has an action to take
 * — but they are also not "connected", and reporting them as connected would be
 * the worst of the options.
 */
export function stateFor(backend: string | undefined): {
  state: VpnStatus['state']
  error?: string
  code?: VpnStatus['errorCode']
} {
  switch (backend) {
    case 'Running':
      return { state: 'connected' }
    case 'Starting':
      return { state: 'starting' }
    case 'NeedsLogin':
      return {
        state: 'error',
        error: 'Tailscale is not logged in on this machine.',
        code: 'auth-failed'
      }
    case 'NeedsMachineAuth':
      return {
        state: 'error',
        error: 'This machine is waiting to be approved by a tailnet administrator.',
        code: 'auth-failed'
      }
    case 'Stopped':
      return {
        state: 'error',
        error: 'Tailscale is installed but switched off on this machine.',
        code: 'engine-stopped'
      }
    case 'InUseOtherUser':
      // A documented state, not an unknown one: another user on this machine is
      // signed in to the daemon. Reporting it as "unknown state" sent people
      // looking for a fault instead of at the fast-user-switching they did.
      return {
        state: 'error',
        error: 'Tailscale is signed in as another user on this machine.',
        code: 'permission-denied'
      }
    case 'NoState':
    case undefined:
      return {
        state: 'error',
        error: 'The Tailscale daemon is not running.',
        code: 'engine-stopped'
      }
    default:
      return {
        state: 'error',
        error: `Tailscale reported an unknown state: ${backend}.`,
        code: 'internal'
      }
  }
}

export const tailscaleDriver: VpnDriver<TailscaleSpec> = {
  kind: 'tailscale',

  validateConfig(spec: TailscaleSpec): VpnValidation {
    const issues: VpnValidationIssue[] = []
    // There is nothing else to validate, and that is the design: this profile
    // configures OUR view of a daemon the user already owns.
    if (spec.binaryPath && !spec.confirmed) {
      issues.push({
        path: 'binaryPath',
        severity: 'error',
        code: 'unconfirmed-path',
        message: 'Confirm the program path before it is run.'
      })
    }
    return { ok: issues.every((i) => i.severity !== 'error'), issues }
  },

  async probe(): Promise<VpnEngineInfo> {
    if (engine) return engine
    try {
      engine = await locate({ kind: 'tailscale' })
    } catch (e) {
      engine = {
        kind: 'tailscale',
        available: false,
        bundled: false,
        reason:
          e instanceof VpnError
            ? e.message
            : 'The Tailscale command-line tool could not be found. Install Tailscale, or point this profile at it.'
      }
    }
    return engine
  },

  async start(
    profile: VpnProfile & { spec: TailscaleSpec },
    ctx: VpnDriverContext
  ): Promise<VpnStartResult> {
    const info = await locate(profile.spec)
    if (!info.available || !info.path) {
      return { ok: false, error: info.reason ?? 'Tailscale was not found.', errorCode: 'binary-missing' }
    }
    // realpath, from `describe`: a symlinked launcher is invoked as the file it
    // actually points at, which is what keeps the #3805 hang out of this path.
    const bin = info.path

    let status: TailscaleStatus
    try {
      status = JSON.parse(await run(bin, ['status', '--json'])) as TailscaleStatus
    } catch (e) {
      return {
        ok: false,
        error: `Tailscale did not answer: ${e instanceof Error ? e.message : String(e)}`,
        errorCode: 'engine-stopped'
      }
    }

    const mapped = stateFor(status.BackendState)
    if (mapped.state !== 'connected' && mapped.state !== 'starting') {
      /**
       * The login URL goes in the ERROR, not through `askUser`.
       *
       * `askUser` raises a credential prompt: `VpnPrompt` is `{kind, label,
       * echo}` where kind is one of password/otp/passphrase/username, and the
       * modal renders `request.label.trim()` unguarded. An informational
       * payload shaped `{kind:'info', title, message}` satisfies none of that —
       * it left `label` undefined, and the modal is mounted at the app root, so
       * `.trim()` on undefined replaced the whole UI with the error screen. It
       * only compiled because of an `as never` cast.
       *
       * It was also the wrong mechanism regardless of shape: a login URL is not
       * a credential this app is collecting. The status error is already
       * rendered with the profile, which is where someone looking at a tunnel
       * that will not start is looking.
       */
      if (status.AuthURL) ctx.log(`Tailscale needs a login: ${status.AuthURL}`, 'app')
      const error = status.AuthURL
        ? `${mapped.error} Open ${status.AuthURL} to authenticate this machine.`
        : mapped.error
      return { ok: false, error, errorCode: mapped.code }
    }

    for (const line of status.Health ?? []) ctx.log(`health: ${line}`, 'ctl')

    const entry: Live = {
      id: profile.id,
      status: {
        id: profile.id,
        kind: 'tailscale',
        state: mapped.state,
        since: Date.now(),
        restarts: 0
      },
      timer: null,
      peers: profile.spec.showPeers === true ? peersFrom(status) : []
    }
    live.set(profile.id, entry)
    ctx.emit(entry.status)

    /**
     * Polling, and what it must NOT do on failure.
     *
     * A poll that cannot reach the daemon means the daemon went away — which is
     * `dropped`, not an emitted error: the manager holds the live entry, the
     * run directory and every registration made against this profile, and
     * emitting alone would leave all of that in place while the tunnel was
     * gone. The driver comment on `dropped` says exactly this.
     */
    entry.timer = setInterval(() => {
      void (async () => {
        const current = live.get(profile.id)
        if (!current) return
        try {
          const next = JSON.parse(await run(bin, ['status', '--json'])) as TailscaleStatus
          const now = stateFor(next.BackendState)
          if (now.state !== 'connected' && now.state !== 'starting') {
            ctx.dropped(now.error ?? 'Tailscale went down.', now.code)
            return
          }
          if (profile.spec.showPeers === true) current.peers = peersFrom(next)
          if (current.status.state !== now.state) {
            current.status = { ...current.status, state: now.state, since: Date.now() }
            ctx.emit(current.status)
          }
        } catch (e) {
          ctx.dropped(
            `Tailscale stopped answering: ${e instanceof Error ? e.message : String(e)}`,
            'engine-stopped'
          )
        }
      })()
    }, POLL_MS)
    // The interval must not hold the app open at quit.
    if (typeof entry.timer.unref === 'function') entry.timer.unref()

    return { ok: true }
  },

  /**
   * A detach. NOT `tailscale down`.
   *
   * Stopping this profile means this app stops watching. The daemon keeps
   * running, because it was running before the profile started and other
   * things on this machine are using it. `force` changes nothing: there is no
   * process of ours to escalate against.
   */
  async stop(id: string): Promise<void> {
    const entry = live.get(id)
    if (!entry) return
    if (entry.timer) clearInterval(entry.timer)
    live.delete(id)
  },

  status(id: string): VpnStatus | null {
    return live.get(id)?.status ?? null
  },

  async stats(): Promise<VpnStats | null> {
    // Tailscale reports per-peer transfer, but this app's VpnStats is a
    // single-tunnel shape and there is no honest way to collapse a mesh into
    // one rx/tx pair. Null says "not applicable" rather than inventing a number.
    return null
  }
}

/** The tailnet's devices, for the UI. Empty unless the profile asked for them. */
export function tailscalePeers(id: string): TailscalePeer[] {
  return live.get(id)?.peers ?? []
}
