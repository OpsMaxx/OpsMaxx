import { sshHopFor } from './ssh'
import type { DatabaseConn, Server } from '../types'
import type { DbConnectConfig } from '../../../shared/db'

/**
 * A stored database connection, as the shape main's drivers take.
 *
 * Hoisted out of DatabaseView because a second caller appeared: the size
 * sampler is handed resolved configs on a timer, exactly as the fleet sampler
 * is handed targets, and a second copy of this would be a second place for the
 * jump host to be forgotten — which produces a connection that fails with
 * "nothing is listening", on a host that is not the one in the error.
 *
 * No credential is in here and none may be. The record's id is what main uses
 * to look one up, which is what keeps every password on the far side of the
 * bridge.
 */
/**
 * The fields this needs, rather than a whole saved record.
 *
 * Widened for the Add Database dialog's Test connection button, which has the
 * same fields and no record yet. Narrowing the parameter rather than copying
 * the function is what keeps the jump host and the VPN from being forgotten on
 * exactly the path that exists to find out whether they work.
 */
export type DbConnectFields = Pick<
  DatabaseConn,
  'id' | 'kind' | 'host' | 'port' | 'username' | 'database' | 'ssl' | 'sshServerId' | 'vpnProfileId'
>

export function dbConnectConfig(db: DbConnectFields, servers: Server[]): DbConnectConfig {
  const jump = db.sshServerId ? servers.find((s) => s.id === db.sshServerId) : undefined
  return {
    id: db.id,
    kind: db.kind,
    host: db.host,
    port: db.port,
    username: db.username,
    database: db.database,
    ssl: db.ssl,
    ssh: jump ? sshHopFor(jump) : undefined,
    // Dropped here until now, which is why a VPN chosen in the dialog was
    // ignored by a test: main resolves the profile from the SAVED record, and
    // an unsaved connection has no record to resolve. A saved one is
    // unaffected — main still decides for those.
    vpnProfileId: db.vpnProfileId ?? undefined
  }
}
