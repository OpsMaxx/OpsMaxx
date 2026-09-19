import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect as tcpConnect } from 'node:net'
import { app } from 'electron'
import { Client, Server, utils } from 'ssh2'
import type { SshHop } from '../src/shared/ssh'
import { fingerprint } from '../src/main/services/knownhosts'
import { poolDisposeAll, poolList, sshExec } from '../src/main/services/ssh'
import { metricsDisposeAll, metricsSample } from '../src/main/services/metrics'
import type { SshConnectConfig } from '../src/shared/ssh'

// A server behind a bastion, sampled the way the BACKGROUND readers sample it.
//
// The reported defect is that such a server reads as disconnected in Monitoring
// and in every panel fed by the sampler's cache — security posture, access,
// inventory, drift — while a direct-connection server in the same list is fine.
//
// Asserted against two real sshd's, not against doubles. The bastion below is
// an ssh2 Server that actually answers `direct-tcpip`, and the target is a
// second one that only ever sees connections arriving through it. A test with a
// fake transport would pass against code that never built the chain at all,
// which is the failure mode this file exists to catch.

const HOST = '127.0.0.1'

interface Fixture {
  server: Server
  port: number
  /** Every connection this sshd has authenticated. */
  logins: string[]
}

let hostKey = ''
let clientKey = ''
let bastion: Fixture
let target: Fixture

/**
 * The host key exactly as ssh2 hands it to `hostVerifier`, read off a throwaway
 * connection rather than derived from the PEM — the same reason
 * tests/sshFreshSession.ts does it this way.
 */
function learnHostKey(port: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const probe = new Client()
    let seen: Buffer | null = null
    probe.on('ready', () => {
      probe.end()
      if (seen) resolve(seen)
      else reject(new Error('connected without a host key'))
    })
    probe.on('error', (e) => reject(e))
    probe.connect({
      host: HOST,
      port,
      username: 'ops',
      privateKey: clientKey,
      hostVerifier: ((key: Buffer, cb: (ok: boolean) => void) => {
        seen = Buffer.from(key)
        cb(true)
      }) as never
    })
  })
}

/**
 * One sshd. `forwards` makes it a bastion: it answers `direct-tcpip` by opening
 * a real TCP socket to wherever the channel asked for and splicing the two
 * together, which is what an OpenSSH jump host does.
 */
async function startServer(name: string, forwards: boolean): Promise<Fixture> {
  const allowed = utils.parseKey(clientKey)
  if (allowed instanceof Error) throw allowed

  const logins: string[] = []
  const server = new Server({ hostKeys: [hostKey] }, (conn) => {
    // Several tests below hang up part-way through a handshake on purpose —
    // that is what "the client refused this host" looks like from here — and
    // ssh2's Server raises KEY_EXCHANGE_FAILED for it. Unhandled, it fails the
    // run from outside any test.
    conn.on('error', () => undefined)
    conn.on('authentication', (ctx) => {
      if (ctx.method !== 'publickey') {
        ctx.reject(['publickey'])
        return
      }
      if (ctx.key.algo !== allowed.type || !ctx.key.data.equals(allowed.getPublicSSH())) {
        ctx.reject(['publickey'])
        return
      }
      if (ctx.signature && !allowed.verify(ctx.blob as Buffer, ctx.signature, ctx.hashAlgo)) {
        ctx.reject(['publickey'])
        return
      }
      ctx.accept()
    })
    conn.on('ready', () => {
      logins.push(name)
      conn.on('session', (accept) => {
        const session = accept()
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec()
          // Echoes which host ran it, so a command that reached the wrong end
          // of the chain is visible rather than merely successful.
          stream.write(`${name}:${info.command}\n`)
          stream.exit(0)
          stream.end()
        })
      })
      if (forwards) {
        conn.on('tcpip', (accept, reject, info) => {
          const socket = tcpConnect(info.destPort, info.destIP, () => {
            const channel = accept()
            channel.pipe(socket).pipe(channel)
          })
          socket.on('error', () => reject())
        })
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, HOST, resolve))
  return { server, port: (server.address() as { port: number }).port, logins }
}

beforeAll(async () => {
  const host = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' }
  })
  const user = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' }
  })
  hostKey = host.privateKey
  clientKey = user.privateKey

  bastion = await startServer('bastion', true)
  target = await startServer('target', false)

  // Both hosts trusted before anything under test connects: this file is about
  // the chain, not about trust-on-first-use.
  const key = await learnHostKey(bastion.port)
  const entry = (port: number): Record<string, unknown> => ({
    id: `${HOST}:${port}`,
    fingerprint: fingerprint(key),
    addedAt: new Date().toISOString()
  })
  writeFileSync(
    join(app.getPath('userData'), 'opsmaxx-known-hosts.json'),
    JSON.stringify({
      [`${HOST}:${bastion.port}`]: entry(bastion.port),
      [`${HOST}:${target.port}`]: entry(target.port)
    })
  )
  bastion.logins.length = 0
  target.logins.length = 0
}, 30_000)

