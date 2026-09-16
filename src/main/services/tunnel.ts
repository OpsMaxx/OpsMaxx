import net from 'node:net'
import type { Client } from 'ssh2'
import type { WebContents } from 'electron'
import { acquire, openChain, release } from './ssh'
import type { TunnelConfig, TunnelResult, TunnelSshConfig, TunnelState, TunnelStatus } from '../../shared/tunnel'

// Port forwarding over the SSH transport:
//   local  — listen here, forwardOut each connection to target via the server
//   remote — ask the server to listen, pipe its connections to a local target
//   socks  — listen here, speak SOCKS5, forwardOut to whatever each client asks

interface Active {
  cfg: TunnelConfig
  clients: Client[]
  server: net.Server | null
  sockets: Set<net.Socket>
  state: TunnelState
  error?: string
  connections: number
  listenPort?: number
  lastForwardError?: string
  forwardFailures: number
  wc: WebContents | null
}

const tunnels = new Map<string, Active>()

// A tunnel started by an AI agent has no renderer that asked for it, so there
// is nowhere to push status to. That is not a reason to refuse to start one —
// the tunnel manager reads live state from tunnelList() when it next renders.
function emit(t: Active): void {
  if (!t.wc || t.wc.isDestroyed()) return
  const status: TunnelStatus = {
    id: t.cfg.id,
    state: t.state,
    error: t.error,
    connections: t.connections,
    listenPort: t.listenPort,
    lastForwardError: t.lastForwardError,
    forwardFailures: t.forwardFailures || undefined
  }
  t.wc.send(`tunnel:status:${t.cfg.id}`, status)
}

/**
 * A connection reached the listener and could not reach the target.
 *
 * Not an error state: the listener is bound and the next connection may well
 * succeed, so flipping the tunnel to `error` would be its own untruth and would
 * race with a stop that is already under way. What was wrong before was that
 * this said nothing at all -- the `.catch(() => socket.destroy())` sites
 * sites dropped the reason on the floor, leaving a green tunnel with a
 * connection count of zero and no way to find out why.
 */
function forwardFailed(t: Active, err: unknown): void {
  t.forwardFailures++
  t.lastForwardError = err instanceof Error ? err.message : String(err)
  emit(t)
}

function setState(t: Active, state: TunnelState, error?: string): void {
  t.state = state
  t.error = error
  emit(t)
}

// Wire a socket to an SSH channel, keeping the live connection count honest
// however the pair happens to tear down.
function bind(t: Active, socket: net.Socket, stream: NodeJS.ReadWriteStream): void {
  t.sockets.add(socket)
  t.connections++
  emit(t)
  let done = false
  const finish = (): void => {
    if (done) return
    done = true
    t.sockets.delete(socket)
    t.connections = Math.max(0, t.connections - 1)
    emit(t)
    socket.destroy()
    ;(stream as unknown as { end?: () => void }).end?.()
  }
  socket.on('error', finish)
  socket.on('close', finish)
  stream.on('error', finish)
  stream.on('close', finish)
  socket.pipe(stream).pipe(socket)
}

function forward(
  client: Client,
  srcHost: string,
  srcPort: number,
  dstHost: string,
  dstPort: number
): Promise<NodeJS.ReadWriteStream> {
  return new Promise((resolve, reject) => {
    client.forwardOut(srcHost, srcPort, dstHost, dstPort, (err, stream) =>
      err ? reject(err) : resolve(stream as unknown as NodeJS.ReadWriteStream)
    )
  })
}

function listen(server: net.Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener('error', onError)
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`Port ${port} on ${host} is already in use.`)
          : err.code === 'EACCES'
            ? new Error(`Not allowed to bind port ${port} (ports below 1024 need elevated rights).`)
            : err
      )
    }
    server.once('error', onError)
    server.listen(port, host, () => {
      server.removeListener('error', onError)
      const addr = server.address()
      resolve(typeof addr === 'object' && addr ? addr.port : port)
    })
  })
}

// ------------------------------------------------------------------- SOCKS5

