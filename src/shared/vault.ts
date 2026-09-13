// Minimum length of the vault master password.
//
// Lives here rather than in VaultView because the vault can now be created from
// two places — the full gate, and the mid-flow prompt that fires when something
// needs a credential and there is no vault yet. Two copies of this number would
// eventually disagree, and the one that disagreed downward would be the one
// creating an unrecoverable secret.
export const VAULT_MIN_PASSWORD = 12

/**
 * The token that marks a failure as "the vault is shut" rather than anything
 * else, so a renderer can offer an unlock without matching an English sentence.
 *
 * It lives here, in the shared vocabulary, because three layers need it and two
 * of them cannot reach the third. It began in main/services/credentialResolver,
 * which `main/services/vault` cannot import without a cycle now that the vault
 * itself has a refusal to tag — and the renderer's copy in
 * renderer/src/lib/withVaultUnlock.ts was a second literal of the same string,
 * which is exactly the drift the VAULT_MIN_PASSWORD comment above warns about.
 *
 * Electron serialises a rejected IPC handler into a plain Error whose message
 * is prefixed with "Error invoking remote method ...", so a class name does not
 * survive the trip. A stable token inside the message does.
 */
export const VAULT_LOCKED = 'OPSMAXX_VAULT_LOCKED'

// A free-form key/value pair on a vault entry. `secret` fields are masked in
// the UI until revealed.
export interface VaultField {
  id: string
  key: string
  value: string
  secret: boolean
}

export type VaultKind = 'login' | 'url' | 'key' | 'sshkey' | 'note' | 'vpn'

export interface VaultEntry {
  id: string
  name: string
  kind: VaultKind
  // Which workspace this entry belongs to, or absent for one that is visible
  // everywhere.
  //
  // Absent is the honest default for entries that predate this field: the
  // vault was a single global store, so there is no record of which workspace
  // any of them was created in, and guessing would either hide a credential
  // someone relies on or claim knowledge we do not have. They stay shared and
  // can be moved deliberately.
  //
  // Shared is also a real, wanted state — a credential used from several
  // workspaces should exist once, which is the whole reason a server
  // references a vault entry rather than copying it.
  workspaceId?: string
  url: string
  username: string
  // Doubles as the key passphrase on an `sshkey` entry. One secret slot, whose
  // label changes with the kind, rather than a second column that is null on
  // every other kind.
  password: string
  // PEM material for an `sshkey` entry. Optional because every other kind
  // leaves them empty, and absent on entries written before this existed.
  //
  // The private key is stored here rather than referenced by path: a path is
  // the one credential OpsMaxx never actually held — not in the OS keychain,
  // not in the encrypted vault, just a filename pointing at plaintext on disk,
  // which also does not travel with an encrypted backup.
  privateKey?: string
  publicKey?: string
  notes: string
  tags: string[]
  fields: VaultField[]
  createdAt: string
  updatedAt: string
}

/**
 * How open the vault is, in three stages rather than two.
 *
 * The two-stage version conflated things that need separating. A single
 * `unlocked` boolean had to answer both "may this person see the entry list"
 * and "can a background sweep resolve a credential", and those have different
 * right answers fifteen minutes after somebody walked away from the keyboard.
 * Answering them together is what made the idle timeout stop monitoring, CI
 * polling, scheduled backups and reconnects along with hiding the entries.
 *
 *   locked   nothing. The derived key is zeroed and the entries are gone.
 *   secured  the key and the decrypted entries are in MAIN, so credentials
 *            still resolve and nothing background pauses — but the renderer
 *            holds no plaintext and the UI asks for the master password again
 *            before showing, copying or editing anything.
 *   open     as secured, plus the renderer has the entries.
 *
 * What `secured` gives up is stated precisely in SECURITY.md, and it is very
 * little: the hardened runtime, not this flag, is what defends the key in main
 * memory against a process running as the same user, and every other credential
 * this app stores has always sat at that same level in opsmaxx-secrets.json.
 * What it protects is the half an idle timer can actually protect — the
 * decrypted entries in the renderer, which renderer-side script injection
 * reaches, and the entry list on an unattended screen.
 */
export type VaultStage = 'locked' | 'secured' | 'open'

