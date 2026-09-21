import { readFile, writeFile, rm } from 'node:fs/promises'
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
import { isTailscaleHostname, tailscaleHostname } from '../../../../shared/vpn'
import type { VpnDriver, VpnDriverContext } from '../driver'
import { VpnError } from '../errors'
import { resolveBundled } from '../binaries'
import { openNetdSession, type NetdSession } from '../netdSession'
import { createStateDir, runIdSegment, vpnStateRoot } from '../runDir'

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

/**
 * Sessions belonging to a start that has not finished.
 *
 * `live` is only populated once `ts.up` has returned, and `ts.up` is precisely
 * the call that blocks — a node waits for its backend to settle, which on an
 * unreachable network is the full timeout. So Cancel had nothing to reach and
 * sat behind the start for a minute. This is what it reaches instead.
 */
const starting = new Map<string, NetdSession>()
let engine: VpnEngineInfo | null = null

/** A device list is not a per-second fact. */
const POLL_MS = 15_000

/**
 * The durable directory a profile's node identity lives in.
 *
 * ONE definition, used by `start()` and by the override below, because they
 * have to name the same directory. When these drifted the override would sit
 * in a folder beside the node it was supposed to name, silently doing nothing.
 */
const stateKey = (profileId: string): string => `tailscale-${profileId}`

/** The per-device name file, beside the node key. */
const hostnameFile = (profileId: string, root: string): string =>
  join(root, runIdSegment(stateKey(profileId)), 'hostname')

/**
 * This machine's own name for a profile's node, if it set one.
 *
 * ── Why it lives here and not in the profile ───────────────────────────────
 *
 * `TailscaleSpec.hostname` syncs, and a tailnet hostname names ONE device — so
 * paired machines running one profile register under one label and Tailscale
 * appends `-1`, `-2`. The override has to be device-local, and this is the
 * directory that already is: `NOT_SYNCED.vpnState` classifies `vpn-state/` as
 * "engine key material, including a tsnet node identity that IS this device on
 * the tailnet". A per-device NAME belongs beside the per-device node key it
 * disambiguates, and the two facts about this device stay together.
 *
 * Three things fall out of that choice rather than needing to be built:
 * `ALL_DATA_DIRS` already covers the directory for wipe and backup, the
 * trust-boundary guardrail needs no new entry, and the value never enters the
 * synced blob — so unlike a stripped field it does not reach the relay even as
 * ciphertext.
 *
 * NOT in `opsmaxx-data.json`. `save()` in the renderer's persist.ts writes a
 * fixed object literal, so any key main added to that blob would be destroyed
 * on the renderer's next save — silent data loss, and no error anywhere.
 *
 * `undefined` for absent rather than `''`: absent means this machine has no
 * opinion, which is what makes the profile's own name the default.
 */
export async function readDeviceHostname(
  profileId: string,
  root: string = vpnStateRoot()
): Promise<string | undefined> {
  try {
    const name = (await readFile(hostnameFile(profileId, root), 'utf8')).trim()
    return name || undefined
  } catch {
    // Never set, or the directory has not been created yet. Both are "no
    // opinion", and neither is a reason to fail a start.
    return undefined
  }
}

/**
 * Set or clear this machine's name for a profile's node.
 *
 * Validated here rather than at start. This arrives from the renderer and
 * becomes a name sent to the sidecar, so a name no tailnet will take has to be
 * refused where the user is standing — a start that fails later says only that
 * the node would not come up, which does not point at the field.
 */
export async function writeDeviceHostname(
  profileId: string,
  name: string | undefined,
  root: string = vpnStateRoot()
): Promise<void> {
  const trimmed = name?.trim()
  if (!trimmed) {
    // Cleared, not blanked: an empty file would read back as absent anyway,
    // and leaving one behind makes "this machine has no override" look like a
    // setting somebody made.
    await rm(hostnameFile(profileId, root), { force: true })
    return
  }
  if (!isTailscaleHostname(trimmed)) {
    throw new VpnError(
      'config-invalid',
      'Use letters, digits and dashes — this becomes the device name on your tailnet.'
    )
  }
  // Through createStateDir so the 0700 parent exists and is hardened the same
  // way the node key's directory is; this file sits in it.
  const dir = await createStateDir(stateKey(profileId), root)
  await writeFile(join(dir, 'hostname'), trimmed, 'utf8')
}

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

