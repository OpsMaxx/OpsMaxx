import { createServer, type Server as HttpServer } from 'node:http'
import { connect as netConnect } from 'node:net'
import type { Duplex } from 'node:stream'
import { connect as tlsConnect, type TLSSocket, type DetailedPeerCertificate } from 'node:tls'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { buildError, buildResponse, parseDestination, parseRequest } from './rdcleanpath'
import { getCachedServer, type CachedServer } from './mcpDataCache'
import { resolveChainSecrets, resolveSecrets } from './credentialResolver'
import { openChain } from './ssh'
import { verifyRdpCertificate } from './rdpTrust'
import { rdpSecretId } from '../../shared/rdp'
import type { RdpTicket, RdpTicketResult, RdpDesktopSize } from '../../shared/rdp'
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
  serverId: string
  destination: string
  expires: NodeJS.Timeout
}

const TICKET_TTL_MS = 30_000
/** Long enough for a slow WAN handshake, short enough that a black hole fails. */
const HANDSHAKE_TIMEOUT_MS = 20_000
/** How long the relay stays up with nothing on it before shutting down. */
const IDLE_SHUTDOWN_MS = 60_000
/**
 * Concurrent desktops. A ceiling rather than a policy: each session can hold an
 * SSH chain to a bastion open behind it, so a runaway caller — a UI loop, or a
 * renderer that is not behaving — should hit a wall here rather than open
 * connections until the machine or the bastion runs out.
 */
const MAX_SESSIONS = 16
/**
 * How much may sit unsent toward the renderer before the server side is paused.
 *
 * A full-screen 1080p update is a few hundred kilobytes, so this is roughly one
 * frame in flight: large enough that ordinary bursts never pause, small enough
 * that a stalled consumer is noticed in milliseconds rather than megabytes.
 */
const HIGH_WATER_BYTES = 4 * 1024 * 1024

const tickets = new Map<string, Ticket>()

let http: HttpServer | null = null
let wss: WebSocketServer | null = null
let port: number | null = null
let sessions = 0
// Sockets past the token check but not yet relaying. See inUse().
let connecting = 0
let idleTimer: NodeJS.Timeout | null = null

/**
 * The relay's own view of itself.
 *
 * Not an IPC contract and not a UI feed: this used to be pushed to the renderer
 * over an `rdp:status` channel that nothing ever subscribed to. What is left is
 * what the lifecycle tests assert against — whether a listener is up, on which
 * port, and how many sessions are on it — so the deletion took the sticky
 * `lastError` field with it, since a failure nobody displays is a failure the
 * session itself already reported.
 */
export function rdpRelayStatus(): { listening: boolean; sessions: number; port?: number } {
  return { listening: http !== null, sessions, port: port ?? undefined }
}

/**
 * Whether anything is using the relay: a live session, a minted ticket nobody
 * has spent yet, or a connection between its WebSocket upgrade and the end of
 * its TLS handshake.
 *
 * `connecting` is the reason this is a function rather than two counters read
 * inline. A ticket is deleted the moment its socket opens, and `sessions` is
 * not incremented until the handshake finishes — which can take up to
 * HANDSHAKE_TIMEOUT_MS. For that whole window the relay looked idle, and an
 * idle check landing inside it would have shut down the listener out from
 * under a connection that was still being negotiated.
 */
function inUse(): boolean {
  return sessions > 0 || connecting > 0 || tickets.size > 0
}

/**
 * Re-arms on every check rather than firing once.
 *
 * The previous version scheduled a single timeout whose callback did nothing
 * when the relay was busy — and did not schedule another. So any check that
 * landed while a ticket was outstanding disarmed the shutdown permanently, and
 * the listener stayed up for the rest of the session. A repeating check is the
 * whole fix: "idle for the last interval" is the condition, and it has to be
 * asked more than once.
 */
