import type { CloudTarget } from './cloud'
import type { SshAuth } from './ssh'

export type DbKind = 'postgres' | 'mysql' | 'mssql' | 'mongodb' | 'redis'

// Optional SSH jump: the driver connects to a local forward instead of the
// database host directly.
export interface DbSshConfig {
  serverId?: string
  host: string
  port: number
  username: string
  // Widened from a copy of the three original methods when cloud servers
  // arrived: a database reached through a GCE or Azure VM authenticates the
  // same way that VM does, certificate included. Kept as the shared union so
  // the two cannot drift apart again.
  auth: SshAuth
  password?: string
  keyPath?: string
  privateKey?: string
  passphrase?: string
  certificate?: string
  /**
   * Set by main when the server this database is tunnelled through is a cloud
   * one. Resolved from the saved record like every other transport detail, and
   * never sent by the renderer.
   */
  cloudTarget?: CloudTarget
}

export interface DbConnectConfig {
  id: string
  /**
   * Which revision of the saved record this was built from. See
   * `DatabaseConn.rev` -- it is what stops a cached client connected to the
   * database a record USED to name from answering a query built from that
   * record as it stands now.
   */
  rev?: number
  kind: DbKind
  host: string
  port: number
  username: string
  password?: string
  database?: string
  ssl?: boolean
  // Full connection string / URI (e.g. mongodb+srv://user:pass@cluster/db).
  // When present it takes precedence over the discrete host/port/... fields.
  uri?: string
  ssh?: DbSshConfig
  // Reach the database through this VPN profile. Independent of `ssh`: a
  // database can be behind a bastion, behind a VPN, or behind both, and when
  // both are set the VPN is the outer transport — the bastion itself is only
  // reachable once the tunnel is up.
  vpnProfileId?: string
  // Shown in the "3 sessions are using this VPN" confirmation, so it names
  // the connection the user recognises rather than a UUID.
  name?: string
}

export interface DbTestResult {
  ok: boolean
  error?: string
  version?: string
}

export type DbResultKind = 'rows' | 'json' | 'value' | 'message'

export interface DbQueryResult {
  ok: boolean
  error?: string
  kind?: DbResultKind
  columns?: string[]
  rows?: unknown[][]
  json?: unknown
  message?: string
  elapsedMs?: number
  rowCount?: number
}

export interface DbInfo {
  ok: boolean
  error?: string
  // A flat list of "schema objects": databases, tables or collections.
  databases?: string[]
  tables?: string[]
}

export const DB_DEFAULT_PORT: Record<DbKind, number> = {
  postgres: 5432,
  mysql: 3306,
  mssql: 1433,
  mongodb: 27017,
  redis: 6379
}

export const DB_LABEL: Record<DbKind, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mssql: 'SQL Server',
  mongodb: 'MongoDB',
  redis: 'Redis'
}