const SOCKS_VERSION = 0x05
const CMD_CONNECT = 0x01
const ATYP_IPV4 = 0x01
const ATYP_DOMAIN = 0x03
const ATYP_IPV6 = 0x04

// Read exactly `n` bytes, buffering across chunks.
function readBytes(socket: net.Socket, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk)
      total += chunk.length
      if (total < n) return
      const buf = Buffer.concat(chunks, total)
      cleanup()
      // Anything past the requested bytes belongs to the next stage.
      if (buf.length > n) socket.unshift(buf.subarray(n))
      resolve(buf.subarray(0, n))
    }
    const onErr = (e: Error): void => {
      cleanup()
      reject(e)
    }
    const onEnd = (): void => onErr(new Error('SOCKS client closed early'))
    const cleanup = (): void => {
      socket.removeListener('data', onData)
      socket.removeListener('error', onErr)
      socket.removeListener('end', onEnd)
    }
    socket.on('data', onData)
    socket.on('error', onErr)
    socket.on('end', onEnd)
  })
}

function socksReply(socket: net.Socket, code: number): void {
  // Reply address is unused by clients for CONNECT; report 0.0.0.0:0.
  socket.write(Buffer.from([SOCKS_VERSION, code, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]))
}

async function handleSocks(t: Active, client: Client, socket: net.Socket): Promise<void> {
  // Greeting: version, method count, methods.
  const head = await readBytes(socket, 2)
  if (head[0] !== SOCKS_VERSION) throw new Error('Not a SOCKS5 client')
  await readBytes(socket, head[1])
  socket.write(Buffer.from([SOCKS_VERSION, 0x00])) // no authentication

  // Request: version, command, reserved, address type.
  const req = await readBytes(socket, 4)
  if (req[1] !== CMD_CONNECT) {
    socksReply(socket, 0x07) // command not supported
    socket.end()
    return
  }

  let host: string
  if (req[3] === ATYP_IPV4) {
    host = [...(await readBytes(socket, 4))].join('.')
  } else if (req[3] === ATYP_DOMAIN) {
    const len = (await readBytes(socket, 1))[0]
    host = (await readBytes(socket, len)).toString('utf8')
  } else if (req[3] === ATYP_IPV6) {
    const raw = await readBytes(socket, 16)
    const parts: string[] = []
    for (let i = 0; i < 16; i += 2) parts.push(raw.readUInt16BE(i).toString(16))
    host = parts.join(':')
  } else {
    socksReply(socket, 0x08) // address type not supported
    socket.end()
    return
  }
  const port = (await readBytes(socket, 2)).readUInt16BE(0)

  let stream: NodeJS.ReadWriteStream
  try {
    stream = await forward(client, socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0, host, port)
  } catch {
    socksReply(socket, 0x05) // connection refused
    socket.end()
    return
  }
  socksReply(socket, 0x00)
  bind(t, socket, stream)
}

// ---------------------------------------------------------------- lifecycle

/**
 * A tunnel gets its OWN connection, jump boxes and all.
 *
 * `openChain` and not `acquire`, deliberately, and unlike the ephemeral
 * forward below. A tunnel is a long-lived thing an operator started and expects
 * to outlive whatever else is open: riding the shared pool would mean a
 * terminal closing, or the pool's idle rules, deciding when a published port
 * stops answering. It dials every hop of its own chain and `tunnelStop` ends
 * every one of them, so nothing it holds is anybody else's.
 */
