import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { duplexPair } from 'node:stream'
import {
  autoMount,
  listMounts,
  mountScript,
  mountShare,
  reenableShares,
  setShares,
  sftpOverStream,
  sharesFor,
  unmountScript,
  unmountServer,
  unmountShare
} from '../src/main/services/reverseMount'
import { refreshMcpDataCache } from '../src/main/services/mcpDataCache'
import {
  MOUNT_EXIT,
  defaultMountpoint,
  explainMountFailure,
  mountpointProblem,
  parseShares,
  serverIdentity,
  type LocalShare
} from '../src/shared/localMounts'
import type { PooledConnection } from '../src/main/services/ssh'

// The mount manager, driven against a fake connection whose channels open and
// close asynchronously, as real ones do: `exec` of the sshfs command hands back
// one end of a pipe and this test speaks SFTP on the other, as sshfs would;
// the "is it mounted" check and the unmount answer after a delay the test
// chooses. What it proves is the bookkeeping a person sees — states, the
// reference held on the connection, the unmount command — and the rules that
// are visible nowhere: setup failures are not retried on their own, a changed
// server address stops a share, and a teardown during a mount undoes it.

interface Fake {
  conn: PooledConnection
  cmds: string[]
  /** Exit code for the sshfs command itself; null means "start and stay up". */
  sshfsExit: number | null
  /** How long the mount check takes to answer. */
  checkMs: number
  /** The live sshfs channel, to drop it from the server side. */
  sshfs: (EventEmitter & { close: () => void }) | null
}

class Channel extends EventEmitter {
  stderr = new EventEmitter()
  resume(): void {}
  close(): void {
    setTimeout(() => this.emit('close', null), 2)
  }
}

function fakeConn(): Fake {
  const fake: Fake = { conn: null as unknown as PooledConnection, cmds: [], sshfsExit: null, checkMs: 5, sshfs: null }
  const client = {
    exec(cmd: string, cb: (err: Error | undefined, ch: unknown) => void) {
      fake.cmds.push(cmd)
      setTimeout(() => {
        if (cmd.startsWith('sh -c')) {
          const [mine, theirs] = duplexPair()
          const ch = Object.assign(mine, { stderr: new EventEmitter(), close: () => void mine.destroy() })
          fake.sshfs = ch
          cb(undefined, ch)
          if (fake.sshfsExit !== null) {
            const code = fake.sshfsExit
            setTimeout(() => ch.emit('close', code), 3)
          } else sftpOverStream(theirs, false)
          return
        }
        const ch = new Channel()
        cb(undefined, ch)
        const isCheck = cmd.includes('for i in')
        setTimeout(() => {
          // Unmounting makes sshfs exit, as fusermount does.
          if (cmd.includes('fusermount')) fake.sshfs?.close()
          ch.emit('close', 0)
        }, isCheck ? fake.checkMs : 3)
      }, 2)
    }
  }
  fake.conn = { key: 'k', id: 'i', host: 'host-1', username: 'deploy', client, refs: 1 } as unknown as PooledConnection
  return fake
}

const server = (id: string, host = 'host-1') => ({
  id,
  workspaceId: 'ws',
  name: id,
  host,
  port: 22,
  username: 'deploy',
  auth: 'key',
  route: []
})
const identity = (host = 'host-1') => serverIdentity({ host, port: 22, username: 'deploy' })

let tmp: string
const share = (dir: string, over: Partial<LocalShare> = {}): LocalShare => ({
  id: `sh-${path.basename(dir)}`,
  localDir: dir,
  mountpoint: `~/opsmaxx/${path.basename(dir)}`,
  readOnly: true,
  autoMount: true,
  ...over
})
const settle = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localmounts-'))
  refreshMcpDataCache({ workspaces: [{ id: 'ws', name: 'W' }], servers: [server('srv-a'), server('srv-b')] })
})

