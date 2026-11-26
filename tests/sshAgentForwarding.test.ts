import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { AgentProtocol, Server, utils, type ServerChannel } from 'ssh2'
import { expect, it, vi } from 'vitest'
import {
  liveServerConnection,
  poolList,
  release,
  setPoolIdle,
  sshClose,
  sshConnect,
  sshDisposeAll,
  sshExec
} from '../src/main/services/ssh'

vi.mock('../src/main/services/knownhosts', () => ({ verifyHostKey: async () => true }))

// ssh2 implements the client side of agent forwarding but has no public
// server API for opening this channel. The test server drives the same
// protocol request an OpenSSH server uses when a program opens SSH_AUTH_SOCK.
function forwardedChannel(connection: unknown): Promise<ServerChannel> {
  type OpenCallback = ((error: Error | undefined, channel: ServerChannel) => void) & { type: string }
  const ssh = connection as {
    _chanMgr: { add: (callback: OpenCallback) => number }
    _protocol: { openssh_authAgent: (channel: number, window: number, packetSize: number) => void }
  }
  return new Promise((resolve, reject) => {
    const callback = Object.assign(
      (error: Error | undefined, channel: ServerChannel) => (error ? reject(error) : resolve(channel)),
      { type: 'auth-agent@openssh.com' }
    )
    ssh._protocol.openssh_authAgent(ssh._chanMgr.add(callback), 2 * 1024 * 1024, 32 * 1024)
  })
}

it('logs in by password, serves the forwarded agent, and closes the dedicated connection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opsmaxx-agent-forward-'))
  const socketPath =
    process.platform === 'win32' ? `\\\\.\\pipe\\opsmaxx-forward-${process.pid}` : join(dir, 'agent.sock')
  const pair = utils.generateKeyPairSync('ed25519')
  const key = utils.parseKey(pair.private)
  if (key instanceof Error) throw key
  const agent = createServer((socket) => {
    const protocol = new AgentProtocol(false)
    protocol.on('identities', (request) => protocol.getIdentitiesReply(request, [key]))
    protocol.on('sign', (request, _pubkey, data) => {
      const signature = key.sign(data)
      if (signature instanceof Error) protocol.failureReply(request)
      else protocol.signReply(request, signature)
    })
    socket.pipe(protocol).pipe(socket)
  })
  const methods: string[] = []
  const forwarded = vi.fn()
  let shellConnection: unknown
  let terminalClosed: Promise<unknown> | undefined
  const ssh = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (conn) => {
    conn.on('authentication', (ctx) => {
      methods.push(ctx.method)
      if (ctx.method === 'password' && ctx.password === 'test-password') ctx.accept()
      else ctx.reject(['publickey', 'password'])
    })
    conn.on('ready', () => {
      conn.on('session', (accept) => {
        const session = accept()
        session.on('auth-agent', (agree) => {
          forwarded()
          agree()
        })
        session.on('pty', (agree) => agree())
        session.on('shell', (agree) => {
          shellConnection = conn
          terminalClosed = once(conn, 'close')
          agree()
        })
        session.on('exec', (agree) => {
          const channel = agree()
          channel.exit(0)
          channel.end()
        })
      })
    })
  })

  try {
    agent.listen(socketPath)
    await once(agent, 'listening')
    vi.stubEnv('SSH_AUTH_SOCK', socketPath)
    ssh.listen(0, '127.0.0.1')
    await once(ssh, 'listening')
    setPoolIdle(-1)

    const target = {
      host: '127.0.0.1',
      port: (ssh.address() as AddressInfo).port,
      username: 'test',
      auth: 'password' as const,
      password: 'test-password',
      serverId: 'test-server'
    }
    const send = vi.fn()
    const window = { send, isDestroyed: () => false } as unknown as WebContents
    await sshConnect(window, { ...target, sessionId: 'forwarded', cols: 80, rows: 24, forwardAgent: true })
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('ssh:status:forwarded', expect.objectContaining({ phase: 'ready' })))
    expect(methods).toEqual(['none', 'password'])
    expect(forwarded).toHaveBeenCalledOnce()

    const channel = await forwardedChannel(shellConnection)
    const protocol = new AgentProtocol(true)
    channel.pipe(protocol).pipe(channel)
    const challenge = Buffer.from('agent forwarding test')
    const signature = await new Promise<Buffer>((resolve, reject) => {
      protocol.sign(key, challenge, (error, signed) => (error || !signed ? reject(error) : resolve(signed)))
    })
    expect(key.verify(challenge, signature)).toBe(true)
    channel.close()

    expect((await sshExec(target, 'check')).code).toBe(0)
    expect(forwarded).toHaveBeenCalledOnce()
    expect(methods).toEqual(['none', 'password', 'none', 'password'])
    const lease = liveServerConnection(target.serverId)
    if (!lease) throw new Error('Expected an open terminal connection')
    lease.refs++ // A folder share can outlive the terminal's own reference.
    sshClose('forwarded')
    await terminalClosed
    release(lease)
    expect(poolList()).toHaveLength(1)
    expect(poolList()[0].key).not.toContain('agent-forward')

    await sshConnect(window, {
      ...target,
      password: 'wrong-password',
      sessionId: 'refused',
      cols: 80,
      rows: 24,
      forwardAgent: true
    })
    expect(send).toHaveBeenCalledWith('ssh:status:refused', expect.objectContaining({ phase: 'error' }))
    expect(methods.slice(4)).toEqual(['none', 'password', 'keyboard-interactive'])
  } finally {
    sshDisposeAll()
    setPoolIdle(0)
    vi.unstubAllEnvs()
    await Promise.all([
      new Promise<void>((resolve) => ssh.close(() => resolve())),
      new Promise<void>((resolve) => agent.close(() => resolve()))
    ])
    rmSync(dir, { recursive: true, force: true })
  }
})
