/**
 * Authenticating with an OpenSSH certificate.
 *
 * Azure issues a short-lived certificate when a VM is set up for Entra ID
 * login: `az ssh config` writes a private key and a `*-cert.pub` beside it, and
 * the server accepts the certificate rather than any key we registered. That is
 * the whole point of the model - nothing is enrolled on the machine, and access
 * expires on its own - and it is also why OpsMaxx could not do it before.
 *
 * ssh2 has no certificate support. What it does have is a parsed-key interface
 * narrow enough to stand in for: `authPK` reads exactly `key.type` and
 * `key.getPublicSSH()` from the object it is given, `parseKey` passes an
 * already-parsed key straight back, and `isParsedKey` is a symbol check that a
 * prototype chain satisfies. So the certificate is presented by a real parsed
 * private key with two properties shadowed - the algorithm name and the public
 * blob - and everything else, signing included, inherited untouched.
 *
 * The half that could NOT be done here is in patches/ssh2+1.17.0.patch: ssh2
 * wrote one algorithm name into both the request and the signature blob, and a
 * certificate needs the certificate spelling in the first and the plain one in
 * the second. That is four lines inside a module-private function, which is why
 * it is a patch and not more of this file. If certificate logins start failing
 * after an ssh2 upgrade, check that the patch still applied before looking here.
 */

import { utils } from 'ssh2'

import { CloudError } from '../../../shared/cloud'

/** What a certificate says about itself, as far as we need to read. */
export interface ParsedCertificate {
  /** e.g. `ssh-ed25519-cert-v01@openssh.com` - the name sent in the request. */
  algorithm: string
  /** The certificate itself, as the bytes that go on the wire. */
  blob: Buffer
  /** Who it was issued to, for the log line. Not a security control. */
  keyId: string
  /** Unix seconds. */
  validAfter: number
  /** Unix seconds. A certificate with no end is reported as Infinity. */
  validBefore: number
}

/**
 * How many key-specific fields sit between the nonce and the serial number.
 *
 * The certificate blob is `algorithm, nonce, <key fields>, serial, type, ...`,
 * and the key fields differ per algorithm. We only need to walk past them to
 * reach the validity window, so the count is all that is required - not the
 * values.
 */
function keyFieldCount(algorithm: string): number {
  if (algorithm.startsWith('ssh-ed25519')) return 1
  if (algorithm.startsWith('ecdsa-sha2-')) return 2
  if (algorithm.startsWith('ssh-rsa') || algorithm.startsWith('rsa-sha2-')) return 2
  if (algorithm.startsWith('ssh-dss')) return 4
  throw new CloudError('cli-failed', `Unsupported certificate algorithm: ${algorithm}.`)
}

/** A reader for SSH wire format: length-prefixed strings and fixed integers. */
class BlobReader {
  private offset = 0

  constructor(private readonly buf: Buffer) {}

  string(): Buffer {
    if (this.offset + 4 > this.buf.length) throw new CloudError('cli-failed', 'Certificate is truncated.')
    const len = this.buf.readUInt32BE(this.offset)
    this.offset += 4
    if (this.offset + len > this.buf.length) throw new CloudError('cli-failed', 'Certificate is truncated.')
    const out = this.buf.subarray(this.offset, this.offset + len)
    this.offset += len
    return out
  }

  uint32(): number {
    if (this.offset + 4 > this.buf.length) throw new CloudError('cli-failed', 'Certificate is truncated.')
    const out = this.buf.readUInt32BE(this.offset)
    this.offset += 4
    return out
  }

  /**
   * Read a 64-bit field as a Number.
   *
   * Certificate timestamps are uint64, and OpenSSH writes "forever" as
   * 0xFFFFFFFFFFFFFFFF - which is not representable as a Number and must not
   * silently become something smaller than now. Anything past the safe integer
   * range is therefore returned as Infinity, which is what it means.
   */
  uint64AsSeconds(): number {
    if (this.offset + 8 > this.buf.length) throw new CloudError('cli-failed', 'Certificate is truncated.')
    const value = this.buf.readBigUInt64BE(this.offset)
    this.offset += 8
    return value > BigInt(Number.MAX_SAFE_INTEGER) ? Infinity : Number(value)
  }
}

/**
 * Read a `*-cert.pub` file.
 *
 * The text form is `<algorithm> <base64 blob> [comment]`, and the algorithm is
 * also the first field INSIDE the blob. Both are checked against each other:
 * they always agree in a real certificate, and a mismatch means we are not
 * looking at what we think we are.
 */
