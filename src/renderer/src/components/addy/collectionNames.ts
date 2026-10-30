import type { MessageKey } from '../../../../shared/i18n'
import { t } from '../../lib/i18n'

/**
 * What each synced collection is, in the words the app uses elsewhere.
 *
 * ONE TABLE FOR EVERY SCREEN THAT NAMES ONE. It was private to the conflict
 * chooser, so the chooser said "your trusted SSH host keys" while the panel's
 * error band, two clicks away, said `knownHosts` — the protocol ids from
 * `SYNCED_COLLECTIONS`, which exist so two implementations agree with each
 * other and not so anybody reads them.
 */
const COLLECTION_NAMES: Record<string, MessageKey> = {
  apiCollections: 'addy.collections.apiCollections',
  apiWorkspace: 'addy.collections.apiWorkspace',
  cicdConnections: 'addy.collections.cicdConnections',
  databases: 'addy.collections.databases',
  deviceNames: 'addy.collections.deviceNames',
  env: 'addy.collections.env',
  folders: 'addy.collections.folders',
  httpChecks: 'addy.collections.httpChecks',
  knownHosts: 'addy.collections.knownHosts',
  manifest: 'addy.collections.manifest',
  monitorGroups: 'addy.collections.monitorGroups',
  servers: 'addy.collections.servers',
  tunnels: 'addy.collections.tunnels',
  vault: 'addy.collections.vault',
  vpns: 'addy.collections.vpns',
  workspaces: 'addy.collections.workspaces'
}

export function collectionName(collection: string): string {
  const key = COLLECTION_NAMES[collection]
  return key ? t(key) : collection
}

/**
 * A sync failure as a sentence.
 *
 * Main reports it as `<collection id>: <what went wrong>`. The id becomes its
 * name; anything not shaped like that is shown as it came, because inventing a
 * cause for text we did not recognise is worse than showing it.
 */
export function syncErrorText(message: string): string {
  const at = message.indexOf(': ')
  const id = at > 0 ? message.slice(0, at) : ''
  if (!(id in COLLECTION_NAMES)) return message
  return t('addy.collections.syncError', { what: t(COLLECTION_NAMES[id]), reason: message.slice(at + 2) })
}
