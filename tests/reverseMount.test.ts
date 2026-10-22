import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { duplexPair } from 'node:stream'
import ssh2, { type SFTPWrapper } from 'ssh2'
import {
  MAX_HANDLES,
  MAX_PENDING,
  MAX_READ,
  confine,
  inside,
  serveShare,
  sftpOverStream,
  shareRoot
} from '../src/main/services/reverseMount'

// A folder on this machine mounted on a server is reachable by whoever holds
// that server. Read-only, confinement and the resource limits are enforced by
// the SFTP server here, so this drives it the way a remote would: ssh2's own
// SFTP client, speaking the protocol over an in-memory pipe, asking for things
// it must not get — and, on a read-write share, the ordinary things cp, touch,
// sqlite and git ask for, which it must get.

const { STATUS_CODE, OPEN_MODE } = ssh2.utils.sftp
type Err = (Error & { code?: number }) | null | undefined

let tmp: string
let share: string

async function connect(root: string, readOnly: boolean): Promise<SFTPWrapper> {
  const [here, there] = duplexPair()
  serveShare(sftpOverStream(here, true), { root: await shareRoot(root), readOnly })
  const client = sftpOverStream(there, false)
  await new Promise((r) => client.once('ready', r))
  return client
}

function code(op: (cb: (err: Err) => void) => void): Promise<number> {
  return new Promise((resolve) => op((err) => resolve(err ? (err.code ?? -1) : STATUS_CODE.OK)))
}
function failure(op: (cb: (err: Err) => void) => void): Promise<Err> {
  return new Promise((resolve) => op((err) => resolve(err)))
}

/** Open with raw SFTP flags, write `data` if any, close. Returns the status. */
async function openWrite(c: SFTPWrapper, p: string, flags: number, data?: string): Promise<number> {
  const opened = await new Promise<{ err: Err; h?: Buffer }>((resolve) =>
    c.open(p, flags, (err, h) => resolve({ err, h }))
  )
  if (opened.err) return opened.err.code ?? -1
  if (data !== undefined) {
    const buf = Buffer.from(data)
    const w = await code((cb) => c.write(opened.h!, buf, 0, buf.length, 0, cb))
    if (w !== STATUS_CODE.OK) return w
  }
  return code((cb) => c.close(opened.h!, cb))
}

let ro: SFTPWrapper

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'revmount-'))
  share = path.join(tmp, 'share')
  fs.mkdirSync(share)
  fs.writeFileSync(path.join(share, 'hello.txt'), 'hi')
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'outside')
  // Links the LOCAL user made, pointing out of the share: one at something
  // that exists, one at something that does not.
  fs.symlinkSync(tmp, path.join(share, 'out'))
  fs.symlinkSync(path.join(tmp, 'does-not-exist'), path.join(share, 'out-missing'))
  // Links that stay inside, one written with this machine's absolute path. On
  // macOS os.tmpdir() is under /var, an alias of /private/var, so this also
  // covers a target that is inside only once resolved.
  fs.mkdirSync(path.join(share, 'sub'))
  fs.symlinkSync(path.join(share, 'hello.txt'), path.join(share, 'sub', 'abs-in'))
  fs.symlinkSync('../hello.txt', path.join(share, 'sub', 'rel-in'))
  ro = await connect(share, true)
})

