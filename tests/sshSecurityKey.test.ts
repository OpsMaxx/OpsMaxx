import { describe, it, expect } from 'vitest'
import { isSecurityKeyPrivateKey, DEFAULT_IDENTITIES } from '../src/main/services/sshKeys'

// A FIDO2 key file is not a private key, and we were treating it as one.
//
// `sk-ssh-ed25519@openssh.com` and `sk-ecdsa-sha2-nistp256@openssh.com` hold a
// credential handle and an application string. The private half is on the
// authenticator and signing it is a CTAP2 assertion plus a touch, which ssh2
// cannot do. DEFAULT_IDENTITIES lists both `sk` filenames, so OpsMaxx OFFERED
// these keys to anyone holding one and then failed with "All configured
// authentication methods failed" — the message a wrong username also gives.
//
// The type is read from the file rather than the filename, because the
// filename is a convention and IdentityFile may point anywhere.

/** Build an OpenSSH v1 private key header carrying `keytype`, the way a real
 *  one is built: everything after the BEGIN line is base64, so the key type
 *  never appears as readable text in the armour.
 *
 *  Synthetic rather than committed key material, so the offsets below were
 *  checked against real `ssh-keygen` output first — ed25519, rsa, and an
 *  ed25519 under a passphrase — and all three read back the right type from
 *  the first 512 bytes. A hardware key differs from those only in this
 *  string, which is why one cannot be checked in here. */
function opensshKey(keytype: string, cipher = 'none'): string {
  const str = (v: string): Buffer => {
    const b = Buffer.from(v, 'utf8')
    const len = Buffer.alloc(4)
    len.writeUInt32BE(b.length)
    return Buffer.concat([len, b])
  }
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n)
    return b
  }
  const pub = Buffer.concat([str(keytype), str('x'.repeat(32))])
  const blob = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'binary'),
    str(cipher),
    str(cipher === 'none' ? 'none' : 'bcrypt'),
    str(''),
    u32(1),
    str(pub.toString('binary'))
  ])
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${blob.toString('base64')}\n-----END OPENSSH PRIVATE KEY-----\n`
}

describe('recognising a hardware-backed key', () => {
  it('spots both sk- types', () => {
    expect(isSecurityKeyPrivateKey(opensshKey('sk-ssh-ed25519@openssh.com'))).toBe(true)
    expect(isSecurityKeyPrivateKey(opensshKey('sk-ecdsa-sha2-nistp256@openssh.com'))).toBe(true)
  })

  it('leaves ordinary keys alone', () => {
    expect(isSecurityKeyPrivateKey(opensshKey('ssh-ed25519'))).toBe(false)
    expect(isSecurityKeyPrivateKey(opensshKey('ecdsa-sha2-nistp256'))).toBe(false)
    expect(isSecurityKeyPrivateKey(opensshKey('ssh-rsa'))).toBe(false)
  })

  it('reads the type through an encrypted key', () => {
    // The v1 container keeps the public key in the clear even when the private
    // half is encrypted, so this answer does not wait for a passphrase — which
    // matters, because the passphrase prompt is the thing we are trying not to
    // raise for a key no passphrase would help with.
    expect(isSecurityKeyPrivateKey(opensshKey('sk-ssh-ed25519@openssh.com', 'aes256-ctr'))).toBe(true)
    expect(isSecurityKeyPrivateKey(opensshKey('ssh-ed25519', 'aes256-ctr'))).toBe(false)
  })

  it('works on the 512-byte prefix the connect path actually passes it', () => {
    // ssh.ts hands it `key.slice(0, 512)` rather than the whole file. The type
    // is early in the blob, but a fixture that only passed on the full text
    // would prove nothing about the caller.
    expect(isSecurityKeyPrivateKey(opensshKey('sk-ssh-ed25519@openssh.com').slice(0, 512))).toBe(true)
  })

  it('says no rather than guessing, on anything it cannot parse', () => {
    // Same call as isEncryptedPrivateKey: the cost of a wrong yes is refusing
    // a key that works, so an unreadable header falls through to the ordinary
    // path and lets a real error come back from the server.
    expect(isSecurityKeyPrivateKey('')).toBe(false)
    expect(isSecurityKeyPrivateKey('-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n')).toBe(false)
    expect(isSecurityKeyPrivateKey('-----BEGIN OPENSSH PRIVATE KEY-----\nnot base64 at all !!!\n')).toBe(false)
    expect(isSecurityKeyPrivateKey('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n')).toBe(false)
  })

  it('is reachable from the identities we offer without being asked', () => {
    // This is why the function has to exist rather than being the user's
    // problem: with no IdentityFile set, OpsMaxx picks a key ITSELF, and two
    // of the six it picks from are hardware keys.
    expect(DEFAULT_IDENTITIES).toContain('id_ed25519_sk')
    expect(DEFAULT_IDENTITIES).toContain('id_ecdsa_sk')
  })
})
