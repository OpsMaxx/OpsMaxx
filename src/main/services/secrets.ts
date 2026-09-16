import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { secretsAvailable } from './secretsBackend'

// Credentials are encrypted with the OS secure store (safeStorage) and the
// ciphertext is persisted as base64. Plaintext never touches disk. If the OS
// keychain is unavailable we refuse to persist rather than store plaintext.
//
// `secretsAvailable()` is that last check, and it lives in secretsBackend.ts
// rather than here. The diagnostics payload needs to report it and may not
// import this module — `exportSecrets()` below returns every credential in
// plaintext — so the predicate sits on the other side of that line and this
// file calls it. One implementation, imported twice, instead of two copies
// free to drift apart.
const FILE = join(app.getPath('userData'), 'opsmaxx-secrets.json')

type SecretMap = Record<string, string> // id -> base64 ciphertext

function read(): SecretMap {
  try {
    if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, 'utf8')) as SecretMap
  } catch {
    /* ignore corrupt file */
  }
  return {}
}

function write(map: SecretMap): void {
  writeFileSync(FILE, JSON.stringify(map), { mode: 0o600 })
}

// Re-exported so every existing caller (`secrets:available`, inspect.ts) keeps
// importing it from the module it has always imported it from.
export { secretsAvailable }

/**
 * Secrets that must never leave this machine — not even inside a backup.
 *
 * Everything else here is exported into the bundle on purpose: a restored
 * machine needs its server credentials, and `importSecrets` re-seals them under
 * the new machine's keychain. There is exactly one class for which that is
 * self-defeating, and it is the passphrase a scheduled backup encrypts WITH.
 * Putting it in the bundle would ship the key to the file inside the file,
 * which is the same as shipping no passphrase at all — the argument the vault
 * requirement was built on in the first place.
 *
 * A prefix rather than a list, because there is one per destination, and one
 * that no server, database, VPN or CI id can produce: those are generated ids
 * and none of them starts with two underscores.
 *
 * The consequence has to be said in the UI where the choice is made: a
 * restored machine does NOT get this passphrase back, so the operator needs it
 * recorded somewhere a lost laptop does not take with it.
 */
export const MACHINE_ONLY_SECRET_PREFIX = '__machine__'

export const isMachineOnlySecret = (id: string): boolean =>
  id.startsWith(MACHINE_ONLY_SECRET_PREFIX)

export function setSecret(id: string, value: string): boolean {
  if (!secretsAvailable()) return false
  const map = read()
  map[id] = safeStorage.encryptString(value).toString('base64')
  write(map)
  return true
}

export function getSecret(id: string): string | null {
  const map = read()
  const enc = map[id]
  if (!enc) return null
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return null
  }
}

// Decrypted view of every stored credential. Used only when building a backup:
// the on-disk form is sealed with the OS keychain and is therefore bound to
// this machine, so it has to be unsealed before being re-encrypted under the
// user's backup passphrase.
export function exportSecrets(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const id of Object.keys(read())) {
    // The one carve-out, and the whole reason the prefix exists. See above.
    if (isMachineOnlySecret(id)) continue
    const value = getSecret(id)
    if (value !== null) out[id] = value
  }
  return out
}

// Re-seal credentials with this machine's keychain during a restore.
export function importSecrets(plain: Record<string, string>): boolean {
  if (!secretsAvailable()) return false
  const map = read()
  for (const [id, value] of Object.entries(plain)) {
    // Belt as well as braces. Nothing should be able to put one of these in a
    // bundle, and a bundle that somehow carries one must not be able to
    // overwrite this machine's own with another machine's.
    if (isMachineOnlySecret(id)) continue
    map[id] = safeStorage.encryptString(value).toString('base64')
  }
  write(map)
  return true
}

export function deleteSecret(id: string): void {
  const map = read()
  if (map[id]) {
    delete map[id]
    write(map)
  }
}
