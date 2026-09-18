import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http'
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
import { loopbackUpgradeAllowed, refuseNonLoopback, rendererOrigins } from './loopbackGuard'

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
 * Bumped every time the relay is torn down.
 *
 * stopRdpRelay zeroes the counters synchronously, but `terminate()` fires each
 * socket's `close` asynchronously. If a new listener is built in that gap — the
 * idle shutdown is fire-and-forget, and a mint can land during the awaits in
 * the teardown — the old sockets' close handlers arrive late and decrement
 * counters that now belong to the NEW relay, so a live desktop reads as idle
 * and is reaped sixty seconds later for no visible reason. Each session
 * remembers the generation it was counted in and only releases its own.
 */
let generation = 0

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
 * Why the last attempt on a given server failed, in words.
 *
 * The paragraph above says a sticky `lastError` was dropped because "a failure
 * nobody displays is a failure the session itself already reported". The half
 * of that which is wrong is "reported": what the session reports is an
 * RDCleanPath error PDU carrying an integer and an HTTP status, so a refused
 * certificate, a deleted server, a session cap and a machine with no RDP
 * service running all arrive as "general error (code 1); HTTP 502 bad
 * gateway". A real Linux host with no xrdp on it is what proved the point.
 *
 * So this comes back, with the two things that were missing before: it is
 * displayed, and it is keyed by server rather than global, so two desktops
 * failing at once cannot show each other's reason.
 */
const failures = new Map<string, string>()

/** Kept small on purpose: one entry per server, and the map only ever holds
 *  servers the user has actually tried to open. */
function rememberFailure(serverId: string, err: unknown): void {
  failures.set(serverId, explain(err))
}

export function rdpLastError(serverId: string): string | null {
  return failures.get(serverId) ?? null
}

/** Cleared when a session gets through, so a stale reason cannot outlive the
 *  problem it described. */
function forgetFailure(serverId: string): void {
  failures.delete(serverId)
}

/**
 * Something true about a session that WORKED, kept apart from why one failed.
 *
 * These are two different things and putting them in one box made the product
 * worse: the "connected without forward secrecy" note was stored as a failure,
 * so the next genuine error — a refused password — was shown after it, in
 * brackets, behind a sentence about TLS that had nothing to do with it.
 *
 * An advisory describes the host and outlives the session, so it is cleared
 * only when a connection no longer needs the thing it warns about.
 */
const advisories = new Map<string, string>()

export function rdpAdvisory(serverId: string): string | null {
  return advisories.get(serverId) ?? null
}

/**
 * The errno cases worth naming, because each one sends you somewhere different.
 *
 * Anything unrecognised keeps its own message rather than being flattened into
 * a house phrase - the point of this function is to stop losing detail, so
 * inventing a friendlier wording for an error nobody predicted would repeat
 * the mistake at one remove.
 */
