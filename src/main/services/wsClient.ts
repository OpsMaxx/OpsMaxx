import http from 'node:http'
import https from 'node:https'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import {
  HIGH_WATER_BYTES,
  IPC_FRAME_BYTES,
  MAX_FRAME_BYTES,
  MAX_SOCKETS,
  NORMAL_CLOSURE,
  type WsEvent,
  type WsFrame,
  type WsOpenResult,
  type WsOpenSpec,
  type WsSendResult
} from '../../shared/httpSocket'
import { isLinkLocalHost, sanitizeHeaders } from '../../shared/httpClient'
import { closeDial, dial, type DialResult, type HttpSshTargetLike } from './netTransport'

/**
 * WebSocket sessions, over the same three transports as an HTTP request.
 *
 * ── The one trick that makes this work ─────────────────────────────────────
 *
 * `ws` accepts a `createConnection` option and passes it to Node's HTTP
 * client, which uses it INSTEAD of an agent when no agent is given. So the
 * handshake — which is an ordinary HTTP/1.1 upgrade request — can be spoken
 * over any socket we can produce, including an ssh2 `direct-tcpip` channel.
 * That is the whole mechanism: a WebSocket to a service bound to a server's
 * loopback, which nothing running in a browser can reach.
 *
 * TLS is handled by the agent rather than by wrapping the socket first, which
 * is the opposite of what `httpClient.ts` does and deliberately so. `ws`
 * computes `Sec-WebSocket-Key`, SNI and the `Host` header from the URL it was
 * given; handing it a pre-encrypted socket under a `ws://` URL would get the
 * first of those right and the other two wrong. An `https.Agent` carrying
 * `rejectUnauthorized` and `ca` reaches the same place with the URL intact.
 *
 * ── Lifetime ───────────────────────────────────────────────────────────────
 *
 * A session owns its transport and, where the route went through a server, a
 * pooled SSH connection borrowed for as long as the socket is open — unlike a
 * request, which borrows one for a few hundred milliseconds. That is why
 * `MAX_SOCKETS` exists and why teardown is idempotent and wired to every way a
 * socket can end, including the renderer that opened it going away.
 */

interface Session {
  id: string
  socket: WebSocket
  dialled: DialResult
  emit: (event: WsEvent) => void
  /** Wired to close, error and the transport ending. Safe to call repeatedly. */
  teardown: () => void
  /** The window that opened it, so a reload does not strand sockets. */
  ownerId: number
}

const sessions = new Map<string, Session>()

/** What this service needs from main: credentials, and somewhere to send events. */
export interface WsContext {
  /**
   * Merges a server's stored credentials into the hop the renderer sent, the
   * same way the terminal and SFTP do. The renderer never sends a secret and
   * could not be trusted with one.
   */
  prepare: (target: HttpSshTargetLike) => HttpSshTargetLike
  /** Delivers one event to the window that opened the socket. */
  emit: (ownerId: number, id: string, event: WsEvent) => void
}

export function socketCount(): number {
  return sessions.size
}

/**
 * The handshake target, vetted the way an HTTP request's is.
 *
 * `isLinkLocalHost` is the one address rule worth keeping here too: those are
 * the cloud metadata endpoints, and a WebSocket to one is the same SSRF shape
 * as a request to one.
 */
function parseWsTarget(
  raw: string
): { hostname: string; port: number; tls: boolean } | { error: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { error: `Not a valid URL: ${raw}` }
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    return { error: `A WebSocket needs ws:// or wss://, not ${url.protocol.replace(':', '')}` }
  }
  if (!url.hostname) return { error: 'The URL has no host.' }
  if (isLinkLocalHost(url.hostname)) {
    return { error: `${url.hostname} is a link-local address, which this client will not open.` }
  }
  const tls = url.protocol === 'wss:'
  return { hostname: url.hostname, port: url.port ? Number(url.port) : tls ? 443 : 80, tls }
}

/** Bytes of a frame, whichever shape it arrived in. */
function sizeOf(data: string | ArrayBuffer): number {
  return typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
}

/**
 * A frame small enough to ship over IPC, flagged when it had to be cut.
 *
 * Cut rather than dropped: a message log cannot usefully render eight
 * megabytes, but the fact that a large frame arrived is exactly what somebody
 * debugging a stream needs to see.
 */
function forIpc(direction: WsFrame['direction'], data: string | ArrayBuffer): WsFrame {
  const at = Date.now()
  if (sizeOf(data) <= IPC_FRAME_BYTES) {
    return typeof data === 'string'
      ? { direction, opcode: 'text', data, at }
      : { direction, opcode: 'binary', data, at }
  }
  return typeof data === 'string'
    ? { direction, opcode: 'text', data: data.slice(0, IPC_FRAME_BYTES), at, truncated: true }
    : { direction, opcode: 'binary', data: data.slice(0, IPC_FRAME_BYTES), at, truncated: true }
}

