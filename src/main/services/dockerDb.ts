import net from 'node:net'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import {
  CONTAINER_NAME_RE,
  buildDbContainerAddressCommand,
  buildDbContainerListCommand,
  parseDbContainerAddress,
  parseDbContainerList,
  type DbContainerProbe
} from '../../shared/dockerDb'
import type { DockerExec } from './docker'
import { LOCAL_TARGET } from '../../shared/execTarget'

// Finding database containers, and reaching one that publishes no port.
// Parsing and command building are in shared/dockerDb.ts; this is the round
// trip, the sudo retry, and the relay for a Docker that hides its network.
//
// Every command goes through the injected exec, never a local-exec import:
// db.ts is reachable from the MCP bridge, and nothing an agent can reach may
// import the local terminal (tests/localTerminalNotExposed.test.ts). The
// bridge refuses a container on this computer before it gets here -- see
// databaseConfig in mcpServer.ts.

let deps: { exec: DockerExec; execQuiet: DockerExec } | null = null

/** Wired from main/index.ts, which owns the SSH-or-local dispatch. */
export function configureDockerDb(d: { exec: DockerExec; execQuiet: DockerExec }): void {
  deps = d
}

type Read = { ok: boolean; reason?: string }

/**
 * One read, retried as root only when the socket refused this account.
 *
 * `sudo -n` never prompts, so the retry either works because the user already
 * set up passwordless sudo on that host or fails at once -- the same discipline
 * as the Docker panel's reads (services/docker.ts).
 */
async function read<R extends Read>(
  target: unknown,
  build: (sudo: boolean) => string,
  parse: (output: string, code: number | null) => R,
  allowPrompt: boolean
): Promise<R & { usedSudo?: boolean }> {
  if (!deps) throw new Error('Container lookup is not available.')
  const exec = allowPrompt ? deps.exec : deps.execQuiet
  const run = async (sudo: boolean): Promise<R> => {
    const r = await exec(target, build(sudo), 20_000)
    if (!r.ok) return { ok: false, reason: 'unknown', detail: r.error ?? 'could not reach the server' } as never
    const stderr = r.stderr ?? ''
    return parse(stderr === '' ? (r.stdout ?? '') : `${r.stdout ?? ''}\n${stderr}`, r.code ?? null)
  }
  const first = await run(false)
  if (first.ok || first.reason !== 'permission-denied') return first
  const elevated = await run(true)
  return elevated.ok ? { ...elevated, usedSudo: true } : first
}

export function listDbContainers(target: unknown): Promise<DbContainerProbe> {
  return read(target, (sudo) => buildDbContainerListCommand({ sudo }), parseDbContainerList, true)
}

/** The container's current address, or an error that says what to do about it. */
export async function resolveDbContainer(
  target: unknown,
  name: string,
  allowPrompt: boolean
): Promise<{ ip: string; network: string }> {
  const r = await read(target, (sudo) => buildDbContainerAddressCommand(name, { sudo }), parseDbContainerAddress, allowPrompt)
  if (r.ok) return { ip: r.ip, network: r.network }
  switch (r.reason) {
    case 'not-found':
      throw new Error(`There is no container named "${name}" any more. Pick it again in the connection's settings.`)
    case 'no-address':
      throw new Error(`The container "${name}" has no network address. Is it running?`)
    case 'permission-denied':
      throw new Error(
        `This account is not allowed to use Docker, so the container "${name}" cannot be found. ` +
          'Add it to the docker group, or allow passwordless sudo for it.'
      )
    case 'not-installed':
      throw new Error('Docker is not installed where this connection looks for the container.')
    case 'daemon-unreachable':
      throw new Error('Docker is not running where this connection looks for the container.')
    default:
      throw new Error(`The container "${name}" could not be looked up: ${r.detail}`)
  }
}

/** Whether this machine can open a TCP connection to the address itself. */
export function canReach(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port })
    const done = (ok: boolean): void => {
      s.destroy()
      resolve(ok)
    }
    s.setTimeout(timeoutMs, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

// ---- The relay ----
//
// Docker Desktop (macOS, Windows) and rootless Docker keep containers in a
// network this machine has no route into, so the address above answers
// nothing. A small helper container joins the database's network instead, and
// each connection runs `docker exec -i <helper> nc <ip> <port>`, piped to a
// listener on this machine's loopback. Nothing is published: the listener is
// 127.0.0.1 only, and the helper exposes no port at all.
//
// `alpine` is the official image and busybox `nc` is in it, which is the whole
// reason it was chosen over a socat image. Docker pulls it on first use.

const RELAY_IMAGE = 'alpine:3.20'
const run = promisify(execFile)
const relays = new Map<string, { users: number; ready: Promise<string> }>()

let dockerBin: Promise<string> | null = null
function docker(): Promise<string> {
  // The login PATH, not Electron's: on macOS that is often /usr/bin:/bin,
  // and Docker Desktop's CLI lives elsewhere.
  if (!deps) return Promise.reject(new Error('Container lookup is not available.'))
  dockerBin ??= deps.exec(LOCAL_TARGET, 'command -v docker || command -v podman', 10_000).then((r) => {
    const bin = (r.stdout ?? '').trim().split('\n')[0]
    if (!r.ok || !bin) throw new Error('Docker was not found on this computer.')
    return bin
  })
  return dockerBin
}

function helperName(network: string): string {
  return `opsmaxx-db-relay-${network}`.slice(0, 120)
}

async function startHelper(network: string): Promise<string> {
  const bin = await docker()
  const name = helperName(network)
  // A helper a previous run left behind is replaced rather than trusted.
  await run(bin, ['rm', '-f', name]).catch(() => undefined)
  await run(
    bin,
    ['run', '-d', '--rm', '--name', name, '--label', 'opsmaxx.role=db-relay', '--network', network, RELAY_IMAGE, 'sleep', 'infinity'],
    { timeout: 180_000 }
  ).catch((e: Error & { stderr?: string }) => {
    throw new Error(`The helper container could not be started: ${(e.stderr || e.message).trim()}`)
  })
  return name
}

function releaseHelper(network: string): void {
  const r = relays.get(network)
  if (!r || --r.users > 0) return
  relays.delete(network)
  void Promise.all([docker(), r.ready])
    .then(([bin, name]) => run(bin, ['rm', '-f', name]))
    .catch(() => undefined)
}

export async function openContainerRelay(
  network: string,
  ip: string,
  port: number
): Promise<{ port: number; close: () => void }> {
  if (!CONTAINER_NAME_RE.test(network)) throw new Error(`"${network}" is not a network name.`)
  // ponytail: one helper per network, shared and reference-counted; a crash
  // leaves it running until the next relay on that network replaces it.
  let entry = relays.get(network)
  if (!entry) {
    entry = { users: 0, ready: startHelper(network) }
    relays.set(network, entry)
  }
  entry.users++
  let helper: string
  try {
    helper = await entry.ready
  } catch (e) {
    relays.delete(network)
    throw e
  }
  const bin = await docker()

  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    const child = spawn(bin, ['exec', '-i', helper, 'nc', ip, String(port)], { windowsHide: true })
    socket.pipe(child.stdin)
    child.stdout.pipe(socket)
    child.on('exit', () => socket.destroy())
    child.on('error', () => socket.destroy())
    child.stdin.on('error', () => undefined)
    socket.on('error', () => undefined)
    socket.on('close', () => {
      sockets.delete(socket)
      child.kill()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => {
      server.close()
      for (const s of sockets) s.destroy()
      releaseHelper(network)
    }
  }
}
