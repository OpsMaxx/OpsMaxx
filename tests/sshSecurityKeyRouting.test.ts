import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:net'
import { openChain } from '../src/main/services/ssh'

// Does an sk- key actually REACH the agent, rather than merely being
// recognised?
//
// tests/sshSecurityKey.test.ts checks the detector. This checks the wiring,
// which is the half that was broken: the key was recognised by nobody and
// handed to ssh2 as `privateKey`, and the connection failed with "All
// configured authentication methods failed" — the message a wrong username
// gives too.
//
// The discriminator is the error. With no agent reachable, a key routed to the
// agent path fails with agentForHop's resolution message; a key that went to
// ssh2 instead cannot produce that message at all, because nothing on that path
// asks about an agent.
//
// It dials a socket that accepts and hangs up rather than a closed port,
// because the auth configuration is assembled AFTER the TCP connection — ssh2
// is handed an already-open `sock`. Against a closed port the connect error
// arrives first and proves nothing about which auth path was chosen.
//
// WHAT THIS STILL DOES NOT COVER, and no test on this machine can: whether a
// real YubiKey then authenticates. `ssh-keygen -t ed25519-sk` here reports "No
// FIDO SecurityKeyProvider specified" — there is no authenticator attached — so
// the signing round trip is unverified and is the one thing worth trying by
// hand before trusting this.

let dir: string
let savedSock: string | undefined
let server: Server
let port: number

/** An OpenSSH v1 container whose public-key section declares `keytype`. Built
 *  the way a real file is: the type is inside base64, never readable in the
 *  armour, which is why the detector decodes rather than pattern-matching. */
function keyFile(keytype: string): string {
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
    str('none'),
    str('none'),
    str(''),
    u32(1),
    str(pub.toString('binary'))
  ])
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${blob.toString('base64')}\n-----END OPENSSH PRIVATE KEY-----\n`
}

const write = (name: string, keytype: string): string => {
  const p = join(dir, name)
  writeFileSync(p, keyFile(keytype), { mode: 0o600 })
  return p
}

const connect = (keyPath: string): Promise<unknown> =>
  openChain(
    { host: '127.0.0.1', port, username: 'nobody', auth: 'key', keyPath } as never,
    undefined,
    false
  )

beforeEach(async () => {
  // Accepts, then hangs up: enough for the connect to succeed so the auth
  // configuration is built, and no more, so an ordinary key fails its
  // handshake immediately instead of waiting out a timeout.
  server = createServer((sock) => sock.destroy())
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as { port: number }).port
  dir = mkdtempSync(join(tmpdir(), 'opsmaxx-skroute-'))
  savedSock = process.env.SSH_AUTH_SOCK
  // No ambient agent, so the agent path has something to fail on and that
  // failure is legible. A machine running an agent would connect to port 1 and
  // fail later, which proves the same routing less clearly.
  delete process.env.SSH_AUTH_SOCK
})
afterEach(async () => {
  if (savedSock === undefined) delete process.env.SSH_AUTH_SOCK
  else process.env.SSH_AUTH_SOCK = savedSock
  rmSync(dir, { recursive: true, force: true })
  await new Promise<void>((r) => server.close(() => r()))
})

describe('a hardware-backed key on the connect path', () => {
  it('is sent to the SSH agent, not to ssh2', async () => {
    await expect(connect(write('id_ed25519_sk', 'sk-ssh-ed25519@openssh.com'))).rejects.toThrow(
      /No SSH agent was found/i
    )
  })

  it('the ECDSA variant too', async () => {
    await expect(
      connect(write('id_ecdsa_sk', 'sk-ecdsa-sha2-nistp256@openssh.com'))
    ).rejects.toThrow(/No SSH agent was found/i)
  })

  it('and an ordinary key is NOT — it still goes to ssh2', async () => {
    // The half that proves the test above means anything. If this also
    // mentioned an agent, the assertion would be passing for every key.
    await expect(connect(write('id_ed25519', 'ssh-ed25519'))).rejects.toThrow()
    await expect(connect(write('id_ed25519', 'ssh-ed25519'))).rejects.not.toThrow(
      /No SSH agent was found/i
    )
  })
})
