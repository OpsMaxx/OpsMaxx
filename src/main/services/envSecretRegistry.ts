import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

// Which vault entries have been written into a host's `.env`, so that the value
// is redacted out of anything that host later prints.
//
// WHAT IS STORED IS A REFERENCE, NEVER A VALUE. The file holds a server id and
// a vault entry id, both non-secret, and the value is resolved at redaction
// time through the same `resolveVaultField` every other consumer uses. A locked
// vault therefore redacts nothing -- which is correct rather than a gap: with
// the vault locked the value could not have been written either, and holding a
// plaintext copy on disk to improve redaction would be the vault leaking to
// make an output filter nicer.
//
// WHY THIS IS PERSISTED AT ALL. An in-memory registry would stop redacting the
// moment the app restarted, and a secret that is scrubbed on Tuesday and
// printed on Wednesday is worse than one that was never claimed to be
// scrubbed. The file is main-owned and written temp-then-rename, like the vault
// and the workspace locks.
//
// It is NOT in `opsmaxx-data.json`: that blob is the renderer's, written
// whole on every save, and a main-process write into it would race with one.

export interface EnvSecretRef {
  serverId: string
  vaultEntryId: string
  slot: 'password' | 'privateKey' | 'username' | 'field'
  fieldKey?: string
}

const FILE = (): string => join(app.getPath('userData'), 'opsmaxx-env-secrets.json')
const TMP = (): string => `${FILE()}.tmp`

let cache: EnvSecretRef[] | null = null

function valid(v: unknown): v is EnvSecretRef {
  const r = v as EnvSecretRef
  return (
    !!r &&
    typeof r.serverId === 'string' &&
    r.serverId !== '' &&
    typeof r.vaultEntryId === 'string' &&
    r.vaultEntryId !== '' &&
    (r.slot === 'password' || r.slot === 'privateKey' || r.slot === 'username' || r.slot === 'field') &&
    (r.fieldKey === undefined || typeof r.fieldKey === 'string')
  )
}

function load(): EnvSecretRef[] {
  if (cache !== null) return cache
  try {
    if (existsSync(FILE())) {
      const raw = JSON.parse(readFileSync(FILE(), 'utf8')) as unknown
      // Re-validated on read for the reason `driftWatchStore` states: a blob on
      // disk is not a promise, and this one names what gets resolved out of the
      // vault.
      cache = Array.isArray(raw) ? raw.filter(valid) : []
      return cache
    }
  } catch {
    // A file that cannot be read means nothing is registered. It does NOT mean
    // the caller may skip redaction -- callers append these to a list that
    // already holds the server's own credentials.
  }
  cache = []
  return cache
}

/** Record that this vault entry's value now lives in a file on this server.
 *  Idempotent: registering the same ref twice is the normal case, because
 *  writing the same variable again is. */
export function registerEnvSecret(ref: EnvSecretRef): void {
  if (!valid(ref)) return
  const all = load()
  const already = all.some(
    (r) =>
      r.serverId === ref.serverId &&
      r.vaultEntryId === ref.vaultEntryId &&
      r.slot === ref.slot &&
      r.fieldKey === ref.fieldKey
  )
  if (already) return
  const next = [...all, ref]
  try {
    writeFileSync(TMP(), JSON.stringify(next), { mode: 0o600 })
    renameSync(TMP(), FILE())
    cache = next
  } catch {
    // The write is what makes this survive a restart. If it failed, the
    // in-memory list is NOT updated either: a registry that claims a value is
    // being redacted after a restart when it will not be is the failure this
    // file exists to prevent.
  }
}

/** Every ref recorded for one server. The caller resolves them. */
export function envSecretRefsForServer(serverId: string): EnvSecretRef[] {
  return load().filter((r) => r.serverId === serverId)
}

/** Test seam. */
export function resetEnvSecretsForTests(): void {
  cache = []
}