afterAll(async () => {
  poolDisposeAll()
  await new Promise<void>((resolve) => bastion.server.close(() => resolve()))
  await new Promise<void>((resolve) => target.server.close(() => resolve()))
})

beforeEach(() => {
  poolDisposeAll()
  bastion.logins.length = 0
  target.logins.length = 0
})

/** The target as the renderer describes it: its own address plus its chain. */
const behindBastion = (): SshHop & { serverId: string; hops: SshHop[] } => ({
  serverId: 'srv-target',
  host: HOST,
  port: target.port,
  username: 'ops',
  auth: 'key',
  privateKey: clientKey,
  hops: [
    {
      serverId: 'srv-bastion',
      host: HOST,
      port: bastion.port,
      username: 'ops',
      auth: 'key',
      privateKey: clientKey
    } as SshHop
  ]
})

describe('a background read of a server behind a jump host', () => {
  // allowPrompt false is the whole difference between the two paths: every
  // background reader passes it, and a terminal does not.
  it('reaches the target through the bastion', async () => {
    const r = await sshExec(behindBastion(), 'uptime', 10_000, false)
    expect(r.error).toBeUndefined()
    expect(r.stdout.trim()).toBe('target:uptime')
    expect(bastion.logins).toHaveLength(1)
    expect(target.logins).toHaveLength(1)
  })

  it('pools both hops, so a second read authenticates nobody again', async () => {
    await sshExec(behindBastion(), 'one', 10_000, false)
    await sshExec(behindBastion(), 'two', 10_000, false)
    expect(bastion.logins).toHaveLength(1)
    expect(target.logins).toHaveLength(1)
    expect(poolList().map((p) => p.key).sort()).toEqual(
      ['srv:srv-bastion', 'srv:srv-bastion>srv:srv-target'].sort()
    )
  })

  /**
   * One bastion, several servers behind it, ONE authentication.
   *
   * The alternative — a connection per target — is what makes a sweep of an
   * estate behind a shared jump host trip `MaxStartups`, which throttles and
   * then refuses concurrent handshakes. `MaxSessions` is not the limit that
   * bites (it counts shell/login/subsystem sessions, and forwarding is
   * permitted even at 0); concurrent *handshakes* are. Asserted against the
   * bastion's own login count, because that is the only thing that can tell
   * multiplexing from N logins that happened to work.
   */
  it('multiplexes every server behind one bastion over a single bastion login', async () => {
    const second = { ...behindBastion(), serverId: 'srv-target-2' }
    await sshExec(behindBastion(), 'one', 10_000, false)
    await sshExec(second, 'two', 10_000, false)
    expect(bastion.logins).toHaveLength(1)
    expect(target.logins).toHaveLength(2)
  })

  /**
   * The Monitoring tab's own probe, not a stand-in for it.
   *
   * `sshExec` above covers the host-facts, posture, access and drift readers.
   * The metrics sample is a different entry point — it holds its own
   * connection map keyed per watcher — and it is the one whose failure the user
   * actually sees as a server reading disconnected, so it is asserted
   * separately rather than assumed to behave like its neighbour.
   *
   * What is checked is what the two sshd's saw. The fixture answers an exec
   * with an echo rather than /proc/stat, so the PARSE is meaningless here and
   * deliberately not asserted; a login on each host is the claim, and it is the
   * one a chain that was never built could not produce.
   */
  it('is reached by the metrics sampler, which is what the monitor shows', async () => {
    const cfg = { ...behindBastion(), sessionId: 'fleet-x', cols: 80, rows: 24 } as unknown as SshConnectConfig
    try {
      await metricsSample('fleet:srv-target', cfg, false)
      expect(bastion.logins).toEqual(['bastion'])
      expect(target.logins).toEqual(['target'])
    } finally {
      metricsDisposeAll()
    }
  })
})

/**
 * WHICH hop failed.
 *
 * Every string asserted below was produced by these two sshd's before the
 * chain walk labelled anything, and each one is why a user could not act on a
 * jump-host failure: the four cases collapsed into two strings, and both of
 * them pointed at the wrong machine.
 */
