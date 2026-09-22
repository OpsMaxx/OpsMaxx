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
  renamed: [string, string][] = []
  put: string[] = []
  ended = false
  // A link that has stopped answering: end() sends a close nobody acknowledges,
  // so nothing in flight ever fails on its own.
  stalled = false
  // Servers without posix-rename@openssh.com make ssh2 throw.
  posixRename = true
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
  fastPut(_local: string, remote: string, _opts: unknown, cb: Cb): void {
    this.put.push(remote)
    this.pending.push(cb)
    this.markStarted()
  }
  writeFile(_path: string, _data: string, cb: Cb): void {
    this.pending.push(cb)
  }
  ext_openssh_rename(from: string, to: string, cb: Cb): void {
    if (!this.posixRename) throw new Error('Server does not support this extended request')
    this.renamed.push([from, to])
    cb(null)
  }
  rename(from: string, to: string, cb: Cb): void {
    this.renamed.push([from, to])
    cb(null)
  }
  unlink(path: string, cb: Cb): void {
    this.unlinked.push(path)
    cb(null)
  }
  end(): void {
    this.ended = true
    if (!this.stalled) for (const cb of this.pending.splice(0)) cb(new Error('No response from server'))
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

// channels[0] is the cached channel sftpConnect opened; a transfer opens its own.
const cached = (): FakeSftp => channels[0]
const transferCh = (): FakeSftp => channels[1]

async function started(): Promise<void> {
  await vi.waitFor(() => expect(channels.length).toBeGreaterThan(1))
  await transferCh().started
}

describe('cancelling a download', () => {
  it('stops the transfer and removes the partial file', async () => {
    const run = sftpDownload(wc, KEY, ['/srv/big.iso', '/srv/next.iso'], dir)
    await started()
    expect(existsSync(join(dir, 'big.iso'))).toBe(true)

    sftpCancel(KEY)
    const r = await run

    expect(r.data?.cancelled).toBe(true)
    expect(r.data?.saved).toEqual([])
    // The half file is gone, and the queued second file never started.
    expect(readdirSync(dir)).toEqual([])
    expect(transferCh().ended).toBe(true)
  })

  it('saves under a cleaned name inside the picked folder', async () => {
    const run = sftpDownload(wc, KEY, ['/srv/..\\evil'], dir)
    await started()
    transferCh().pending.shift()?.(null)
    const r = await run
    expect(r.data?.saved).toEqual(['evil'])
    expect(readdirSync(dir)).toEqual(['evil'])
  })
})

describe('cancel touches only the transfer', () => {
  /**
   * The cached channel also carries the external editor's auto-save and the
   * inline editor's writes, and both truncate before they write. Closing it
   * to stop a download cut those off half-done.
   */
  it('leaves the shared channel, and a save in flight on it, alone', async () => {
    let saved: Error | null | undefined = undefined
    cached().writeFile('/etc/app.conf', 'x', (err) => (saved = err ?? null))

    const run = sftpDownload(wc, KEY, ['/srv/big.iso'], dir)
    await started()
    sftpCancel(KEY)
    await run

    expect(cached().ended).toBe(false)
    expect(cached().pending).toHaveLength(1)
    cached().pending.shift()?.(null)
    expect(saved).toBeNull()
  })

  it('comes back at once on a link that has stopped answering', async () => {
    const run = sftpDownload(wc, KEY, ['/srv/big.iso'], dir)
    await started()
    transferCh().stalled = true
    sftpCancel(KEY)
    const r = await Promise.race([run, new Promise((resolve) => setTimeout(() => resolve('hung'), 1000))])
    expect(r).not.toBe('hung')
    expect(readdirSync(dir)).toEqual([])
  })

  it('refuses a second transfer on the same key, and Cancel still stops the first', async () => {
    const first = sftpDownload(wc, KEY, ['/srv/big.iso'], dir)
    const second = await sftpDownload(wc, KEY, ['/srv/other.iso'], dir)
    expect(second.ok).toBe(false)
    expect(second.error).toMatch(/already running/)

    await started()
    sftpCancel(KEY)
    expect((await first).data?.cancelled).toBe(true)
  })
})

describe('uploads', () => {
  it('write to a temporary name and rename it over the target when complete', async () => {
    const local = join(dir, 'app.conf')
    writeFileSync(local, 'x')
    const run = sftpUpload(wc, KEY, [local], '/srv')
    await started()
    const tmp = transferCh().put[0]
    expect(tmp).toMatch(/^\/srv\/\.app\.conf\.opsmaxx-partial-/)
    transferCh().pending.shift()?.(null)
    const r = await run
    expect(r.data?.uploaded).toEqual(['app.conf'])
    expect(transferCh().renamed).toEqual([[tmp, '/srv/app.conf']])
  })

  it('replace the target first on a server without posix-rename', async () => {
    const local = join(dir, 'app.conf')
    writeFileSync(local, 'x')
    const run = sftpUpload(wc, KEY, [local], '/srv')
    await started()
    transferCh().posixRename = false
    transferCh().pending.shift()?.(null)
    await run
    expect(transferCh().unlinked).toEqual(['/srv/app.conf'])
    expect(transferCh().renamed).toEqual([[transferCh().put[0], '/srv/app.conf']])
  })

  it('cancelled, remove only their own temporary file and never touch the target', async () => {
    const local = join(dir, 'app.conf')
    writeFileSync(local, 'x')
    const run = sftpUpload(wc, KEY, [local], '/srv')
    await started()
    const tmp = transferCh().put[0]
    sftpCancel(KEY)
    const r = await run
    expect(r.data?.cancelled).toBe(true)
    expect(r.data?.leftover).toBeUndefined()
    // Removed over the cached channel, because the transfer's own is closing.
    expect(cached().unlinked).toEqual([tmp])
    expect([...cached().renamed, ...transferCh().renamed]).toEqual([])
    expect(transferCh().unlinked).toEqual([])
  })
})
