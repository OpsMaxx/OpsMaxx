import { createServer, type Server as HttpServer } from 'node:http'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect, type TLSSocket, type DetailedPeerCertificate } from 'node:tls'
import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { WebSocketServer, type WebSocket } from 'ws'
import { buildError, buildResponse, parseDestination, parseRequest } from './rdcleanpath'
import { getCachedServer } from './mcpDataCache'
import { resolveSecrets } from './credentialResolver'
import type {
  RdpRelayStatus,
  RdpTicket,
  RdpTicketResult,
  RdpDesktopSize
} from '../../shared/rdp'
import type { SshHop } from '../../shared/ssh'

// The main-process half of an RDP session.
//
// The client is WebAssembly running in the renderer, which cannot open a TCP
// socket. So it speaks RDCleanPath to this relay over a loopback WebSocket:
// the relay performs the X.224 negotiation and the TLS handshake on its
// behalf, hands back the server's certificate chain, and from then on carries
// TLS records in both directions. See rdcleanpath.ts for why that shape.
//
// Three properties this file exists to hold, none of them incidental:
//
//  - **The renderer does not choose the destination.** RDCleanPath puts it in a
//    PDU the *client* builds, so a compromised renderer could otherwise use the
//    relay to reach anything this machine can reach. Every ticket is minted by
//    main against one destination resolved from the saved server record, and a
//    PDU naming anything else is refused.
//  - **The relay terminates TLS.** After the handshake it holds the plaintext
//    RDP stream, and the CredSSP exchange carrying the user's password crosses
//    the local WebSocket. Binding loopback only, on an ephemeral port, behind a
//    single-use token, is what makes that acceptable.
//  - **It starts on demand and stops when idle.** An always-listening local
//    proxy is a standing piece of attack surface for a feature most sessions
//    never use.

/** A minted, unspent ticket. Deleted on use and on expiry, whichever is first. */
interface Ticket {
  destination: string
  expires: NodeJS.Timeout
}

const TICKET_TTL_MS = 30_000
/** Long enough for a slow WAN handshake, short enough that a black hole fails. */
const HANDSHAKE_TIMEOUT_MS = 20_000
/** How long the relay stays up with nothing on it before shutting down. */
const IDLE_SHUTDOWN_MS = 60_000

const tickets = new Map<string, Ticket>()

let http: HttpServer | null = null
let wss: WebSocketServer | null = null
let port: number | null = null
let sessions = 0
let lastError: string | undefined
let idleTimer: NodeJS.Timeout | null = null
let statusTarget: WebContents | null = null

function emitStatus(): void {
  if (!statusTarget || statusTarget.isDestroyed()) return
  statusTarget.send('rdp:status', rdpRelayStatus())
}

export function rdpRelayStatus(): RdpRelayStatus {
  const state: RdpRelayStatus['state'] = lastError
    ? 'error'
    : sessions > 0
      ? 'connected'
      : http
        ? 'listening'
        : 'idle'
  return { state, sessions, port: port ?? undefined, error: lastError }
}

/** Where relay status is pushed. One window, like every other status channel. */
export function setRdpStatusTarget(wc: WebContents | null): void {
  statusTarget = wc
}

function scheduleIdleShutdown(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (sessions === 0 && tickets.size === 0) void stopRdpRelay()
  }, IDLE_SHUTDOWN_MS)
  idleTimer.unref()
}

function ensureRelay(): Promise<number> {
  if (http && port !== null) return Promise.resolve(port)

  return new Promise<number>((resolve, reject) => {
    // 404 everything: this server exists to carry one WebSocket upgrade, and
    // serving anything over it would make it a second, unaudited surface.
    const server = createServer((_req, res) => {
      res.writeHead(404).end()
    })

    const sockets = new WebSocketServer({ server, path: '/rdp' })
    sockets.on('connection', handleConnection)

    server.once('error', (err) => {
      lastError = err.message
      http = null
      wss = null
      port = null
      emitStatus()
      reject(err)
    })

    // Port 0: the OS picks. A fixed port would be guessable by anything else
    // running as this user, and it is handed to the renderer anyway.
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('relay bound to a non-TCP address'))
        return
      }
      http = server
      wss = sockets
      port = address.port
      lastError = undefined
      emitStatus()
      scheduleIdleShutdown()
      resolve(address.port)
    })
  })
}

