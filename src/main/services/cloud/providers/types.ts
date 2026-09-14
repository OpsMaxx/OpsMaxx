/**
 * What every cloud provider has to be able to do, and nothing more.
 *
 * The shape is deliberately small. A broker's whole job is to turn a
 * CloudTarget into an SshHop the existing stack can dial, plus a way to undo
 * whatever it had to set up. Everything past that point - the terminal, SFTP,
 * metrics, Docker, the MCP tools - is the ordinary SSH path and knows nothing
 * about clouds.
 *
 * That boundary is the reason this feature is a few files rather than a rewrite,
 * and it is worth defending: if something here starts returning a terminal, or a
 * command runner, or anything else that is not "where to connect and how", the
 * abstraction has slipped.
 */

import type { SshHop } from '../../../../shared/ssh'
import type { CloudTarget } from '../../../../shared/cloud'
import type { CloudAccount, CloudAuthStatus, CloudInstance, CloudLocation } from '../../../../shared/cloudCommands'
import type { ProviderDetectionResult } from '../binaries'

export interface PreparedCloudConnection {
  /** Where to dial and how to authenticate, once the provider has had its say. */
  hop: SshHop
  /**
   * Undo it. Kills a tunnel, deletes a temporary credential directory.
   *
   * Must be safe to call twice and must never throw: it runs on the failure
   * path as well as the success one, and a release that throws while unwinding
   * a failed connect replaces a useful error with a useless one.
   */
  release: () => Promise<void>
  /**
   * What was done, in order, for the connection log.
   *
   * Never contains key material, tokens or provider output - see the logging
   * rules. "Opened an IAP tunnel" is a note; the tunnel's stderr is not.
   */
  notes: string[]
}

export interface CloudBroker {
  /** `force` re-reads the filesystem instead of answering from the per-run cache. */
  detect(force?: boolean): Promise<ProviderDetectionResult>
  authStatus(account?: string): Promise<CloudAuthStatus>

  /** Projects, profiles, or subscriptions. */
  listAccounts(): Promise<CloudAccount[]>
  /** Zones, regions, or resource groups. */
  listLocations(account: string): Promise<CloudLocation[]>
  listInstances(account: string, location: string): Promise<CloudInstance[]>

  prepare(target: CloudTarget): Promise<PreparedCloudConnection>
}
