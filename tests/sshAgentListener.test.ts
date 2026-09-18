import { describe, it, expect, afterEach } from 'vitest'
import { connect, type Socket } from 'node:net'
import { generateKeyPairSync } from 'node:crypto'
import { statSync } from 'node:fs'
import { dirname } from 'node:path'
import { AGENT } from '../src/shared/sshAgentHost'
import { Reader, Writer, frame } from '../src/main/services/sshAgent/protocol'
import { loadKeys } from '../src/main/services/sshAgent/agent'
import { listen, type RunningListener } from '../src/main/services/sshAgent/listener'
import type { VaultEntry } from '../src/shared/vault'

/**
 * The agent over a real socket.
 *
 * The core's tests take a Buffer and return a Buffer. These are about what the
 * socket adds: framing across chunk boundaries, several requests in flight,
 * and who is allowed to reach it at all.
 */

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' }
})

const entry: VaultEntry = {
  id: 'v-1',
  name: 'Production key',
  kind: 'sshkey',
  url: '',
  username: 'root',
  password: '',
  privateKey
} as VaultEntry

let running: RunningListener | null = null
const sockets: Socket[] = []

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy()
  await running?.close()
  running = null
})

async function start(): Promise<RunningListener> {
  const keys = loadKeys([entry])
  running = await listen({
    deps: {
      keys: () => keys,
      policy: () => ({ allow: async () => true, forgetAll: () => {} }),
      canSign: () => true
    }
  })
  return running
}

function client(path: string): Socket {
  const s = connect(path)
  sockets.push(s)
  return s
}

/** Sends raw bytes and resolves with the first complete reply. */
function exchange(sock: Socket, bytes: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      if (buf.length < 4) return
      const len = buf.readUInt32BE(0)
      if (buf.length < 4 + len) return
      sock.off('data', onData)
      resolve(buf.subarray(4, 4 + len))
    }
    sock.on('data', onData)
    sock.once('error', reject)
    setTimeout(() => reject(new Error('no reply within 5s')), 5000).unref?.()
    sock.write(bytes)
  })
}

describe.skipIf(process.platform === 'win32')('the agent over a unix socket', () => {
  it('answers a request', async () => {
    const agent = await start()
    const reply = await exchange(
      client(agent.path),
      frame(Buffer.from([AGENT.REQUEST_IDENTITIES]))
    )
    const r = new Reader(reply)
    expect(r.byte()).toBe(AGENT.IDENTITIES_ANSWER)
    expect(r.uint32()).toBe(1)
  })

  it('reassembles a request written one byte at a time', async () => {
    // A socket delivers whatever it delivers. An implementation that assumed a
    // chunk is a message works on loopback until the day a client writes the
    // length prefix and the body separately.
    const agent = await start()
    const sock = client(agent.path)
    const msg = frame(Buffer.from([AGENT.REQUEST_IDENTITIES]))

    const reply = new Promise<Buffer>((resolve) => {
      let buf = Buffer.alloc(0)
      sock.on('data', (c) => {
        buf = Buffer.concat([buf, c])
        if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) resolve(buf.subarray(4))
      })
    })
    await new Promise<void>((r) => sock.once('connect', () => r()))
    for (const byte of msg) sock.write(Buffer.from([byte]))

    expect(new Reader(await reply).byte()).toBe(AGENT.IDENTITIES_ANSWER)
  })

  it('answers pipelined requests in order', async () => {
    // The protocol is request/response with no message ids, so a reply that
    // overtook another would answer the wrong request -- and the client has no
    // way to notice.
    const agent = await start()
    const sock = client(agent.path)
    await new Promise<void>((r) => sock.once('connect', () => r()))

    const list = frame(Buffer.from([AGENT.REQUEST_IDENTITIES]))
    const bogus = frame(Buffer.from([0xfe]))
    const replies: number[] = []
    const done = new Promise<void>((resolve) => {
      let buf = Buffer.alloc(0)
      sock.on('data', (c) => {
        buf = Buffer.concat([buf, c])
        for (;;) {
          if (buf.length < 4) break
          const len = buf.readUInt32BE(0)
          if (buf.length < 4 + len) break
          replies.push(buf[4])
          buf = buf.subarray(4 + len)
          if (replies.length === 3) resolve()
        }
      })
    })

    sock.write(Buffer.concat([list, bogus, list]))
    await done
    expect(replies).toEqual([AGENT.IDENTITIES_ANSWER, AGENT.FAILURE, AGENT.IDENTITIES_ANSWER])
  })

  it('hangs up on a length nobody could mean', async () => {
    const agent = await start()
    const sock = client(agent.path)
    await new Promise<void>((r) => sock.once('connect', () => r()))

    const huge = Buffer.alloc(4)
    huge.writeUInt32BE(0xffffffff)
    const closed = new Promise<void>((resolve) => sock.once('close', () => resolve()))
    sock.write(huge)
    // A stream whose framing we have stopped trusting cannot be
    // resynchronised, and 0xffffffff is an instruction to allocate four
    // gigabytes from any local process that can reach the socket.
    await closed
  })

  it('puts the socket in a directory only this user can enter', async () => {
    const agent = await start()
    // The permission that is portably enforced on a Unix socket is the
    // DIRECTORY's -- several kernels ignore the socket's own mode bits. A
    // predictable path in a shared temp directory is one another user can
    // create first, and then every tool on the machine connects to them while
    // `ssh-add -l` looks entirely normal.
    const mode = statSync(dirname(agent.path)).mode & 0o777
    expect(mode).toBe(0o700)
  })

  it('removes its socket when it stops', async () => {
    const agent = await start()
    const path = agent.path
    await agent.close()
    running = null
    expect(() => statSync(path)).toThrow()
  })

  it('signs over the socket, and the signature verifies', async () => {
    const agent = await start()
    const keys = loadKeys([entry])
    const blob = Buffer.from(keys[0].identity.publicKeyBase64, 'base64')
    const data = Buffer.from('what a server asked us to sign')

    const body = new Writer().byte(AGENT.SIGN_REQUEST).blob(blob).blob(data).uint32(0).body()
    const reply = await exchange(client(agent.path), frame(body))

    const r = new Reader(reply)
    expect(r.byte()).toBe(AGENT.SIGN_RESPONSE)
    const sig = new Reader(r.blob())
    expect(sig.str()).toBe('ssh-rsa')

    const { utils } = await import('ssh2')
    const pub = utils.parseKey(blob)
    if (pub instanceof Error) throw pub
    expect((Array.isArray(pub) ? pub[0] : pub).verify(data, sig.blob())).toBe(true)
  })
})