export async function stopRdpRelay(): Promise<void> {
  for (const ticket of tickets.values()) clearTimeout(ticket.expires)
  tickets.clear()
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  const sockets = wss
  const server = http
  wss = null
  http = null
  port = null
  sessions = 0
  // Closing the WebSocketServer terminates live sessions; that is the point of
  // an explicit stop, and quitting the app must not leave a listener behind.
  await new Promise<void>((resolve) => {
    if (!sockets) return resolve()
    sockets.close(() => resolve())
  })
  await new Promise<void>((resolve) => {
    if (!server) return resolve()
    server.close(() => resolve())
  })
  emitStatus()
}

/**
 * Mint a ticket for one server's RDP session.
 *
 * Everything that decides *what* is connected to is read here, in main, from
 * the saved record — never taken from the caller. The caller names a server id
 * and gets back a token plus the settings the client needs; it cannot ask for a
 * different host, a different account, or someone else's credential.
 */
export async function rdpMintTicket(
  serverId: string,
  desktopSize?: RdpDesktopSize
): Promise<RdpTicketResult> {
  const server = getCachedServer(serverId)
  if (!server) {
    return { ok: false, code: 'no-target', error: 'That server no longer exists.' }
  }
  if (!server.rdp) {
    return { ok: false, code: 'no-target', error: `${server.name} is not configured for RDP.` }
  }

  // A jump-host route means the target is not reachable from here directly,
  // and this relay dials directly. Saying so is better than dialling a host
  // that resolves to something else on this network. (A VPN profile is not in
  // this list: a VPN moves the OS routing table, so a direct dial is exactly
  // what it is for.)
  if (server.route.length > 0) {
    return {
      ok: false,
      code: 'no-target',
      error: `${server.name} is reached through a jump host, and RDP over a jump host is not supported yet.`
    }
  }

  // Resolved through the same path as an interactive SSH session, so an RDP
  // password lives in the same vault entry and rotates in the same place. A
  // locked vault throws, and is reported as such rather than as a bad password.
  let password: string | undefined
  try {
    const resolved = resolveSecrets({
      host: server.host,
      port: server.rdp.port,
      username: server.username,
      serverId: server.id
    } as SshHop & { serverId?: string })
    password = resolved.password
  } catch (err) {
    return { ok: false, code: 'no-credentials', error: (err as Error).message }
  }
  if (!password) {
    return {
      ok: false,
      code: 'no-credentials',
      error: `No password is stored for ${server.name}. RDP authenticates with a password.`
    }
  }

  let listenPort: number
  try {
    listenPort = await ensureRelay()
  } catch (err) {
    return { ok: false, code: 'relay-unavailable', error: (err as Error).message }
  }

  const destination = formatDestination(server.host, server.rdp.port)
  const token = randomUUID()
  const expires = setTimeout(() => {
    tickets.delete(token)
    scheduleIdleShutdown()
  }, TICKET_TTL_MS)
  expires.unref()
  tickets.set(token, { destination, expires })

  const ticket: RdpTicket = {
    token,
    proxyUrl: `ws://127.0.0.1:${listenPort}/rdp`,
    destination,
    username: server.username,
    password,
    domain: server.rdp.domain || undefined,
    nla: server.rdp.nla,
    kdcProxyUrl: server.rdp.kdcProxyUrl || undefined,
    expiresInMs: TICKET_TTL_MS
  }
  // `desktopSize` is the renderer's business — the relay does not care — but it
  // is accepted here so the caller has one call rather than two.
  void desktopSize
  return { ok: true, ticket }
}

/** IPv6 literals need brackets before a port, or the colon is ambiguous. */
function formatDestination(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
}

function handleConnection(ws: WebSocket, req: { url?: string }): void {
  const token = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('token')
  const ticket = token === null ? undefined : tickets.get(token)
  if (!token || !ticket) {
    ws.close(1008, 'bad token')
    return
  }
  // Spent on sight. A token that opened a socket cannot open a second one, so a
  // leaked URL is worth nothing after the session it was minted for starts.
  clearTimeout(ticket.expires)
  tickets.delete(token)

  ws.once('message', (data: Buffer) => {
    void openSession(ws, token, ticket.destination, Buffer.from(data))
  })
  ws.on('error', () => {
    /* the close handler in relay() does the cleanup */
  })
}

