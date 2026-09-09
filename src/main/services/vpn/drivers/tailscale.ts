import { join } from 'node:path'
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
import { resolveBundled } from '../binaries'
import { openNetdSession, type NetdSession } from '../netdSession'

/**
 * Tailscale, running inside the bundled sidecar.
 *
 * There is no `tailscale` binary to find, no version to negotiate and nothing
 * for the user to install: `opsmaxx-netd` embeds a full Tailscale node via
 * tsnet, and this driver drives it over the same NDJSON protocol WireGuard
 * uses. tailscale.com is BSD-3-Clause, so it ships the way frpc and OpenVPN
 * already do.
 *
 * ── What a node here IS ────────────────────────────────────────────────────
 *
 * Our own device on the tailnet, with its own key and its own name. It does not
 * borrow, reuse or disturb a `tailscaled` the user may also run — both can be
 * up at once and neither knows about the other.
 *
 * That is the trade that makes the app standalone, and it changes what `stop()`
 * means. An earlier version of this driver attached to the user's daemon and
 * therefore refused to stop anything, because the daemon was machine-wide and
 * other software depended on it. This one owns its node completely, so stopping
 * a profile stops exactly one thing and nothing else notices.
 */

/** The sidecar's `ts.status` reply. */
interface TsStatusReply {
  backendState: string
  authUrl?: string
  self: { name?: string; ips?: string[] }
  magicDnsSuffix?: string
  peers: { name: string; host: string; online: boolean; os?: string }[]
  health?: string[]
}

export interface TailscalePeer {
  name: string
  host: string
  online: boolean
  os?: string
}

interface Live {
  status: VpnStatus
  session: NetdSession
  peers: TailscalePeer[]
  timer: ReturnType<typeof setInterval> | null
}

const live = new Map<string, Live>()
let engine: VpnEngineInfo | null = null

/** A device list is not a per-second fact. */
const POLL_MS = 15_000