export async function tunnelStart(
  wc: WebContents | null,
  cfg: TunnelConfig,
  ssh: TunnelSshConfig,
  /**
   * False for a caller with nobody in front of it.
   *
   * The MCP bridge can start a tunnel (`set_tunnel`), and an agent doing so
   * must not be able to raise a verification-code dialog on a bastion or a
   * trust-on-first-use dialog for an unknown host — that would record a trust
   * decision as a side effect of something the agent asked for. The IPC handler
   * opts in, because there a person pressed Start.
   */
  allowPrompt = false
): Promise<TunnelResult> {
  await tunnelStop(cfg.id)

  const t: Active = {
    cfg,
    clients: [],
    server: null,
    sockets: new Set(),
    state: 'starting',
    connections: 0,
    forwardFailures: 0,
    wc
  }
  tunnels.set(cfg.id, t)
  emit(t)

  try {
    const chain = await openChain(ssh, undefined, allowPrompt)
    t.clients = chain.clients
    const client = chain.client

    /**
     * EVERY hop, not just the last one.
     *
     * A dropped SSH connection must not leave a listener accepting traffic that
     * has nowhere to go — and on a chain the connection that drops is often not
     * the one carrying the traffic. Hops 1..n ride channels opened on the hop
     * before, so a bastion going away kills the whole chain in fact, but only
     * the client whose socket actually closed is guaranteed to say so. Watching
     * the last one alone left a multi-hop tunnel reporting `active`, with a
     * bound port, over a path that had been dead for minutes.
     *
     * Stopping is idempotent and `tunnels.get(cfg.id) === t` guards a tunnel
     * that has already been replaced, so several hops closing at once is one
     * stop, not n.
     */
    for (const c of chain.clients) {
      c.on('close', () => {
        if (tunnels.get(cfg.id) === t && t.state === 'active') {
          setState(t, 'error', 'SSH connection closed')
          void tunnelStop(cfg.id, true)
        }
      })
      c.on('error', (err: Error) => {
        if (tunnels.get(cfg.id) === t) setState(t, 'error', err.message)
      })
    }

    if (cfg.kind === 'remote') {
      const port = await new Promise<number>((resolve, reject) => {
        client.forwardIn(cfg.listenHost, cfg.listenPort, (err, bound) =>
          err ? reject(err) : resolve(bound || cfg.listenPort)
        )
      })
      client.on('tcp connection', (info, accept) => {
        if (info.destPort !== port) return
        const stream = accept() as unknown as NodeJS.ReadWriteStream
        const socket = net.connect(cfg.targetPort, cfg.targetHost)
        socket.on('connect', () => bind(t, socket, stream))
        socket.on('error', (err) => {
          forwardFailed(t, err)
          ;(stream as unknown as { end: () => void }).end()
        })
      })
      t.listenPort = port
      setState(t, 'active')
      return { ok: true, listenPort: port }
    }

    const server = net.createServer((socket) => {
      if (cfg.kind === 'socks') {
        handleSocks(t, client, socket).catch((err) => {
          forwardFailed(t, err)
          socket.destroy()
        })
        return
      }
      forward(client, socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0, cfg.targetHost, cfg.targetPort)
        .then((stream) => bind(t, socket, stream))
        .catch((err) => {
          forwardFailed(t, err)
          socket.destroy()
        })
    })
    t.server = server
    t.listenPort = await listen(server, cfg.listenHost, cfg.listenPort)
    setState(t, 'active')
    return { ok: true, listenPort: t.listenPort }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    setState(t, 'error', message)
    await tunnelStop(cfg.id, true)
    return { ok: false, error: message }
  }
}

export async function tunnelStop(id: string, keepError = false): Promise<void> {
  const t = tunnels.get(id)
  if (!t) return
  tunnels.delete(id)
  for (const s of t.sockets) {
    try {
      s.destroy()
    } catch {
      /* ignore */
    }
  }
  t.sockets.clear()
  if (t.server) await new Promise<void>((resolve) => t.server?.close(() => resolve()))
  for (const c of [...t.clients].reverse()) {
    try {
      c.end()
    } catch {
      /* ignore */
    }
  }
  t.connections = 0
  // A fresh run reports its own failures, not the previous run's.
  t.forwardFailures = 0
  t.lastForwardError = undefined
  if (!keepError) setState(t, 'stopped')
  else emit(t)
}

export function tunnelStatus(id: string): TunnelStatus | null {
  const t = tunnels.get(id)
  if (!t) return null
  return {
    id,
    state: t.state,
    error: t.error,
    connections: t.connections,
    listenPort: t.listenPort,
    lastForwardError: t.lastForwardError,
    forwardFailures: t.forwardFailures || undefined
  }
}