afterAll(() => {
  ro.end()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('reverse mount: read-only share', () => {
  it('serves reads inside the share', async () => {
    const data = await new Promise<string>((resolve, reject) =>
      ro.readFile('/hello.txt', (err, buf) => (err ? reject(err) : resolve(buf.toString())))
    )
    expect(data).toBe('hi')
  })

  it('refuses every kind of write, whatever the open flags', async () => {
    const denied = STATUS_CODE.PERMISSION_DENIED
    const { READ, WRITE, CREAT, TRUNC, EXCL, APPEND } = OPEN_MODE
    const sets = [
      WRITE,
      WRITE | CREAT,
      WRITE | CREAT | TRUNC,
      WRITE | CREAT | EXCL,
      READ | WRITE,
      READ | WRITE | CREAT,
      WRITE | APPEND,
      APPEND,
      CREAT,
      TRUNC
    ]
    for (const flags of sets) {
      expect(await openWrite(ro, '/hello.txt', flags), `flags ${flags}`).toBe(denied)
      expect(await openWrite(ro, '/new.txt', flags), `flags ${flags}`).toBe(denied)
    }
    expect(await code((cb) => ro.mkdir('/d', cb))).toBe(denied)
    expect(await code((cb) => ro.rename('/hello.txt', '/moved.txt', cb))).toBe(denied)
    expect(await code((cb) => ro.unlink('/hello.txt', cb))).toBe(denied)
    expect(await code((cb) => ro.rmdir('/sub', cb))).toBe(denied)
    expect(await code((cb) => ro.setstat('/hello.txt', { mode: 0o777 }, cb))).toBe(denied)
    expect(await code((cb) => ro.symlink('/etc', '/l', cb))).not.toBe(STATUS_CODE.OK)
    expect(fs.readdirSync(share).sort()).toEqual(['hello.txt', 'out', 'out-missing', 'sub'])
    expect(fs.readFileSync(path.join(share, 'hello.txt'), 'utf8')).toBe('hi')
  })

  it('refuses a .. escape, and one through a symlink', async () => {
    const denied = STATUS_CODE.PERMISSION_DENIED
    expect(await code((cb) => ro.open('/../secret.txt', 'r', cb))).toBe(denied)
    expect(await code((cb) => ro.open('../../secret.txt', 'r', cb))).toBe(denied)
    expect(await code((cb) => ro.stat('/a/../../secret.txt', cb))).toBe(denied)
    expect(await code((cb) => ro.realpath('/..', cb))).toBe(denied)
    expect(await code((cb) => ro.open('/out/secret.txt', 'r', cb))).toBe(denied)
    expect(await code((cb) => ro.opendir('/out', cb))).toBe(denied)
    // The link itself may be seen, just not followed.
    expect(await code((cb) => ro.lstat('/out', cb))).toBe(STATUS_CODE.OK)
  })

  it('answers the same for a link out of the share whether or not its target exists', async () => {
    // Otherwise "no such file" against "permission denied" is a way to ask
    // whether a path on this machine exists.
    const denied = STATUS_CODE.PERMISSION_DENIED
    const ops = {
      stat: (p: string) => (cb: (err: Err) => void) => ro.stat(p, cb),
      open: (p: string) => (cb: (err: Err) => void) => ro.open(p, 'r', cb),
      readlink: (p: string) => (cb: (err: Err) => void) => ro.readlink(p, cb)
    }
    for (const [name, call] of Object.entries(ops)) {
      expect(await code(call('/out')), name).toBe(name === 'stat' || name === 'open' ? denied : denied)
      expect(await code(call('/out-missing')), name).toBe(denied)
    }
    expect(await code((cb) => ro.stat('/out/secret.txt', cb))).toBe(denied)
    expect(await code((cb) => ro.stat('/out-missing/x', cb))).toBe(denied)
  })

  it('never puts a local path in a status message', async () => {
    const errs = [
      await failure((cb) => ro.open('/missing/file', 'r', cb)),
      await failure((cb) => ro.open('/out/secret.txt', 'r', cb)),
      await failure((cb) => ro.stat('/hello.txt/x', cb))
    ]
    for (const e of errs) {
      expect(e).toBeTruthy()
      expect(e!.message).not.toContain(tmp)
      expect(e!.message).not.toContain(fs.realpathSync(tmp))
      expect(e!.message).not.toContain(os.userInfo().username)
    }
  })
})

describe('reverse mount: link targets', () => {
  const readlink = (p: string): Promise<{ code: number; target?: string }> =>
    new Promise((resolve) =>
      ro.readlink(p, (err, target) =>
        resolve(err ? { code: (err as Error & { code?: number }).code ?? -1 } : { code: STATUS_CODE.OK, target })
      )
    )

  it('rewrites a target inside the share as a relative one, absolute or not', async () => {
    expect(await readlink('/sub/abs-in')).toEqual({ code: STATUS_CODE.OK, target: '../hello.txt' })
    expect(await readlink('/sub/rel-in')).toEqual({ code: STATUS_CODE.OK, target: '../hello.txt' })
  })

  it('never hands the server a path on this machine, or its length', async () => {
    const out = await readlink('/out')
    expect(out.code).toBe(STATUS_CODE.PERMISSION_DENIED)
    expect(out.target).toBeUndefined()
    const names = await new Promise<string[]>((resolve, reject) =>
      ro.readdir('/sub', (err, list) => (err ? reject(err) : resolve(list.map((e) => `${e.filename} ${e.longname}`))))
    )
    for (const n of names) {
      expect(n).not.toContain(tmp)
      expect(n).not.toContain(fs.realpathSync(tmp))
    }
    const size = await new Promise<number>((resolve, reject) =>
      ro.lstat('/sub/abs-in', (err, st) => (err ? reject(err) : resolve(st.size)))
    )
    expect(size).toBe(0)
  })
})

describe('reverse mount: read-write share', () => {
  let rwDir: string
  let rw: SFTPWrapper
  const local = (n: string): string => fs.readFileSync(path.join(rwDir, n), 'utf8')
  const { READ, WRITE, CREAT, TRUNC, EXCL, APPEND } = OPEN_MODE

  beforeAll(async () => {
    rwDir = path.join(tmp, 'rw')
    fs.mkdirSync(rwDir)
    fs.writeFileSync(path.join(rwDir, 'existing.txt'), 'old')
    rw = await connect(rwDir, false)
  })
  afterAll(() => rw.end())

  it('creates a file the way touch does (WRITE|CREAT, no TRUNC)', async () => {
    expect(await openWrite(rw, '/touched', WRITE | CREAT)).toBe(STATUS_CODE.OK)
    expect(local('touched')).toBe('')
  })
  it('copies a new file the way cp does (WRITE|CREAT|TRUNC)', async () => {
    expect(await openWrite(rw, '/copied', WRITE | CREAT | TRUNC, 'copy')).toBe(STATUS_CODE.OK)
    expect(local('copied')).toBe('copy')
  })
  it('creates exclusively (WRITE|CREAT|EXCL), and refuses when it exists', async () => {
    expect(await openWrite(rw, '/excl', WRITE | CREAT | EXCL, 'x')).toBe(STATUS_CODE.OK)
    expect(await openWrite(rw, '/excl', WRITE | CREAT | EXCL)).not.toBe(STATUS_CODE.OK)
  })
  it('opens read-write and creates, as sqlite and git do (READ|WRITE|CREAT)', async () => {
    expect(await openWrite(rw, '/db', READ | WRITE | CREAT, 'sqlite')).toBe(STATUS_CODE.OK)
    expect(local('db')).toBe('sqlite')
  })
  it('appends (WRITE|APPEND) and writes in place (WRITE)', async () => {
    expect(await openWrite(rw, '/existing.txt', WRITE | APPEND, '+more')).toBe(STATUS_CODE.OK)
    expect(local('existing.txt')).toBe('old+more')
    expect(await openWrite(rw, '/existing.txt', WRITE, 'NEW')).toBe(STATUS_CODE.OK)
    expect(local('existing.txt')).toBe('NEW+more')
  })
})

describe('reverse mount: what a hostile server cannot make it do', () => {
  it(`returns at most ${MAX_READ / 1024} KiB for one READ, however much is asked for`, async () => {
    // Driven with raw requests: ssh2's own client splits a large read itself
    // and loops on a short one, so it can never ask for too much in one go.
    const dir = fs.mkdtempSync(path.join(tmp, 'big-'))
    fs.writeFileSync(path.join(dir, 'big'), Buffer.alloc(MAX_READ * 3, 1))
    const sent: { handle?: Buffer; data?: Buffer } = {}
    const fake = Object.assign(new EventEmitter(), {
      handle: (_id: number, h: Buffer) => (sent.handle = h),
      data: (_id: number, d: Buffer) => (sent.data = d),
      status: () => {},
      end: () => {}
    })
    serveShare(fake as unknown as SFTPWrapper, { root: await shareRoot(dir), readOnly: true })
    fake.emit('OPEN', 1, '/big', OPEN_MODE.READ, {})
    await vi.waitFor(() => expect(sent.handle).toBeDefined())
    fake.emit('READ', 2, sent.handle, 0, MAX_READ * 3)
    await vi.waitFor(() => expect(sent.data).toBeDefined())
    expect(sent.data!.length).toBe(MAX_READ)
  })

  it(`stops opening handles past ${MAX_HANDLES}`, async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'handles-'))
    fs.writeFileSync(path.join(dir, 'f'), 'x')
    const c = await connect(dir, true)
    const results = await Promise.all(Array.from({ length: MAX_HANDLES + 5 }, () => code((cb) => c.open('/f', 'r', cb))))
    expect(results.filter((r) => r === STATUS_CODE.OK)).toHaveLength(MAX_HANDLES)
    expect(results.filter((r) => r === STATUS_CODE.FAILURE)).toHaveLength(5)
    c.end()
  })

  it(`hangs up on a server that queues more than ${MAX_PENDING} requests`, async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'flood-'))
    const [here, there] = duplexPair()
    serveShare(sftpOverStream(here, true), { root: await shareRoot(dir), readOnly: true })
    const c = sftpOverStream(there, false)
    await new Promise((r) => c.once('ready', r))
    const hungUp = new Promise<void>((r) => here.once('finish', () => r()))
    for (let i = 0; i < MAX_PENDING + 50; i++) c.stat('/', () => {})
    await hungUp
  })

  it('re-checks a directory handle on every READDIR, so a swapped-in link leaks nothing', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'swap-'))
    fs.mkdirSync(path.join(dir, 'd'))
    fs.writeFileSync(path.join(dir, 'd', 'a'), '1')
    const outside = fs.mkdtempSync(path.join(tmp, 'outside-'))
    fs.writeFileSync(path.join(outside, 'a'), 'secret contents, long')
    const c = await connect(dir, false)
    const h = await new Promise<Buffer>((resolve, reject) => c.opendir('/d', (e, hh) => (e ? reject(e) : resolve(hh))))
    // The remote renames the opened folder away; a link out takes its place.
    expect(await code((cb) => c.rename('/d', '/d2', cb))).toBe(STATUS_CODE.OK)
    fs.symlinkSync(outside, path.join(dir, 'd'))
    expect(await code((cb) => c.readdir(h, cb))).toBe(STATUS_CODE.PERMISSION_DENIED)
    c.end()
  })
})

describe('confine and inside', () => {
  it('maps remote paths to segments under the root, or refuses them', () => {
    expect(confine('/')).toEqual([])
    expect(confine('.')).toEqual([])
    expect(confine('/a/./b/../c')).toEqual(['a', 'c'])
    expect(confine('/..')).toBeNull()
    expect(confine('a/../..')).toBeNull()
    expect(confine('/a\\..\\..\\x')).toBeNull()
    expect(confine('/a\0b')).toBeNull()
  })

  it('works when the share is the filesystem root', () => {
    const root = path.parse(process.cwd()).root
    expect(inside(root, path.join(root, 'etc'))).toBe(true)
    expect(inside(root, root)).toBe(true)
    expect(inside('/srv/share', '/srv/share/x')).toBe(true)
    expect(inside('/srv/share', '/srv/shared')).toBe(false)
    expect(inside('/srv/share', '/srv/x')).toBe(false)
    expect(inside('/srv/share', '/srv/share/..x')).toBe(true)
  })
})
