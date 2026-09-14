import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { Client } from 'ssh2'

import {
  certificateAuthHandler,
  certificateKey,
  parseOpenSshCertificate
} from '../src/main/services/cloud/certKey'

// The one test that proves the Azure Entra login path actually works.
//
// ssh2 cannot authenticate with an OpenSSH certificate as shipped: it writes a
// single algorithm name into both the userauth request and the signature blob,
// and a certificate needs the certificate spelling in the first and the plain
// one in the second. patches/ssh2+1.17.0.patch separates them. Nothing in a
// unit test can prove that is right, because the only authority on the wire
// format is a real server - ssh2's own Server implementation has no
// certificate support either, and would accept a malformed packet as readily
// as a correct one.
//
// So this starts OpenSSH's sshd with a trusted CA and logs into it. If it
// fails, certificate authentication is broken in production, whatever the unit
// tests say. If the patch silently stops applying after an ssh2 upgrade, this
// is what notices.

const SSHD_CANDIDATES = ['/usr/sbin/sshd', '/usr/bin/sshd', '/sbin/sshd']

let root = ''
let sshd: ChildProcess | null = null
let port = 0
let skip = ''
const username = userInfo().username

function findSshd(): string | null {
  for (const p of SSHD_CANDIDATES) if (existsSync(p)) return p
  return null
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const chosen = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(chosen))
    })
  })
}

beforeAll(async () => {
  const bin = findSshd()
  if (!bin) {
    skip = 'no sshd on this machine'
    return
  }
  try {
    root = mkdtempSync(join(tmpdir(), 'opsmaxx-certauth-'))
    const kg = (args: string[]): void => {
      execFileSync('ssh-keygen', args, { stdio: 'pipe' })
    }
    kg(['-t', 'ed25519', '-f', join(root, 'host'), '-N', '', '-q', '-C', 'host'])
    kg(['-t', 'ed25519', '-f', join(root, 'ca'), '-N', '', '-q', '-C', 'ca'])
    kg(['-t', 'ed25519', '-f', join(root, 'user'), '-N', '', '-q', '-C', 'user'])
    kg(['-t', 'rsa', '-b', '2048', '-f', join(root, 'rsauser'), '-N', '', '-q', '-C', 'rsa'])
    // Signed for THIS user, because that is who sshd will be asked to admit.
    kg(['-s', join(root, 'ca'), '-I', 'opsmaxx-test', '-n', username, join(root, 'user.pub')])
    kg(['-s', join(root, 'ca'), '-I', 'opsmaxx-rsa', '-n', username, join(root, 'rsauser.pub')])
    chmodSync(join(root, 'host'), 0o600)

    port = await freePort()
    sshd = spawn(
      bin,
      [
        '-D',
        '-e',
        '-f',
        '/dev/null',
        '-o', `Port=${port}`,
        '-o', 'ListenAddress=127.0.0.1',
        '-o', `HostKey=${join(root, 'host')}`,
        '-o', `TrustedUserCAKeys=${join(root, 'ca.pub')}`,
        '-o', 'AuthorizedPrincipalsFile=none',
        '-o', 'PubkeyAuthentication=yes',
        '-o', 'PasswordAuthentication=no',
        '-o', 'KbdInteractiveAuthentication=no',
        '-o', 'UsePAM=no',
        '-o', 'StrictModes=no',
        '-o', 'PidFile=none',
        '-o', 'LogLevel=DEBUG1'
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let log = ''
    sshd.stdout?.on('data', (d: Buffer) => (log += d.toString()))
    sshd.stderr?.on('data', (d: Buffer) => (log += d.toString()))

    // Wait for it to say it is listening, rather than sleeping and hoping.
    const deadline = Date.now() + 10_000
    for (;;) {
      if (/Server listening on/.test(log)) break
      if (sshd.exitCode !== null || Date.now() > deadline) {
        skip = `sshd did not start: ${log.split('\n').slice(-3).join(' ')}`
        return
      }
      await new Promise((r) => setTimeout(r, 100))
    }
  } catch (e) {
    skip = `could not set up sshd: ${String(e)}`
  }

  if (skip) {
    console.warn(
      `SKIPPING certificate AUTH test (${skip}). This is the only check that ` +
        'proves the ssh2 certificate patch works; a green run without it is not coverage.'
    )
  }
}, 30_000)

afterAll(() => {
  sshd?.kill('SIGKILL')
  if (root) rmSync(root, { recursive: true, force: true })
})

/** Log in with a certificate and resolve when authentication succeeds. */
async function connectWithCertificate(keyName: string): Promise<void> {
  const cert = parseOpenSshCertificate(readFileSync(join(root, `${keyName}-cert.pub`), 'utf8'))
  const key = certificateKey(readFileSync(join(root, keyName)), cert)

  await new Promise<void>((resolve, reject) => {
    const client = new Client()
    const done = (e?: Error): void => {
      client.end()
      if (e) reject(e)
      else resolve()
    }
    client
      .on('ready', () => done())
      .on('error', (e: Error) => done(e))
      .connect({
        host: '127.0.0.1',
        port,
        username,
        // Via authHandler, never `privateKey` - see certificateAuthHandler.
        authHandler: certificateAuthHandler(username, key) as never,
        readyTimeout: 15_000,
        // The host key is throwaway and the point of the test is the client's
        // own credential, not TOFU.
        hostVerifier: () => true
      })
  })
}

describe('authenticating to a real sshd with an OpenSSH certificate', () => {
  // A skipped run looks identical to a passing one, and this suite is the only
  // evidence the ssh2 certificate patch works. CI sets OPSMAXX_REQUIRE_SSHD=1
  // so that "sshd was missing" is a failure there rather than a silent pass.
  it('actually ran, where the environment is meant to support it', () => {
    if (process.env.OPSMAXX_REQUIRE_SSHD === '1') {
      expect(skip, 'OPSMAXX_REQUIRE_SSHD=1 but the suite skipped itself').toBe('')
    }
    expect(typeof skip).toBe('string')
  })

  it('logs in with an ed25519 certificate', async () => {
    if (skip) return
    await expect(connectWithCertificate('user')).resolves.toBeUndefined()
  }, 30_000)

  it('logs in with an RSA certificate, which must sign with SHA-2', async () => {
    if (skip) return
    // Modern OpenSSH refuses ssh-rsa/SHA-1 outright, so this fails unless the
    // patched getKeyAlgos picked rsa-sha2-* and the signature honoured it.
    await expect(connectWithCertificate('rsauser')).resolves.toBeUndefined()
  }, 30_000)

  it('is refused when the certificate is not signed by a trusted CA', async () => {
    if (skip) return
    const kg = (args: string[]): void => {
      execFileSync('ssh-keygen', args, { stdio: 'pipe' })
    }
    // A perfectly well-formed certificate from a CA this server never heard of.
    kg(['-t', 'ed25519', '-f', join(root, 'rogue-ca'), '-N', '', '-q', '-C', 'rogue'])
    kg(['-t', 'ed25519', '-f', join(root, 'rogue'), '-N', '', '-q', '-C', 'rogue'])
    kg([
      '-s', join(root, 'rogue-ca'),
      '-I', 'rogue',
      '-n', username,
      join(root, 'rogue.pub')
    ])
    // Anti-vacuity: if this passed, the two tests above would prove nothing,
    // because the server would be admitting everyone.
    await expect(connectWithCertificate('rogue')).rejects.toThrow()
  }, 30_000)
})