function scheduleIdleShutdown(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (!http) return
    if (inUse()) {
      scheduleIdleShutdown()
      return
    }
    void stopRdpRelay()
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
      http = null
      wss = null
      port = null
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
  connecting = 0

  // Each live socket, explicitly. `WebSocketServer.close()` stops the server
  // accepting new connections and does NOT close the ones it already has —
  // verified, not assumed — so relying on it left every open desktop's TLS
  // session and its whole SSH chain alive with nothing tracking them, while
  // the counters above said zero. Terminating each one runs the session's own
  // close handler, which is what releases the transport beneath it.
  if (sockets) {
    for (const client of sockets.clients) {
      try {
        client.terminate()
      } catch {
        /* already gone */
      }
    }
  }

  await new Promise<void>((resolve) => {
    if (!sockets) return resolve()
    sockets.close(() => resolve())
  })
  await new Promise<void>((resolve) => {
    if (!server) return resolve()
    server.close(() => resolve())
  })
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

  /**
   * RDP's OWN account, and RDP's own password.
   *
   * Both used to be SSH's: the username came from `Server.username` and the
   * password from `getSecret(serverId)`, the one secret per server. That is
   * what made the two protocols codependent rather than merely adjacent — a
   * desktop signing in as Administrator and a shell signing in as root had to
   * agree on one password, which on a Windows box they never do.
   *
   * The fallback to the server's own credential is what keeps every record
   * saved before this working: no RDP username means the SSH one, and no
   * secret under the derived id means the shared one. A locked vault throws
   * and is reported as such rather than as a bad password.
   */
  const rdpUser = server.rdp.username?.trim() || server.username
  let password: string | undefined
  try {
    const ownHop = {
      host: server.host,
      port: server.rdp.port,
      username: rdpUser,
      serverId: rdpSecretId(server.id)
    } as SshHop & { serverId?: string }
    password = resolveSecrets(ownHop).password
    if (!password) {
      // Nothing stored against the desktop specifically, so the server's own
      // credential stands in — which is what it was doing for everyone
      // before RDP had a place of its own.
      password = resolveSecrets({
        host: server.host,
        port: server.rdp.port,
        username: rdpUser,
        serverId: server.id
      } as SshHop & { serverId?: string }).password
    }
  } catch (err) {
    return { ok: false, code: 'no-credentials', error: (err as Error).message }
  }
  if (!password) {
    return {
      ok: false,
      code: 'no-credentials',
      error: `No password is stored for ${rdpUser} on ${server.name}. RDP authenticates with a password.`
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
  tickets.set(token, { serverId: server.id, destination, expires })

  const ticket: RdpTicket = {
    token,
    proxyUrl: `ws://127.0.0.1:${listenPort}/rdp`,
    destination,
    // The account the ticket signs in as, resolved above: RDP's own where one
    // is set, the server's where it is not.
    username: rdpUser,
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

  // Counted from here, not from the start of openSession: the ticket is gone
  // as of the line above, so between now and the handshake finishing nothing
  // else records that this socket exists.
  connecting++
  let counted = true
  const uncount = (): void => {
    if (!counted) return
    counted = false
    connecting = Math.max(0, connecting - 1)
  }

  // A socket that opens and never sends a PDU would otherwise sit here for as
  // long as the relay lives, holding the connecting count above zero and so
  // keeping the listener from ever shutting down.
  const firstMessage = setTimeout(() => {
    uncount()
    ws.close(1008, 'no request')
    scheduleIdleShutdown()
  }, HANDSHAKE_TIMEOUT_MS)
  firstMessage.unref()

  ws.once('message', (data: Buffer) => {
    clearTimeout(firstMessage)
    void openSession(ws, token, ticket, Buffer.from(data)).finally(uncount)
  })
  ws.on('close', () => {
    clearTimeout(firstMessage)
    uncount()
  })
  ws.on('error', () => {
    /* the close handler above and the one in relay() do the cleanup */
  })
}

async function openSession(
  ws: WebSocket,
  token: string,
  ticket: Ticket,
  first: Buffer
): Promise<void> {
  let dialled: Dialled | null = null
  let tlsSocket: TLSSocket | null = null
  try {
    const request = parseRequest(first)

    // The token travels twice: once on the upgrade, once inside the PDU. This
    // is the check that matters, because the PDU is what names a destination —
    // authenticating only the socket would leave the request itself unbound.
    if (request.proxyAuth !== token) throw new Error('proxy_auth does not match the ticket')

    // Compared as a parsed host and port, not as the two strings. The client
    // echoes back the destination it was given, but "echoes it byte for byte"
    // is an assumption about someone else's code, and the cost of it being
    // wrong is a feature that fails to connect for anyone whose hostname the
    // client happens to normalise. Host casing is ignored because DNS ignores
    // it; everything else must match exactly.
    const wanted = parseDestination(ticket.destination)
    const asked = parseDestination(request.destination)
    if (asked.host.toLowerCase() !== wanted.host.toLowerCase() || asked.port !== wanted.port) {
      throw new Error('destination does not match the ticket')
    }
    // Re-read rather than captured at mint time: a route the user edited in
    // the seconds since should be the route this session takes.
    const server = getCachedServer(ticket.serverId)
    if (!server) throw new Error('that server no longer exists')
    if (sessions >= MAX_SESSIONS) throw new Error('too many remote desktops are already open')

    const { host, port: target } = wanted
    dialled = await dialTarget(server, host, target)
    const handshake = await performHandshake(dialled.stream, request.x224, wanted)
    tlsSocket = handshake.tlsSocket

    ws.send(buildResponse(request.destination, handshake.x224Response, handshake.certChain))
    relay(ws, handshake.tlsSocket, dialled.close)
  } catch (err) {
    try {
      // An error PDU rather than a bare close, so the client reports why.
      ws.send(buildError(1, 502))
    } catch {
      /* the peer may already be gone; the close below is what matters */
    }
    tlsSocket?.destroy()
    // The transport under it too: a failed handshake through a bastion would
    // otherwise leave the whole SSH chain open with nothing on it.
    dialled?.close()
    ws.close()
    scheduleIdleShutdown()
  }
}

interface Handshake {
  x224Response: Buffer
  certChain: Buffer[]
  tlsSocket: TLSSocket
}

/**
 * A transport to the RDP host, and the way to tear down whatever carries it.
 *
 * `stream` is a `net.Socket` for a direct dial and an ssh2 channel for a
 * jump-host one. Everything downstream — the X.224 exchange, the TLS handshake,
 * the relay — only ever treats it as a Duplex, which is why the two cases do
 * not fork past this point.
 */
interface Dialled {
  stream: Duplex
  /** Closes the SSH chain or VPN forward beneath the stream. A no-op for a direct dial. */
  close: () => void
}

/**
 * Reach `host:port` the way this server is reachable.
 *
 * Three cases, in the order they are tried:
 *
 *  - **Through a jump route.** The SSH chain is built to end at the LAST HOP,
 *    not at the server: the target is a Windows box that usually runs no sshd
 *    at all, so the connection is forwarded to it *from* the bastion. Building
 *    the chain all the way to the server would require SSH on the very machine
 *    the user is opening a desktop on.
 *  - **Through a VPN with no route.** A userspace WireGuard profile carries
 *    traffic through this app's own netd rather than the OS routing table, so a
 *    direct dial would miss the tunnel entirely and connect to whatever else
 *    answers on that address. `vpnOpenForward` gives a loopback port that is
 *    genuinely inside it. System mode has a real route and reports
 *    `unsupported`, which is the signal to dial directly after all.
 *  - **Directly.**
 */
async function dialTarget(server: CachedServer, host: string, port: number): Promise<Dialled> {
  if (server.route.length > 0) return dialThroughRoute(server, host, port)
  if (server.vpnProfileId) return dialThroughVpn(server, host, port)
  return dialDirect(host, port)
}

function dialDirect(host: string, port: number): Promise<Dialled> {
  return new Promise<Dialled>((resolve, reject) => {
    const socket = netConnect({ host, port }, () =>
      resolve({ stream: socket, close: () => socket.destroy() })
    )
    socket.once('error', (err) =>
      reject(new Error(`could not reach ${host}:${port}: ${err.message}`))
    )
  })
}

async function dialThroughRoute(
  server: CachedServer,
  host: string,
  port: number
): Promise<Dialled> {
  const route = server.route
  const last = route[route.length - 1]
  // `openChain` connects `hops` in order and then `cfg` itself, so naming the
  // last hop as the destination is what stops the chain at the bastion.
  // Credentials for every hop are resolved through the same path an
  // interactive session uses; a hop backed by a saved server authenticates by
  // its own stored credential.
  const cfg = resolveChainSecrets({
    ...last,
    hops: route.slice(0, -1),
    // Carried so the chain's FIRST hop is itself reached through the VPN when
    // the server has one. The RDP host beyond the bastion needs nothing more:
    // it is reached from inside the chain.
    vpnProfileId: server.vpnProfileId ?? undefined,
    serverId: last.serverId,
    serverName: server.name
  })

  const chain = await openChain(cfg)
  let chainClosed = false
  const closeChain = (): void => {
    // Idempotent: the session's teardown and the failure path below can both
    // reach it, and a VPN forward's close is not guaranteed to tolerate twice.
    if (chainClosed) return
    chainClosed = true
    // Innermost first: ending an outer client tears down the channel the inner
    // one rides, and ssh2 logs that as an error rather than a clean close.
    // Each is guarded because `end()` on a client whose transport has already
    // gone throws, and this runs from a socket close handler — where an
    // exception is an unhandled one in the main process.
    for (const client of [...chain.clients].reverse()) {
      try {
        client.end()
      } catch {
        /* already gone */
      }
    }
    // After the clients, not before: this releases the VPN forward the whole
    // chain is riding, and pulling it out from under a client still shutting
    // down is what makes a clean close look like a transport error.
    try {
      chain.close?.()
    } catch {
      /* already released */
    }
  }

  try {
    const stream = await new Promise<Duplex>((resolve, reject) => {
      chain.client.forwardOut('127.0.0.1', 0, host, port, (err, channel) =>
        err
          ? reject(
              new Error(
                `${last.host} could not reach ${host}:${port}: ${err.message}`
              )
            )
          : resolve(channel as unknown as Duplex)
      )
    })
    return { stream, close: closeChain }
  } catch (err) {
    closeChain()
    throw err
  }
}

async function dialThroughVpn(
  server: CachedServer,
  host: string,
  port: number
): Promise<Dialled> {
  const { vpnOpenForward, vpnStart } = await import('./vpn/manager')
  const vpnId = server.vpnProfileId as string

  const started = await vpnStart(vpnId)
  if (!started.ok) {
    // The VPN's own message, not a connect timeout twenty seconds later.
    throw new Error(started.error ?? 'The VPN for this server could not be started.')
  }

  let forward: { port: number; close: () => void } | null = null
  try {
    forward = await vpnOpenForward(vpnId, host, port, {
      kind: 'server',
      id: server.id,
      name: server.name
    })
  } catch (err) {
    // System mode routes for real and has no forward to open.
    if ((err as { code?: string }).code !== 'unsupported') throw err
  }

  if (!forward) {
    const { registerVpnConsumer } = await import('./vpn/dependencies')
    const release = registerVpnConsumer(vpnId, { kind: 'server', id: server.id, name: server.name })
    try {
      const direct = await dialDirect(host, port)
      return { stream: direct.stream, close: () => (direct.close(), release()) }
    } catch (err) {
      release()
      throw err
    }
  }

  const local = forward
  try {
    const direct = await dialDirect('127.0.0.1', local.port)
    return { stream: direct.stream, close: () => (direct.close(), local.close()) }
  } catch (err) {
    local.close()
    throw err
  }
}

// Replay the client's X.224 Connection Request on the transport, read the
// Confirm, then upgrade to TLS and capture the chain. This is the entire reason
// the relay is a protocol participant rather than a pipe.
//
// Takes a Duplex rather than a socket so that a direct dial and a jump-host
// channel run the identical code: an ssh2 channel has no `setTimeout` and no
// `remoteAddress`, so anything socket-shaped here would fork the two paths at
// exactly the point where they must not differ.
function performHandshake(
  stream: Duplex,
  x224Request: Buffer,
  // The RDP host, for the certificate pin. Never the bastion: the identity
  // being checked is the machine the desktop is on, not the route to it.
  target: { host: string; port: number }
): Promise<Handshake> {
  return new Promise<Handshake>((resolve, reject) => {
    let settled = false
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stream.destroy()
      reject(err)
    }
    // A plain timer, not `socket.setTimeout`: see above.
    const timer = setTimeout(() => fail(new Error('RDP handshake timed out')), HANDSHAKE_TIMEOUT_MS)

    stream.once('error', (err: Error) => fail(new Error(`RDP handshake failed: ${err.message}`)))
    stream.once('data', (x224Response: Buffer) => {
      if (x224Response.length === 0) {
        fail(new Error('the server closed the connection before the X.224 confirm'))
        return
      }
      // Every listener has to go before the stream becomes TLS's, or the two
      // layers both consume from it.
      stream.removeAllListeners('error')
      stream.removeAllListeners('data')

      // `rejectUnauthorized` stays false and that is deliberate: RDP servers
      // are self-signed by default, and the trust decision is the client's --
      // which is why the chain is handed back in the response rather than
      // judged here. Judging it here would also be judging it in the wrong
      // place, since CredSSP binds to the certificate the *client* saw.
      //
      // No `servername`: it is only ever an SNI hint, the RDP host is commonly
      // named by address, and an IP there is invalid per RFC 6066 and warned
      // about by Node. Nothing verifies the name, so sending none is honest.
      const socket = tlsConnect(
        // `tls.connect` types the option as a net.Socket, but it wants a
        // Duplex and documents it as one; an ssh2 channel is exactly that.
        //
        // `rejectUnauthorized: false` is required, not a shortcut: RDP servers
        // are self-signed by default, so CA validation would refuse nearly
        // every real host — Windows' own client does not do it either. What
        // replaces it is the pin checked below, which is the same policy this
        // app applies to SSH host keys. Turning this to `true` does not harden
        // the connection; it removes the feature.
        { socket: stream as unknown as import('node:net').Socket, rejectUnauthorized: false },
        () => {
          if (settled) return
          // The network half is done, so the deadline for it stops here. What
          // remains is a person reading a fingerprint, and timing that out
          // after twenty seconds would refuse the connection for thinking.
          clearTimeout(timer)
          const peer = socket.getPeerCertificate(true)
          const chain = collectChain(peer)
          const leaf = peer?.raw
          if (!leaf) {
            fail(new Error('the server presented no certificate'))
            return
          }
          // Before the response reaches the client and before a single byte is
          // relayed: an untrusted server must not be spoken to at all.
          void verifyRdpCertificate(target.host, target.port, Buffer.from(leaf))
            .then((trusted) => {
              if (settled) return
              if (!trusted) {
                fail(new Error('the certificate for this host was not trusted'))
                return
              }
              settled = true
              resolve({ x224Response: Buffer.from(x224Response), certChain: chain, tlsSocket: socket })
            })
            .catch((err: Error) => fail(err))
        }
      )
      socket.once('error', (err) => fail(new Error(`TLS handshake failed: ${err.message}`)))
    })

    stream.write(x224Request)
  })
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

function relay(ws: WebSocket, tlsSocket: TLSSocket, closeTransport: () => void): void {
  sessions++
  if (idleTimer) clearTimeout(idleTimer)

  // Both directions apply backpressure. A desktop under load produces frames
  // faster than a busy renderer drains them, and `ws.send` buffers without
  // bound — so an unpaused pipe turns a slow consumer on either side into main
  // process memory growth for as long as the session lasts.
  tlsSocket.on('data', (chunk: Buffer) => {
    if (ws.readyState !== ws.OPEN) return
    ws.send(chunk)
    if (ws.bufferedAmount > HIGH_WATER_BYTES) {
      tlsSocket.pause()
      // `bufferedAmount` is a poll, not an event: ws offers no drain signal for
      // a server socket, so the only way to notice it has emptied is to look.
      const resume = setInterval(() => {
        if (ws.readyState !== ws.OPEN || ws.bufferedAmount <= HIGH_WATER_BYTES) {
          clearInterval(resume)
          if (!tlsSocket.destroyed) tlsSocket.resume()
        }
      }, 20)
      resume.unref()
    }
  })
  ws.on('message', (chunk: Buffer) => {
    if (tlsSocket.destroyed) return
    // The socket's own drain event is authoritative in this direction, so
    // pausing the WebSocket until it fires is exact rather than sampled.
    if (!tlsSocket.write(chunk)) {
      ws.pause()
      tlsSocket.once('drain', () => ws.resume())
    }
  })

  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    sessions = Math.max(0, sessions - 1)
    if (!tlsSocket.destroyed) tlsSocket.destroy()
    // The SSH chain or VPN forward beneath the TLS session. Destroying only the
    // TLS socket would leave a bastion connection open per closed desktop.
    closeTransport()
    if (ws.readyState === ws.OPEN) ws.close()
    scheduleIdleShutdown()
  }

  tlsSocket.on('end', close)
  tlsSocket.on('close', close)
  tlsSocket.on('error', close)
  ws.on('close', close)
  ws.on('error', close)
}
