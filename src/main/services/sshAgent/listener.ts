import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, existsSync, mkdirSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { MessageStream, ProtocolError } from './protocol'
import { handleMessage, type AgentDeps, type SessionState } from './agent'

/**
 * Where the agent listens.
 *
 * ONE PROTOCOL CORE, SEVERAL LISTENERS. The core takes a Buffer and returns a
 * Buffer; everything below is about the differences between a Unix domain
 * socket and a Windows named pipe, which are considerable and none of which
 * the protocol should have to know.
 */

/** How long a connection may hold an incomplete message.
 *
 *  A peer that connects and sends three bytes of a length prefix costs a file
 *  descriptor and a buffer for as long as it likes. Every local process can
 *  reach this socket, so "local" is not a trust boundary here -- it is the
 *  boundary this whole feature is about. */
const IDLE_MS = 60_000

/** The most connections to hold at once. Generous for real use -- a busy `git
 *  push` opens one -- and finite, which is the point. */
const MAX_CONNECTIONS = 32

export interface ListenerOptions {
  deps: AgentDeps
  /** Overridden by tests. Production picks its own path. */
  path?: string
  log?(message: string): void
}

export interface RunningListener {
  /** What goes in `SSH_AUTH_SOCK`, or the pipe name on Windows. */
  path: string
  close(): Promise<void>
}

/**
 * The socket path.
 *
 * A directory of our own under the OS temp root, mode 0700, with a random
 * component. Three things that buys, in order of how badly each one bites:
 *
 *  - A predictable path in a shared temp directory is a path another user can
 *    create first. They then own the socket, every tool on the machine
 *    connects to THEM, and the user's `ssh-add -l` looks entirely normal.
 *  - `chmod 0700` on the directory rather than only on the socket, because the
 *    permissions that are portably enforced on a Unix socket are the
 *    directory's -- several kernels ignore the socket's own mode bits.
 *  - A per-run component means a stale socket from a crashed previous run is
 *    never mistaken for a live one.
 */
export function defaultSocketPath(): string {
  const dir = join(tmpdir(), `opsmaxx-agent-${process.getuid?.() ?? 0}-${randomBytes(6).toString('hex')}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  return join(dir, 'agent.sock')
}

/** `\\.\pipe\...`, with a random component for the same reason.
 *
 *  Deliberately NOT `\\.\pipe\openssh-ssh-agent`: that is Windows' own agent
 *  and the name 1Password and Bitwarden also use, so binding it would either
 *  fail or, worse, silently take over for every tool on the machine including
 *  ones the user did not mean to point here. */
export function defaultPipePath(): string {
  return `\\\\.\\pipe\\opsmaxx-ssh-agent-${randomBytes(6).toString('hex')}`
}

/**
 * Binds the agent.
 *
 * The Windows and Unix paths differ in one way that matters beyond the name,
 * and it is the thing the plan flagged: a named pipe SERVER INSTANCE IS
 * CONSUMED BY THE CONNECTION IT ACCEPTS. Node's net server handles the
 * re-creation internally for the listening handle, but the window between
 * accept and the next instance existing is real, and a client connecting in it
 * gets ERROR_PIPE_BUSY rather than a queue. So on Windows the server is created
 * with a backlog and never torn down between connections -- and this comment
 * exists because the symptom, if it is ever got wrong, is an intermittent
 * "could not connect to agent" under concurrency that reproduces on nobody's
 * machine.
 */
export async function listen(opts: ListenerOptions): Promise<RunningListener> {
  const windows = process.platform === 'win32'
  const path = opts.path ?? (windows ? defaultPipePath() : defaultSocketPath())

  if (!windows && existsSync(path)) {
    // Only ours to remove, and only if it is actually a socket. Unlinking
    // whatever happens to be at a path is how a bug becomes a data loss.
    try {
      if (statSync(path).isSocket()) unlinkSync(path)
    } catch {
      /* if it cannot be inspected, listen() will fail and say so */
    }
  }

  const connections = new Set<Socket>()
  const server: Server = createServer((socket) => {
    if (connections.size >= MAX_CONNECTIONS) {
      socket.destroy()
      return
    }
    connections.add(socket)
    serve(socket, opts, () => connections.delete(socket))
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('error', onError)
      reject(err)
    }
    server.once('error', onError)
    // A backlog, for the Windows reason above and because a Unix socket with a
    // backlog of one refuses a second concurrent `git` under load.
    server.listen({ path, backlog: 16 }, () => {
      server.removeListener('error', onError)
      resolve()
    })
  })

  if (!windows) {
    // Belt as well as braces over the 0700 directory. Several kernels ignore a
    // socket's own mode, which is exactly why the directory carries the real
    // permission -- but the ones that honour it should see 0600.
    try {
      chmodSync(path, 0o600)
    } catch {
      /* the directory is the enforced boundary; this is the extra one */
    }
  }

  return {
    path,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of connections) socket.destroy()
        connections.clear()
        server.close(() => {
          if (!windows) {
            try {
              unlinkSync(path)
            } catch {
              /* already gone */
            }
          }
          resolve()
        })
      })
  }
}

function serve(socket: Socket, opts: ListenerOptions, done: () => void): void {
  const stream = new MessageStream()
  const session: SessionState = {}
  let closed = false

  const shut = (why?: string): void => {
    if (closed) return
    closed = true
    if (why) opts.log?.(`agent connection closed: ${why}`)
    socket.destroy()
    done()
  }

  socket.setTimeout(IDLE_MS, () => shut('idle'))
  socket.on('error', () => shut())
  socket.on('close', () => shut())

  // Serialised deliberately. The protocol is request/response and a client may
  // pipeline, so replies must go back in order -- and a sign request can block
  // on a human for a long time. Handling the next message while a prompt is up
  // would let a second request overtake the first and answer the wrong one.
  let chain: Promise<void> = Promise.resolve()

  socket.on('data', (chunk) => {
    let messages: Buffer[]
    try {
      messages = stream.push(chunk)
    } catch (err) {
      // A peer whose framing we have stopped trusting cannot be resynchronised.
      shut(err instanceof ProtocolError ? err.message : 'bad framing')
      return
    }
    for (const body of messages) {
      chain = chain.then(async () => {
        if (closed) return
        const reply = await handleMessage(body, session, opts.deps)
        if (!closed) socket.write(reply)
      })
    }
  })
}
