import net from 'node:net'
import tls from 'node:tls'
import type { Duplex } from 'node:stream'
import { acquire, release, type PooledConnection } from './ssh'
import type { HttpVia } from '../../shared/httpClient'

/**
 * Opening a socket to somewhere, by whichever of three routes was asked for.
 *
 * This is the piece that makes OpsMaxx's HTTP client different from a
 * standalone one, and it is shared rather than copied because there are now
 * two protocols riding it: requests (`httpClient.ts`) and WebSockets
 * (`wsClient.ts`). The SSH channel shim in particular is subtle enough that a
 * second copy would drift — it is a list of connection-management no-ops that
 * a stream multiplexed inside an SSH connection does not have, and getting it
 * wrong fails on the first `setNoDelay` rather than anywhere informative.
 *
 * The VPN dance below already carried a comment about being the third copy of
 * itself. This is where the fourth would have gone.
 */

/**
 * ssh2's channel is a Duplex, and Node's HTTP client expects a net.Socket. The
 * missing pieces are all connection-management no-ops on a stream that is
 * already multiplexed inside an SSH connection: there is no Nagle to disable
 * and no event loop handle to ref. Without them the request throws on the
 * first `setNoDelay` rather than sending anything.
 */
export function asSocket(stream: Duplex): net.Socket {
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

export function tcpConnect(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
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
export function forwardOut(conn: PooledConnection, host: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    conn.client.forwardOut('127.0.0.1', 0, host, port, (err, stream) =>
      err ? reject(err) : resolve(stream as unknown as Duplex)
    )
  })
}

/** TLS on top of an already-open transport, so every `via` mode shares it. */
export function startTls(
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
      // What the certificate is checked against. Without it an IP literal,
      // which gets no SNI above, is checked as `localhost` — so a cert issued
      // for 10.0.0.5 failed against https://10.0.0.5 even with its CA supplied.
      host: servername,
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
export async function vpnConnect(
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


/** Where a request or socket leaves from, resolved into an open transport. */
export interface DialResult {
  /** The stream to speak the protocol over. Destroy it when done. */
  transport: Duplex
  /** Returned to the pool by `closeDial`, never destroyed. */
  conn: PooledConnection | null
  /** Releases a VPN forward opened for this dial, if there was one. */
  closeVpn: (() => void) | null
}

/**
 * Open a transport to `host:port` by the route `via` names.
 *
 * The caller still owns TLS: `httpClient` wraps the result with `startTls`
 * when the target is https, and `wsClient` does the same for wss. Keeping the
 * two separable is what lets a WebSocket ride an SSH channel — the handshake
 * is plain HTTP over whatever this returns.
 */
export async function dial(
  via: HttpVia,
  host: string,
  port: number,
  timeoutMs: number,
  prepare: (target: HttpSshTargetLike) => HttpSshTargetLike
): Promise<DialResult> {
  if (via.kind === 'server') {
    const conn = await acquire(prepare(via.server) as Parameters<typeof acquire>[0])
    try {
      return { transport: await forwardOut(conn, host, port), conn, closeVpn: null }
    } catch (err) {
      release(conn)
      throw err
    }
  }
  if (via.kind === 'vpn') {
    const dialled = await vpnConnect(via.vpnProfileId, host, port, timeoutMs)
    return { transport: dialled.socket, conn: null, closeVpn: dialled.close }
  }
  return { transport: await tcpConnect(host, port, timeoutMs), conn: null, closeVpn: null }
}

/** The credential-free SSH target shape, as the renderer sends it. */
export type HttpSshTargetLike = Parameters<typeof acquire>[0]

/**
 * Everything a dial opened, released in the right order.
 *
 * The channel belongs to the caller; the pooled SSH connection does not, and
 * a VPN forward was opened for this dial alone — including the one that
 * failed, which is a listener per attempt if nobody closes it.
 */
export function closeDial(dialled: Partial<DialResult>): void {
  try {
    dialled.transport?.destroy()
  } catch {
    /* a transport that never opened has nothing to close */
  }
  if (dialled.conn) release(dialled.conn)
  try {
    dialled.closeVpn?.()
  } catch {
    /* already closed with the tunnel */
  }
}