export function parseOpenSshCertificate(text: string): ParsedCertificate {
  const parts = text.trim().split(/\s+/)
  if (parts.length < 2) {
    throw new CloudError('cli-failed', 'The certificate file is not in OpenSSH format.')
  }
  const [algorithm, encoded] = parts
  if (!algorithm.includes('-cert-v01@openssh.com')) {
    throw new CloudError('cli-failed', `Not a certificate: ${algorithm}.`)
  }

  let blob: Buffer
  try {
    blob = Buffer.from(encoded, 'base64')
  } catch {
    throw new CloudError('cli-failed', 'The certificate body is not valid base64.')
  }
  if (blob.length === 0) {
    throw new CloudError('cli-failed', 'The certificate body is empty.')
  }

  const reader = new BlobReader(blob)
  const inner = reader.string().toString('utf8')
  if (inner !== algorithm) {
    throw new CloudError(
      'cli-failed',
      `The certificate names ${inner} inside but ${algorithm} outside.`
    )
  }

  reader.string() // nonce
  for (let i = 0; i < keyFieldCount(algorithm); i++) reader.string()
  reader.uint64AsSeconds() // serial - read to advance, not used
  reader.uint32() // certificate type: 1 user, 2 host
  const keyId = reader.string().toString('utf8')
  reader.string() // valid principals

  return {
    algorithm,
    blob,
    keyId,
    validAfter: reader.uint64AsSeconds(),
    validBefore: reader.uint64AsSeconds()
  }
}

/**
 * Refuse a certificate that is outside its window.
 *
 * Worth checking before connecting rather than letting the server refuse: the
 * server's answer is an indistinguishable "Permission denied (publickey)",
 * which sends the user looking at their IAM roles instead of at a clock or an
 * expiry they can fix by signing in again.
 */
export function assertCertificateUsable(cert: ParsedCertificate, now = Date.now()): void {
  const seconds = Math.floor(now / 1000)
  if (seconds < cert.validAfter) {
    throw new CloudError(
      'auth-expired',
      'The certificate is not valid yet, which usually means this computer’s clock is wrong.'
    )
  }
  if (seconds >= cert.validBefore) {
    throw new CloudError('auth-expired', 'The certificate has expired.')
  }
}

/**
 * The minimum of ssh2's parsed-key surface that `authPK` actually touches.
 * Declared rather than imported because ssh2 ships no type for it.
 */
export interface CertificateKey {
  type: string
  getPublicSSH(): Buffer
  sign(data: Buffer, algo?: string): Buffer | Error
  isPrivateKey(): boolean
}

/**
 * Present `privateKey` under `certificate`.
 *
 * `Object.create` rather than a copy: the prototype carries the decrypted-key
 * symbol that `isParsedKey` looks for and the `sign` that holds the private
 * material, and neither is reachable to copy even if we wanted to. Only the two
 * properties `authPK` reads are shadowed.
 *
 * `sign` is deliberately NOT overridden. ssh2 calls it with the hash algorithm
 * it worked out, and for every certificate type that resolves correctly on its
 * own: ed25519 and ECDSA fall back to the key's own hash, which is right, and
 * RSA gets an explicit sha256/sha512 from the patched `getKeyAlgos`.
 */
export function certificateKey(
  privateKey: string | Buffer,
  certificate: ParsedCertificate,
  passphrase?: string
): CertificateKey {
  const parsed = utils.parseKey(privateKey, passphrase)
  if (parsed instanceof Error) {
    throw new CloudError('cli-failed', `The private key could not be read: ${parsed.message}`)
  }
  if (!parsed.isPrivateKey()) {
    throw new CloudError('cli-failed', 'The certificate was given a public key to sign with.')
  }

  const key = Object.create(parsed) as CertificateKey
  Object.defineProperties(key, {
    type: { value: certificate.algorithm, enumerable: true },
    getPublicSSH: { value: () => certificate.blob }
  })
  return key
}

/**
 * How a certificate key has to be handed to ssh2.
 *
 * NOT as `privateKey`. That option is filtered at client.js:208 to a string or
 * a Buffer and anything else is silently replaced with undefined - at which
 * point `publickey` never enters the allowed-methods list, the client tries
 * `none`, fails, and reports "All configured authentication methods failed"
 * with no mention of the key it threw away. It is a quiet failure that looks
 * exactly like a rejected credential, so it is worth one helper to make it
 * impossible to hit.
 *
 * The `authHandler` array form bypasses that filter: ssh2 passes each entry's
 * `key` straight to `parseKey`, which returns an already-parsed key untouched.
 */
export function certificateAuthHandler(
  username: string,
  key: CertificateKey
): { type: 'publickey'; username: string; key: CertificateKey }[] {
  return [{ type: 'publickey', username, key }]
}
