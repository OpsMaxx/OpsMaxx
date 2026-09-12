import net from 'node:net'
import { remoteText } from '../../shared/remoteText'
import tls from 'node:tls'
import http from 'node:http'
import type { Duplex } from 'node:stream'
import {
  MAX_REDIRECT_HOPS,
  MAX_RESPONSE_BYTES,
  REDIRECT_STATUSES,
  clampTimeout,
  isPinnedOrigin,
  methodAllowsBody,
  parseTarget,
  sanitizeHeaders,
  stripCredentialHeaders,
  type HttpRequestSpec,
  type HttpResponseOk,
  type HttpResult,
  type HttpSshTarget
} from '../../shared/httpClient'
import { acquire, release, type PooledConnection } from './ssh'

/**
 * Executes the HTTP client's requests.
 *
 * Every request is built the same way: open a transport, optionally wrap it in
 * TLS, then speak HTTP over it. The only thing `via` changes is where the
 * transport comes from — a TCP socket from this machine, a direct-tcpip
 * channel on a server's existing SSH connection, or a loopback forward into a
 * VPN. Keeping one path means a request through a server behaves identically
 * to a direct one, including timeouts, the response cap and the redirect rules
 * below.
 *
 * Redirects are `sendOnce` called again on the `Location`, and only when the
 * caller asked for them (`maxRedirects`). A hop to a different origin keeps
 * only `CROSS_ORIGIN_SAFE_HEADERS` and loses the transport and the TLS
 * relaxations with them; nothing that was granted to the host the user named
 * follows a Location to a host the far end named.
 */

/**
 * ssh2's channel is a Duplex, and Node's HTTP client expects a net.Socket. The
 * missing pieces are all connection-management no-ops on a stream that is
 * already multiplexed inside an SSH connection: there is no Nagle to disable
 * and no event loop handle to ref. Without them the request throws on the
 * first `setNoDelay` rather than sending anything.
 */
function asSocket(stream: Duplex): net.Socket {
  const shim = stream as unknown as net.Socket & Record<string, unknown>
  if (typeof shim.setNoDelay !== 'function') shim.setNoDelay = () => shim
  if (typeof shim.setKeepAlive !== 'function') shim.setKeepAlive = () => shim
  if (typeof shim.ref !== 'function') shim.ref = () => shim
  if (typeof shim.unref !== 'function') shim.unref = () => shim
  // http.ClientRequest sets its own timeout on the socket. A channel has none,
  // so the request-level timer below is what actually enforces it.
  if (typeof shim.setTimeout !== 'function') shim.setTimeout = () => shim
  return shim
}

function tcpConnect(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    const fail = (err: Error): void => {
      socket.destroy()
      reject(err)
    }
    socket.setTimeout(timeoutMs, () => fail(new Error(`Timed out connecting to ${host}:${port}`)))
    socket.once('connect', () => {
      socket.setTimeout(0)
      socket.removeListener('error', fail)
      resolve(socket)
    })
    socket.once('error', fail)
  })
}

/**
 * A direct-tcpip channel from the server to the request's host and port. The
 * server resolves the hostname, which is the whole point: `localhost` is the
 * server's loopback, and a private name resolves in the server's network.
 */
function forwardOut(conn: PooledConnection, host: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    conn.client.forwardOut('127.0.0.1', 0, host, port, (err, stream) =>
      err ? reject(err) : resolve(stream as unknown as Duplex)
    )
  })
}