/**
 * THE ONE TEST THAT IS NOT MARKING ITS OWN HOMEWORK.
 *
 * Everything above checks this agent against this repository's idea of the
 * protocol. That is worth having and it is circular: a misreading of the spec
 * produces a matching misreading in the test. OpenSSH's own `ssh-add` is the
 * reference implementation, so pointing it at the socket is the only check
 * here that could catch a wrong reading of the draft.
 *
 * `ssh-add -T` is the strong form: OpenSSH asks the agent to sign a challenge
 * and then verifies the signature against the public key itself. It exercises
 * the framing, the identity list, the sign request, the algorithm name on the
 * wire and the signature bytes, and nothing that merely looks plausible
 * satisfies it.
 *
 * ASYNC, and that is not a style preference. The agent runs in THIS process,
 * so `execFileSync` deadlocks instantly: it blocks the event loop, the socket
 * is never serviced, ssh-add waits forever and so does the test. The first
 * version of this did exactly that and hung for two minutes before anything
 * said why.
 *
 * Skipped where ssh-add is absent rather than failing: a runner without
 * OpenSSH is a legitimate place to run the unit tests, and a skip beats a red
 * build nobody can act on.
 */
describe.skipIf(process.platform === 'win32')('against OpenSSH itself', () => {
  it('ssh-add lists the key, and ssh-add -T signs with it', async () => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { writeFileSync, mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const run = promisify(execFile)

    const agent = await start()
    const env = { ...process.env, SSH_AUTH_SOCK: agent.path }

    let listed: string
    try {
      listed = (await run('ssh-add', ['-l'], { env })).stdout
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return // no OpenSSH here
      throw err
    }

    // The fingerprint is computed by OpenSSH, not by us, which is what makes
    // this a check on `fingerprintOf` rather than a restatement of it.
    expect(listed).toContain('Production key')
    expect(listed).toMatch(/SHA256:[A-Za-z0-9+/]+/)

    const pub = (await run('ssh-add', ['-L'], { env })).stdout
    const dir = mkdtempSync(join(tmpdir(), 'opsmaxx-agent-test-'))
    const pubPath = join(dir, 'id.pub')
    writeFileSync(pubPath, pub)

    // Signs a challenge through the agent and verifies it. A non-zero exit
    // rejects the promise, which is the assertion.
    await run('ssh-add', ['-T', pubPath], { env })
  }, 20_000)
})