async function openSession(
  ws: WebSocket,
  token: string,
  allowedDestination: string,
  first: Buffer
): Promise<void> {
  let tlsSocket: TLSSocket | null = null
  try {
    const request = parseRequest(first)

    // The token travels twice: once on the upgrade, once inside the PDU. This
    // is the check that matters, because the PDU is what names a destination —
    // authenticating only the socket would leave the request itself unbound.
    if (request.proxyAuth !== token) throw new Error('proxy_auth does not match the ticket')
    if (request.destination !== allowedDestination) {
      throw new Error('destination does not match the ticket')
    }

    const { host, port: target } = parseDestination(request.destination)
    const handshake = await performHandshake(host, target, request.x224)
    tlsSocket = handshake.tlsSocket

    ws.send(buildResponse(request.destination, handshake.x224Response, handshake.certChain))
    relay(ws, handshake.tlsSocket)
  } catch (err) {
    lastError = (err as Error).message
    try {
      // An error PDU rather than a bare close, so the client reports why.
      ws.send(buildError(1, 502))
    } catch {
      /* the peer may already be gone; the close below is what matters */
    }
    tlsSocket?.destroy()
    ws.close()
    emitStatus()
    scheduleIdleShutdown()
  }
}

interface Handshake {
  x224Response: Buffer
  certChain: Buffer[]
  tlsSocket: TLSSocket
}

// TCP connect, replay the client's X.224 Connection Request, read the Confirm,
// then upgrade to TLS and capture the chain. This is the entire reason the
// relay is a protocol participant rather than a pipe.
function performHandshake(host: string, target: number, x224Request: Buffer): Promise<Handshake> {
  return new Promise<Handshake>((resolve, reject) => {
    const tcp = netConnect({ host, port: target }, () => {
      tcp.write(x224Request)
    })

    let settled = false
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      tcp.destroy()
      reject(err)
    }

    tcp.setTimeout(HANDSHAKE_TIMEOUT_MS, () => fail(new Error('RDP handshake timed out')))
    tcp.once('error', (err) => fail(new Error(`could not reach ${host}:${target}: ${err.message}`)))

    tcp.once('data', (x224Response: Buffer) => {
      if (x224Response.length === 0) {
        fail(new Error('the server closed the connection before the X.224 confirm'))
        return
      }
      // Every listener has to go before the socket becomes TLS's, or the two
      // layers both consume from it.
      tcp.removeAllListeners('error')
      tcp.removeAllListeners('data')
      tcp.setTimeout(0)

      // `rejectUnauthorized` stays false and that is deliberate: RDP servers
      // are self-signed by default, and the trust decision is the client's —
      // which is why the chain is handed back in the response rather than
      // judged here. Judging it here would also be judging it in the wrong
      // place, since CredSSP binds to the certificate the *client* saw.
      const socket = tlsConnect(
        {
          socket: tcp,
          // An IP is not a valid SNI name (RFC 6066) and Node warns about it.
          servername: isIpLiteral(host) ? undefined : host,
          rejectUnauthorized: false
        },
        () => {
          if (settled) return
          settled = true
          resolve({
            x224Response: Buffer.from(x224Response),
            certChain: collectChain(socket.getPeerCertificate(true)),
            tlsSocket: socket
          })
        }
      )
      socket.once('error', (err) => fail(new Error(`TLS handshake failed: ${err.message}`)))
    })
  })
}

function isIpLiteral(host: string): boolean {
  if (host.includes(':')) return true
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
}

// `getPeerCertificate(true)` returns the detailed shape, which is the one that
// carries `issuerCertificate` -- the plain PeerCertificate does not, and the
// walk up the chain is the whole point of asking for it.
function collectChain(peerCert: DetailedPeerCertificate | null): Buffer[] {
  const chain: Buffer[] = []
  const seen = new Set<string>()
  let current: DetailedPeerCertificate | null = peerCert
  while (current?.raw) {
    const id = current.fingerprint256 ?? current.raw.toString('hex')
    // Self-signed certificates are their own issuer, so the walk has to stop on
    // a repeat rather than on reaching a root.
    if (seen.has(id)) break
    seen.add(id)
    chain.push(Buffer.from(current.raw))
    const issuer: DetailedPeerCertificate | undefined = current.issuerCertificate
    if (!issuer || issuer === current) break
    current = issuer
  }
  return chain
}

function relay(ws: WebSocket, tlsSocket: TLSSocket): void {
  sessions++
  if (idleTimer) clearTimeout(idleTimer)
  emitStatus()

  tlsSocket.on('data', (chunk: Buffer) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk)
  })
  ws.on('message', (chunk: Buffer) => {
    if (!tlsSocket.destroyed) tlsSocket.write(chunk)
  })

  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    sessions = Math.max(0, sessions - 1)
    if (!tlsSocket.destroyed) tlsSocket.destroy()
    if (ws.readyState === ws.OPEN) ws.close()
    emitStatus()
    scheduleIdleShutdown()
  }

  tlsSocket.on('end', close)
  tlsSocket.on('close', close)
  tlsSocket.on('error', (err) => {
    lastError = err.message
    close()
  })
  ws.on('close', close)
  ws.on('error', close)
}
