import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { duplexPair, type Duplex } from 'node:stream'
import {
  autoMount,
  listMounts,
  mountScript,
  mountShare,
  notePickedFolder,
  onMountsChanged,
  sftpOverStream,
  syncShares,
  unmountScript,
  unmountServer,
  unmountShare
} from '../src/main/services/reverseMount'
import {
  MOUNT_EXIT,
  defaultMountpoint,
  explainMountFailure,
  mountpointProblem,
  parseShares,
  type LocalShare,
  type MountStatus
} from '../src/shared/localMounts'
import type { PooledConnection } from '../src/main/services/ssh'

// The mount manager, driven against a fake connection: `exec` of the sshfs
// command hands back one end of a pipe and this test speaks SFTP on the other,
// as sshfs would; every other command "runs" and exits with the code the test
// chose. What it proves is the bookkeeping a person sees in the Files view —
// states, the reference held on the connection, the unmount command — and the
// two rules that are not visible anywhere: a folder nobody picked cannot be
// mounted, and an auto-mount failure is recorded rather than thrown.

interface Fake {
  conn: PooledConnection
  cmds: string[]
  /** Exit code for the sshfs command itself; null means "start and stay up". */
  sshfsExit: number | null
}

function fakeConn(): Fake {
  const fake: Fake = { conn: null as unknown as PooledConnection, cmds: [], sshfsExit: null }
  const channel = (): Duplex & { stderr: EventEmitter; close: () => void } => {
    const [mine, theirs] = duplexPair()
    theirs.resume()
    return Object.assign(mine, { stderr: new EventEmitter(), close: () => mine.destroy() })
  }
  const client = {
    exec(cmd: string, cb: (err: Error | undefined, ch: unknown) => void) {
      fake.cmds.push(cmd)
      if (cmd.startsWith('sh -c')) {
        const [mine, theirs] = duplexPair()
        const ch = Object.assign(mine, { stderr: new EventEmitter(), close: () => mine.destroy() })
        cb(undefined, ch)
        if (fake.sshfsExit !== null) {
          const code = fake.sshfsExit
          setImmediate(() => ch.emit('close', code))
        } else {
          // Be sshfs: open the SFTP session on our end of the pipe.
          sftpOverStream(theirs, false)
        }
        return
      }
      const ch = channel()
      cb(undefined, ch)
      setImmediate(() => ch.emit('close', 0))
    }
  }
  fake.conn = { key: 'k', id: 'i', host: 'host-1', username: 'deploy', client, refs: 1 } as unknown as PooledConnection
  return fake
}

let tmp: string
const events: MountStatus[][] = []

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localmounts-'))
  onMountsChanged((_id, list) => events.push(list))
})

afterAll(async () => {
  await unmountServer('srv-a')
  await unmountServer('srv-b')
  fs.rmSync(tmp, { recursive: true, force: true })
})

const share = (dir: string, over: Partial<LocalShare> = {}): LocalShare => ({
  id: `sh-${path.basename(dir)}`,
  localDir: dir,
  mountpoint: `~/opsmaxx/${path.basename(dir)}`,
  readOnly: true,
  autoMount: false,
  ...over
})

describe('the mount manager', () => {
  it('will not mount a folder that was neither picked nor saved', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'unpicked-'))
    const fake = fakeConn()
    const reply = await mountShare('srv-a', fake.conn, share(dir))
    expect(reply.ok).toBe(false)
    expect(fake.cmds).toEqual([])
    expect(listMounts('srv-a')).toEqual([])
  })

  it('mounts, reports each state, holds the connection, and unmounts with fusermount', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'picked-'))
    notePickedFolder(dir)
    const fake = fakeConn()
    events.length = 0

    const reply = await mountShare('srv-a', fake.conn, share(dir))
    expect(reply).toEqual({ ok: true })
    expect(events.map((l) => l[0]?.state)).toEqual(['mounting', 'mounted'])
    expect(fake.conn.refs).toBe(2)

    // Asking again — another pane connecting — does nothing new.
    const before = fake.cmds.length
    expect(await mountShare('srv-a', fake.conn, share(dir))).toEqual({ ok: true })
    expect(fake.cmds.length).toBe(before)

    expect(await unmountShare('srv-a', share(dir).mountpoint)).toBe(true)
    expect(fake.cmds.at(-1)).toBe(unmountScript(share(dir).mountpoint))
    expect(fake.cmds.at(-1)).toContain('fusermount')
    expect(fake.conn.refs).toBe(1)
    expect(listMounts('srv-a')).toEqual([])
  })

  it('auto-mounts saved shares on connect, and records a failure instead of throwing', async () => {
    const good = fs.mkdtempSync(path.join(tmp, 'auto-'))
    const manual = fs.mkdtempSync(path.join(tmp, 'manual-'))
    syncShares({
      servers: [
        {
          id: 'srv-b',
          shares: [share(good, { autoMount: true }), share(manual, { autoMount: false })]
        }
      ]
    })
    const fake = fakeConn()
    fake.sshfsExit = MOUNT_EXIT.noSshfs
    autoMount('srv-b', fake.conn)
    await new Promise((r) => setTimeout(r, 50))

    const list = listMounts('srv-b')
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ localDir: good, state: 'failed', error: 'sshfs is not installed on this server.' })
    expect(list[0].fix).toMatch(/apt install sshfs/)
    expect(fake.conn.refs).toBe(1)

    // A saved share counts as chosen: it mounts once the server can.
    fake.sshfsExit = null
    autoMount('srv-b', fake.conn)
    await new Promise((r) => setTimeout(r, 50))
    expect(listMounts('srv-b')[0].state).toBe('mounted')
    await unmountServer('srv-b')
    expect(listMounts('srv-b')).toEqual([])
    expect(fake.conn.refs).toBe(1)
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
    // Every command before `exec` sends its output to stderr or /dev/null:
    // stdout is the SFTP stream.
    expect(beforeExec).not.toMatch(/\becho\b/)
    expect(beforeExec).toContain('mkdir -p -- "$mp" >&2')
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
    expect(explainMountFailure(MOUNT_EXIT.fuseDenied, '', 'deploy').fix).toMatch(/usermod -aG fuse deploy/)
    expect(explainMountFailure(1, 'fusermount3: mount failed: Operation not permitted', 'deploy').fix).toMatch(
      /containers/
    )
    expect(explainMountFailure(1, 'something else entirely', 'deploy').error).toBe('something else entirely')
  })
})
