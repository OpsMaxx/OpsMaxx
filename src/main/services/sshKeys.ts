import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs'

// Offers the keys already sitting in ~/.ssh, because the native file picker is
// a poor way to find them: the folder is hidden, OpenSSH private keys have no
// extension, and the matching .pub sits right next to the file you actually
// want. Detection only — nothing here is ever used unless the user picks it.

export interface DetectedKey {
  path: string
  fileName: string
  // From the matching .pub when there is one; OpenSSH does not put the
  // algorithm in the private file's first line, and reading further into a
  // private key just to label it is not worth doing.
  algorithm: string | null
  encrypted: boolean
}

const IGNORED = new Set([
  'config',
  'known_hosts',
  'known_hosts.old',
  'authorized_keys',
  'agent.sock',
  'environment',
  'rc'
])

const PRIVATE_HEADER = /-----BEGIN [^-]*PRIVATE KEY-----/

const OPENSSH_MAGIC = 'openssh-key-v1\0'

// Whether a private key needs a passphrase, given the start of the file.
//
// The legacy PEM formats say so in a header, so those are a substring check.
// New-format OpenSSH keys do not: everything after the BEGIN line is base64,
// and the cipher name lives inside it. Testing the armoured text for "none"
// finds nothing in a real key — the bytes spelling it are base64-encoded — so
// that reads every unencrypted ed25519/rsa key as encrypted and refuses to use
// it. Decode the header instead and read the cipher field properly.
export function isEncryptedPrivateKey(head: string): boolean {
  if (/ENCRYPTED/.test(head)) return true
  if (!head.includes('OPENSSH PRIVATE KEY')) return false
  try {
    const body = head.slice(head.indexOf('-----\n') + 6).replace(/\s+/g, '')
    const buf = Buffer.from(body, 'base64')
    if (buf.subarray(0, OPENSSH_MAGIC.length).toString('binary') !== OPENSSH_MAGIC) return false
    const len = buf.readUInt32BE(OPENSSH_MAGIC.length)
    if (len <= 0 || len > 64) return false
    const cipher = buf.subarray(OPENSSH_MAGIC.length + 4, OPENSSH_MAGIC.length + 4 + len).toString('utf8')
    return cipher !== 'none'
  } catch {
    // Unparseable means unknown, and guessing "encrypted" is the failure that
    // caused this function to exist. Let ssh2 report a real auth error instead
    // of pre-emptively refusing a key that might be fine.
    return false
  }
}

// Only the header is needed to tell a private key from a .pub, a config file or
// a socket, so read a prefix rather than pulling whole key files into memory.
function readPrefix(path: string, bytes: number): string {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(bytes)
    const read = readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, read).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

function algorithmFromPub(privatePath: string): string | null {
  const pub = `${privatePath}.pub`
  if (!existsSync(pub)) return null
  try {
    const first = readFileSync(pub, 'utf8').trim().split(/\s+/)[0] ?? ''
    if (!first.startsWith('ssh-') && !first.startsWith('ecdsa-')) return null
    return first.replace(/^ssh-/, '').replace(/^ecdsa-sha2-/, 'ECDSA ').toUpperCase()
  } catch {
    return null
  }
}

export function sshDir(): string {
  return join(homedir(), '.ssh')
}

/**
 * The identities OpenSSH tries when a connection names no key, in its order.
 *
 * From ssh_config(5)'s IdentityFile default. Order matters: it is the one a
 * user's `ssh host` already follows, so following it is what makes OpsMaxx
 * pick the same key their terminal picks.
 */
export const DEFAULT_IDENTITIES = ['id_ed25519', 'id_ecdsa', 'id_ecdsa_sk', 'id_ed25519_sk', 'id_rsa', 'id_dsa'] as const

/**
 * The first default identity that exists, or null.
 *
 * OpenSSH with no `IdentityFile` does not fail — it tries these in turn. Doing
 * nothing instead is what made an empty key field mean "authenticate with
 * nothing", and the server then refused every method: reported as "the
 * private key mechanism is not working anymore", against a field whose grey
 * placeholder already said `~/.ssh/id_ed25519`.
 *
 * First match rather than all of them, because ssh2 takes ONE key per
 * connection. That covers the ordinary case — one key, the one `ssh` would
 * also have chosen — and the caller names the file it used so a mismatch is
 * diagnosable rather than silent.
 */
export function defaultIdentityPath(): string | null {
  const dir = sshDir()
  for (const name of DEFAULT_IDENTITIES) {
    const path = join(dir, name)
    try {
      if (statSync(path).isFile()) return path
    } catch {
      // Absent or unreadable is simply "not this one", exactly as ssh treats it.
    }
  }
  return null
}

export function listDefaultKeys(): DetectedKey[] {
  const dir = sshDir()
  if (!existsSync(dir)) return []

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }

  const keys: DetectedKey[] = []
  for (const fileName of entries) {
    if (fileName.startsWith('.') || fileName.endsWith('.pub') || IGNORED.has(fileName)) continue
    const path = join(dir, fileName)
    try {
      if (!statSync(path).isFile()) continue
    } catch {
      continue
    }

    const head = readPrefix(path, 256)
    if (!PRIVATE_HEADER.test(head)) continue

    keys.push({ path, fileName, algorithm: algorithmFromPub(path), encrypted: isEncryptedPrivateKey(head) })
  }

  // id_ed25519 before id_rsa before anything unusual, matching the order a
  // person would expect to see them offered in.
  const rank = (n: string): number =>
    n === 'id_ed25519' ? 0 : n === 'id_ecdsa' ? 1 : n === 'id_rsa' ? 2 : n === 'id_dsa' ? 3 : 4
  return keys.sort((a, b) => rank(a.fileName) - rank(b.fileName) || a.fileName.localeCompare(b.fileName))
}
