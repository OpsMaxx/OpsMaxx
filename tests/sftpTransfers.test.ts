import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import type { SshConnectConfig } from '../src/shared/ssh'

/**
 * Downloads, cancel, and the names a server gets to choose.
 *
 * The SFTP channel is a fake that does what ssh2's does in the two places that
 * matter here: fastGet/fastPut write through to the local disk and then wait,
 * and end() fails whatever is in flight with the error ssh2 raises when a
 * channel closes under a request. Nothing else about ssh2 is under test.
 */

type Cb = (err?: Error | null) => void

class FakeSftp {
  pending: Cb[] = []
  unlinked: string[] = []
  existing = new Set<string>()
  // Resolves once a transfer is mid-flight, so a test can cancel it there.
  started!: Promise<void>
  private markStarted!: () => void
  constructor() {
    this.started = new Promise((r) => (this.markStarted = r))
  }
  fastGet(_remote: string, local: string, _opts: unknown, cb: Cb): void {
    // Half a file, as a real download is when the cancel lands.
    writeFileSync(local, 'partial')
    this.pending.push(cb)
    this.markStarted()
  }
  fastPut(_local: string, _remote: string, _opts: unknown, cb: Cb): void {
    this.pending.push(cb)
    this.markStarted()
  }
  stat(path: string, cb: (err: (Error & { code?: number }) | null) => void): void {
    cb(this.existing.has(path) ? null : Object.assign(new Error('No such file'), { code: 2 }))
  }
  unlink(path: string, cb: Cb): void {
    this.unlinked.push(path)
    cb(null)
  }
  end(): void {
    for (const cb of this.pending.splice(0)) cb(new Error('No response from server'))
  }
}

let channels: FakeSftp[] = []
const client = {
  sftp: (cb: (err: Error | null, s: FakeSftp) => void) => {
    const s = new FakeSftp()
    channels.push(s)
    cb(null, s)
  },
  on: vi.fn()
}

vi.mock('../src/main/services/ssh', () => ({
  acquire: vi.fn(async () => ({ client })),
  release: vi.fn()
}))

const { sftpConnect, sftpDownload, sftpUpload, sftpCancel, sftpDisposeAll } = await import(
  '../src/main/services/sftp'
)
const { safeLocalName, reserveLocalFile } = await import('../src/main/services/transferName')

const wc = { isDestroyed: () => false, send: vi.fn() } as unknown as WebContents
const cfg = { sessionId: 's', host: 'box.example.test', port: 22, username: 'ops', cols: 80, rows: 24 } as SshConnectConfig
const KEY = 'srv-1'

let dir: string

beforeEach(async () => {
  channels = []
  dir = mkdtempSync(join(tmpdir(), 'sp-sftp-xfer-'))
  await sftpConnect(KEY, cfg)
})
afterEach(() => {
  sftpDisposeAll()
  rmSync(dir, { recursive: true, force: true })
})

describe('the names a server chooses', () => {
  it('cannot climb out of the picked folder', () => {
    expect(safeLocalName('../evil')).toBe('evil')
    expect(safeLocalName('..\\..\\Startup\\x.bat')).toBe('Startup_x.bat')
    expect(safeLocalName('a/b')).toBe('a_b')
    expect(safeLocalName('/etc/passwd')).toBe('etc_passwd')
  })

  it('loses control characters and what Windows refuses', () => {
    expect(safeLocalName('bad\u0000na\u001bme\n.txt')).toBe('badname.txt')
    expect(safeLocalName('a:b*c?.log')).toBe('a_b_c_.log')
    expect(safeLocalName('trailing. . ')).toBe('trailing')
    expect(safeLocalName('CON.txt')).toBe('_CON.txt')
  })

  it('refuses a name with nothing left in it', () => {
    for (const n of ['', '.', '..', '...', '/', '\u0001\u0002']) expect(safeLocalName(n)).toBeNull()
  })

  it('never replaces a file already in the folder', async () => {
    writeFileSync(join(dir, 'report.txt'), 'mine')
    const first = await reserveLocalFile(dir, 'report.txt')
    const second = await reserveLocalFile(dir, 'report.txt')
    expect(first).toBe(join(dir, 'report (1).txt'))
    expect(second).toBe(join(dir, 'report (2).txt'))
    expect(readFileSync(join(dir, 'report.txt'), 'utf8')).toBe('mine')
  })
})

describe('cancelling a download', () => {
  it('stops the transfer, removes the partial file and reopens the channel', async () => {
    const run = sftpDownload(wc, KEY, ['/srv/big.iso', '/srv/next.iso'], dir)
    await channels[0].started
    expect(existsSync(join(dir, 'big.iso'))).toBe(true)

    sftpCancel(KEY)
    const r = await run

    expect(r.data?.cancelled).toBe(true)
    expect(r.data?.saved).toEqual([])
    // The half file is gone, and the queued second file never started.
    expect(readdirSync(dir)).toEqual([])
    // A fresh channel on the same connection, so the next listing works.
    expect(channels).toHaveLength(2)
  })

  it('saves under a cleaned name inside the picked folder', async () => {
    const run = sftpDownload(wc, KEY, ['/srv/..\\evil'], dir)
    await channels[0].started
    channels[0].pending.shift()?.(null)
    const r = await run
    expect(r.data?.saved).toEqual(['evil'])
    expect(readdirSync(dir)).toEqual(['evil'])
  })
})

describe('cancelling an upload', () => {
  it('removes the partial remote file this upload created', async () => {
    const local = join(dir, 'new.tar')
    writeFileSync(local, 'x')
    const run = sftpUpload(wc, KEY, [local], '/srv')
    await channels[0].started
    sftpCancel(KEY)
    const r = await run
    expect(r.data?.cancelled).toBe(true)
    expect(channels[1].unlinked).toEqual(['/srv/new.tar'])
    expect(r.data?.leftover).toBeUndefined()
  })

  it('leaves a file that was there before, and says where it is', async () => {
    const local = join(dir, 'app.conf')
    writeFileSync(local, 'x')
    channels[0].existing.add('/srv/app.conf')
    const run = sftpUpload(wc, KEY, [local], '/srv')
    await channels[0].started
    sftpCancel(KEY)
    const r = await run
    expect(channels[1].unlinked).toEqual([])
    expect(r.data?.leftover).toBe('/srv/app.conf')
  })
})
