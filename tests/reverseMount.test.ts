import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { duplexPair } from 'node:stream'
import ssh2, { type SFTPWrapper } from 'ssh2'
import { confine, serveShare, sftpOverStream, shareRoot } from '../src/main/services/reverseMount'

// A folder on this machine mounted on a server is reachable by whoever holds
// that server. Read-only and confinement are enforced by the SFTP server here,
// so this drives it the way a remote would: ssh2's own SFTP client, speaking
// the protocol over an in-memory pipe, asking for things it must not get.

const { STATUS_CODE } = ssh2.utils.sftp

let tmp: string
let share: string
let client: SFTPWrapper

function code(op: (cb: (err: (Error & { code?: number }) | null | undefined) => void) => void): Promise<number> {
  return new Promise((resolve) => op((err) => resolve(err ? (err.code ?? -1) : STATUS_CODE.OK)))
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'revmount-'))
  share = path.join(tmp, 'share')
  fs.mkdirSync(share)
  fs.writeFileSync(path.join(share, 'hello.txt'), 'hi')
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'outside')
  // A link the LOCAL user made, pointing out of the share.
  fs.symlinkSync(tmp, path.join(share, 'out'))

  const [here, there] = duplexPair()
  serveShare(sftpOverStream(here, true), { root: await shareRoot(share), readOnly: true })
  client = sftpOverStream(there, false)
  await new Promise((r) => client.once('ready', r))
})

afterAll(() => {
  client.end()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('reverse mount: read-only share', () => {
  it('serves reads inside the share', async () => {
    const data = await new Promise<string>((resolve, reject) =>
      client.readFile('/hello.txt', (err, buf) => (err ? reject(err) : resolve(buf.toString())))
    )
    expect(data).toBe('hi')
  })

  it('refuses every kind of write', async () => {
    const denied = STATUS_CODE.PERMISSION_DENIED
    expect(await code((cb) => client.open('/hello.txt', 'w', cb))).toBe(denied)
    expect(await code((cb) => client.open('/new.txt', 'wx', cb))).toBe(denied)
    expect(await code((cb) => client.open('/hello.txt', 'a', cb))).toBe(denied)
    expect(await code((cb) => client.mkdir('/d', cb))).toBe(denied)
    expect(await code((cb) => client.rename('/hello.txt', '/moved.txt', cb))).toBe(denied)
    expect(await code((cb) => client.unlink('/hello.txt', cb))).toBe(denied)
    expect(await code((cb) => client.setstat('/hello.txt', { mode: 0o777 }, cb))).toBe(denied)
    expect(await code((cb) => client.symlink('/etc', '/l', cb))).not.toBe(STATUS_CODE.OK)
    expect(fs.readdirSync(share).sort()).toEqual(['hello.txt', 'out'])
    expect(fs.readFileSync(path.join(share, 'hello.txt'), 'utf8')).toBe('hi')
  })

  it('refuses a .. escape, and one through a symlink', async () => {
    const denied = STATUS_CODE.PERMISSION_DENIED
    expect(await code((cb) => client.open('/../secret.txt', 'r', cb))).toBe(denied)
    expect(await code((cb) => client.open('../../secret.txt', 'r', cb))).toBe(denied)
    expect(await code((cb) => client.stat('/a/../../secret.txt', cb))).toBe(denied)
    expect(await code((cb) => client.realpath('/..', cb))).toBe(denied)
    expect(await code((cb) => client.open('/out/secret.txt', 'r', cb))).toBe(denied)
    expect(await code((cb) => client.opendir('/out', cb))).toBe(denied)
    // The link itself may be seen, just not followed.
    expect(await code((cb) => client.lstat('/out', cb))).toBe(STATUS_CODE.OK)
  })
})

describe('confine', () => {
  it('maps remote paths to segments under the root, or refuses them', () => {
    expect(confine('/')).toEqual([])
    expect(confine('.')).toEqual([])
    expect(confine('/a/./b/../c')).toEqual(['a', 'c'])
    expect(confine('/..')).toBeNull()
    expect(confine('a/../..')).toBeNull()
    expect(confine('/a\\..\\..\\x')).toBeNull()
    expect(confine('/a\0b')).toBeNull()
  })
})
