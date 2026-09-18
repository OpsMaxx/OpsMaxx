import { describe, it, expect } from 'vitest'
import { createCipheriv, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import {
  BitwardenImportError,
  Kdf,
  decryptString,
  deriveMasterKey,
  masterPasswordHash,
  parseEncString,
  stretchMasterKey,
  unwrapUserKey
} from '../src/main/services/import/bitwardenCrypto'

/**
 * Bitwarden's client crypto, checked against ciphertext built the way a real
 * client builds it.
 *
 * The fixtures here ENCRYPT with an independent implementation written from
 * the same format description, rather than reusing the code under test. That
 * is the only way a test of a format can catch a misreading of it: a fixture
 * produced by the implementation agrees with the implementation by
 * construction, however wrong both are.
 */

const PASSWORD = 'correct horse battery staple'
const EMAIL = 'Test@Example.com'
const ITERATIONS = 600_000

/** The reference construction, written out rather than imported. */
function referenceMasterKey(): Buffer {
  return pbkdf2Sync(PASSWORD, EMAIL.trim().toLowerCase(), ITERATIONS, 32, 'sha256')
}

function referenceExpand(prk: Buffer, info: string): Buffer {
  const mac = createHmac('sha256', prk)
  mac.update(Buffer.from(info, 'utf8'))
  mac.update(Buffer.from([1]))
  return mac.digest().subarray(0, 32)
}

/** Builds a type-2 EncString the way a client does. */
function encString(plaintext: Buffer, encKey: Buffer, macKey: Buffer): string {
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', encKey, iv)
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const mac = createHmac('sha256', macKey).update(iv).update(ct).digest()
  return `2.${iv.toString('base64')}|${ct.toString('base64')}|${mac.toString('base64')}`
}

const KDF = { kdf: Kdf.PBKDF2, iterations: ITERATIONS }

describe('deriving the keys', () => {
  it('matches the reference construction', async () => {
    const derived = await deriveMasterKey(PASSWORD, EMAIL, KDF)
    expect(derived).toEqual(referenceMasterKey())
  })

  it('lowercases and trims the email, because the salt IS the email', async () => {
    const a = await deriveMasterKey(PASSWORD, '  TEST@example.COM ', KDF)
    const b = await deriveMasterKey(PASSWORD, 'test@example.com', KDF)
    expect(a).toEqual(b)
  })

  it('stretches with HKDF-Expand ONLY, not extract-then-expand', async () => {
    // The trap. Every HKDF helper does extract-then-expand by default, and
    // doing that here gives two keys that are perfectly good and decrypt
    // nothing -- the symptom is an HMAC mismatch that looks exactly like a
    // wrong password.
    const masterKey = await deriveMasterKey(PASSWORD, EMAIL, KDF)
    const { encKey, macKey } = stretchMasterKey(masterKey)
    expect(encKey).toEqual(referenceExpand(masterKey, 'enc'))
    expect(macKey).toEqual(referenceExpand(masterKey, 'mac'))
    expect(encKey).not.toEqual(macKey)
  })

  it('produces a server hash that is not the key', async () => {
    const masterKey = await deriveMasterKey(PASSWORD, EMAIL, KDF)
    const hash = await masterPasswordHash(masterKey, PASSWORD)
    // The point of the second round: the server can verify a login without
    // ever holding anything that decrypts the vault.
    expect(Buffer.from(hash, 'base64')).not.toEqual(masterKey)
    expect(Buffer.from(hash, 'base64')).toHaveLength(32)
  })
})

describe('the key hierarchy', () => {
  it('unwraps a user key the master key never decrypts directly', async () => {
    const masterKey = await deriveMasterKey(PASSWORD, EMAIL, KDF)
    const stretched = stretchMasterKey(masterKey)
    const userKey = randomBytes(64)

    const wrapped = encString(userKey, stretched.encKey, stretched.macKey)
    const unwrapped = unwrapUserKey(wrapped, masterKey)

    // 64 bytes: an encryption key and a MAC key, in that order.
    expect(unwrapped.encKey).toEqual(userKey.subarray(0, 32))
    expect(unwrapped.macKey).toEqual(userKey.subarray(32, 64))
  })

  it('refuses a key that unwraps to the wrong length', async () => {
    const masterKey = await deriveMasterKey(PASSWORD, EMAIL, KDF)
    const stretched = stretchMasterKey(masterKey)
    const wrapped = encString(randomBytes(32), stretched.encKey, stretched.macKey)
    expect(() => unwrapUserKey(wrapped, masterKey)).toThrow(/64/)
  })

  it('reports a wrong password as a failed authentication, not as garbage', async () => {
    const right = await deriveMasterKey(PASSWORD, EMAIL, KDF)
    const wrong = await deriveMasterKey('not the password', EMAIL, KDF)
    const stretched = stretchMasterKey(right)
    const wrapped = encString(randomBytes(64), stretched.encKey, stretched.macKey)

    // The MAC catches it before any decryption happens, so the user is told
    // the password is wrong rather than shown a padding error.
    expect(() => unwrapUserKey(wrapped, wrong)).toThrow(/did not authenticate/)
  })
})

describe('decrypting a field', () => {
  const encKey = randomBytes(32)
  const macKey = randomBytes(32)

  it('round-trips text', () => {
    const value = encString(Buffer.from('hunter2', 'utf8'), encKey, macKey)
    expect(decryptString(value, encKey, macKey)).toBe('hunter2')
  })

  it('checks the MAC before decrypting', () => {
    // CBC without that check is a padding oracle, and an importer is exactly
    // the sort of program somebody points at a server they do not control.
    const value = encString(Buffer.from('hunter2', 'utf8'), encKey, macKey)
    const [head, ct, mac] = value.split('|')
    const tamperedCt = Buffer.from(ct, 'base64')
    tamperedCt[0] ^= 0xff
    const tampered = `${head}|${tamperedCt.toString('base64')}|${mac}`

    expect(() => decryptString(tampered, encKey, macKey)).toThrow(/did not authenticate/)
  })

  it('refuses an unauthenticated ciphertext type outright', () => {
    // Type 0 is AES-CBC with NO MAC. Quietly accepting it would mean
    // decrypting attacker-malleable ciphertext and putting the result in a
    // password field.
    expect(() => parseEncString('0.aXY=|Y3Q=')).toThrow(/not supported/)
  })

  it('refuses something that is not an encrypted field at all', () => {
    expect(() => parseEncString('just a string')).toThrow(/not an encrypted field/)
  })
})

describe('what it refuses to guess at', () => {
  it('names Argon2id rather than deriving the wrong key', async () => {
    // An importer that silently used PBKDF2 against an Argon2id account
    // produces a wrong key and reports "wrong password" -- sending the user to
    // reset a password that was correct.
    await expect(
      deriveMasterKey(PASSWORD, EMAIL, { kdf: Kdf.Argon2id, iterations: 3, memory: 64, parallelism: 4 })
    ).rejects.toThrow(/Argon2id/)
  })

  it('refuses an iteration count a server could use to weaken the key', async () => {
    // The count comes from the server, so it is an input. A low one is the
    // cheapest possible attack on anyone who accepts it.
    await expect(deriveMasterKey(PASSWORD, EMAIL, { kdf: Kdf.PBKDF2, iterations: 1 })).rejects.toThrow(
      /too few/
    )
  })

  it('is an error type a caller can recognise', async () => {
    await expect(
      deriveMasterKey(PASSWORD, EMAIL, { kdf: Kdf.PBKDF2, iterations: 1 })
    ).rejects.toBeInstanceOf(BitwardenImportError)
  })
})
