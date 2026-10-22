import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import type { EventEmitter } from 'node:events'

// Folder shares through the REAL session path: sshConnect → the shell is ready
// → ssh.ts's onServerSession hook → wireFolderShares → autoMount; and sshClose
// of the last terminal → unmountServer. Only ssh2's Client is replaced, by one
// whose channels open and close asynchronously and whose sshfs is this test
// speaking SFTP. The manager tests call autoMount directly; this one proves the
// hooks are wired the way index.ts wires them, including a reconnect and a
// terminal closed while a mount is still being set up.

interface World {
  cmds: string[]
  /** How long the "is it mounted" check takes. */
  checkMs: number
  /** How long the server takes to open the sshfs channel. */
  openMs: number
  /** Live sshfs channels, to drop them from the server side. */
  sshfs: Set<EventEmitter & { close: () => void }>
  /** Plays sshfs on the server's end of the channel. Set once the module under test has loaded. */
  speak: (stream: import('node:stream').Duplex) => void
}
const world = vi.hoisted((): World => ({ cmds: [], checkMs: 5, openMs: 2, sshfs: new Set(), speak: () => {} }))

vi.mock('ssh2', async (orig) => {
  const real = await orig<typeof import('ssh2')>()
  const { EventEmitter } = await import('node:events')
  const { duplexPair } = await import('node:stream')
  class Channel extends EventEmitter {
    stderr = new EventEmitter()
    resume(): void {}
    write(): boolean {
      return true
    }
    setWindow(): void {}
    close(): void {
      setTimeout(() => this.emit('close', null), 2)
    }
  }
  class FakeClient extends EventEmitter {
    connect(): void {
      setTimeout(() => this.emit('ready'), 2)
    }
    shell(_pty: unknown, cb: (err: Error | undefined, ch: Channel) => void): void {
      setTimeout(() => cb(undefined, new Channel()), 2)
    }
    exec(cmd: string, ...rest: unknown[]): void {
      const cb = rest[rest.length - 1] as (err: Error | undefined, ch: unknown) => void
      world.cmds.push(cmd)
      const opening = cmd.startsWith('sh -c') ? world.openMs : 2
      setTimeout(() => {
        if (cmd.startsWith('sh -c')) {
          const [mine, theirs] = duplexPair()
          const ch = Object.assign(mine, { stderr: new EventEmitter(), close: () => void mine.destroy() })
          world.sshfs.add(ch)
          ch.once('close', () => world.sshfs.delete(ch))
          cb(undefined, ch)
          world.speak(theirs)
          return
        }
        const ch = new Channel()
        cb(undefined, ch)
        setTimeout(
          () => {
            if (!cmd.startsWith('sh -c') && cmd.includes('fusermount')) for (const s of world.sshfs) s.close()
            ch.emit('close', 0)
          },
          cmd.includes('for i in') ? world.checkMs : 3
        )
      }, opening)
    }
    end(): void {
      for (const s of world.sshfs) s.close()
      setTimeout(() => this.emit('close'), 2)
    }
    destroy(): void {
      this.end()
    }
  }
  const realDefault = (real as unknown as { default: object }).default
  return { ...real, default: { ...realDefault, Client: FakeClient }, Client: FakeClient }
})
vi.mock('../src/main/services/knownhosts', async (orig) => ({
  ...(await orig<typeof import('../src/main/services/knownhosts')>()),
  verifyHostKey: () => Promise.resolve(true)
}))

const { sshConnect, sshClose, poolList } = await import('../src/main/services/ssh')
const { listMounts, setShares, sftpOverStream, wireFolderShares } = await import('../src/main/services/reverseMount')
world.speak = (stream) => void sftpOverStream(stream, false)
const { refreshMcpDataCache } = await import('../src/main/services/mcpDataCache')
const { serverIdentity } = await import('../src/shared/localMounts')

let listener: net.Server
let port: number
let tmp: string
const SID = 'srv-session'
const wc = { isDestroyed: () => false, send: () => {} } as never
// Password, not agent: ssh2 is faked, but agent auth still resolves a real
// agent socket first, and a CI runner has none — every connect failed there
// and no share ever started, while a Mac with launchd's agent passed.
const cfg = (sessionId: string) =>
  ({ sessionId, serverId: SID, host: '127.0.0.1', port, username: 'deploy', auth: 'password', password: 'unused', cols: 80, rows: 24, hops: [] }) as never