describe('a failure part-way along the chain says where it happened', () => {
  it('a bastion that refuses our credential is not reported as the target refusing it', async () => {
    const other = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' }
    })
    const cfg = behindBastion()
    cfg.hops[0] = { ...cfg.hops[0], privateKey: other.privateKey }
    const r = await sshExec(cfg, 'uptime', 10_000, false)

    expect(r.ok).toBe(false)
    // The bare string is "All configured authentication methods failed", which
    // reads as the TARGET's key being wrong. The target was never dialled.
    expect(r.error).toContain('Jump host 1 of 1')
    expect(r.error).toContain(`ops@${HOST}:${bastion.port}`)
    expect(target.logins).toHaveLength(0)
  })

  /**
   * The name the user chose, INSTEAD OF the address — not beside it.
   *
   * A jump host is addressed in this app by the friendly name of a saved
   * server, so that is the handle the user has on it. The substitution also
   * keeps these strings inside the rule the MCP bridge is built on: an agent
   * is never shown a hostname, an address or an account, and a connection
   * error is one of the few things that reaches it.
   */
  it('calls the jump host by its saved name, and does not append its address', async () => {
    const { refreshMcpDataCache } = await import('../src/main/services/mcpDataCache')
    refreshMcpDataCache({
      workspaces: [{ id: 'ws', name: 'default' }],
      servers: [
        {
          id: 'srv-bastion',
          workspaceId: 'ws',
          name: 'edge-bastion',
          host: HOST,
          port: bastion.port,
          username: 'ops',
          auth: 'key'
        }
      ]
    })
    try {
      const cfg = behindBastion()
      cfg.hops[0] = { ...cfg.hops[0], port: 1 }
      const r = await sshExec(cfg, 'uptime', 10_000, false)
      expect(r.error).toContain('edge-bastion')
      expect(r.error).not.toContain('ops@')
    } finally {
      refreshMcpDataCache({ workspaces: [], servers: [] })
    }
  })

  it('a bastion that cannot be reached at all names the bastion, not the server', async () => {
    const cfg = behindBastion()
    cfg.hops[0] = { ...cfg.hops[0], port: 1 }
    const r = await sshExec(cfg, 'uptime', 10_000, false)

    expect(r.ok).toBe(false)
    expect(r.error).toContain('Jump host 1 of 1')
    expect(r.error).toContain('ECONNREFUSED')
  })

  /**
   * The two that were literally the same string: "(SSH) Channel open failure: "
   * with an empty reason, for a bastion that will not forward AND for a target
   * that is down behind a bastion that is fine. Different machines, different
   * fixes, one message.
   */
  it('separates a bastion that will not forward from a target that is down', async () => {
    // `target` is a perfectly good sshd that answers no `direct-tcpip` — which
    // is a real jump host with `AllowTcpForwarding no`. Used as the hop here so
    // both fixtures stay inside the trusted-host-key set: this test is about
    // the forward, not about trust.
    const viaRefuser = behindBastion()
    viaRefuser.hops[0] = { ...viaRefuser.hops[0], port: target.port, serverId: 'srv-noforward' } as SshHop
    viaRefuser.port = bastion.port
    viaRefuser.serverId = 'srv-far-end'
    const a = await sshExec(viaRefuser, 'uptime', 10_000, false)

    const deadTarget = behindBastion()
    deadTarget.port = 1
    const b = await sshExec(deadTarget, 'uptime', 10_000, false)

    expect(a.ok).toBe(false)
    expect(b.ok).toBe(false)
    // Both are the jump host failing to carry the connection onwards rather
    // than the far end refusing to authenticate, and both say so — including
    // WHICH address could not be reached, which is what tells them apart.
    expect(a.error).toContain('could not open a connection onwards')
    expect(b.error).toContain('could not open a connection onwards')
    expect(a.error).toContain(`${HOST}:${bastion.port}`)
    expect(b.error).toContain(`${HOST}:1`)
    expect(a.error).not.toBe(b.error)
  })

  it('leaves a target-side failure unlabelled, so a direct server reads exactly as before', async () => {
    const direct: SshHop & { serverId: string } = {
      serverId: 'srv-direct',
      host: HOST,
      port: 1,
      username: 'ops',
      auth: 'key',
      privateKey: clientKey
    }
    const r = await sshExec(direct, 'uptime', 10_000, false)
    expect(r.ok).toBe(false)
    expect(r.error).not.toContain('Jump host')
  })
})