afterEach(async () => {
  await unmountServer('srv-a')
  await unmountServer('srv-b')
  await setShares('srv-a', [], identity())
  await setShares('srv-b', [], identity())
  // Setup failures survive unmountServer on purpose; clear them for the next test.
  for (const m of listMounts('srv-a')) await unmountShare('srv-a', m.mountpoint)
  for (const m of listMounts('srv-b')) await unmountShare('srv-b', m.mountpoint)
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the mount manager', () => {
  it('mounts, reports each state, holds the connection, and unmounts with fusermount', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'a-'))
    const s = share(dir, { autoMount: false })
    await setShares('srv-a', [s], identity())
    const fake = fakeConn()

    expect(await mountShare('srv-a', fake.conn, s.id, true)).toEqual({ ok: true })
    expect(listMounts('srv-a')[0].state).toBe('mounted')
    expect(fake.conn.refs).toBe(2)

    // Another pane connecting does nothing new.
    const before = fake.cmds.length
    expect(await mountShare('srv-a', fake.conn, s.id, false)).toEqual({ ok: true })
    expect(fake.cmds.length).toBe(before)

    expect(await unmountShare('srv-a', s.mountpoint)).toBe(true)
    expect(fake.cmds.at(-1)).toBe(unmountScript(s.mountpoint))
    expect(fake.conn.refs).toBe(1)
    expect(listMounts('srv-a')).toEqual([])
  })

  it('does not retry a setup failure on its own; Retry does', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'nosshfs-'))
    await setShares('srv-a', [share(dir)], identity())
    const fake = fakeConn()
    fake.sshfsExit = MOUNT_EXIT.noSshfs
    autoMount('srv-a', fake.conn)
    await settle()
    expect(listMounts('srv-a')[0]).toMatchObject({ state: 'failed', error: 'sshfs is not installed on this server.' })
    expect(fake.conn.refs).toBe(1)

    // A new pane, and the last terminal closing and a reconnect: no new attempt.
    const tries = fake.cmds.length
    autoMount('srv-a', fake.conn)
    await unmountServer('srv-a')
    autoMount('srv-a', fake.conn)
    await settle()
    expect(fake.cmds.length).toBe(tries)
    expect(listMounts('srv-a')[0].state).toBe('failed')

    // Retry is a person asking.
    fake.sshfsExit = null
    expect(await mountShare('srv-a', fake.conn, share(dir).id, true)).toEqual({ ok: true })
    expect(listMounts('srv-a')[0].state).toBe('mounted')
  })

  it('remounts after the connection drops, on the next connect', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'drop-'))
    await setShares('srv-a', [share(dir)], identity())
    const fake = fakeConn()
    autoMount('srv-a', fake.conn)
    await settle()
    expect(listMounts('srv-a')[0].state).toBe('mounted')

    fake.sshfs!.close()
    await settle()
    expect(listMounts('srv-a')[0]).toMatchObject({ state: 'failed' })
    expect(fake.conn.refs).toBe(1)

    const again = fakeConn()
    autoMount('srv-a', again.conn)
    await settle()
    expect(listMounts('srv-a')[0].state).toBe('mounted')
  })

  it('undoes a mount that is still being set up when the last terminal closes', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'mid-'))
    await setShares('srv-a', [share(dir)], identity())
    const fake = fakeConn()
    fake.checkMs = 5000
    autoMount('srv-a', fake.conn)
    await settle(30)
    expect(listMounts('srv-a')[0].state).toBe('mounting')

    const started = Date.now()
    await unmountServer('srv-a')
    expect(Date.now() - started).toBeLessThan(2000)
    expect(listMounts('srv-a')).toEqual([])
    expect(fake.cmds.some((c) => !c.startsWith('sh -c') && c.includes('fusermount'))).toBe(true)
    expect(fake.conn.refs).toBe(1)
  })

  it("stops a share when the server's address changes, until it is re-enabled", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'moved-'))
    await setShares('srv-a', [share(dir)], identity())
    expect(sharesFor('srv-a')[0].stale).toBe(false)

    // Anyone can change the record: the user, a synced edit, an agent.
    refreshMcpDataCache({ workspaces: [{ id: 'ws', name: 'W' }], servers: [server('srv-a', 'elsewhere'), server('srv-b')] })
    expect(sharesFor('srv-a')[0].stale).toBe(true)
    const fake = fakeConn()
    autoMount('srv-a', fake.conn)
    await settle()
    expect(fake.cmds).toEqual([])
    expect((await mountShare('srv-a', fake.conn, share(dir).id, true)).ok).toBe(false)

    reenableShares('srv-a')
    expect(sharesFor('srv-a')[0].stale).toBe(false)
  })

  it('cannot be given a share by a synced or restored server record', async () => {
    // What addy sync and a backup restore write is the data blob. A share in
    // it, on a server record, is inert: shares are read from their own
    // per-machine file and nowhere else.
    const dir = fs.mkdtempSync(path.join(tmp, 'synced-'))
    refreshMcpDataCache({
      workspaces: [{ id: 'ws', name: 'W' }],
      servers: [{ ...server('srv-b'), shares: [share(dir, { readOnly: false })] }]
    })
    expect(sharesFor('srv-b')).toEqual([])
    const fake = fakeConn()
    autoMount('srv-b', fake.conn)
    await settle()
    expect(fake.cmds).toEqual([])

    // And the file shares live in is in neither a backup bundle nor a sync.
    const src = (p: string): string => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')
    const backup = src('src/main/services/backup.ts')
    expect(backup.split('opsmaxx-folder-shares.json').length - 1).toBe(1)
    expect(backup.slice(backup.indexOf('export const ALL_DATA_FILES'))).toContain("'opsmaxx-folder-shares.json'")
    for (const f of fs.readdirSync(path.join(__dirname, '../src/main/services/addy')))
      expect(src(`src/main/services/addy/${f}`)).not.toMatch(/folder-shares|reverseMount|shares/)
  })
})

