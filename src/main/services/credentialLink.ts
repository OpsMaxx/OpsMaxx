import { statSync } from 'node:fs'
import { getSecret } from './secrets'
import { DATA_FILE_PATH, loadData } from './store'

/**
 * A server's or database's stored credential, as this device should use it.
 *
 * ---------------------------------------------------------------------------
 * WHY A SECOND SOURCE
 * ---------------------------------------------------------------------------
 *
 * A credential is kept in this machine's keychain under the record's id, and
 * the keychain does not sync — so on a second device every server arrived with
 * an address and nothing to log in with. The vault does sync. So a record whose
 * credential is a vault entry carries that entry's id on the synced record
 * itself (`Server.vaultEntryId`, `DatabaseConn.vaultEntryId`): a pointer, never
 * a value, opened only by a device that has the vault unlocked.
 *
 * THIS DEVICE'S OWN BLOB WINS. A credential somebody stored here is a decision
 * made at this keyboard; the link is the fallback for a device that has none.
 *
 * A link is exactly the shape the sync-trust layer exists for — a record that
 * names a credential and the address it is sent to — so a link that arrived by
 * sync is held until a person here confirms it (`credential` in
 * `syncTrust.fieldsOf`), like a changed address is.
 *
 * Returns the blob as JSON, the same type `getSecret` does, so every reader
 * that used to parse the keychain blob reads this unchanged.
 */
export function storedCredential(id: string): string | null {
  const own = getSecret(id)
  if (own !== null && holdsCredential(own)) return own
  const link = linkFor(id)
  if (link === null) return own
  if (own === null) return link
  // A local blob holding no credential -- a remembered second-factor answer
  // saved on a device that logs in through the link -- keeps what it holds
  // and gains the link, rather than hiding it.
  try {
    return JSON.stringify({ ...(JSON.parse(own) as Rec), ...(JSON.parse(link) as Rec) })
  } catch {
    return link
  }
}

/** Whether THIS device stores a credential of its own for `id` -- the case in
 *  which the synced link is not what would be used. */
export function hasOwnCredential(id: string): boolean {
  const own = getSecret(id)
  return own !== null && holdsCredential(own)
}

type Rec = Record<string, unknown>

const CREDENTIAL_FIELDS = ['vaultEntryId', 'vaultUriEntryId', 'password', 'keyPath', 'passphrase', 'uri', 'agentSocket']

function holdsCredential(raw: string): boolean {
  try {
    const blob = JSON.parse(raw) as Rec
    return CREDENTIAL_FIELDS.some((f) => typeof blob[f] === 'string' && blob[f] !== '')
  } catch {
    // Unreadable is not a credential, and the resolvers read it as none too.
    return false
  }
}

// Keyed on the data file's modification time, so a sync that lands a link is
// seen on the next read without anything having to remember to invalidate it,
// and a monitoring sweep reading every target does not unseal the file each
// time.
let cache: { stamp: string; links: Map<string, string> } | null = null

function stamp(): string {
  try {
    const st = statSync(DATA_FILE_PATH)
    // The size as well: two writes inside one timestamp tick are rare, and a
    // stale link here means a server that cannot log in.
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return ''
  }
}

function linkFor(id: string): string | null {
  const now = stamp()
  if (!cache || cache.stamp !== now) cache = { stamp: now, links: linksOf(loadData()) }
  return cache.links.get(id) ?? null
}

/** The link blobs a data file implies. Exported for tests. */
export function linksOf(data: unknown): Map<string, string> {
  const out = new Map<string, string>()
  const list = (key: string): Rec[] => {
    const v = (data as Rec | null)?.[key]
    return Array.isArray(v) ? v.filter((r): r is Rec => !!r && typeof r === 'object') : []
  }
  const ok = (v: unknown): v is string => typeof v === 'string' && v !== ''
  for (const s of list('servers')) {
    if (ok(s.id) && ok(s.vaultEntryId)) out.set(s.id, JSON.stringify({ vaultEntryId: s.vaultEntryId }))
  }
  for (const d of list('databases')) {
    if (!ok(d.id) || !ok(d.vaultEntryId)) continue
    // A connection-string database keeps its entry in the URI slot of the
    // blob, which is the field the resolver reads for it.
    out.set(d.id, JSON.stringify(d.uri === true ? { vaultUriEntryId: d.vaultEntryId } : { vaultEntryId: d.vaultEntryId }))
  }
  return out
}
