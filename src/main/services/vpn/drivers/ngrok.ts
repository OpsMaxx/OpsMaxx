import type {
  NgrokEndpoint,
  NgrokSpec,
  NgrokTunnel,
  VpnBoundListener,
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
 * ngrok, running inside the bundled sidecar.
 *
 * No agent binary anywhere. `golang.ngrok.com/ngrok/v2` is MIT and opens
 * endpoints from inside `opsmaxx-netd`, so a machine that has never heard of
 * ngrok can publish a port. The agent IS closed-source and genuinely could not
 * be shipped — which is true, and which is a different question from whether
 * ngrok can be embedded. Answering only the first is how this driver previously
 * ended up requiring an install the app could not perform.
 *
 * ── The gate ───────────────────────────────────────────────────────────────
 *
 * Starting this makes a port on this machine reachable from the whole internet,
 * immediately, by anyone with the URL. That is a stronger claim than any other
 * tunnel in this app makes — an frp proxy reaches one server the user runs — so
 * every endpoint carries an explicit acknowledgement, checked in validation AND
 * again at start. Validation runs while somebody types; start reads a stored
 * profile, which can arrive from a restored backup.
 */

/**
 * One endpoint EXACTLY as the sidecar sends it.
 *
 * Separate from `NgrokEndpoint`, which is the app's own shape, because the two
 * disagree and reading the reply as the domain type made that disagreement
 * invisible: the sidecar's field is `url` (see `NgrokEndpointResult` in
 * sidecar/netd/ngrok.go) and the domain field is `publicUrl`, so every endpoint
 * arrived with `publicUrl: undefined`. The status carried an endpoint list with
 * no addresses in it, the log line read "published web at undefined", and the
 * card rendered an empty span -- a tunnel that was genuinely up and would not
 * say where.
 *
 * It survived a test because the test stubbed the reply in the DOMAIN shape,
 * which is the one shape the sidecar never sends. tests/ngrokWireShape.test.ts
 * now reads the Go struct's json tags directly, so the two cannot drift again
 * without something going red.
 */
interface NgrokEndpointWire {
  name: string
  url: string
  proto: string
  localAddr?: string
}

function fromWire(e: NgrokEndpointWire): NgrokEndpoint {
  return { name: e.name, publicUrl: e.url, proto: e.proto, localAddr: e.localAddr }
}

const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
/** A hostname, or `host:port` for a reserved TCP address. */
const DOMAIN_OK = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(:\d{1,5})?$/

interface Live {
  status: VpnStatus
  session: NetdSession
  endpoints: NgrokEndpoint[]
}

const live = new Map<string, Live>()
let engine: VpnEngineInfo | null = null

export const ngrokDriver: VpnDriver<NgrokSpec> = {
  kind: 'ngrok',

  validateConfig(spec: NgrokSpec): VpnValidation {
    const issues: VpnValidationIssue[] = []

    if (!spec.authtokenRef) {
      issues.push({
        path: 'authtokenRef',
        severity: 'error',
        code: 'authtoken-missing',
        message: 'ngrok needs an account authtoken. Add it to the vault and select it here.'
      })
    }
    if (spec.tunnels.length === 0) {
      issues.push({
        path: 'tunnels',
        severity: 'error',
        code: 'no-tunnels',
        message: 'Add at least one port to publish.'
      })
    }
    if (spec.tunnels.length > 1) {
      issues.push({
        path: 'tunnels',
        severity: 'warning',
        code: 'multiple-tunnels',
        message:
          'Some ngrok plans allow only one endpoint per session. If a second is refused, that is the account rather than this profile.'
      })
    }

    const seen = new Set<string>()
    spec.tunnels.forEach((t, i) => {
      if (!NAME_OK.test(t.name)) {
        issues.push({
          path: `tunnels[${i}].name`,
          severity: 'error',
          code: 'name-invalid',
          message: 'Use letters, digits, dashes and underscores.'
        })
      }
      if (seen.has(t.name)) {
        issues.push({
          path: `tunnels[${i}].name`,
          severity: 'error',
          code: 'name-duplicate',
          message: `Another endpoint is already called "${t.name}".`
        })
      }
      seen.add(t.name)
      if (!Number.isInteger(t.localPort) || t.localPort < 1 || t.localPort > 65535) {
        issues.push({
          path: `tunnels[${i}].localPort`,
          severity: 'error',
          code: 'port-invalid',
          message: 'Enter a port between 1 and 65535.'
        })
      }
      if (t.domain && !DOMAIN_OK.test(t.domain)) {
        issues.push({
          path: `tunnels[${i}].domain`,
          severity: 'error',
          code: 'domain-invalid',
          message: 'Enter a hostname, or host:port for a reserved TCP address.'
        })
      }
      // Per endpoint, not just the first: the second is exactly the one someone
      // adds later without re-reading the first one's caveats.
      if (!t.domain) {
        issues.push({
          path: `tunnels[${i}].domain`,
          severity: 'warning',
          code: 'ephemeral-url',
          message:
            'Without a reserved domain the public URL changes every time this starts, so anything pointing at the old one stops working.'
        })
      }
      if (!t.acknowledgedExposure) {
        issues.push({
          path: `tunnels[${i}].acknowledgedExposure`,
          severity: 'error',
          code: 'exposure-unacknowledged',
          message: `Confirm that publishing port ${t.localPort} makes it reachable from the public internet.`
        })
      }
    })

    return { ok: issues.every((x) => x.severity !== 'error'), issues }
  },

  async probe(): Promise<VpnEngineInfo> {
    if (engine) return engine
    try {
      const info = await resolveBundled('opsmaxx-netd')
      engine = { ...info, kind: 'ngrok' }
    } catch (e) {
      engine = {
        kind: 'ngrok',
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
    profile: VpnProfile & { spec: NgrokSpec },
    ctx: VpnDriverContext
  ): Promise<VpnStartResult> {
    const spec = profile.spec

    if (live.has(profile.id)) {
      return { ok: false, error: 'This profile is already running.', errorCode: 'already-running' }
    }

    // Re-checked here and not only in validation: validation runs as the user
    // types, and this is what actually opens a port to the internet.
    const ungated = spec.tunnels.filter((t) => !t.acknowledgedExposure)
    if (ungated.length > 0) {
      return {
        ok: false,
        error: `Confirm the exposure of ${ungated.map((t) => t.name).join(', ')} before starting.`,
        errorCode: 'exposure-unacknowledged'
      }
    }
    // The same shape rules the sidecar would apply, applied before anything is
    // spawned — a refusal with no process started is cheaper and clearer.
    for (const t of spec.tunnels) {
      if (!NAME_OK.test(t.name) || (t.domain && !DOMAIN_OK.test(t.domain))) {
        return {
          ok: false,
          error: `Endpoint "${t.name}" is not valid.`,
          errorCode: 'config-invalid'
        }
      }
    }

    const authtoken = ctx.secrets.token
    if (!authtoken) {
      return {
        ok: false,
        error: 'The ngrok authtoken could not be read from the vault.',
        errorCode: 'vault-locked'
      }
    }

    let session: NetdSession
    try {
      session = await openNetdSession(profile.id, ctx, 'ngrok')
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : 'The sidecar could not be started.',
        errorCode: e instanceof VpnError ? e.code : 'engine-failed'
      }
    }

    try {
      const reply = await session.send<{ endpoints: NgrokEndpointWire[] }>(
        'ngrok.up',
        {
          tunnelId: profile.id,
          // Per call, from the vault. It is never written to a config file and
          // never placed on a command line.
          authtoken,
          endpoints: spec.tunnels.map((t) => ({
            name: t.name,
            proto: t.proto,
            localPort: t.localPort,
            domain: t.domain
          })),
          timeoutMs: 60_000
        },
        75_000
      )

      const endpoints = reply.endpoints.map(fromWire)
      for (const e of endpoints) ctx.log(`published ${e.name} at ${e.publicUrl}`, 'app')

      // The public URLs ride along with the status that announces the
      // connection. `stats()` is only polled on a wake nudge, so a card that
      // waited for one would sit there saying "connected" and nothing else --
      // and the URL, assigned fresh on every run without a reserved domain, is
      // the whole reason the user started the tunnel.
      const status: VpnStatus = {
        id: profile.id,
        kind: 'ngrok',
        state: 'connected',
        since: Date.now(),
        restarts: 0,
        stats: {
          rxBytes: 0,
          txBytes: 0,
          endpoints,
          sampledAt: Date.now()
        }
      }
      live.set(profile.id, { status, session, endpoints })

      // An endpoint that stops serving without being asked to.
      //
      // `dropped` rather than `emit`, because emitting only updates the status
      // bus: the manager would still hold the Live entry, its session and its
      // resolved secrets, and `hasLiveVpnDependents` would go on saying this
      // profile was up. See the note on VpnDriverContext.dropped.
      session.onEvent((event, data) => {
        // Two ways this tunnel stops being real, and the card was honest about
        // neither: one endpoint stops serving, or the engine holding all of
        // them goes away. The second cannot announce itself -- a process that
        // has exited sends nothing -- so netdSession synthesises it.
        if (event !== 'ngrok.endpoint.down' && event !== 'sidecar.exit') return
        if (live.get(profile.id)?.session !== session) return
        const d = data as { name?: string; error?: string; reason?: string } | undefined
        live.delete(profile.id)
        void session.close()
        ctx.dropped(
          event === 'sidecar.exit'
            ? (d?.reason ?? 'The network sidecar stopped, so the public address is gone.')
            : `ngrok stopped serving ${d?.name ?? 'an endpoint'}${d?.error ? `: ${d.error}` : ''}`,
          'engine-failed'
        )
      })

      ctx.emit(status)
      return { ok: true, listeners: listenersFor(spec) }
    } catch (e) {
      await session.close()
      return {
        ok: false,
        error: e instanceof Error ? e.message : 'The endpoints could not be published.',
        errorCode: e instanceof VpnError ? e.code : 'engine-failed'
      }
    }
  },

  /**
   * Stopping means the URL stops resolving to this machine.
   *
   * Which is why this tears the endpoints down explicitly before killing the
   * process rather than relying on the kill: a published address that outlives
   * the thing serving it still resolves, and points at nothing.
   */
  async stop(id: string): Promise<void> {
    const entry = live.get(id)
    if (!entry) return
    live.delete(id)
    try {
      if (entry.session.alive()) {
        await entry.session.send<unknown>('ngrok.down', { tunnelId: id }, 15_000)
      }
    } catch {
      // close() stops the process regardless.
    }
    await entry.session.close()
  },

  status(id: string): VpnStatus | null {
    return live.get(id)?.status ?? null
  },

  /**
   * The published endpoints, which are the telemetry that matters here.
   *
   * No rx/tx: what a user needs is the public URL — assigned by ngrok, different
   * on every run without a reserved domain, and available nowhere else in the
   * app. It travels in `stats()` for the same reason frp's proxy table does.
   */
  async stats(id: string): Promise<VpnStats | null> {
    const entry = live.get(id)
    if (!entry) return null
    return { rxBytes: 0, txBytes: 0, endpoints: entry.endpoints, sampledAt: Date.now() }
  }
}

/**
 * What this profile publishes FROM this machine.
 *
 * The local ports, not the public URLs: this field is labelled "listening on"
 * in the UI, and a remote address there would be wrong in the same way the frp
 * driver's note says a proxy's remote port would be.
 */
function listenersFor(spec: NgrokSpec): VpnBoundListener[] {
  return spec.tunnels.map((t: NgrokTunnel) => ({
    kind: t.proto,
    bindHost: '127.0.0.1',
    bindPort: t.localPort
  }))
}

/** The public URLs, for the UI. Empty until the sidecar has published. */
export function ngrokEndpoints(id: string): NgrokEndpoint[] {
  return live.get(id)?.endpoints ?? []
}