const until = async (pred: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(listMounts(SID))}`)
}
const isUnmount = (c: string): boolean => !c.startsWith('sh -c') && c.includes('fusermount')
/** References held on this server's pooled connection: terminals plus mounts. */
const refs = (): number => poolList().reduce((n, p) => n + p.sessions, 0)
const states = (): string[] => listMounts(SID).map((m) => m.state)

beforeAll(async () => {
  // ssh.ts opens the TCP socket itself before handing it to the Client.
  listener = net.createServer((s) => s.on('error', () => {}))
  await new Promise<void>((r) => listener.listen(0, '127.0.0.1', () => r()))
  port = (listener.address() as net.AddressInfo).port
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shares-session-'))
  fs.mkdirSync(path.join(tmp, 'site'))
  refreshMcpDataCache({
    workspaces: [{ id: 'ws', name: 'W' }],
    servers: [{ id: SID, workspaceId: 'ws', name: 'Box', host: '127.0.0.1', port, username: 'deploy', auth: 'agent', route: [] }]
  })
  await setShares(
    SID,
    [{ id: 'site', localDir: path.join(tmp, 'site'), mountpoint: '~/opsmaxx/site', readOnly: true, autoMount: true }],
    serverIdentity({ host: '127.0.0.1', port, username: 'deploy' })
  )
  wireFolderShares()
})

afterAll(() => {
  listener.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('folder shares follow the terminal', () => {
  it('mount when a terminal connects, and unmount when the last one closes', async () => {
    await sshConnect(wc, cfg('t1'))
    await until(() => states()[0] === 'mounted', 'mounted')

    // A second pane: still one mount.
    await sshConnect(wc, cfg('t2'))
    await new Promise((r) => setTimeout(r, 50))
    expect(world.cmds.filter((c) => c.startsWith('sh -c'))).toHaveLength(1)

    sshClose('t2')
    await new Promise((r) => setTimeout(r, 50))
    expect(states()).toEqual(['mounted'])

    // Two terminals and the mount.
    expect(refs()).toBe(2)
    sshClose('t1')
    await until(() => listMounts(SID).length === 0, 'unmounted')
    expect(world.cmds.some(isUnmount)).toBe(true)
    expect(refs()).toBe(0)
  })

  it('mounts again on reconnect after the connection drops', async () => {
    await sshConnect(wc, cfg('t3'))
    await until(() => states()[0] === 'mounted', 'mounted')
    // The server goes away under the mount: sshfs's channel closes first.
    for (const s of world.sshfs) s.close()
    await until(() => states()[0] === 'failed', 'failed after the drop')
    sshClose('t3')
    await until(() => listMounts(SID).length === 0, 'cleared')

    await sshConnect(wc, cfg('t4'))
    await until(() => states()[0] === 'mounted', 'remounted')
    sshClose('t4')
    await until(() => listMounts(SID).length === 0, 'unmounted')
  })

  it('undoes a mount still being set up when its terminal closes', async () => {
    world.checkMs = 5000
    const before = world.cmds.filter(isUnmount).length
    await sshConnect(wc, cfg('t5'))
    await until(() => states()[0] === 'mounting', 'mounting')
    const t = Date.now()
    sshClose('t5')
    await until(() => listMounts(SID).length === 0, 'gone')
    expect(Date.now() - t).toBeLessThan(2000)
    expect(world.cmds.filter(isUnmount).length).toBe(before + 1)
    expect(world.sshfs.size).toBe(0)
    expect(refs()).toBe(0)
    world.checkMs = 5
  })

  it('undoes a mount whose channel is still opening when its terminal closes', async () => {
    // The window the original bug lived in: the server has been asked to run
    // sshfs and has not answered yet.
    world.openMs = 300
    const before = world.cmds.filter(isUnmount).length
    await sshConnect(wc, cfg('t6'))
    await until(() => world.cmds.filter((c) => c.startsWith('sh -c')).length > 0 && states()[0] === 'mounting', 'asked for sshfs')
    sshClose('t6')
    await until(() => listMounts(SID).length === 0, 'gone')
    // The channel that opens after the close is closed as soon as it does.
    await new Promise((r) => setTimeout(r, 400))
    expect(world.sshfs.size).toBe(0)
    expect(refs()).toBe(0)
    expect(world.cmds.filter(isUnmount).length).toBeGreaterThanOrEqual(before)
    world.openMs = 2
  })
})
