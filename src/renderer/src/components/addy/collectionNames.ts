/**
 * What each synced collection is, in the words the app uses elsewhere.
 *
 * ONE TABLE FOR EVERY SCREEN THAT NAMES ONE. It was private to the conflict
 * chooser, so the chooser said "your trusted SSH host keys" while the panel's
 * error band, two clicks away, said `knownHosts` — the protocol ids from
 * `SYNCED_COLLECTIONS`, which exist so two implementations agree with each
 * other and not so anybody reads them.
 */
const COLLECTION_NAMES: Record<string, string> = {
  apiCollections: 'your HTTP collections',
  apiWorkspace: 'your HTTP environments and variables',
  cicdConnections: 'your CI/CD connections',
  databases: 'your saved databases',
  deviceNames: 'what you call your devices',
  env: 'your environment variables',
  folders: 'your folders',
  httpChecks: 'your HTTP checks',
  knownHosts: 'your trusted SSH host keys',
  manifest: 'your provisioning manifest',
  monitorGroups: 'your monitor groups',
  servers: 'your servers',
  tunnels: 'your tunnels',
  vault: 'your vault',
  vpns: 'your VPN profiles',
  workspaces: 'your workspaces'
}

export function collectionName(collection: string): string {
  return COLLECTION_NAMES[collection] ?? collection
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
  return `could not carry ${COLLECTION_NAMES[id]} — ${message.slice(at + 2)}`
}
