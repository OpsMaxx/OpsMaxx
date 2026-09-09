import { get } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
import { resolveSystem } from '../binaries'

/**
 * ngrok: publishes a local port to a public URL.
 *
 * Supervised normally, unlike the Tailscale driver beside it. The distinction
 * is ownership: `tailscaled` is a machine-wide daemon the user installed and
 * other software depends on, while the ngrok agent is a per-user process with
 * no system state that exists only to serve this profile. Stopping the profile
 * must stop it, and leaving it running would leave a public URL pointing at
 * this machine after the user believed they had closed it.
 *
 * ── What this driver will not do ───────────────────────────────────────────
 *
 * Ship the agent, or fetch it. It is closed-source and not redistributable, so
 * bundling is not available; and auto-downloading it would put an unscanned
 * binary on the user's disk, bypassing the ClamAV, Defender and VirusTotal
 * passes every artifact in a release goes through. frp is handled the same way
 * for the same reason — built from pinned source and checksum-verified, never
 * downloaded at runtime.
 *
 * The practical consequence is a Windows one: choco and winget both install
 * outside the allowlisted roots and this app does not search PATH on Windows,
 * so a Windows user usually has to point the profile at the binary. That is a
 * thing the form should lead with, not report as a failure afterwards.
 *
 * ── The authtoken ─────────────────────────────────────────────────────────
 *
 * Reaches the agent through `NGROK_AUTHTOKEN` in the environment, and appears
 * in no config file and no argv. SupervisedSpec documents why: argv is
 * world-readable through `ps`. Env is not the strongest channel available —
 * `/proc/<pid>/environ` is readable by the same user, and stdin is what this
 * app prefers where an engine will take it — but the ngrok agent has no stdin
 * intake for it, so env is the best available and the residual risk is stated
 * rather than implied away.
 */

/** The agent's own local API. Not configurable by us: this is where it binds. */
const AGENT_API_PORT = 4040
const AGENT_API_HOST = '127.0.0.1'

interface AgentTunnel {
  name?: string
  public_url?: string
  proto?: string
  config?: { addr?: string }
}

interface Live {
  status: VpnStatus
  /**
   * The supervisor, kept so stop() can reach it.
   *
   * stop() takes only an id — it is called by the manager, not by the driver
   * context — so the thing that owns the process has to be remembered from
   * start(). Addressed by profile id rather than by handle, as frp does: a
   * handle is a view of the current attempt, and a run can have several.
   */
  supervisor: VpnDriverContext['supervisor']
  endpoints: NgrokEndpoint[]
  timer: ReturnType<typeof setInterval> | null
}

const live = new Map<string, Live>()
let engine: VpnEngineInfo | null = null

const POLL_MS = 10_000

/** The agent API, which is plain HTTP on loopback and needs no auth. */
function agentApi<T>(path: string, timeoutMs = 4_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const req = get(
      { host: AGENT_API_HOST, port: AGENT_API_PORT, path, timeout: timeoutMs },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => {
          // Bounded: this is a local API, but a bounded read is cheaper than
          // trusting one.
          if (body.length < 1 << 20) body += c
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as T)
          } catch {
            reject(new Error('The ngrok agent returned something that was not JSON.'))
          }
        })
      }
    )
    req.on('timeout', () => {
      req.destroy(new Error('The ngrok agent did not answer in time.'))
    })
    req.on('error', reject)
  })
}

