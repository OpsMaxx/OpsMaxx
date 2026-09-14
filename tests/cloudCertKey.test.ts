import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVerify } from 'node:crypto'
import { utils } from 'ssh2'

import { CloudError } from '../src/shared/cloud'
import {
  assertCertificateUsable,
  certificateKey,
  parseOpenSshCertificate
} from '../src/main/services/cloud/certKey'

// Certificates are generated with the real ssh-keygen rather than committed as
// fixtures. Two reasons: a hand-rolled blob would only prove the parser agrees
// with whatever encoder wrote it, and a committed private key in a public repo
// is a finding in every scanner even when it guards nothing.

let root = ''
let haveSshKeygen = true

function keygen(args: string[]): void {
  execFileSync('ssh-keygen', args, { stdio: 'pipe' })
}

/** A CA, a user key signed by it, and the resulting certificate. */
function makeCert(type: string, name: string, extra: string[] = []): void {
  keygen(['-t', type, '-f', join(root, `${name}-ca`), '-N', '', '-C', 'ca', '-q'])
  keygen(['-t', type, '-f', join(root, name), '-N', '', '-C', 'user', '-q'])
  keygen([
    '-s',
    join(root, `${name}-ca`),
    '-I',
    `opsmaxx-test-${name}`,
    '-n',
    'someone',
    ...extra,
    join(root, `${name}.pub`)
  ])
}