describe('the mount script', () => {
  it('expands ~/ without letting the folder name reach the shell', () => {
    const s = mountScript("~/opsmaxx/it's $(rm -rf ~)", true)
    expect(s).toContain(`mp="$HOME"/'opsmaxx/it'\\''s $(rm -rf ~)'`)
    expect(s).toContain('-o ro')
    expect(mountScript('/srv/x', false)).not.toContain('-o ro')
  })

  it('refuses a non-empty mount point, and writes nothing to stdout before sshfs', () => {
    const s = mountScript('/srv/x', true)
    expect(s).toContain(`exit ${MOUNT_EXIT.notEmpty}`)
    const beforeExec = s.slice(0, s.indexOf('exec sshfs'))
    expect(beforeExec).not.toMatch(/\becho\b/)
    expect(beforeExec).toContain('mkdir -p -- "$mp" >&2')
  })

  it('checks the unmount took', () => {
    expect(unmountScript('/srv/x')).toMatch(/! mountpoint -q -- "\$mp"$/)
  })
})

describe('shared helpers', () => {
  it('suggests ~/opsmaxx/<folder name>', () => {
    expect(defaultMountpoint('/Users/me/Projects/site')).toBe('~/opsmaxx/site')
    expect(defaultMountpoint('C:\\Users\\me\\My Docs\\')).toBe('~/opsmaxx/My-Docs')
    expect(defaultMountpoint('/')).toBe('~/opsmaxx/folder')
  })

  it('refuses mount points that would cover something', () => {
    expect(mountpointProblem('~/opsmaxx/site')).toBeNull()
    expect(mountpointProblem('~')).not.toBeNull()
    expect(mountpointProblem('/')).not.toBeNull()
    expect(mountpointProblem('~/')).not.toBeNull()
    expect(mountpointProblem('a\nb')).not.toBeNull()
  })

  it('reads a damaged saved share as read-only, or not at all', () => {
    expect(
      parseShares([
        { id: 'a', localDir: '/x', mountpoint: '~/x', readOnly: 'no', autoMount: 1 },
        { id: 'b', localDir: '/y', mountpoint: '/' },
        { id: 'c', mountpoint: '~/z' },
        'junk'
      ])
    ).toEqual([{ id: 'a', localDir: '/x', mountpoint: '~/x', readOnly: true, autoMount: false }])
  })

  it('turns the failures people actually hit into a sentence and a fix', () => {
    expect(explainMountFailure(MOUNT_EXIT.noFuse, '', 'deploy')).toMatchObject({
      error: '/dev/fuse is not available on this server.',
      fix: expect.stringMatching(/Containers usually lack it/)
    })
    const denied = explainMountFailure(MOUNT_EXIT.fuseDenied, '', 'deploy').fix
    expect(denied).toMatch(/usermod -aG fuse deploy/)
    expect(denied).toMatch(/not Ubuntu or Debian/)
    expect(denied).toMatch(/close every tab to this server/)
    expect(explainMountFailure(1, 'fusermount3: mount failed: Operation not permitted', 'deploy').fix).toMatch(/containers/)
    expect(explainMountFailure(1, 'something else entirely', 'deploy').error).toBe('something else entirely')
  })
})
