import { DB_DEFAULT_PORT, type DbKind } from './db'
import { DOCKER_SEP, classifyDockerFailure, resolveBinary, type DockerFailure } from './docker'

// Databases running in Docker containers that publish no port.
//
// A container on a bridge network -- `--internal` ones included -- is reachable
// from its own host at the container's IP, with nothing published and nothing
// listening on a public interface. Measured on Docker 29.9.2 rather than taken
// from the docs: a Postgres with no `-p` answered `pg_isready` from the host's
// network namespace at 172.x on both a normal and an internal network, and did
// not answer on the host's 127.0.0.1.
//
// So a saved database can name a CONTAINER instead of an address. The IP is not
// saved: it changes every time the container is recreated, which is exactly
// when someone would least expect their saved connection to stop working. It
// is looked up by name each time the connection opens.

export interface DbContainerNetwork {
  name: string
  ip: string
}

export interface DbContainer {
  name: string
  image: string
  kind: DbKind
  /** The port the database listens on INSIDE the container. */
  port: number
  /** Whether that port is also published on the host. Shown, not acted on. */
  published: boolean
  networks: DbContainerNetwork[]
}

export type DbContainerProbe =
  | { ok: true; containers: DbContainer[]; usedSudo?: boolean }
  | { ok: false; reason: DockerFailure; detail: string }

export type DbContainerAddress =
  | { ok: true; ip: string; network: string }
  | { ok: false; reason: DockerFailure | 'not-found' | 'no-address'; detail: string }

const MARK = '===OPSMAXX-DBC==='

/**
 * Docker's own rule for a container name, and the reason a name can be put on
 * a command line at all: nothing a shell treats specially can get past it.
 */
export const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/

const NETWORKS = '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}};{{end}}'
const PORTS = '{{range $p, $b := .NetworkSettings.Ports}}{{$p}}={{if $b}}{{(index $b 0).HostPort}}{{end}};{{end}}'
const ROW = ['{{.Name}}', '{{.Config.Image}}', NETWORKS, PORTS].join(DOCKER_SEP)

function runner(sudo: boolean): string {
  return sudo ? 'sudo -n "$SP_BIN"' : '"$SP_BIN"'
}

/** Every running container, inspected in one round trip. */
export function buildDbContainerListCommand(opts: { sudo?: boolean } = {}): string {
  const run = runner(!!opts.sudo)
  return [
    resolveBinary('docker', [], ['podman']),
    `ids=$(${run} ps -q 2>&1) || { printf '%s\\n' "$ids"; exit 1; }`,
    `echo "${MARK}"`,
    `[ -z "$ids" ] || ${run} inspect --format '${ROW}' $ids 2>&1`
  ].join('; ')
}

/** One container's networks and addresses. Throws on a name docker would not accept. */
export function buildDbContainerAddressCommand(name: string, opts: { sudo?: boolean } = {}): string {
  if (!CONTAINER_NAME_RE.test(name)) throw new Error(`"${name}" is not a container name.`)
  const run = runner(!!opts.sudo)
  return [
    resolveBinary('docker', [], ['podman']),
    `out=$(${run} inspect --format '${NETWORKS}' ${name} 2>&1) || { printf '%s\\n' "$out"; exit 1; }`,
    `echo "${MARK}"`,
    `printf '%s\\n' "$out"`
  ].join('; ')
}

/**
 * Which engine an image runs, from its repository name.
 *
 * Registry and tag are dropped first, so `mcr.microsoft.com/mssql/server:2022`
 * and `docker.io/library/postgres:16-alpine` both reduce to the path that says
 * what they are. Anything unrecognised is not offered: a list of every
 * container on the host is the Docker panel's job, not a database picker's.
 */
export function dbKindForImage(image: string): DbKind | null {
  const repo = image
    .replace(/@.*$/, '')
    .replace(/:[^/]*$/, '')
    .replace(/^[^/]+\.[^/]+\//, '')
    .toLowerCase()
  if (/postgres|postgis|timescale|pgvector/.test(repo)) return 'postgres'
  if (/mysql|mariadb|percona/.test(repo)) return 'mysql'
  if (/mssql|sql-server|azure-sql-edge/.test(repo)) return 'mssql'
  if (/mongo/.test(repo)) return 'mongodb'
  if (/redis|valkey|keydb/.test(repo)) return 'redis'
  // Keeper ships from the same org but is ZooKeeper's stand-in, not a database.
  if (/clickhouse/.test(repo) && !/keeper/.test(repo)) return 'clickhouse'
  return null
}

function parseNetworks(field: string): DbContainerNetwork[] {
  return field
    .split(';')
    .map((pair) => {
      const i = pair.lastIndexOf('=')
      return { name: pair.slice(0, i).trim(), ip: pair.slice(i + 1).trim() }
    })
    // `host` and `none` carry no address of their own.
    .filter((n) => n.name !== '' && n.ip !== '')
}

function parsePorts(field: string): { port: number; published: boolean }[] {
  const out: { port: number; published: boolean }[] = []
  for (const pair of field.split(';')) {
    const m = /^(\d+)\/tcp=(\d*)$/.exec(pair.trim())
    if (m) out.push({ port: Number(m[1]), published: m[2] !== '' })
  }
  return out
}

function splitAtMark(output: string, exitCode: number | null): { body: string } | { ok: false; reason: DockerFailure; detail: string } {
  const at = output.indexOf(MARK)
  if (at === -1) {
    const detail = output.split('\n').find((l) => l.trim() !== '')?.trim() ?? 'docker did not run'
    return { ok: false, reason: classifyDockerFailure(output, exitCode), detail }
  }
  return { body: output.slice(at + MARK.length) }
}

export function parseDbContainerList(output: string, exitCode: number | null): DbContainerProbe {
  const split = splitAtMark(output, exitCode)
  if (!('body' in split)) return split
  const containers: DbContainer[] = []
  for (const line of split.body.split('\n')) {
    const f = line.split(DOCKER_SEP)
    if (f.length !== 4) continue
    const kind = dbKindForImage(f[1].trim())
    if (!kind) continue
    const ports = parsePorts(f[3])
    const own = ports.find((p) => p.port === DB_DEFAULT_PORT[kind]) ?? ports[0]
    containers.push({
      name: f[0].trim().replace(/^\//, ''),
      image: f[1].trim(),
      kind,
      port: own?.port ?? DB_DEFAULT_PORT[kind],
      published: own?.published ?? false,
      networks: parseNetworks(f[2])
    })
  }
  containers.sort((a, b) => a.name.localeCompare(b.name))
  return { ok: true, containers }
}

export function parseDbContainerAddress(output: string, exitCode: number | null): DbContainerAddress {
  const split = splitAtMark(output, exitCode)
  if (!('body' in split)) {
    return /no such (object|container)/i.test(split.detail)
      ? { ok: false, reason: 'not-found', detail: split.detail }
      : split
  }
  const net = parseNetworks(split.body.trim())[0]
  if (!net) return { ok: false, reason: 'no-address', detail: 'The container is on no network with an address.' }
  return { ok: true, ip: net.ip, network: net.name }
}