/**
 * A loopback listener whose connections are carried by the node.
 *
 * ── Why this has to exist ──────────────────────────────────────────────────
 *
 * tsnet is a USERSPACE node. It installs no route on this machine and no
 * resolver entry, so nothing outside the sidecar process can reach the tailnet
 * through it: `100.64.0.0/10` is not routed here and a MagicDNS name does not
 * resolve here.
 *
 * Without this method the driver had no `openForward`, so `vpnOpenForward`
 * threw `unsupported` and `vpnDial` took its "system mode routes for real, so
 * there is nothing to forward" branch — which is true of WireGuard and OpenVPN
 * in system mode and is exactly wrong here. A server marked "reach through
 * Tailscale" was then dialled straight from the host OS, where the MagicDNS
 * name gave `getaddrinfo ENOTFOUND` and the 100.x address had no route. The
 * transport silently did not exist behind a UI that offered it.
 *
 * The sidecar dials through `srv.Dial`, which resolves on the tailnet's own
 * DNS and carries the connection over the node — so both a MagicDNS name and a
 * 100.x address work, and they work whether or not this machine also runs a
 * Tailscale client of its own.
 */
async function openForward(
  id: string,
  host: string,
  port: number
): Promise<{ port: number; close: () => void }> {
  const entry = live.get(id)
  if (!entry || !entry.session.alive()) {
    throw new VpnError('internal', 'That Tailscale node is not running.')
  }

  const res = await entry.session.send<{ forwardId: string; listenPort: number }>(
    'ts.forward.open',
    { tunnelId: id, host, port }
  )

  let closed = false
  return {
    port: res.listenPort,
    close: (): void => {
      if (closed) return
      closed = true
      // Fire and forget: a forward whose node already went down is not an
      // error, and closing one is often what happens on the way out of a
      // failed connection.
      void entry.session
        .send('ts.forward.close', { forwardId: res.forwardId })
        .catch(() => undefined)
    }
  }
}