export interface VaultStatus {
  // Whether a vault file exists yet — false means the user still has to choose
  // a master password.
  exists: boolean
  /**
   * The key is in main-process memory and credentials resolve.
   *
   * TRUE IN BOTH `open` AND `secured`, which is the whole point of the split: a
   * background sweep does not care whether a person is at the keyboard, and the
   * dozen or so `!s.exists || s.unlocked` gates across main are all asking that
   * question rather than the viewing one. They keep their line and become
   * correct for free.
   *
   * Anything that is about to put plaintext in front of a person must read
   * `stage === 'open'` instead.
   */
  unlocked: boolean
  stage: VaultStage
  entryCount: number
}

export interface VaultResult {
  ok: boolean
  error?: string
}

export interface VaultListResult extends VaultResult {
  entries?: VaultEntry[]
}

export const VAULT_KIND_LABEL: Record<VaultKind, string> = {
  login: 'Login',
  url: 'URL',
  key: 'API key',
  sshkey: 'SSH key',
  note: 'Note',
  vpn: 'VPN profile'
}

// Entries visible from a given workspace: the ones that belong to it, plus the
// shared ones. Filtering happens in the renderer rather than in the vault
// service because the vault file is one encrypted blob — splitting it per
// workspace would mean a master password per workspace, which is a different
// product. This hides entries from view; it is not a cryptographic boundary,
// and SECURITY.md says so.
export function vaultEntriesFor(entries: VaultEntry[], workspaceId: string | null): VaultEntry[] {
  if (!workspaceId) return entries
  return entries.filter((e) => !e.workspaceId || e.workspaceId === workspaceId)
}

export function isSharedVaultEntry(e: VaultEntry): boolean {
  return !e.workspaceId
}

// Matches an entry against a search query across every stored field, so the
// user can find things by value (a hostname, a username) not just by title.
export function vaultMatches(e: VaultEntry, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const hay = [
    e.name,
    e.url,
    e.username,
    e.notes,
    // The public half is not a secret and is the useful thing to search by —
    // it carries the key's comment, which is usually user@host. The private
    // key and the passphrase are never in here, same as every other secret.
    e.publicKey,
    ...e.tags,
    ...e.fields.flatMap((f) => [f.key, f.secret ? '' : f.value])
  ]
  return hay.some((h) => h?.toLowerCase().includes(q))
}

export type VaultSecretSlot = 'password' | 'key' | 'passphrase'

export interface VaultKindFields {
  url: boolean
  username: boolean
  secret: VaultSecretSlot | null
  keys?: boolean
}

// Which built-in fields each kind shows. Lives here rather than in the view so
// the tests exercise the real map: when this started as a copy inside the test
// file, adding a kind left the copy behind and the coverage assertion was the
// only thing that noticed.
//
// Name, tags, custom fields and notes are on every kind and are not listed.
export const VAULT_KIND_FIELDS: Record<VaultKind, VaultKindFields> = {
  login: { url: true, username: true, secret: 'password' },
  url: { url: true, username: false, secret: null },
  key: { url: true, username: false, secret: 'key' },
  // username is the account the key logs in as, worth keeping beside the key
  // rather than only on each server that uses it.
  sshkey: { url: false, username: true, secret: 'passphrase', keys: true },
  note: { url: false, username: false, secret: null },
  // A VPN profile's credentials, stored here rather than in the OS keychain for
  // the same reason an SSH key is: a WireGuard private key must travel with
  // `backupExport`, and the keychain is a machine-local store that no backup can
  // carry. The comment on `privateKey` above states the rule this follows.
  //
  // What each slot holds for a `vpn` entry:
  //   privateKey — the WireGuard private key, the OpenVPN key material, or the
  //                sanitised `.ovpn` config body (which embeds that material)
  //   password   — the auth password, or the frp token
  //   username   — the OpenVPN auth username
  //   fields[]   — everything else, keyed: per-peer preshared keys by peer
  //                public key, per-proxy secret keys by proxy name
  vpn: { url: true, username: true, secret: 'password', keys: true }
}

export const VAULT_SECRET_LABEL: Record<VaultSecretSlot, string> = {
  password: 'Password',
  key: 'API key',
  passphrase: 'Passphrase'
}

// Values an entry is holding that its current kind does not display. Stored and
// searchable, but invisible — which is its own trap, so the UI says so.
export function hiddenFieldsFor(e: VaultEntry): string[] {
  const shown = VAULT_KIND_FIELDS[e.kind] ?? VAULT_KIND_FIELDS.login
  return [
    !shown.url && e.url ? 'URL' : null,
    !shown.username && e.username ? 'username' : null,
    !shown.secret && e.password ? 'password' : null,
    !shown.keys && e.privateKey ? 'private key' : null
  ].filter((v): v is string => v !== null)
}