/** TLS on top of an already-open transport, so every `via` mode shares it. */
function startTls(
  socket: Duplex,
  servername: string,
  insecure: boolean,
  timeoutMs: number,
  caPem?: string
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({
      socket: asSocket(socket),
      // SNI. Omitted for an IP literal, which is not a valid SNI value and
      // makes some servers abort the handshake outright.
      ...(net.isIP(servername) ? {} : { servername }),
      // A private CA for this request only. Node replaces the root store when
      // `ca` is set, so the system roots go back in alongside it — a company CA
      // for the internal Jenkins must not stop the same session reaching
      // github.com. Verification stays on either way: this is the opposite of
      // `insecureTls`, not a softer spelling of it.
      ...(caPem ? { ca: [caPem, ...tls.rootCertificates] } : {}),
      rejectUnauthorized: !insecure
    })
    const timer = setTimeout(() => {
      secure.destroy()
      reject(new Error('Timed out during the TLS handshake'))
    }, timeoutMs)
    secure.once('secureConnect', () => {
      clearTimeout(timer)
      resolve(secure)
    })
    secure.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/**
 * A TCP connection that has actually gone through a VPN profile.
 *
 * This is the third copy of `vpnStart` → `vpnOpenForward` →
 * `unsupported`-means-system-mode → `registerVpnConsumer` (`db.ts:104-160` and
 * `ssh.ts:459-490` are the other two), and three copies is where the pattern is
 * usually worth a shared helper. Extracting it means refactoring two working
 * subsystems, so it is not done here — but writing the third copy without
 * saying so is how the fourth gets written.
 *
 * Both imports are dynamic, as in the existing callers: the VPN manager pulls
 * in the whole driver set, and a request that never touches a VPN should not
 * pay for it.
 */
async function vpnConnect(
  vpnProfileId: string,
  host: string,
  port: number,
  timeoutMs: number
): Promise<{ socket: net.Socket; close: () => void }> {
  const { vpnOpenForward, vpnStart } = await import('./vpn/manager')

  // First, and before anything can time out downstream. A profile that failed
  // to come up has a real reason, and an ETIMEDOUT twenty seconds later hides
  // it behind something that looks like a broken CI server.
  const started = await vpnStart(vpnProfileId)
  if (!started.ok) {
    throw new Error(started.error ?? 'The VPN for this request could not be started.')
  }

  const consumer = { kind: 'cicd' as const, id: `${host}:${port}`, name: host }
  let fwd: { port: number; close: () => void } | null = null
  try {
    fwd = await vpnOpenForward(vpnProfileId, host, port, consumer)
  } catch (err) {
    // System mode has a real route and nothing to forward through. Anything
    // else is a genuine failure.
    if ((err as { code?: string }).code !== 'unsupported') throw err
  }

  if (!fwd) {
    // Still register: stopping the profile would cut this request, and the
    // confirmation has to be able to say so.
    const { registerVpnConsumer } = await import('./vpn/dependencies')
    const release = registerVpnConsumer(vpnProfileId, consumer)
    try {
      return {
        socket: await tcpConnect(host, port, timeoutMs),
        close: release
      }
    } catch (err) {
      release()
      throw err
    }
  }

  const local = fwd
  try {
    return {
      socket: await tcpConnect('127.0.0.1', local.port, timeoutMs),
      close: local.close
    }
  } catch (err) {
    local.close()
    throw err
  }
}

/** Node attaches a `code` to transport errors; surfacing it lets the UI explain the failure. */
function codeOf(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * Why a request that the caller routed through a server or a VPN did not go
 * that way.
 *
 * Without this the user sees `getaddrinfo ENOTFOUND ghes-blob.internal` — a
 * hostname they never typed — and, on the refused branch, advice to "send the
 * request through that server", which is precisely what they configured. The
 * mechanism is invisible: a third party chose the second host, and the route
 * they granted the first host does not extend to it.
 */
function explainDroppedRoute(
  error: string,
  dropped: { from: string; to: string; hadRoute: boolean }
): string {
  // The ECONNREFUSED tail is actively wrong here — it tells them to do the
  // thing the policy just declined to do — so it is cut rather than appended to.
  const bare = error.replace(
    / — nothing is listening there\. If the service is bound to the server's loopback, send the request through that server\./,
    ''
  )
  const what = dropped.hadRoute
    ? 'was reached from this machine rather than through the route you configured'
    : 'was reached with normal certificate checking'
  return (
    `${bare} — ${remoteText(dropped.to, 120)} ${what}: ` +
    `${remoteText(dropped.from, 120)} redirected there, and a redirect target does not inherit ` +
    'the route, private CA or certificate exemption you granted the host you named.'
  )
}

function messageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  // Node's self-signed message is accurate but tells the user nothing about
  // what to do, and this is by far the most common failure against internal
  // services. Name the toggle that fixes it.
  if (/self[- ]signed certificate/i.test(raw)) {
    return `${raw} — turn on "Skip certificate check" for this request if that is expected.`
  }
  if (codeOf(err) === 'ECONNREFUSED') {
    return `${raw} — nothing is listening there. If the service is bound to the server's loopback, send the request through that server.`
  }
  return raw
}

export interface HttpRequestContext {
  /**
   * Merges the server's stored credentials into the hop the renderer sent, and
   * rewrites the first hop when the server sits behind a VPN. Supplied by
   * main's IPC layer — the same `resolveChainSecrets`/`withVpnTransport`
   * pipeline the terminal and SFTP go through — so this service never reads
   * secrets itself and stays unit-testable with a stub.
   */
  prepare: (target: HttpSshTarget) => HttpSshTarget
}

/** One request over one transport. `httpRequest` calls it once per redirect hop. */
interface Hop {
  url: string
  /** Already uppercased. */
  method: string
  /** Already sanitized, and already stripped if this hop crossed an origin. */
  headers: Record<string, string>
  body?: ArrayBuffer
}

async function sendOnce(
  hop: Hop,
  spec: HttpRequestSpec,
  ctx: HttpRequestContext
): Promise<HttpResult> {
  const target = parseTarget(hop.url)
  if ('error' in target) return { ok: false, error: target.error }

  const timeoutMs = clampTimeout(spec.timeoutMs)
  const { method, headers } = hop

  let conn: PooledConnection | null = null
  let transport: Duplex | null = null
  let closeVpn: (() => void) | null = null

  try {
    if (spec.via.kind === 'server') {
      conn = await acquire(ctx.prepare(spec.via.server))
      transport = await forwardOut(conn, target.hostname, target.port)
    } else if (spec.via.kind === 'vpn') {
      const dialled = await vpnConnect(
        spec.via.vpnProfileId,
        target.hostname,
        target.port,
        timeoutMs
      )
      transport = dialled.socket
      closeVpn = dialled.close
    } else {
      transport = await tcpConnect(target.hostname, target.port, timeoutMs)
    }

    const socket = target.tls
      ? await startTls(transport, target.hostname, spec.insecureTls === true, timeoutMs, spec.caPem)
      : asSocket(transport)

    return await new Promise<HttpResult>((resolve) => {
      const started = Date.now()
      let settled = false
      const finish = (result: HttpResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }

      const timer = setTimeout(() => {
        request.destroy()
        socket.destroy()
        finish({ ok: false, error: `Timed out after ${timeoutMs}ms`, code: 'ETIMEDOUT' })
      }, timeoutMs)

      // `createConnection` is an AGENT option, not a request option: with
      // `agent: false` Node builds its own agent and ignores it, opening a
      // fresh TCP connection instead — which would silently dial the target
      // directly even when the user asked to go through a server, and would
      // redo TLS with verification back on. Handing the socket over on a real
      // agent is the only way it is actually used.
      //
      // `http` rather than `https` even for TLS targets, because the socket is
      // already encrypted by startTls above. `https` would try to negotiate TLS
      // a second time, inside the tunnel it just built.
      const agent = new http.Agent({ keepAlive: false, maxSockets: 1 })
      agent.createConnection = () => socket

      const request = http.request(
        {
          method,
          // Still needed: they build the request line and the Host header.
          host: target.hostname,
          port: target.port,
          path: target.path,
          headers,
          // One request per transport. Keeping it alive would strand an SSH
          // channel for every request the user ever sent.
          agent
        },
        (res) => {
          const chunks: Buffer[] = []
          let size = 0
          let truncated = false

          res.on('data', (chunk: Buffer) => {
            if (truncated) return
            if (size + chunk.length > MAX_RESPONSE_BYTES) {
              chunks.push(chunk.subarray(0, MAX_RESPONSE_BYTES - size))
              size = MAX_RESPONSE_BYTES
              truncated = true
              res.destroy()
              return
            }
            chunks.push(chunk)
            size += chunk.length
          })

          const done = (): void => {
            const body = Buffer.concat(chunks)
            finish({
              ok: true,
              status: res.statusCode ?? 0,
              statusText: res.statusMessage ?? '',
              headers: Object.fromEntries(
                Object.entries(res.headers).map(([k, v]) => [
                  k,
                  Array.isArray(v) ? v.join(', ') : String(v ?? '')
                ])
              ),
              body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
              durationMs: Date.now() - started,
              truncated
            })
          }
          res.on('end', done)
          // A capped body destroys the stream, which ends it via `close`
          // rather than `end`. Without this the response never resolves.
          res.on('close', done)
          res.on('error', (err) => finish({ ok: false, error: messageOf(err), code: codeOf(err) }))
        }
      )

      request.on('error', (err) => finish({ ok: false, error: messageOf(err), code: codeOf(err) }))
      if (hop.body && methodAllowsBody(method)) request.write(Buffer.from(hop.body))
      request.end()
    })
  } catch (err) {
    return { ok: false, error: messageOf(err), code: codeOf(err) }
  } finally {
    // The channel belongs to this request; the pooled SSH connection does not.
    try {
      transport?.destroy()
    } catch {
      /* a transport that never opened has nothing to close */
    }
    if (conn) release(conn)
    // Same rule for a VPN forward: it was opened for this request, including
    // the one that failed, and a listener per attempt would leak.
    try {
      closeVpn?.()
    } catch {
      /* already closed with the tunnel */
    }
  }
}

function locationOf(res: HttpResponseOk): string | null {
  if (!REDIRECT_STATUSES.has(res.status)) return null
  const raw = Object.entries(res.headers).find(([k]) => k.toLowerCase() === 'location')?.[1]
  return raw && raw.trim() !== '' ? raw.trim() : null
}

export async function httpRequest(
  spec: HttpRequestSpec,
  ctx: HttpRequestContext
): Promise<HttpResult> {
  const maxHops = Math.min(Math.max(Math.floor(spec.maxRedirects ?? 0), 0), MAX_REDIRECT_HOPS)
  const { headers } = sanitizeHeaders(spec.headers ?? {})

  // Set when a cross-origin hop lost the route or the TLS relaxations, so a
  // later failure can say why it was reached the way it was.
  let dropped: { from: string; to: string; hadRoute: boolean } | null = null
  let hop: Hop = {
    url: spec.url,
    method: (spec.method || 'GET').toUpperCase(),
    headers,
    body: spec.body
  }

  // The per-hop spec, which is the original one only until a Location moves the
  // request to another origin. See the cross-origin branch below for why.
  let hopSpec = spec

  for (let hops = 0; ; hops++) {
    const res = await sendOnce(hop, hopSpec, ctx)
    // A caller that did not ask to follow gets the 3xx itself, which is what
    // every caller before `maxRedirects` existed relied on.
    if (!res.ok && dropped) return { ...res, error: explainDroppedRoute(res.error, dropped) }
    if (!res.ok || maxHops === 0) return res

    const location = locationOf(res)
    if (location === null) return res
    if (hops >= maxHops) {
      return {
        ok: false,
        error: `Stopped after ${maxHops} redirect${maxHops === 1 ? '' : 's'}; ${remoteText(hop.url, 120)} redirected again.`,
        code: 'ETOOMANYREDIRECTS'
      }
    }

    let next: string
    try {
      next = new URL(location, hop.url).toString()
    } catch {
      return {
        ok: false,
        // `location` is a header the far end wrote. It reaches the UI and, for
        // a CI connection, MCP tool results — so it is flattened and capped on
        // the way into a message the same way any other remote text is. A
        // Location carrying a bidi override would otherwise reverse the
        // sentence it lands in.
        error: `The redirect pointed at something that is not a URL: ${remoteText(location, 120)}`
      }
    }

    // The one rule that matters. GitHub answers a job-log request with a 302
    // to a signed blob URL on another origin, and that URL rejects an
    // Authorization header — forwarding the PAT there would both fail and hand
    // the token to whatever the Location named.
    const crossOrigin = !isPinnedOrigin(next, hop.url)
    const nextHeaders = crossOrigin ? stripCredentialHeaders(hop.headers).headers : hop.headers

    // A PER-HOST TRUST DECISION MUST NOT BECOME A GLOBAL ONE FOR THE LENGTH OF
    // A REDIRECT CHAIN. `via`, `insecureTls` and `caPem` are all answers to the
    // question "what do I grant THIS host", asked once about the URL the user
    // typed. The far end chooses where the next hop goes, so on an origin
    // change all three are dropped and stay dropped:
    //
    //   - `via` is the serious one. A self-hosted GitLab or Jenkins answering
    //     `302 Location: http://10.0.0.5:8080/admin` would otherwise have that
    //     URL fetched through the user's SSH direct-tcpip channel or VPN
    //     forward and the body handed back as a build log — a read primitive
    //     into a private network, pointed by the remote side, with the
    //     credential stripping doing nothing to stop it. Direct is the only
    //     transport the far end cannot aim.
    //   - `insecureTls` and `caPem` say "for THIS request"
    //     (shared/httpClient.ts:65-72), and a hop to another origin is a
    //     different request to a different host. A user who skipped
    //     verification for their own Jenkins did not skip it for wherever
    //     Jenkins points, and a company CA is not evidence about a third party.
    //
    // Sticky rather than recomputed from `spec`, so a chain that goes
    // A → B → A cannot walk back into the tunnel on the third hop.
    if (crossOrigin && (hopSpec.via.kind !== 'direct' || hopSpec.insecureTls || hopSpec.caPem)) {
      // Remembered, because the failure this causes is otherwise undiagnosable.
      // The request fails at a hostname the user never typed, with Node's own
      // message, and nothing says a redirect happened or that the route was
      // taken away — the ECONNREFUSED branch of `messageOf` even advises
      // routing through a server, which is exactly what they already did.
      dropped = { from: hop.url, to: next, hadRoute: hopSpec.via.kind !== 'direct' }
      hopSpec = { ...hopSpec, via: { kind: 'direct' }, insecureTls: false, caPem: undefined }
    }

    // 303 always, and 301/302 by universal practice, turn a non-idempotent
    // request into a GET. 307/308 exist precisely to keep method and body.
    const downgrade = res.status !== 307 && res.status !== 308 && hop.method !== 'HEAD'
    hop = {
      url: next,
      method: downgrade ? 'GET' : hop.method,
      headers: nextHeaders,
      body: downgrade ? undefined : hop.body
    }
  }
}