beforeAll(() => {
  try {
    execFileSync('ssh-keygen', ['-A', '-h'], { stdio: 'pipe' })
  } catch {
    // -A -h is nonsense on purpose; we only care that the binary runs at all.
  }
  try {
    root = mkdtempSync(join(tmpdir(), 'opsmaxx-cert-'))
    makeCert('ed25519', 'ed')
    makeCert('rsa', 'rsa')
    // A certificate whose window has already closed.
    makeCert('ed25519', 'expired', ['-V', '-2w:-1w'])
  } catch (e) {
    haveSshKeygen = false
    console.warn(
      `SKIPPING certificate tests: ssh-keygen is unavailable or failed (${String(e)}). ` +
        'These tests prove the Azure Entra login path works; do not treat a green run ' +
        'without them as coverage.'
    )
  }
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

const read = (name: string): string => readFileSync(join(root, name), 'utf8')

describe('parsing an OpenSSH certificate', () => {
  it('reads the algorithm, key id and validity window of an ed25519 certificate', () => {
    if (!haveSshKeygen) return
    const cert = parseOpenSshCertificate(read('ed-cert.pub'))
    expect(cert.algorithm).toBe('ssh-ed25519-cert-v01@openssh.com')
    expect(cert.keyId).toBe('opsmaxx-test-ed')
    // ssh-keygen defaults to "forever", which is uint64 max and must not
    // silently round down to something in the past.
    expect(cert.validBefore).toBe(Infinity)
    expect(cert.validAfter).toBe(0)
    expect(cert.blob.length).toBeGreaterThan(32)
  })

  it('reads an RSA certificate, whose key fields are laid out differently', () => {
    if (!haveSshKeygen) return
    const cert = parseOpenSshCertificate(read('rsa-cert.pub'))
    expect(cert.algorithm).toBe('ssh-rsa-cert-v01@openssh.com')
    expect(cert.keyId).toBe('opsmaxx-test-rsa')
  })

  it('reads a bounded validity window', () => {
    if (!haveSshKeygen) return
    const cert = parseOpenSshCertificate(read('expired-cert.pub'))
    expect(cert.validBefore).toBeLessThan(Math.floor(Date.now() / 1000))
    expect(cert.validAfter).toBeGreaterThan(0)
  })

  it('refuses anything that is not a certificate', () => {
    if (!haveSshKeygen) return
    // A plain public key is the realistic mistake: same directory, same shape,
    // one suffix apart.
    expect(() => parseOpenSshCertificate(read('ed.pub'))).toThrow(CloudError)
    for (const bad of ['', 'garbage', 'ssh-ed25519-cert-v01@openssh.com !!!notbase64!!!']) {
      expect(() => parseOpenSshCertificate(bad), JSON.stringify(bad)).toThrow(CloudError)
    }
  })

  it('refuses a certificate whose inner and outer algorithms disagree', () => {
    if (!haveSshKeygen) return
    const real = read('ed-cert.pub').trim().split(/\s+/)
    const swapped = `ssh-rsa-cert-v01@openssh.com ${real[1]}`
    expect(() => parseOpenSshCertificate(swapped)).toThrow(CloudError)
  })
})

describe('validity is checked before connecting', () => {
  it('accepts a live certificate', () => {
    if (!haveSshKeygen) return
    expect(() => assertCertificateUsable(parseOpenSshCertificate(read('ed-cert.pub')))).not.toThrow()
  })

  it('rejects an expired one, rather than letting the server say "publickey"', () => {
    if (!haveSshKeygen) return
    const cert = parseOpenSshCertificate(read('expired-cert.pub'))
    expect(() => assertCertificateUsable(cert)).toThrow(CloudError)
    try {
      assertCertificateUsable(cert)
    } catch (e) {
      expect((e as CloudError).fault).toBe('auth-expired')
    }
  })

  it('rejects one that is not valid yet and blames the clock', () => {
    if (!haveSshKeygen) return
    const cert = parseOpenSshCertificate(read('ed-cert.pub'))
    // Pretend we are well before its start.
    const notYet = { ...cert, validAfter: Math.floor(Date.now() / 1000) + 3600 }
    expect(() => assertCertificateUsable(notYet)).toThrow(/clock/i)
  })
})

describe('the key object handed to ssh2', () => {
  it('announces the certificate algorithm and serves the certificate blob', () => {
    if (!haveSshKeygen) return
    const cert = parseOpenSshCertificate(read('ed-cert.pub'))
    const key = certificateKey(read('ed'), cert)
    expect(key.type).toBe('ssh-ed25519-cert-v01@openssh.com')
    expect(key.getPublicSSH().equals(cert.blob)).toBe(true)
    // authPK skips anything that is not a private key.
    expect(key.isPrivateKey()).toBe(true)
  })

  it('survives ssh2 parseKey, which is what authPK calls on it first', () => {
    if (!haveSshKeygen) return
    // parseKey returns an already-parsed key unchanged - but only if it
    // recognises one. If the prototype chain ever stops carrying ssh2's
    // internal marker this returns an Error and certificate auth silently
    // becomes "Skipping invalid key auth attempt".
    const cert = parseOpenSshCertificate(read('ed-cert.pub'))
    const key = certificateKey(read('ed'), cert)
    const round = utils.parseKey(key as never)
    expect(round).not.toBeInstanceOf(Error)
    expect((round as { type: string }).type).toBe('ssh-ed25519-cert-v01@openssh.com')
  })

  it('signs with the private key, verifiably', () => {
    if (!haveSshKeygen) return
    const cert = parseOpenSshCertificate(read('ed-cert.pub'))
    const key = certificateKey(read('ed'), cert)
    const data = Buffer.from('the bytes ssh2 would ask us to sign')
    const signature = key.sign(data)
    expect(signature).not.toBeInstanceOf(Error)

    // Verify against the PLAIN public key, which is what the certificate
    // carries and what the server checks the signature with.
    const pub = utils.parseKey(read('ed.pub'))
    expect(pub).not.toBeInstanceOf(Error)
    const ok = (pub as { verify(d: Buffer, s: Buffer, a?: string): boolean }).verify(
      data,
      signature as Buffer
    )
    expect(ok, 'the signature did not verify against the certified public key').toBe(true)
  })

  it('signs an RSA certificate with the SHA-2 hash the request announces', () => {
    if (!haveSshKeygen) return
    // The sharp edge the patch exists for: an RSA key's own default is SHA-1,
    // while the request says rsa-sha2-256. ssh2 passes the hash it chose, so
    // the signature has to honour it.
    const cert = parseOpenSshCertificate(read('rsa-cert.pub'))
    const key = certificateKey(read('rsa'), cert)
    const data = Buffer.from('rsa payload')
    const signature = key.sign(data, 'sha256')
    expect(signature).not.toBeInstanceOf(Error)

    const pubPem = (
      utils.parseKey(read('rsa.pub')) as { getPublicPEM(): string }
    ).getPublicPEM()
    const verifier = createVerify('sha256')
    verifier.update(data)
    expect(
      verifier.verify(pubPem, signature as Buffer),
      'RSA certificate signature did not verify as SHA-256'
    ).toBe(true)
  })

  it('refuses to sign with a public key', () => {
    if (!haveSshKeygen) return
    const cert = parseOpenSshCertificate(read('ed-cert.pub'))
    expect(() => certificateKey(read('ed.pub'), cert)).toThrow(CloudError)
  })
})
