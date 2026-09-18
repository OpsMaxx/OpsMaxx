import { createDecipheriv, createHmac, pbkdf2, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const pbkdf2Async = promisify(pbkdf2)

/**
 * Bitwarden's client-side crypto, as much of it as a read-only import needs.
 *
 * Implemented from the published format description and from the wire, not
 * from `@bitwarden/sdk-internal` -- which is GPL-3.0, and this repository is
 * MIT with a CI test that fails on a GPL dependency. That is the hard reason.
 * The softer one is that an importer is a small, well-specified thing and
 * taking a dependency on a whole SDK to read six fields is how a client
 * acquires an obligation it cannot later shed.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It decrypts; it never writes. Push comes
 * later and continuous two-way sync is permanently out of scope -- two systems
 * that both believe they own a password produce a conflict nobody can resolve
 * from either side, and the honest version of "sync your passwords" is one
 * store.
 */

/** Which KDF the account uses. Bitwarden's own numbering, from `prelogin`. */
export enum Kdf {
  PBKDF2 = 0,
  Argon2id = 1
}

export interface KdfParams {
  kdf: Kdf
  iterations: number
  /** Argon2id only, in MiB. */
  memory?: number
  /** Argon2id only. */
  parallelism?: number
}

export class BitwardenImportError extends Error {}

/**
 * The master key: what the password becomes before anything else happens.
 *
 * The SALT IS THE EMAIL, lowercased. That is Bitwarden's choice and it has a
 * consequence worth knowing when reading this: two accounts with the same
 * password and the same email on different servers derive the same master key,
 * so the server's identity is not in the derivation at all.
 */
export async function deriveMasterKey(
  password: string,
  email: string,
  params: KdfParams
): Promise<Buffer> {
  const salt = Buffer.from(email.trim().toLowerCase(), 'utf8')

  if (params.kdf === Kdf.Argon2id) {
    // Refused, clearly, rather than approximated. Node has no Argon2id, the
    // CSP-free options are a native module or a wasm blob, and an importer
    // that silently used PBKDF2 against an Argon2id account would simply
    // produce a wrong key and report "wrong password" -- sending the user to
    // reset a password that was correct.
    throw new BitwardenImportError(
      'This account uses Argon2id, which OpsMaxx cannot derive yet. ' +
        'Bitwarden lets you switch an account to PBKDF2 in Security > Keys; ' +
        'that re-encrypts your vault and lets this import run.'
    )
  }
  if (!Number.isInteger(params.iterations) || params.iterations < 5000) {
    // A server-supplied iteration count is an input, and a low one is the
    // cheapest possible attack on anyone who accepts it: it makes the master
    // key trivial to brute force from a captured hash.
    throw new BitwardenImportError(
      `That server asked for ${params.iterations} KDF iterations, which is too few to be genuine. Refusing.`
    )
  }
  return pbkdf2Async(password, salt, params.iterations, 32, 'sha256')
}

/**
 * The hash the SERVER sees, which is not the key.
 *
 * One more PBKDF2 round with the password as salt. The point is that the
 * server can verify a login without ever holding anything that decrypts the
 * vault -- so this value is safe to send and the master key never is.
 */
export async function masterPasswordHash(masterKey: Buffer, password: string): Promise<string> {
  const hash = await pbkdf2Async(masterKey, Buffer.from(password, 'utf8'), 1, 32, 'sha256')
  return hash.toString('base64')
}

/**
 * Stretches the master key into an encryption key and a MAC key.
 *
 * HKDF-EXPAND ONLY, with no extract step: the master key is already a PBKDF2
 * output and is used directly as the PRK. Getting this wrong -- running a full
 * extract-then-expand, which is what every HKDF helper does by default -- gives
 * two keys that are perfectly good and decrypt nothing, and the symptom is an
 * HMAC mismatch that looks exactly like a wrong password.
 */
export function stretchMasterKey(masterKey: Buffer): { encKey: Buffer; macKey: Buffer } {
  return {
    encKey: Buffer.from(hkdfExpand(masterKey, 'enc', 32)),
    macKey: Buffer.from(hkdfExpand(masterKey, 'mac', 32))
  }
}

/** HKDF-Expand with the PRK supplied directly.
 *
 *  Node's `hkdfSync` always extracts, so this is the expand step written out:
 *  one HMAC round is enough for 32 bytes of output, which is all Bitwarden
 *  asks for. */
function hkdfExpand(prk: Buffer, info: string, length: number): Buffer {
  if (length > 32) throw new BitwardenImportError('hkdfExpand: this implementation covers one block')
  const mac = createHmac('sha256', prk)
  mac.update(Buffer.from(info, 'utf8'))
  mac.update(Buffer.from([1]))
  return mac.digest().subarray(0, length)
}

/**
 * An `EncString`: Bitwarden's per-field ciphertext.
 *
 * `<type>.<iv>|<ct>|<mac>`, all base64. Only type 2 --
 * AES-256-CBC + HMAC-SHA256 -- is produced by any current client, and the
 * others are refused rather than guessed at: type 0 is AES-CBC with NO MAC,
 * and quietly accepting it would mean decrypting attacker-malleable ciphertext
 * and putting the result in a password field.
 */
export interface EncString {
  type: number
  iv: Buffer
  ct: Buffer
  mac: Buffer
}

export function parseEncString(value: string): EncString {
  const dot = value.indexOf('.')
  if (dot === -1) throw new BitwardenImportError('that is not an encrypted field')
  const type = Number(value.slice(0, dot))
  const parts = value.slice(dot + 1).split('|')
  if (type !== 2) {
    throw new BitwardenImportError(
      `encrypted field type ${type} is not supported; only AES-256-CBC with HMAC-SHA256 is`
    )
  }
  if (parts.length !== 3) {
    throw new BitwardenImportError('an encrypted field of this type has three parts')
  }
  return {
    type,
    iv: Buffer.from(parts[0], 'base64'),
    ct: Buffer.from(parts[1], 'base64'),
    mac: Buffer.from(parts[2], 'base64')
  }
}

/**
 * Decrypts one field.
 *
 * THE MAC IS CHECKED FIRST, over `iv || ct`, before a byte is decrypted. CBC
 * without that check is a padding oracle, and an importer is exactly the sort
 * of program somebody points at a server they do not control.
 */
export function decryptEncString(value: string, encKey: Buffer, macKey: Buffer): Buffer {
  const parsed = parseEncString(value)

  const expected = createHmac('sha256', macKey)
    .update(parsed.iv)
    .update(parsed.ct)
    .digest()
  if (parsed.mac.length !== expected.length || !timingSafeEqual(parsed.mac, expected)) {
    throw new BitwardenImportError(
      'an encrypted field did not authenticate: the password is wrong, or the data has been altered'
    )
  }

  const decipher = createDecipheriv('aes-256-cbc', encKey, parsed.iv)
  return Buffer.concat([decipher.update(parsed.ct), decipher.final()])
}

/** Decrypts to a string, for the fields that are text. */
export function decryptString(value: string, encKey: Buffer, macKey: Buffer): string {
  return decryptEncString(value, encKey, macKey).toString('utf8')
}

/**
 * Unwraps the user key -- the one that actually decrypts the vault.
 *
 * The master key does not decrypt anything except this. That indirection is
 * what lets a password change re-wrap one key rather than re-encrypt every
 * item, and it is why an importer has to do two steps rather than one.
 *
 * The unwrapped value is 64 bytes: an encryption key and a MAC key
 * concatenated, in that order.
 */
export function unwrapUserKey(
  protectedKey: string,
  masterKey: Buffer
): { encKey: Buffer; macKey: Buffer } {
  const stretched = stretchMasterKey(masterKey)
  const raw = decryptEncString(protectedKey, stretched.encKey, stretched.macKey)
  if (raw.length !== 64) {
    throw new BitwardenImportError(
      `the account key unwrapped to ${raw.length} bytes; a Bitwarden user key is 64`
    )
  }
  return { encKey: raw.subarray(0, 32), macKey: raw.subarray(32, 64) }
}

/**
 * Unwraps an organisation key, which is RSA-wrapped rather than AES-wrapped.
 *
 * NOT IMPLEMENTED, and refused by name rather than skipped. An import that
 * silently dropped every item in a shared collection would be an import that
 * looked like it worked and left half the vault behind -- which somebody finds
 * out about when they need one of those passwords.
 */
export function unwrapOrganisationKey(): never {
  throw new BitwardenImportError(
    'Items shared with an organisation are wrapped with an RSA key that OpsMaxx does not read yet. ' +
      'Personal items import; shared ones are listed and skipped rather than silently dropped.'
  )
}