function explain(err: unknown): string {
  // Down the `cause` chain: dialDirect wraps the socket error to say which
  // host and port it was, so the errno is one level in.
  let code: string | undefined
  for (let e: unknown = err, hops = 0; e && hops < 5; hops++) {
    const c = (e as { code?: string }).code
    if (typeof c === 'string') {
      code = c
      break
    }
    e = (e as { cause?: unknown }).cause
  }
  const message = err instanceof Error ? err.message : String(err)
  switch (code) {
    case 'ECONNREFUSED':
      return 'Nothing is listening for remote desktop on that host and port. A Windows machine needs Remote Desktop turned on; a Linux one needs xrdp installed and running.'
    case 'ETIMEDOUT':
      return 'The host did not answer. It may be off, or a firewall may be dropping the remote desktop port.'
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'That hostname did not resolve.'
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'There is no route to that host from here.'
    default:
      return message
  }
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
    const server = createServer((req, res) => {
      if (refuseNonLoopback(req, res)) return
      res.writeHead(404).end()
    })

    const sockets = new WebSocketServer({
      server,
      path: '/rdp',
      // The upgrade is the only thing this server actually does, so guarding
      // the 404 handler above would guard nothing. Refused at the handshake
      // rather than closed afterwards: a closed socket looks like a network
      // problem to whatever opened it, and a refused upgrade does not.
      //
      // Unlike the other two loopback servers, this one IS dialled by a
      // browser — our own renderer — and RFC 6455 makes it send an `Origin`.
      // Refusing every Origin here refused the renderer, which is what broke
      // RDP in 0.50.0 with exactly the "closed socket looks like a network
      // problem" symptom the line above warns about.
      // A CEILING ON A FRAME NOBODY HAS AUTHENTICATED YET.
      //
      // ws defaults maxPayload to 100 MiB, and a socket is accepted and may
      // buffer a whole frame of that size BEFORE the first message is parsed
      // and its token looked at. Nothing bounded how many such sockets there
      // could be, so anything that found the port could grow main-process
      // memory without presenting a credential at all -- and each one held
      // `connecting` above zero, which keeps the listener from ever idling out.
      //
      // 64 KiB is far above anything the protocol sends here: the first message
      // is an RDCleanPath request PDU carrying an X.224 Connection Request, and
      // the relayed traffic after it is TLS records, which cap at 16 KiB plus
      // overhead.
      maxPayload: 64 * 1024,
      verifyClient: ({ req }: { req: IncomingMessage }) =>
        // Refused at the handshake rather than after it, so a flood cannot
        // occupy the pre-auth window in the first place. `connecting` counts
        // sockets past the upgrade and not yet relaying.
        connecting < MAX_SESSIONS && loopbackUpgradeAllowed(req, rendererOrigins())
    })
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
  // Past this point, every counter release from the relay being torn down
  // belongs to a generation that no longer owns these numbers.
  generation++

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
    // The token rides the URL as well as the PDU. Belt and braces, and it costs
    // nothing: the socket is loopback and single-use, and handleConnection
    // accepts either.
    proxyUrl: `ws://127.0.0.1:${listenPort}/rdp?token=${encodeURIComponent(token)}`,
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

/**
 * The PDU's `proxy_auth_token`, or null if this is not a request we can read.
 *
 * Deliberately lenient and deliberately not the real parse: its only job is to
 * find which ticket a socket is claiming, before anything has been dialled.
 * openSession parses the same bytes properly straight afterwards and is what
 * decides whether the request is well formed and whether the token matches the
 * destination.
 */
function proxyAuthOf(first: Buffer): string | null {
  try {
    return parseRequest(first).proxyAuth ?? null
  } catch {
    return null
  }
}

/** Take a minted ticket out of the book. Idempotent. */
function spend(token: string): Ticket | undefined {
  const ticket = tickets.get(token)
  if (!ticket) return undefined
  clearTimeout(ticket.expires)
  tickets.delete(token)
  return ticket
}

/**
 * THE TOKEN MAY ARRIVE ON THE URL OR IN THE PDU, and this used to insist on the
 * URL.
 *
 * RDCleanPath carries `proxy_auth_token` inside the request PDU, which is where
 * the client puts it: `withAuthToken()` reaches the Rust side, and the socket it
 * opens is the proxy address verbatim. Nothing appends a query string. So a
 * relay that closed every socket arriving without `?token=` closed every socket
 * the real client has ever opened — with 1008, which reaches the renderer as the
 * bare "WebSocket is `Closed`" that was reported.
 *
 * It survived because the tests reached for the relay through a helper that
 * appends `?token=` itself, so the whole suite exercised a URL shape the app
 * does not mint. The ticket now carries the token in its URL as well, so the
 * common path still authenticates twice — but a socket without one is no longer
 * refused before it can present the PDU. Authentication is not weakened: the
 * check that matters is the one in openSession, which binds the token to the
 * destination the PDU asks for, and no session starts without it.
 */
function handleConnection(ws: WebSocket, req: { url?: string }): void {
  const urlToken = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('token')
  const ticket = urlToken === null ? undefined : spend(urlToken)
  if (urlToken !== null && !ticket) {
    // Presented one and it was wrong: nothing to wait for.
    ws.close(1008, 'bad token')
    return
  }

  // Counted from here, not from the start of openSession: a ticket presented on
  // the URL is already gone, so between now and the handshake finishing nothing
  // else records that this socket exists.
  connecting++
  let counted = true
  // Same generation scoping as relay(): a socket terminated by a teardown
  // emits its close after the counters have been zeroed and possibly re-used.
  const gen = generation
  const uncount = (): void => {
    if (!counted) return
    counted = false
    if (gen === generation) connecting = Math.max(0, connecting - 1)
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

  // ONE ASSUMPTION, WRITTEN DOWN RATHER THAN DEFENDED.
  //
  // This reads the first frame and relay() attaches the real message handler
  // only after the dial and the handshake, seconds later. Anything arriving in
  // between has no listener and is dropped. Nothing does: the RDCleanPath
  // client waits for the response PDU before it sends a single TLS record.
  //
  // That is an assumption about someone else's code, which this file otherwise
  // refuses to make — so it is stated here rather than left implicit. If it
  // ever stops holding, the fix is `ws.pause()` on the next line and
  // `ws.resume()` at the end of relay() once the real handler is on: frames
  // then queue in the socket, bounded by the TCP receive window, which is how
  // relay() already handles backpressure in this direction. Buffering them into
  // an array instead would add an unbounded memory path for a misbehaving
  // client, to defend against a symptom that does not exist.
  ws.once('message', (data: Buffer) => {
    clearTimeout(firstMessage)
    const first = Buffer.from(data)
    // No token on the URL: the PDU has to name one, and it has to be a ticket
    // this process minted. Parsed here only far enough to find it; openSession
    // parses it properly and is what checks it against the destination.
    let token = urlToken
    let resolved = ticket
    if (!resolved) {
      token = proxyAuthOf(first)
      resolved = token === null ? undefined : spend(token)
      if (!token || !resolved) {
        uncount()
        ws.close(1008, 'bad token')
        scheduleIdleShutdown()
        return
      }
    }
    void openSession(ws, token as string, resolved, first).finally(uncount)
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
    // `sessions + connecting`, not `sessions` alone. The counter this cap
    // reads is only incremented in relay(), AFTER the dial and the whole
    // handshake — so N sockets arriving together all see zero, all pass, and
    // all go on to open an SSH chain apiece. The ceiling exists precisely to
    // bound those chains, and it bounded nothing in the one case it was
    // written for.
    if (sessions + connecting >= MAX_SESSIONS) {
      throw new Error('too many remote desktops are already open')
    }

    const { host, port: target } = wanted
    dialled = await dialTarget(server, host, target)
    // Set when the fallback below carried the session. It survives the success
    // path deliberately: this describes the server's certificate, which is a
    // standing condition, not a failed attempt — so it stays on record until a
    // connection succeeds without needing it.
    let degraded: string | null = null
    let handshake: Handshake
    try {
      handshake = await performHandshake(dialled.stream, request.x224, wanted)
    } catch (err) {
      if (!isKeyUsageRefusal(err)) throw err
      // A fresh connection, not a second handshake on this one: the failed TLS
      // attempt has already consumed the X.224 exchange and left the stream
      // unusable, so there is nothing here to retry on.
      dialled.close()
      dialled = await dialTarget(server, host, target)
      handshake = await performHandshake(dialled.stream, request.x224, wanted, RSA_KEY_EXCHANGE)
      degraded =
        "This host's certificate does not permit the usual key exchange, so the desktop connected with an older one that has no forward secrecy. Reissuing the machine's RDP certificate with the digitalSignature key usage restores it."
    }
    tlsSocket = handshake.tlsSocket

    ws.send(buildResponse(request.destination, handshake.x224Response, handshake.certChain))
    // Got through, so whatever went wrong last time no longer describes
    // anything and must not be shown against the next failure.
    forgetFailure(ticket.serverId)
    // The fallback is not a failure, and must not be filed as one: it is a
    // standing fact about this host's certificate, shown after whatever the
    // session itself has to say rather than in front of it.
    if (degraded) advisories.set(ticket.serverId, degraded)
    else advisories.delete(ticket.serverId)
    relay(ws, handshake.tlsSocket, dialled.close)
  } catch (err) {
    // WHY THIS IS RECORDED RATHER THAN ONLY SENT.
    //
    // The RDCleanPath error PDU carries an integer and an HTTP status and
    // nothing else, so every failure in this block — a destination that does
    // not match the ticket, a server that was deleted, too many sessions, a
    // refused certificate, a host that is simply not listening — reaches the
    // user as the same "general error (code 1); HTTP 502 bad gateway". That
    // sent somebody hunting a relay bug when the answer was that the machine
    // had no RDP service running on it at all.
    //
    // So the reason is kept here for the tab to ask about. Keyed by server, so
    // two desktops failing at once cannot show each other's reason.
    rememberFailure(ticket.serverId, err)
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
    // A DEADLINE ON THE DIAL ITSELF. HANDSHAKE_TIMEOUT_MS is armed inside
    // performHandshake, which cannot start until this resolves, so a
    // blackholed host sat here for the OS TCP timeout -- a minute and a half
    // or more -- with `connecting` held above zero the whole time, which is
    // also the window in which a client giving up leaks the session.
    const socket = netConnect({ host, port, timeout: HANDSHAKE_TIMEOUT_MS }, () => {
      // Cleared on success: from here the socket is a long-lived relay
      // transport, and an idle desktop must not be torn down for being quiet.
      socket.setTimeout(0)
      resolve({ stream: socket, close: () => socket.destroy() })
    })
    socket.once('timeout', () => {
      socket.destroy()
      reject(new Error(`could not reach ${host}:${port}: timed out`))
    })
    socket.once('error', (err) =>
      // `cause` carried, not just the message. Without it the errno is gone by
      // the time anything wants to explain the failure, and ECONNREFUSED —
      // "there is no RDP service on that machine" — becomes indistinguishable
      // from a timeout or a DNS miss, which send you somewhere entirely else.
      reject(new Error(`could not reach ${host}:${port}: ${err.message}`, { cause: err }))
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
/**
 * THE SECOND ATTEMPT, FOR A CERTIFICATE THAT FORBIDS THE FIRST ONE'S CIPHER.
 *
 * Electron links BoringSSL, and BoringSSL enforces the leaf certificate's
 * X.509 KeyUsage against the key exchange it negotiated: keyEncipherment for
 * RSA, digitalSignature for ECDHE_RSA. That enforcement became the default in
 * BORINGSSL_API_VERSION 19; OpenSSL does not do it, and neither do mstsc or
 * FreeRDP. A Windows RDP host whose self-signed certificate carries
 * keyEncipherment but not digitalSignature therefore refuses an ECDHE
 * handshake here and completes one everywhere else, as
 * "KEY_USAGE_BIT_INCORRECT ... ssl_cert.cc".
 *
 * There is a BoringSSL switch for this — SSL_set_enforce_rsa_key_usage — and
 * node:tls exposes no way to reach it, so the only lever left is to stop
 * asking for the key exchange the certificate forbids. Offering RSA key
 * exchange makes keyEncipherment the bit that matters, which is the one such a
 * certificate has. TLS 1.3 has no RSA key exchange at all, hence the cap.
 *
 * NOT THE DEFAULT, AND THIS IS THE POINT. RSA key exchange has no forward
 * secrecy: somebody who records this session and later obtains the server's
 * private key can read it. So the normal path is untouched and keeps ECDHE,
 * and this is reached only after a server has refused, for that server, with
 * the reason recorded so the downgrade is visible rather than silent.
 */
export const RSA_KEY_EXCHANGE = {
  ciphers: 'AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA256:AES128-SHA:AES256-SHA',
  maxVersion: 'TLSv1.2'
} as const

/** Whether this failure is the one RSA_KEY_EXCHANGE can answer. Matched on the
 *  BoringSSL reason code, which is stable and specific — anything broader would
 *  retry handshakes that failed for reasons a cipher list cannot fix. */
export function isKeyUsageRefusal(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('KEY_USAGE_BIT_INCORRECT')
}

/**
 * An RDP Negotiation Failure in the X.224 Connection Confirm, in words.
 *
 * MS-RDPBCGR 2.2.1.2: the Confirm is a 4-byte TPKT header and a 7-byte CC-TPDU,
 * optionally followed by an 8-byte negotiation structure whose first byte is
 * 0x02 for a response and 0x03 for a failure. A server that omits it entirely
 * is doing standard RDP security and is not refusing anything, so a short
 * buffer is a `null` here rather than an error — reading absence as refusal
 * would break every host that simply has nothing to add.
 *
 * Returns null when there is nothing wrong, so the caller reads as a guard.
 */
function negotiationFailure(confirm: Buffer): string | null {
  const NEG_AT = 11
  if (confirm.length < NEG_AT + 8) return null
  if (confirm[NEG_AT] !== 0x03) return null

  const code = confirm.readUInt32LE(NEG_AT + 4)
  switch (code) {
    case 0x00000001:
      return 'This host requires TLS for remote desktop and the connection did not offer it.'
    case 0x00000002:
      return 'This host refuses TLS for remote desktop, which OpsMaxx requires.'
    case 0x00000003:
      return 'This host has no certificate installed for remote desktop, so it cannot start TLS.'
    case 0x00000004:
      return 'This host rejected the combination of security options offered.'
    case 0x00000005:
      // The default on current Windows, and the one worth naming precisely:
      // it is a per-server switch in this app, so the user can act on it.
      return 'This host requires Network Level Authentication. Turn NLA on for this server in its settings, then reconnect.'
    case 0x00000006:
      return 'This host requires TLS with user authentication, which OpsMaxx does not offer.'
    default:
      return `This host refused the remote desktop security options offered (code ${code}).`
  }
}

function performHandshake(
  stream: Duplex,
  x224Request: Buffer,
  // The RDP host, for the certificate pin. Never the bastion: the identity
  // being checked is the machine the desktop is on, not the route to it.
  target: { host: string; port: number },
  // Empty for the normal attempt. RSA_KEY_EXCHANGE on the retry.
  tls: { ciphers?: string; maxVersion?: 'TLSv1.2' } = {}
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
    // FRAMED BY ITS OWN LENGTH, NOT BY WHAT ONE READ RETURNED.
    //
    // This took the first `data` chunk to be the whole Connection Confirm. TCP
    // has no message framing, so that is an assumption about the network, and
    // `once('data')` does not even hand back a segment — it hands back whatever
    // the Readable had buffered when the listener attached, which can be less
    // than one Confirm or more.
    //
    // Split is not exotic: an MSS clamp on a VPN, a re-segmenting proxy, a
    // retransmit, or a server that writes the TPKT header and body separately
    // with TCP_NODELAY set. The jump-host path is likelier still, because an
    // ssh2 channel emits one event per SSH_MSG_CHANNEL_DATA and the bastion
    // reproduces whatever split it saw, then adds its own.
    //
    // What it cost: a Confirm carrying an RDP_NEG_FAILURE arriving as 11 bytes
    // then 8 made negotiationFailure() return null for being too short, so the
    // refusal — the very thing that names the protocol the server wants — was
    // skipped, the remaining bytes were fed to TLS as a ServerHello, and the
    // user got the generic 502 this code exists to prevent.
    //
    // TPKT (RFC 1006 / ITU T.123): byte 0 is version 3, bytes 2-3 are the total
    // length big-endian INCLUDING the four-byte header. That is the frame.
    let pending = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      // Always concat: the one-chunk shortcut typed as a Buffer over a
      // possibly-shared ArrayBuffer, and a Confirm is 19 bytes.
      pending = Buffer.concat([pending, chunk])

      // A Confirm is 11 bytes, or 19 with a negotiation structure. Anything
      // that keeps growing without a plausible TPKT length is not one, and
      // waiting for it for ever is how the handshake timer becomes the only
      // thing between us and a stuck session.
      if (pending.length > 4096) {
        fail(new Error('the server sent an oversized X.224 confirm'))
        return
      }
      if (pending.length < 4) return

      if (pending[0] !== 0x03) {
        fail(new Error('the server did not answer with an RDP (TPKT) confirm'))
        return
      }
      const tpktLen = pending.readUInt16BE(2)
      if (tpktLen < 7 || tpktLen > 4096) {
        fail(new Error(`the server sent a malformed TPKT length (${tpktLen})`))
        return
      }
      if (pending.length < tpktLen) return

      const x224Response = pending.subarray(0, tpktLen)
      // Anything past the Confirm belongs to TLS. Unshifting rather than
      // dropping it: a server may write its ServerHello into the same segment,
      // and those bytes are not ours to discard.
      const rest = pending.subarray(tpktLen)

      // READ THE ANSWER BEFORE ASSUMING IT SAID YES.
      //
      // A server refusing the security it was offered replies with an RDP
      // Negotiation Failure here and then does not speak TLS at all, so the
      // refusal used to surface as a TLS error and then as the generic 502 —
      // with the actual answer sitting unread in the bytes we already had.
      const refusal = negotiationFailure(x224Response)
      if (refusal) {
        fail(new Error(refusal))
        return
      }
      // Every listener has to go before the stream becomes TLS's, or the two
      // layers both consume from it.
      stream.removeAllListeners('error')
      stream.off('data', onData)
      if (rest.length > 0) stream.unshift(rest)

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
        {
          socket: stream as unknown as import('node:net').Socket,
          rejectUnauthorized: false,
          // Normally undefined, so the default suites and TLS 1.3 apply. Set
          // only on the second attempt, for a server whose certificate forbids
          // the key exchange the first attempt chose. See RSA_KEY_EXCHANGE.
          ...tls
        },
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
    }

    // `on`, not `once`: a Confirm that arrives in pieces needs every piece.
    stream.on('data', onData)
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
  // NOTHING TO RELAY TO. Everything below hangs its cleanup off `ws`'s close
  // and error events, so a socket that closed during openSession's async work
  // — the dial, the handshake, or verifyRdpCertificate, which waits on a person
  // reading a fingerprint and is deliberately unbounded — has already emitted
  // both and will never emit them again. `sessions` would then be one higher
  // for the life of the process: `inUse()` stays true, the idle shutdown
  // re-arms for ever, the listener never closes, and the TLS session and its
  // SSH chain leak untracked. stopRdpRelay cannot reach it either, because the
  // socket is no longer among `wss.clients`.
  if (ws.readyState !== ws.OPEN) {
    tlsSocket.destroy()
    closeTransport()
    scheduleIdleShutdown()
    return
  }

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

  const gen = generation
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    // The transport still has to go, whoever it belonged to; only the counter
    // is generation-scoped, because a newer relay owns that number now.
    if (gen === generation) sessions = Math.max(0, sessions - 1)
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