export async function wsOpen(
  spec: WsOpenSpec,
  ownerId: number,
  ctx: WsContext
): Promise<WsOpenResult> {
  if (sessions.size >= MAX_SOCKETS) {
    return {
      ok: false,
      error: `That is ${MAX_SOCKETS} open sockets, which is as many as OpsMaxx will hold. Close one first.`
    }
  }

  const target = parseWsTarget(spec.url)
  if ('error' in target) return { ok: false, error: target.error }

  // The same rules a request's headers go through: a name that is not a token,
  // a value carrying CR or LF, or one of the fields the transport itself sets
  // would produce a handshake that contradicts what is on the wire.
  const { headers } = sanitizeHeaders(spec.headers ?? {})

  let dialled: DialResult | null = null
  try {
    dialled = await dial(spec.via, target.hostname, target.port, HANDSHAKE_TIMEOUT_MS, (t) =>
      ctx.prepare(t)
    )
    const transport = dialled

    // `createConnection` is used INSTEAD of an agent when no agent is given
    // (see Node's `_http_client`), which is what lets the handshake travel
    // over an SSH channel. TLS stays with the agent so `ws` keeps computing
    // SNI and Host from the real URL.
    const agent = target.tls
      ? new https.Agent({
          rejectUnauthorized: spec.insecureTls !== true,
          ...(spec.caPem ? { ca: spec.caPem } : {})
        })
      : new http.Agent()
    ;(agent as unknown as { createConnection: () => unknown }).createConnection = () =>
      transport.transport

    const socket = new WebSocket(spec.url, spec.protocols ?? [], {
      agent,
      headers,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      maxPayload: MAX_FRAME_BYTES
    })

    const id = randomUUID()
    const emit = (event: WsEvent): void => ctx.emit(ownerId, id, event)

    let torn = false
    const teardown = (): void => {
      if (torn) return
      torn = true
      sessions.delete(id)
      try {
        // `terminate`, not `close`: teardown runs on paths where the far end
        // is already gone, and a graceful close would wait for a reply that
        // is never coming.
        socket.terminate()
      } catch {
        /* already closed */
      }
      closeDial(transport)
    }

    const session: Session = { id, socket, dialled: transport, emit, teardown, ownerId }

    return await new Promise<WsOpenResult>((resolve) => {
      let settled = false
      const settle = (result: WsOpenResult): void => {
        if (settled) return
        settled = true
        resolve(result)
      }

      socket.on('open', () => {
        sessions.set(id, session)
        emit({ type: 'open', protocol: socket.protocol ?? '' })
        settle({ ok: true, id })
      })

      socket.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
        const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer)
        emit({
          type: 'frame',
          frame: forIpc(
            'incoming',
            isBinary
              ? (buffer.buffer.slice(
                  buffer.byteOffset,
                  buffer.byteOffset + buffer.byteLength
                ) as ArrayBuffer)
              : buffer.toString('utf8')
          )
        })
      })

      socket.on('error', (err: Error) => {
        // Before `open`, this is why the socket never opened and belongs in the
        // result. After it, it is an event on a live session.
        if (!settled) {
          teardown()
          settle({ ok: false, error: err.message })
          return
        }
        emit({ type: 'error', error: err.message })
      })

      socket.on('close', (code: number, reason: Buffer) => {
        const wasClean = code === NORMAL_CLOSURE || code === 1005
        teardown()
        if (!settled) {
          settle({ ok: false, error: `The server closed the connection (${code})` })
          return
        }
        emit({ type: 'close', code, reason: reason.toString('utf8'), wasClean })
      })
    })
  } catch (err) {
    if (dialled) closeDial(dialled)
    const message = err instanceof Error ? err.message : String(err)
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    return { ok: false, error: message, ...(typeof code === 'string' ? { code } : {}) }
  }
}

/** Long enough for an SSH channel plus a TLS handshake, short enough to notice. */
const HANDSHAKE_TIMEOUT_MS = 30_000

export function wsSend(id: string, data: string | ArrayBuffer): WsSendResult {
  const session = sessions.get(id)
  if (!session) return { ok: false, error: 'That socket is not open.', reason: 'unknown-session' }
  if (session.socket.readyState !== WebSocket.OPEN) {
    return { ok: false, error: 'That socket is not open.', reason: 'closed' }
  }
  // Refusing rather than buffering. An unbounded queue behind a far end that
  // has stopped reading is main-process memory growth with nothing on screen
  // to explain it.
  if (session.socket.bufferedAmount > HIGH_WATER_BYTES) {
    return {
      ok: false,
      error: 'The connection is not keeping up — that frame was not sent.',
      reason: 'backpressure'
    }
  }

  session.socket.send(typeof data === 'string' ? data : Buffer.from(data))
  // Echoed back so the log shows both halves of the conversation in the order
  // main saw them, rather than the renderer guessing when its own frame went.
  session.emit({ type: 'frame', frame: forIpc('outgoing', data) })
  return { ok: true }
}

export function wsClose(id: string, code = NORMAL_CLOSURE, reason = ''): void {
  const session = sessions.get(id)
  if (!session) return
  try {
    // Graceful here, unlike teardown: this is a deliberate close and the far
    // end deserves the handshake. `close` fires the listener that tears down.
    session.socket.close(code, reason)
  } catch {
    session.teardown()
  }
}

/**
 * Every socket a window owns.
 *
 * Called when that window goes away. A renderer reload would otherwise strand
 * one SSH channel per socket it had open, for the life of the app.
 */
export function wsCloseForOwner(ownerId: number): void {
  for (const session of [...sessions.values()]) {
    if (session.ownerId === ownerId) session.teardown()
  }
}

/** Every socket, for shutdown. */
export function wsCloseAll(): void {
  for (const session of [...sessions.values()]) session.teardown()
}
