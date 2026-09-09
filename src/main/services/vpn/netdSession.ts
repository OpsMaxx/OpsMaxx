import type { VpnKind } from '../../../shared/vpn'
import type { VpnDriverContext } from './driver'
import { VpnError } from './errors'
import { resolveBundled } from './binaries'

/**
 * One request/response session with the bundled sidecar.
 *
 * Tailscale and ngrok both run INSIDE `opsmaxx-netd` now, so both need the same
 * thing: spawn it, speak NDJSON over its stdio, match responses to requests by
 * id, and route its log lines into the profile's log ring.
 *
 * Deliberately separate from the WireGuard driver's own copy of this rather
 * than extracted from it. That driver's session is entangled with elevation,
 * crash-loop handling, UAPI state and a privileged variant — none of which
 * applies here, because a tsnet node and an ngrok listener are both plain
 * userspace and need no privilege at all. Factoring the two together would mean
 * touching the one path in this subsystem that is hardest to test and easiest
 * to break, to save a hundred lines in the two that are neither.
 */

const NETD = 'opsmaxx-netd'

/** The sidecar's reply frame. */
interface Frame {
  id?: string
  ok?: boolean
  result?: unknown
  error?: { code?: string; message?: string }
  event?: string
  data?: unknown
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface NetdSession {
  /** Call one method. Rejects with a VpnError carrying the sidecar's code. */
  send<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
  /** Stop the sidecar. Safe to call more than once. */
  close(): Promise<void>
  /** True until close() or an exit. */
  alive(): boolean
}

const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Spawn the sidecar and return a session.
 *
 * `id` is the profile id, so the supervisor's own bookkeeping and the log lines
 * both point back at the profile a user is looking at.
 */
export async function openNetdSession(
  id: string,
  ctx: VpnDriverContext,
  kind: VpnKind
): Promise<NetdSession> {
  const engine = await resolveBundled(NETD)
  if (!engine.available || !engine.path) {
    throw new VpnError(
      'binary-missing',
      engine.reason ?? 'The bundled network sidecar could not be found.'
    )
  }

  const pending = new Map<string, Pending>()
  let seq = 0
  let closed = false
  let buffer = ''

  const settleAll = (err: Error): void => {
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    pending.clear()
  }

  const handleLine = (line: string): void => {
    const text = line.trim()
    if (!text) return
    let frame: Frame
    try {
      frame = JSON.parse(text) as Frame
    } catch {
      // Not a protocol frame. The sidecar routes its own logging through the
      // `log` event precisely so this cannot happen, so a line here is worth
      // keeping rather than dropping — it is usually a runtime writing to
      // stdout before main() ever ran.
      ctx.log(text, 'stderr')
      return
    }

    if (frame.event) {
      // `log` carries {level, tunnelId, msg}; anything else is a state event
      // the caller does not subscribe to here.
      const d = frame.data as { level?: string; msg?: string } | undefined
      if (frame.event === 'log' && d?.msg) ctx.log(d.msg, 'ctl')
      return
    }

    if (!frame.id) return
    const p = pending.get(frame.id)
    if (!p) return
    pending.delete(frame.id)
    clearTimeout(p.timer)
    if (frame.ok) p.resolve(frame.result)
    else {
      p.reject(
        new VpnError(
          (frame.error?.code as VpnError['code']) ?? 'internal',
          frame.error?.message ?? 'The sidecar refused the request.'
        )
      )
    }
  }

  const handle = await ctx.supervisor.spawn({
    id,
    command: engine.path,
    args: [],
    cwd: ctx.runDir,
    // Nothing to wait for beyond the process being up: this sidecar answers
    // `ping` as soon as its read loop is running, and the first real call is
    // what actually proves it.
    readiness: async (h) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('the sidecar did not start')), 15_000)
        // The supervisor resolves its own spawn before this runs, so a single
        // tick is enough to let the pipes attach.
        setImmediate(() => {
          clearTimeout(t)
          resolve()
        })
        void h
      })
    },
    readinessTimeoutMs: 20_000,
    // Never restarted by the supervisor. A tsnet node that died has lost its
    // tailnet session and an ngrok endpoint that died has lost its public URL;
    // silently respawning would produce a process that is up and a tunnel that
    // is not, which is the state hardest to diagnose. The driver reports it
    // dropped instead, and the user restarts the profile.
    restart: 'never',
    backoff: { baseMs: 1_000, maxMs: 30_000, jitter: 0.3 },
    crashLoop: { windowMs: 120_000, maxRestarts: 3 },
    logRing: { maxLines: 2_000, maxBytes: 1 << 20 },
    // Whatever the caller resolved from the vault, so nothing reaches the ring.
    redact: [...ctx.secrets.all],
    kind,
    profileId: id,
    noun: 'tunnel'
  })

  handle.onLog((l) => {
    // stdout is the protocol channel; stderr is the sidecar's own diagnostics.
    if (l.stream === 'stdout') {
      buffer += l.text + '\n'
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        handleLine(buffer.slice(0, nl))
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
      }
    } else {
      ctx.log(l.text, l.stream)
    }
  })

  handle.onExit((e) => {
    closed = true
    settleAll(
      new VpnError('engine-stopped', `The sidecar stopped (${e.code ?? e.signal ?? 'unknown'}).`)
    )
  })

  return {
    alive: () => !closed,
    send<T>(method: string, params?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
      if (closed) {
        return Promise.reject(new VpnError('engine-stopped', 'The sidecar is not running.'))
      }
      const reqId = String(++seq)
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(reqId)
          reject(
            new VpnError(
              'handshake-timeout',
              `The sidecar did not answer ${method} in ${Math.round(timeoutMs / 1000)}s.`
            )
          )
        }, timeoutMs)
        pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject, timer })
        handle.write(`${JSON.stringify({ id: reqId, method, params })}\n`)
      })
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      settleAll(new VpnError('engine-stopped', 'The tunnel was stopped.'))
      await handle.kill().catch(() => undefined)
    }
  }
}