/**
 * Tailscale's own vocabulary, mapped onto this app's.
 *
 * `NeedsLogin` and `NeedsMachineAuth` are not failures — nothing broke, the
 * user has an action to take — but they are also not connected, and calling
 * them connected would be the worst of the options.
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
      return { state: 'authenticating', error: 'This node needs to be authorised.' }
    case 'NeedsMachineAuth':
      return {
        state: 'authenticating',
        error: 'This node is waiting to be approved by a tailnet administrator.'
      }
    case 'Stopped':
      return { state: 'stopped' }
    case 'NoState':
    case undefined:
      return { state: 'error', error: 'The node did not report a state.', code: 'engine-failed' }
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
    // Nothing is required. A profile with no fields set is the normal case:
    // the node is created on first start and authorised in a browser.
    if (spec.hostname !== undefined && !/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(spec.hostname)) {
      issues.push({
        path: 'hostname',
        severity: 'error',
        code: 'hostname-invalid',
        message: 'Use letters, digits and dashes — this becomes the device name on your tailnet.'
      })
    }
    return { ok: issues.every((i) => i.severity !== 'error'), issues }
  },

  async probe(): Promise<VpnEngineInfo> {
    if (engine) return engine
    try {
      const info = await resolveBundled('opsmaxx-netd')
      // The sidecar resolves as the WireGuard engine because that is the name
      // it is registered under; for this driver it IS the Tailscale engine.
      engine = { ...info, kind: 'tailscale' }
    } catch (e) {
      engine = {
        kind: 'tailscale',
        available: false,
        bundled: true,
        reason:
          e instanceof VpnError
            ? e.message
            : 'The bundled network sidecar could not be found. Reinstalling OpsMaxx restores it.'
      }
    }
    return engine
  },

  async start(
    profile: VpnProfile & { spec: TailscaleSpec },
    ctx: VpnDriverContext
  ): Promise<VpnStartResult> {
    if (live.has(profile.id)) {
      return { ok: false, error: 'This profile is already running.', errorCode: 'already-running' }
    }

    let session: NetdSession
    try {
      session = await openNetdSession(profile.id, ctx, 'tailscale')
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : 'The sidecar could not be started.',
        errorCode: e instanceof VpnError ? e.code : 'engine-failed'
      }
    }

    try {
      /**
       * The node's identity lives beside the run directory, keyed by profile.
       *
       * NOT inside the run directory, which is swept per run — a node whose key
       * is deleted between starts comes back as a NEW device every time, and
       * fills the tailnet's admin console with duplicates of itself.
       */
      const stateDir = join(ctx.runDir, '..', `tailscale-${profile.id}`)

      const reply = await session.send<TsStatusReply>('ts.up', {
        tunnelId: profile.id,
        hostname: profile.spec.hostname,
        stateDir,
        // An auth key, when the user supplied one through the vault. Absent is
        // the normal path: the node reports an auth URL instead.
        authKey: ctx.secrets.token,
        timeoutMs: 60_000
      })

      const mapped = stateFor(reply.backendState)
      for (const h of reply.health ?? []) ctx.log(`health: ${h}`, 'ctl')

      if (mapped.state === 'authenticating' && reply.authUrl) {
        // The one actionable thing to offer. It goes in the status error, which
        // the profile card already renders — not through `askUser`, which
        // raises a CREDENTIAL prompt and is the wrong shape entirely.
        ctx.log(`authorise this node: ${reply.authUrl}`, 'app')
      }

      const status: VpnStatus = {
        id: profile.id,
        kind: 'tailscale',
        state: mapped.state,
        since: Date.now(),
        restarts: 0,
        error:
          mapped.state === 'authenticating' && reply.authUrl
            ? `${mapped.error} Open ${reply.authUrl} to authorise it.`
            : mapped.error,
        errorCode: mapped.code
      }

      const entry: Live = {
        status,
        session,
        peers: profile.spec.showPeers === true ? reply.peers : [],
        timer: null
      }
      live.set(profile.id, entry)
      ctx.emit(status)

      entry.timer = setInterval(() => {
        void (async () => {
          const current = live.get(profile.id)
          if (!current || !current.session.alive()) return
          try {
            const next = await current.session.send<TsStatusReply>('ts.status', {
              tunnelId: profile.id
            })
            const now = stateFor(next.backendState)
            if (profile.spec.showPeers === true) current.peers = next.peers
            if (current.status.state !== now.state) {
              current.status = { ...current.status, state: now.state, since: Date.now() }
              ctx.emit(current.status)
            }
          } catch (e) {
            // The sidecar went away. `dropped` rather than an emitted error:
            // the manager holds the live entry, the run directory and every
            // registration made against this profile, and emitting alone would
            // leave all of that in place while the tunnel was gone.
            ctx.dropped(
              e instanceof Error ? e.message : 'The Tailscale node stopped answering.',
              'engine-stopped'
            )
          }
        })()
      }, POLL_MS)
      if (typeof entry.timer.unref === 'function') entry.timer.unref()

      // `authenticating` is a successful start that is waiting on a person.
      // Reporting it as a failure would make the UI offer a retry, and the
      // retry re-runs the same wait.
      return { ok: mapped.state !== 'error', error: status.error, errorCode: status.errorCode }
    } catch (e) {
      await session.close()
      return {
        ok: false,
        error: e instanceof Error ? e.message : 'The Tailscale node could not start.',
        errorCode: e instanceof VpnError ? e.code : 'engine-failed'
      }
    }
  },

  /**
   * Stops OUR node, which is the whole node.
   *
   * Unambiguous in a way the attach-based version never was: nothing else on
   * the machine is using it, because nothing else knows it exists.
   */
  async stop(id: string): Promise<void> {
    const entry = live.get(id)
    if (!entry) return
    live.delete(id)
    if (entry.timer) clearInterval(entry.timer)
    try {
      if (entry.session.alive()) {
        await entry.session.send<unknown>('ts.down', { tunnelId: id }, 15_000)
      }
    } catch {
      // A node that will not answer its own shutdown still has to have its
      // process stopped, which close() does regardless.
    }
    await entry.session.close()
  },

  status(id: string): VpnStatus | null {
    return live.get(id)?.status ?? null
  },

  async stats(): Promise<VpnStats | null> {
    // A mesh has no single rx/tx pair, and collapsing per-peer counters into
    // one would be inventing a number. The peer list is the useful reading.
    return null
  }
}

/** The tailnet's devices. Empty unless the profile asked for them. */
export function tailscalePeers(id: string): TailscalePeer[] {
  return live.get(id)?.peers ?? []
}