function endpointsFrom(tunnels: AgentTunnel[]): NgrokEndpoint[] {
  return tunnels
    .filter((t) => !!t.public_url)
    .map((t) => ({
      name: t.name ?? 'tunnel',
      publicUrl: t.public_url as string,
      proto: t.proto ?? 'http',
      localAddr: t.config?.addr
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The agent's config file. No secret in it, by construction.
 *
 * Written rather than passed as flags because the flag form cannot express
 * several tunnels, and because a file is what the agent's own documentation
 * describes. The authtoken is deliberately absent: it goes in the environment,
 * so this file can sit in the run directory without being a credential.
 */
/**
 * The allowed shapes for every value that reaches the config.
 *
 * Checked HERE and not only in `validateConfig`, because validateConfig is not
 * on the start path: `start()` reads a stored profile, and a spec can reach it
 * from a restored backup or a file edited by hand without validation ever
 * running. That made this an injection: YAML is newline-delimited, so a
 * `domain` containing a newline could append a whole second tunnel that
 * `spec.tunnels` never held — and therefore one that carried no
 * `acknowledgedExposure` — while a `region` could inject a top-level
 * `authtoken:` or redirect `log:`.
 *
 * An allowlist rather than escaping: every one of these is a hostname, an
 * identifier or a fixed word, so the set of legal characters is small and
 * knowable. Escaping would be a guess about a YAML parser we do not own.
 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
/** A hostname, or `host:port` for a reserved TCP address. */
const SAFE_DOMAIN = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(:\d{1,5})?$/
const SAFE_REGION = /^[a-z]{2,4}$/
const SAFE_PROTO = new Set(['http', 'tcp', 'tls'])

class NgrokConfigError extends Error {}

export function configYaml(spec: NgrokSpec): string {
  /**
   * Config version 2, quoted.
   *
   * Not 3: v3 moved `authtoken` and `log` under an `agent:` block and renamed
   * parts of the tunnel schema, and emitting `version: 3` over a v2-shaped body
   * — top-level `log`, top-level `tunnels` — is a file that matches neither.
   * v2 is still accepted, is the format the tunnel schema below actually is,
   * and takes the authtoken from NGROK_AUTHTOKEN just the same.
   *
   * Quoted, because an unquoted `2` is an integer and the agent expects a
   * string here.
   */
  const lines = ['version: "2"', 'log_level: info', 'log_format: json', 'log: stdout']

  if (spec.region) {
    if (!SAFE_REGION.test(spec.region)) {
      throw new NgrokConfigError(`"${spec.region}" is not a valid ngrok region.`)
    }
    lines.push(`region: ${spec.region}`)
  }

  lines.push('tunnels:')
  for (const t of spec.tunnels) {
    if (!SAFE_NAME.test(t.name)) {
      throw new NgrokConfigError(`"${t.name}" is not a usable endpoint name.`)
    }
    if (!SAFE_PROTO.has(t.proto)) {
      throw new NgrokConfigError(`"${t.proto}" is not a protocol this supports.`)
    }
    if (!Number.isInteger(t.localPort) || t.localPort < 1 || t.localPort > 65535) {
      throw new NgrokConfigError(`${t.localPort} is not a port.`)
    }
    lines.push(`  ${t.name}:`)
    lines.push(`    proto: ${t.proto}`)
    lines.push(`    addr: ${t.localPort}`)
    if (t.domain) {
      if (!SAFE_DOMAIN.test(t.domain)) {
        throw new NgrokConfigError(`"${t.domain}" is not a valid address.`)
      }
      // `domain` for http/tls, `remote_addr` for tcp — the agent rejects the
      // wrong one for the protocol rather than ignoring it.
      lines.push(t.proto === 'tcp' ? `    remote_addr: ${t.domain}` : `    domain: ${t.domain}`)
    }
  }
  return `${lines.join('\n')}\n`
}

export const ngrokDriver: VpnDriver<NgrokSpec> = {
  kind: 'ngrok',

  validateConfig(spec: NgrokSpec): VpnValidation {
    const issues: VpnValidationIssue[] = []

    if (spec.binaryPath && !spec.confirmed) {
      issues.push({
        path: 'binaryPath',
        severity: 'error',
        code: 'unconfirmed-path',
        message: 'Confirm the program path before it is run.'
      })
    }
    if (!spec.authtokenRef) {
      issues.push({
        path: 'authtokenRef',
        severity: 'error',
        code: 'authtoken-missing',
        message: 'ngrok needs an account authtoken. Add it to the vault and select it here.'
      })
    }
    if (spec.region && !SAFE_REGION.test(spec.region)) {
      issues.push({
        path: 'region',
        severity: 'error',
        code: 'region-invalid',
        message: 'Use a region code such as us, eu, ap, au, sa, jp or in.'
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

    // Once, about the profile — not once per tunnel inside the loop, which is
    // where a `tunnels`-level issue does not belong.
    if (spec.tunnels.length > 1) {
      issues.push({
        path: 'tunnels',
        severity: 'warning',
        code: 'multiple-tunnels',
        message:
          'Some ngrok plans allow only one tunnel per agent. If the second one is refused, that is the account rather than this profile.'
      })
    }

    const seen = new Set<string>()
    spec.tunnels.forEach((t, i) => {
      if (!SAFE_NAME.test(t.name)) {
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
          message: `Another tunnel is already called "${t.name}".`
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
      /**
       * The gate, not a preference.
       *
       * An frp proxy is reachable from one server the user runs. An ngrok
       * endpoint is reachable from the whole internet the moment it comes up,
       * by anyone who has or guesses the URL — so this is checked here AND
       * refused again in start(), because validation runs while typing and the
       * profile is what start() reads.
       */
      if (!t.acknowledgedExposure) {
        issues.push({
          path: `tunnels[${i}].acknowledgedExposure`,
          severity: 'error',
          code: 'exposure-unacknowledged',
          message: `Confirm that publishing port ${t.localPort} makes it reachable from the public internet.`
        })
      }
      // Free accounts get one agent session, so several tunnels in one profile
      // is a thing that will fail at the server rather than here. A warning
      // rather than an error: a paid account is fine, and this app does not
      // know which one the user has.
      if (spec.tunnels.length > 1 && i === 0) {
        issues.push({
          path: 'tunnels',
          severity: 'warning',
          code: 'multiple-tunnels',
          message:
            'Some ngrok plans allow only one tunnel per agent. If the second one is refused, that is the account rather than this profile.'
        })
      }
      if (t.domain && !SAFE_DOMAIN.test(t.domain)) {
        issues.push({
          path: `tunnels[${i}].domain`,
          severity: 'error',
          code: 'domain-invalid',
          message: 'Enter a hostname, or host:port for a reserved TCP address.'
        })
      }
      if (!t.domain && i === 0) {
        issues.push({
          path: `tunnels[${i}].domain`,
          severity: 'warning',
          code: 'ephemeral-url',
          message:
            'Without a reserved domain the public URL changes every time this starts, so anything pointing at the old one stops working.'
        })
      }
    })

    return { ok: issues.every((x) => x.severity !== 'error'), issues }
  },

  async probe(): Promise<VpnEngineInfo> {
    if (engine) return engine
    try {
      engine = await resolveSystem('ngrok')
    } catch (e) {
      engine = {
        kind: 'ngrok',
        available: false,
        bundled: false,
        reason:
          e instanceof VpnError
            ? e.message
            : 'The ngrok agent could not be found. Install it, then point this profile at it.'
      }
    }
    return engine
  },

  async start(
    profile: VpnProfile & { spec: NgrokSpec },
    ctx: VpnDriverContext
  ): Promise<VpnStartResult> {
    const spec = profile.spec

    // Refused here as well as in validation: validation runs as the user types,
    // and this is what actually opens a port to the internet.
    const ungated = spec.tunnels.filter((t) => !t.acknowledgedExposure)
    if (ungated.length > 0) {
      return {
        ok: false,
        error: `Confirm the exposure of ${ungated.map((t) => t.name).join(', ')} before starting.`,
        errorCode: 'exposure-unacknowledged'
      }
    }

    const token = ctx.secrets.token
    if (!token) {
      return {
        ok: false,
        error: 'The ngrok authtoken could not be read from the vault.',
        errorCode: 'vault-locked'
      }
    }

    const info = await resolveSystem('ngrok', {
      binaryPath: spec.binaryPath,
      confirmed: spec.confirmed
    }).catch((e: unknown) => {
      ctx.log(e instanceof Error ? e.message : String(e), 'app')
      return null
    })
    if (!info?.path) {
      return {
        ok: false,
        error: 'The ngrok agent could not be found.',
        errorCode: 'binary-missing'
      }
    }

    const configPath = join(ctx.runDir, 'ngrok.yml')
    let body: string
    try {
      body = configYaml(spec)
    } catch (e) {
      // A stored spec that cannot be rendered safely is a refusal, not a crash.
      return {
        ok: false,
        error: e instanceof Error ? e.message : 'This ngrok profile could not be written.',
        errorCode: 'config-invalid'
      }
    }
    await writeFile(configPath, body, { encoding: 'utf8', mode: 0o600 })

    await ctx.supervisor.spawn({
      id: profile.id,
      command: info.path,
      // `start --all` runs every tunnel in the config. The config path is the
      // only argument that varies, and the authtoken is not among them: argv is
      // world-readable through `ps`.
      args: ['start', '--all', '--config', configPath, '--log', 'stdout'],
      env: { NGROK_AUTHTOKEN: token },
      cwd: ctx.runDir,
      readiness: async () => {
        // Up means the agent's own API answers AND at least one tunnel has a
        // public URL. The process being alive is not the same thing: the agent
        // starts, then authenticates, then publishes, and a "connected" reported
        // between the second and third steps is a URL that does not exist yet.
        const res = await agentApi<{ tunnels?: AgentTunnel[] }>('/api/tunnels')
        if (endpointsFrom(res.tunnels ?? []).length === 0) {
          throw new Error('The ngrok agent is running but has not published anything yet.')
        }
      },
      readinessTimeoutMs: 30_000,
      healthCheck: async () => {
        await agentApi<unknown>('/api/tunnels')
      },
      healthIntervalMs: 30_000,
      restart: 'on-failure',
      backoff: { baseMs: 2_000, maxMs: 60_000, jitter: 0.3 },
      crashLoop: { windowMs: 120_000, maxRestarts: 5 },
      logRing: { maxLines: 2_000, maxBytes: 1 << 20 },
      // The token, so it can never reach the log ring the UI renders.
      redact: [...ctx.secrets.all, token],
      kind: 'ngrok',
      profileId: profile.id,
      noun: 'tunnel'
    })

    let endpoints: NgrokEndpoint[] = []
    try {
      const res = await agentApi<{ tunnels?: AgentTunnel[] }>('/api/tunnels')
      endpoints = endpointsFrom(res.tunnels ?? [])
    } catch {
      // Readiness already proved the API answers; a failure here is a race and
      // the poll below will fill it in.
    }
    for (const e of endpoints) ctx.log(`published ${e.name} at ${e.publicUrl}`, 'app')

    const status: VpnStatus = {
      id: profile.id,
      kind: 'ngrok',
      state: 'connected',
      since: Date.now(),
      restarts: 0
    }
    const entry: Live = { status, supervisor: ctx.supervisor, endpoints, timer: null }
    live.set(profile.id, entry)
    ctx.emit(status)

    entry.timer = setInterval(() => {
      void (async () => {
        const current = live.get(profile.id)
        if (!current) return
        try {
          const res = await agentApi<{ tunnels?: AgentTunnel[] }>('/api/tunnels')
          current.endpoints = endpointsFrom(res.tunnels ?? [])
        } catch {
          // Not `dropped`: the supervisor's own health check owns that
          // decision, and two things deciding the run is dead races them.
          // A poll that missed once is a poll that missed once.
        }
      })()
    }, POLL_MS)
    if (typeof entry.timer.unref === 'function') entry.timer.unref()

    return { ok: true, listeners: listenersFor(spec) }
  },

  async stop(id: string, opts?: { force?: boolean }): Promise<void> {
    const entry = live.get(id)
    if (entry?.timer) clearInterval(entry.timer)
    live.delete(id)
    // The supervisor owns the process; it knows about graceful stop, timeouts
    // and Windows' lack of SIGTERM. Addressed by profile id, as frp does —
    // the handle is a view of the current attempt, not the run.
    await entry?.supervisor.stop(id, { force: opts?.force }).catch(() => undefined)
  },

  status(id: string): VpnStatus | null {
    return live.get(id)?.status ?? null
  },

  /**
   * The published endpoints, which are the telemetry that matters here.
   *
   * No rx/tx: the agent reports per-tunnel counters and summing several into
   * one pair would be a number nobody asked for. What a user needs is the
   * public URL — assigned by the server, different on every run without a
   * reserved domain, and available nowhere else in the app. It travels in
   * `stats()` for the same reason frp's proxy table does.
   */
  async stats(id: string): Promise<VpnStats | null> {
    const entry = live.get(id)
    if (!entry) return null
    return {
      rxBytes: 0,
      txBytes: 0,
      endpoints: entry.endpoints,
      sampledAt: Date.now()
    }
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

/** The public URLs, for the UI. Empty until the agent has published. */
export function ngrokEndpoints(id: string): NgrokEndpoint[] {
  return live.get(id)?.endpoints ?? []
}