export function tunnelList(): TunnelStatus[] {
  return [...tunnels.keys()].map((id) => tunnelStatus(id)).filter((s): s is TunnelStatus => s !== null)
}

export function tunnelDisposeAll(): void {
  for (const id of [...tunnels.keys()]) void tunnelStop(id, true)
}

/**
 * A local forward on an ephemeral port. Used to reach a database that is only
 * routable from the SSH server. Not a user-visible tunnel — the caller owns its
 * lifetime.
 *
 * POOLED, where it used to dial its own connection through `openChain`.
 *
 * The old behaviour was one full SSH authentication per database connection.
 * On a bastion with a second factor that is one verification code per
 * connection, and `openTransient` — which the Operations panel uses on purpose,
 * because a shared client would leak its session settings into the query tab —
 * opens a fresh one every time it runs. So reading a database behind a
 * two-factor bastion meant typing a code per click, and none of those codes
 * could be spent on the connection the user's own terminal had already
 * authenticated to the same machine.
 *
 * `acquire` is the same pool every terminal, SFTP browser and metrics sample
 * already shares, so the bastion is authenticated once and this rides it. It
 * also brings the VPN and cloud transports with it, which this path was
 * hand-rolling or missing.
 *
 * `close()` therefore RELEASES rather than ending the clients: ending them
 * would tear down the terminal sitting on the same connection.
 */
export async function openEphemeralForward(
  ssh: TunnelSshConfig,
  targetHost: string,
  targetPort: number,
  // False for a caller with nobody in front of it -- the MCP bridge's database
  // tools and the size sampler. See ssh.ts's keyboard-interactive handler.
  allowPrompt = false
): Promise<{ port: number; close: () => void }> {
  const conn = await acquire(ssh, undefined, allowPrompt)
  const client = conn.client
  const sockets = new Set<net.Socket>()

  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    forward(client, '127.0.0.1', 0, targetHost, targetPort)
      .then((stream) => {
        socket.pipe(stream).pipe(socket)
        const kill = (): void => {
          socket.destroy()
          ;(stream as unknown as { end?: () => void }).end?.()
        }
        socket.on('error', kill)
        stream.on('error', kill)
      })
      .catch((err) => {
        // No Active tunnel here and so no status to emit: this forward is owned
        // by whoever asked for it (a database connection reaching a host only
        // routable from the SSH server), and its lifetime ends with theirs.
        // What the caller sees without this is a reset socket and a generic
        // client-side "connection closed", with the actual reason -- refused,
        // no route, wrong port -- discarded here. Logged rather than swallowed,
        // so it is at least answerable.
        console.error(
          `[tunnel] ephemeral forward to ${targetHost}:${targetPort} failed:`,
          err instanceof Error ? err.message : err
        )
        socket.destroy()
      })
  })

  // Released on the way out too. Binding a local port is the one thing here
  // that can fail after the connection is in hand, and a ref taken and never
  // given back pins the bastion open for the life of the app.
  let port: number
  try {
    port = await listen(server, '127.0.0.1', 0)
  } catch (err) {
    server.close()
    release(conn)
    throw err
  }

  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    for (const s of sockets) s.destroy()
    sockets.clear()
    server.close()
    client.removeListener('close', onConnectionLost)
    // Hand the connection back rather than ending it. Another pane may be on
    // it; the pool's own idle rules decide when it actually goes away.
    release(conn)
  }

  /**
   * The shared connection going away takes this listener with it.
   *
   * Without this the local port stays bound over a dead channel, so the
   * database driver's next connection hangs until its own timeout rather than
   * being refused — and the caller's `close()` would later release a connection
   * that is already gone. Closing the listener turns a dropped bastion into a
   * refused connection, which every driver reports immediately and clearly.
   */
  function onConnectionLost(): void {
    close()
  }
  client.once('close', onConnectionLost)

  return { port, close }
}