export const tailscaleDriver: VpnDriver<TailscaleSpec> = {
  kind: 'tailscale',

  openForward,

  validateConfig(spec: TailscaleSpec): VpnValidation {
    const issues: VpnValidationIssue[] = []
    // Nothing is required. A profile with no fields set is the normal case:
    // the node is created on first start and authorised in a browser.
    // The shared rule, so the form and the per-device override cannot accept a
    // name this would reject.
    if (spec.hostname !== undefined && !isTailscaleHostname(spec.hostname)) {
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
      // Reachable before `ts.up` returns, which is the whole point: that call
      // is what Cancel needs to interrupt, and it can block for as long as the
      // node takes to settle. Cleared in the `finally` below.
      starting.set(profile.id, session)
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : 'The sidecar could not be started.',
        errorCode: e instanceof VpnError ? e.code : 'engine-failed'
      }
    }

    try {
      /**
       * The node's identity, in the durable root.
       *
       * It used to be `join(ctx.runDir, '..', ...)` — a SIBLING of the run
       * directories, which put it inside `vpn-run`. That root is emptied at
       * startup by `sweepRunDirs([])`, with an empty keep list, on every
       * launch. So the key that makes this node the same device next time was
       * deleted on every launch: the node registered afresh, the admin console
       * filled with `opsmaxx`, `opsmaxx-1`, and the authorisation had to be
       * done again each restart. The comment above this line said it must not
       * be inside the run directory and it was not — it was one level up, in
       * the directory that gets emptied.
       */
      const stateDir = await createStateDir(stateKey(profile.id))

      const reply = await session.send<TsStatusReply>('ts.up', {
        tunnelId: profile.id,
        // This machine's name if it set one, else the profile's. Resolved by
        // the shared function so the form shows the node the user is actually
        // going to get.
        hostname: tailscaleHostname(profile.spec, await readDeviceHostname(profile.id)),
        stateDir,
        // An auth key, when the user supplied one through the vault. Absent
        // is the normal path: the node reports an auth URL instead.
        authKey: ctx.secrets.token,
        timeoutMs: 60_000
      })

      const mapped = stateFor(reply.backendState)
      for (const h of reply.health ?? []) ctx.log(`health: ${h}`, 'ctl')

      if (mapped.state === 'authenticating' && reply.authUrl) {
        ctx.log(`authorise this node: ${reply.authUrl}`, 'app')
      }

      const status: VpnStatus = {
        id: profile.id,
        kind: 'tailscale',
        state: mapped.state,
        since: Date.now(),
        restarts: 0,
        error: mapped.error,
        errorCode: mapped.code,
        // Carried as a field, not spliced into the error sentence. The card
        // turns it into a button; a URL inside a paragraph cannot be clicked.
        ...(mapped.state === 'authenticating' && reply.authUrl
          ? { authUrl: reply.authUrl }
          : {})
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

            /**
             * The link and the reason are re-read every poll, not only when the
             * state changes.
             *
             * This used to carry the first reply's `error` forward untouched
             * for the life of the tunnel, and never set `authUrl` at all after
             * the initial `ts.up`. A node that came up before its login
             * completed therefore kept whatever it said at second zero — so a
             * node that had since produced a login URL still showed none, and a
             * node that had finished authorising still showed the old
             * complaint. The engine goes on printing its own reminder every
             * five seconds either way, which is what the screen looked like:
             * an unusable link, repeated, next to a state that had stopped
             * agreeing with it.
             */
            const nextAuthUrl = now.state === 'authenticating' ? next.authUrl : undefined
            const changed =
              current.status.state !== now.state ||
              current.status.error !== now.error ||
              current.status.authUrl !== nextAuthUrl
            if (changed) {
              current.status = {
                ...current.status,
                state: now.state,
                error: now.error,
                errorCode: now.code,
                // Cleared the moment the node stops waiting. An authorisation
                // link that outlives its state invites authorising twice.
                authUrl: nextAuthUrl,
                since: current.status.state !== now.state ? Date.now() : current.status.since
              }
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
    } finally {
      // Whichever way it went — settled, timed out, refused, or interrupted by
      // `abortStart` — this start is no longer the one a cancel should reach.
      // In a `finally` rather than on each path because a stale entry here
      // would send `ts.down` down a session that has moved on.
      starting.delete(profile.id)
    }
  },

  /**
   * Stops OUR node, which is the whole node.
   *
   * Unambiguous in a way the attach-based version never was: nothing else on
   * the machine is using it, because nothing else knows it exists.
   */
  /**
   * Interrupt a start that is still waiting for the node to settle.
   *
   * `ts.down` on the same session, sent while `ts.up` is still outstanding.
   * The sidecar registers the node BEFORE it waits, and `ts.down` cancels that
   * node's context — so the wait ends, `ts.up` returns, and the stop already
   * queued behind it runs in order. The NDJSON channel multiplexes by request
   * id, so a second call on a busy session is ordinary rather than exotic.
   *
   * Fire and forget, and never throws: a cancel that cannot reach the sidecar
   * still has a stop queued behind it, and that is the part that must happen.
   */
  abortStart(id: string): void {
    const session = starting.get(id)
    if (!session || !session.alive()) return
    void session.send('ts.down', { tunnelId: id }).catch(() => undefined)
  },

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

  /**
   * The tailnet's devices, which are the telemetry that matters here.
   *
   * No rx/tx: a mesh has no single pair, and collapsing per-peer counters into
   * one would be inventing a number. The device list travels in `stats()` for
   * the same reason ngrok's URLs do — it is the road that already reaches the
   * profile card, and an accessor nothing calls is a feature nobody can see.
   */
  async stats(id: string): Promise<VpnStats | null> {
    const entry = live.get(id)
    if (!entry) return null
    return {
      rxBytes: 0,
      txBytes: 0,
      tailnetPeers: entry.peers,
      sampledAt: Date.now()
    }
  }
}
