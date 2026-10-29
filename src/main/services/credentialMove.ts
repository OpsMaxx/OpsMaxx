import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { getSecret, setSecret } from './secrets'
import { loadData } from './store'
import { vaultEntriesForResolve, vaultSave, vaultStatus } from './vault'
import { VAULT_LOCKED, type VaultEntry, type VaultKind } from '../../shared/vault'
import type { CredentialMoveResult as MoveResult } from '../../shared/credentialShape'

/**
 * Credentials kept only in THIS machine's keychain, moved into the vault.
 *
 * The keychain does not sync and the vault does, so a server whose password
 * or key lives in the keychain is one the user's other devices can see and
 * cannot log in to. Moving it makes it a vault entry, the record then carries
 * a link to that entry (see credentialLink.ts), and the other devices log in
 * with it once a person there confirms.
 *
 * In MAIN because it reads the stored values, which never leave main. The
 * renderer is told which entries were made and reloads its copy of the vault:
 * it holds the entry list while the vault is open and saves the whole list
 * back, so a copy that did not know about these would erase them.
 */

type Rec = Record<string, unknown>
type Blob = Rec & {
  vaultEntryId?: string
  vaultUriEntryId?: string
  password?: string
  keyPath?: string
  passphrase?: string
  uri?: string
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** A key file is a few kilobytes; anything far larger is not one. */
const MAX_KEY_BYTES = 64 * 1024

/** The ids, of those given, whose credential is stored only on this device:
 *  a password, key or connection string with no vault entry behind it. */
export function keychainOnly(ids: string[]): string[] {
  return ids.filter((id) => {
    const b = blobOf(id)
    return !!b && !b.vaultEntryId && !b.vaultUriEntryId && !!(b.password || b.keyPath || b.uri)
  })
}

function blobOf(id: string): Blob | null {
  const raw = getSecret(id)
  if (!raw) return null
  try {
    const b = JSON.parse(raw) as unknown
    return b && typeof b === 'object' ? (b as Blob) : null
  } catch {
    return null
  }
}

function readKey(path: string): string | null {
  try {
    if (statSync(path).size > MAX_KEY_BYTES) return null
    const text = readFileSync(path, 'utf8')
    return text.includes('PRIVATE KEY') ? text : null
  } catch {
    return null
  }
}

export function moveCredentialsToVault(ids: string[]): MoveResult {
  const entries = vaultEntriesForResolve()
  // `open`, not merely unlocked: a vault write is a person's act, and
  // `vaultSave` refuses anything less. Checked first so nothing is half done.
  if (!entries || vaultStatus().stage !== 'open') {
    return { ok: false, error: `${VAULT_LOCKED}: the vault is locked.`, moved: [], skipped: [] }
  }
  const data = (loadData() ?? {}) as Rec
  const records = new Map<string, { kind: 'server' | 'database'; rec: Rec }>()
  for (const kind of ['server', 'database'] as const) {
    const list = data[kind === 'server' ? 'servers' : 'databases']
    if (!Array.isArray(list)) continue
    for (const r of list) if (r && typeof r === 'object' && str((r as Rec).id)) records.set(str((r as Rec).id), { kind, rec: r as Rec })
  }

  const now = new Date().toISOString()
  const made: VaultEntry[] = []
  const rewrites: { id: string; blob: Blob; vaultEntryId: string }[] = []
  const skipped: MoveResult['skipped'] = []

  for (const id of new Set(ids)) {
    const found = records.get(id)
    const blob = blobOf(id)
    if (!found || !blob) {
      skipped.push({ id, reason: 'nothing is stored for it on this device' })
      continue
    }
    if (blob.vaultEntryId || blob.vaultUriEntryId) {
      skipped.push({ id, reason: 'it already uses the vault' })
      continue
    }
    const { kind, rec } = found
    let entryKind: VaultKind = 'login'
    const secret: Partial<VaultEntry> = {}
    // What stays in the blob: the parts that are not the credential itself.
    const rest: Blob = { ...blob }
    delete rest.password
    delete rest.keyPath
    delete rest.passphrase
    delete rest.uri
    let slot: 'vaultEntryId' | 'vaultUriEntryId' = 'vaultEntryId'

    if (kind === 'server' && blob.keyPath) {
      const pem = readKey(blob.keyPath)
      if (!pem) {
        skipped.push({ id, reason: `its key file ${blob.keyPath} could not be read as a private key` })
        continue
      }
      entryKind = 'sshkey'
      secret.privateKey = pem
      // On an `sshkey` entry the secret slot is the key's passphrase.
      secret.password = blob.passphrase ?? ''
    } else if (kind === 'database' && blob.uri) {
      // A `key` entry: what the connection-string picker lists, and what the
      // resolver reads a `vaultUriEntryId` from.
      entryKind = 'key'
      secret.password = blob.uri
      slot = 'vaultUriEntryId'
    } else if (blob.password) {
      secret.password = blob.password
    } else {
      skipped.push({ id, reason: 'it has no password or key stored, only an agent or a certificate' })
      continue
    }

    const entry: VaultEntry = {
      id: `v-${randomUUID()}`,
      name: `${str(rec.name) || id}${str(rec.username) ? ` (${str(rec.username)})` : ''}`,
      kind: entryKind,
      // The workspace the record is in, so the entry is listed where the
      // server is; an unscoped record makes an unscoped entry.
      ...(str(rec.workspaceId) ? { workspaceId: str(rec.workspaceId) } : {}),
      url: '',
      username: str(rec.username),
      password: '',
      notes: 'Moved here from the keychain of one device, so that your other devices can use it.',
      tags: [kind],
      fields: [],
      createdAt: now,
      updatedAt: now,
      ...secret
    }
    made.push(entry)
    rewrites.push({ id, blob: { ...rest, [slot]: entry.id }, vaultEntryId: entry.id })
  }

  if (made.length === 0) return { ok: true, moved: [], skipped }
  // The vault first: a blob pointing at an entry that was never written would
  // lose the credential, whereas an entry nothing points at yet loses nothing.
  const saved = vaultSave([...entries, ...made])
  if (!saved.ok) return { ok: false, error: saved.error, moved: [], skipped }

  const moved: MoveResult['moved'] = []
  for (const r of rewrites) {
    if (setSecret(r.id, JSON.stringify(r.blob))) moved.push({ id: r.id, vaultEntryId: r.vaultEntryId })
    // The entry exists and the old credential is still stored, so the server
    // keeps working as it did; only the move did not happen.
    else skipped.push({ id: r.id, reason: 'this device would not store the updated credential' })
  }
  return { ok: true, moved, skipped }
}
