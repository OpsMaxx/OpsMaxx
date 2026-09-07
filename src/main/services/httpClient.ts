import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import https from 'node:https'
import type { Duplex } from 'node:stream'
import {
  MAX_RESPONSE_BYTES,
  clampTimeout,
  methodAllowsBody,
  parseTarget,
  sanitizeHeaders,
  type HttpRequestSpec,
  type HttpResult,
  type HttpSshTarget
} from '../../shared/httpClient'
import { acquire, release, type PooledConnection } from './ssh'

/**
 * Executes the HTTP client's requests.
 *
 * Every request is built the same way: open a transport, optionally wrap it in
 * TLS, then speak HTTP over it. The only thing `via` changes is where the
 * transport comes from — a TCP socket from this machine, or a direct-tcpip
 * channel on a server's existing SSH connection. Keeping one path means a
 * request through a server behaves identically to a direct one, including
 * redirect handling, timeouts and the response cap.
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

/** TLS on top of an already-open transport, so both `via` modes share it. */
function startTls(
  socket: Duplex,
  servername: string,
  insecure: boolean,
  timeoutMs: number
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({
      socket: asSocket(socket),
      // SNI. Omitted for an IP literal, which is not a valid SNI value and
      // makes some servers abort the handshake outright.
      ...(net.isIP(servername) ? {} : { servername }),
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

/** Node attaches a `code` to transport errors; surfacing it lets the UI explain the failure. */
function codeOf(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' ? code : undefined
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

export async function httpRequest(
  spec: HttpRequestSpec,
  ctx: HttpRequestContext
): Promise<HttpResult> {
  const target = parseTarget(spec.url)
  if ('error' in target) return { ok: false, error: target.error }

  const timeoutMs = clampTimeout(spec.timeoutMs)
  const method = (spec.method || 'GET').toUpperCase()
  const { headers } = sanitizeHeaders(spec.headers ?? {})

  let conn: PooledConnection | null = null
  let transport: Duplex | null = null

  try {
    if (spec.via.kind === 'server') {
      conn = await acquire(ctx.prepare(spec.via.server))
      transport = await forwardOut(conn, target.hostname, target.port)
    } else {
      transport = await tcpConnect(target.hostname, target.port, timeoutMs)
    }

    const socket = target.tls
      ? await startTls(transport, target.hostname, spec.insecureTls === true, timeoutMs)
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

      const agent = target.tls ? https : http
      const request = agent.request(
        {
          method,
          // The transport is already connected and already the right one, so
          // Node must not open its own. Everything about where this request
          // goes was decided above.
          createConnection: () => socket,
          // Still needed: they build the request line and the Host header.
          host: target.hostname,
          port: target.port,
          path: target.path,
          headers,
          // One request per transport. Keeping it alive would strand an SSH
          // channel for every request the user ever sent.
          agent: false
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
      if (spec.body && methodAllowsBody(method)) request.write(Buffer.from(spec.body))
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
  }
}
