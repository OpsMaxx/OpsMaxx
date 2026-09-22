import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/**
 * The server's files, shared by every channel as a real server's are. Only
 * what the upload path inspects: mode, owner, and whether it is a link.
 */
interface RemoteNode {
  mode: number
  uid: number
  gid: number
  link?: string
}
let remote = new Map<string, RemoteNode>()
// Folders the uploader may not create files in.
let readonlyDirs = new Set<string>()
// Whether this user may chown (they may not, unless root).
let chownDenied = false
// What fchmod and fstat answer: a server with no POSIX modes says unsupported.
let attrError: Error | null = null
const ME = { uid: 1000, gid: 1000 }
const sftpError = (code: number, message: string): Error => Object.assign(new Error(message), { code })
const statsOf = (n: RemoteNode): object => ({
  mode: (n.link ? 0o120000 : 0o100000) | n.mode,
  uid: n.uid,
  gid: n.gid,
  isSymbolicLink: () => !!n.link
})
const parent = (p: string): string => p.slice(0, p.lastIndexOf('/')) || '/'

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
  got: string[] = []
  // The local path turns into a directory and the transfer fails, so removing
  // the partial throws — the case that used to end the whole batch.
  poisonGet = false
  fastGet(_remote: string, local: string, _opts: unknown, cb: Cb): void {
    this.got.push(local)
    if (this.poisonGet) {
      rmSync(local, { force: true })
      mkdirSync(local)
      return cb(new Error('Failure'))
    }
    // Half a file, as a real download is when the cancel lands.
    writeFileSync(local, 'partial')
    this.pending.push(cb)
    this.markStarted()
  }
  fastPut(_local: string, path: string, _opts: unknown, cb: Cb): void {
    // Opens with 'w': an existing file keeps its mode and owner.
    if (!remote.has(path)) remote.set(path, { mode: 0o644, ...ME })
    this.put.push(path)
    this.pending.push(cb)
    this.markStarted()
  }
  writeFile(_path: string, _data: string, cb: Cb): void {
    this.pending.push(cb)
  }
  ext_openssh_rename(from: string, to: string, cb: Cb): void {
    if (!this.posixRename) throw new Error('Server does not support this extended request')
    this.renamed.push([from, to])
    this.move(from, to)
    cb(null)
  }
  private move(from: string, to: string): void {
    const n = remote.get(from)
    remote.delete(from)
    if (n) remote.set(to, n)
  }
  lstat(path: string, cb: (err: Error | null, s?: object) => void): void {
    const n = remote.get(path)
    if (n) cb(null, statsOf(n))
    else cb(sftpError(2, 'No such file'))
  }
  readlink(path: string, cb: (err: Error | null, l?: string) => void): void {
    cb(null, remote.get(path)?.link)
  }
  open(path: string, _flags: string, cb: (err: Error | null, h?: Buffer) => void): void {
    if (readonlyDirs.has(parent(path))) return cb(sftpError(3, 'Permission denied'))
    if (remote.has(path)) return cb(sftpError(4, 'Failure'))
    remote.set(path, { mode: 0o644, ...ME })
    cb(null, Buffer.from(path))
  }
  fchmod(h: Buffer, mode: number, cb: Cb): void {
    if (attrError) return cb(attrError)
    const n = remote.get(h.toString())
    if (n) n.mode = mode
    cb(null)
  }
  fstat(h: Buffer, cb: (err: Error | null, s?: object) => void): void {
    if (attrError) return cb(attrError)
    const n = remote.get(h.toString())
    if (n) cb(null, statsOf(n))
    else cb(sftpError(2, 'No such file'))
  }
  fchown(h: Buffer, uid: number, gid: number, cb: Cb): void {
    if (chownDenied) return cb(sftpError(3, 'Permission denied'))
    Object.assign(remote.get(h.toString()) ?? {}, { uid, gid })
    cb(null)
  }
  close(_h: Buffer, cb: Cb): void {
    cb(null)
  }
  // Per-call outcomes for plain rename, in order; absent means success.
  renameErrors: (Error | null)[] = []
  // Holds plain renames until the test releases them, to cancel mid-swap.
  held: (() => void)[] | null = null
  rename(from: string, to: string, cb: Cb): void {
    this.renamed.push([from, to])
    const scripted = this.renameErrors.shift() ?? null
    const run = (): void => {
      if (scripted) return cb(scripted)
      if (!remote.has(from)) return cb(sftpError(2, 'No such file'))
      // Plain SFTP rename will not replace an existing file.
      if (remote.has(to)) return cb(sftpError(4, 'Failure'))
      this.move(from, to)
      cb(null)
    }
    if (this.held) this.held.push(run)
    else run()
  }
  unlink(path: string, cb: Cb): void {
    this.unlinked.push(path)
    remote.delete(path)
    cb(null)
  }
  end(): void {
    this.ended = true
    if (!this.stalled) for (const cb of this.pending.splice(0)) cb(new Error('No response from server'))
  }
}

let channels: FakeSftp[] = []
// Set to make the next channel open fail the way sshd's MaxSessions does.
let refuseChannel = false
const client = {
  sftp: (cb: (err: Error | null, s?: FakeSftp) => void) => {
    if (refuseChannel) return cb(new Error('(SSH) Channel open failure: open failed'))
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
const { safeLocalName, reserveLocalFile, tempName } = await import('../src/main/services/transferName')

const wc = { isDestroyed: () => false, send: vi.fn() } as unknown as WebContents
const cfg = { sessionId: 's', host: 'box.example.test', port: 22, username: 'ops', cols: 80, rows: 24 } as SshConnectConfig
const KEY = 'srv-1'

let dir: string

beforeEach(async () => {
  channels = []
  refuseChannel = false
  remote = new Map()
  readonlyDirs = new Set()
  chownDenied = false
  attrError = null
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

  it('loses C1 controls and format characters that disguise a name', () => {
    // U+202E makes this display as invoiceexe.jpg in a file manager.
    expect(safeLocalName('invoice\u202Egpj.exe')).toBe('invoicegpj.exe')
    expect(safeLocalName('a\u200Bb\u0085c\u009f.txt')).toBe('abc.txt')
    // Every bidi embedding, override and isolate, and the other zero-widths.
    expect(safeLocalName('\u202Ai\u202Bn\u202Cv\u2066o\u2067i\u2068c\u2069e\u200C\u200D\uFEFF.pdf')).toBe('invoice.pdf')
  })

  it('prefixes every Windows device name', () => {
    for (const n of ['COM¹', 'COM⁹', 'lpt³.log', 'CONIN$', 'conout$.txt', 'nul', 'NUL .txt'])
      expect(safeLocalName(n)).toBe(`_${n}`)
    // Trailing dots and spaces are what Windows strips, so CON. is CON.
    expect(safeLocalName('CON. ')).toBe('_CON')
    expect(safeLocalName('console.log')).toBe('console.log')
  })

  it('refuses a name with nothing left in it', () => {
    for (const n of ['', '.', '..', '...', '/', '\u0001\u0002']) expect(safeLocalName(n)).toBeNull()
  })

  // The temporary name must not push a long name past the 255-byte limit.
  it('keeps temporary names short whatever the name', () => {
    const long = 'x'.repeat(240) + '.tar.gz'
    expect(Buffer.byteLength(tempName(long))).toBeLessThan(80)
    expect(Buffer.byteLength(tempName('😀'.repeat(100), 'old'))).toBeLessThan(250)
    expect(tempName('a.txt')).toMatch(/^\.a\.txt\.opx-part-[0-9a-f]{16}$/)
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

describe('downloads', () => {
  // fastGet opens its destination by path with 'w', which follows a symlink
  // swapped in for the reserved file. It writes to a fresh unpredictable name
  // instead, which is then renamed over the reservation.
  it('never hand fastGet the reserved path', async () => {
    const run = sftpDownload(wc, KEY, ['/srv/report.pdf'], dir)
    await started()
    expect(transferCh().got[0]).toMatch(/\.report\.pdf\.opx-part-/)
    transferCh().pending.shift()?.(null)
    expect((await run).data?.saved).toEqual(['report.pdf'])
    expect(readFileSync(join(dir, 'report.pdf'), 'utf8')).toBe('partial')
    expect(readdirSync(dir)).toEqual(['report.pdf'])
  })

  it('carry on with the batch when a partial file cannot be removed', async () => {
    const run = sftpDownload(wc, KEY, ['/srv/a.bin', '/srv/b.bin'], dir)
    await vi.waitFor(() => expect(channels.length).toBeGreaterThan(1))
    transferCh().poisonGet = true
    const r = await run
    expect(transferCh().got).toHaveLength(2)
    expect(r.data?.failed.map((f) => f.name)).toEqual(['a.bin', 'b.bin'])
    // And what could not be removed is named, not left to be found.
    expect(r.data?.leftover).toEqual(transferCh().got)
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

  // The stop race returns before fastGet settles, so a write already on its
  // way can recreate the partial after it was removed. It is removed again.
  it('removes a partial file the cut-off transfer writes after the cancel', async () => {
    const run = sftpDownload(wc, KEY, ['/srv/big.iso'], dir)
    await started()
    const ch = transferCh()
    ch.stalled = true
    sftpCancel(KEY)
    await run
    expect(readdirSync(dir)).toEqual([])

    writeFileSync(ch.got[0], 'late')
    ch.pending.shift()?.(new Error('No response from server'))
    await vi.waitFor(() => expect(readdirSync(dir)).toEqual([]))
  })

  it('says the session limit, not a raw channel error, when the server refuses a channel', async () => {
    refuseChannel = true
    const r = await sftpDownload(wc, KEY, ['/srv/big.iso'], dir)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/session limit/)
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
    expect(tmp).toMatch(/^\/srv\/\.app\.conf\.opx-part-[0-9a-f]{16}$/)
    transferCh().pending.shift()?.(null)
    const r = await run
    expect(r.data?.uploaded).toEqual(['app.conf'])
    expect(transferCh().renamed).toEqual([[tmp, '/srv/app.conf']])
  })

  /**
   * Without posix-rename, plain SFTP rename will not replace a file. Deleting
   * the target first and then renaming loses BOTH copies if the rename fails,
   * so the old file is moved aside, the upload renamed in, and only then is
   * the old one deleted.
   */
  describe('on a server without posix-rename', () => {
    async function swap(prepare: (ch: FakeSftp) => void): Promise<{ ch: FakeSftp; tmp: string; r: Awaited<ReturnType<typeof sftpUpload>> }> {
      const local = join(dir, 'app.conf')
      writeFileSync(local, 'x')
      remote.set('/srv/app.conf', { mode: 0o644, ...ME })
      const run = sftpUpload(wc, KEY, [local], '/srv')
      await started()
      const ch = transferCh()
      ch.posixRename = false
      prepare(ch)
      ch.pending.shift()?.(null)
      const r = await run
      return { ch, tmp: ch.put[0], r }
    }
    const old = (ch: FakeSftp): string => ch.renamed[0][1]

    it('moves the old file aside, renames the upload in, then deletes the old one', async () => {
      const { ch, tmp, r } = await swap(() => {})
      expect(r.data?.uploaded).toEqual(['app.conf'])
      expect(old(ch)).toMatch(/^\/srv\/\.app\.conf\.opx-old-/)
      expect(ch.renamed).toEqual([
        ['/srv/app.conf', old(ch)],
        [tmp, '/srv/app.conf']
      ])
      expect(ch.unlinked).toEqual([old(ch)])
    })

    it('puts the old file back when the upload cannot be renamed in', async () => {
      const { ch, tmp, r } = await swap((ch) => (ch.renameErrors = [null, new Error('Failure')]))
      expect(ch.renamed[2]).toEqual([old(ch), '/srv/app.conf'])
      // The old file is back, so the upload's temporary copy is ordinary cleanup.
      expect(ch.unlinked).toEqual([tmp])
      expect(r.data?.failed.map((f) => f.name)).toEqual(['app.conf'])
      expect(r.data?.leftover).toBeUndefined()
    })

    it('deletes nothing, and names both files, when the old one cannot be put back', async () => {
      const { ch, tmp, r } = await swap((ch) => (ch.renameErrors = [null, new Error('Failure'), new Error('Failure')]))
      expect(ch.unlinked).toEqual([])
      expect(cached().unlinked).toEqual([])
      expect(r.data?.leftover).toEqual([tmp, old(ch)])
      expect(r.data?.failed[0].error).toContain(old(ch))
      expect(r.data?.failed[0].error).toContain(tmp)
    })

    // The swap is the commit point. A cancel that lands inside it is honoured
    // after it, not by closing the channel between "moved aside" and
    // "renamed in" — which left the user's file under a name they never saw.
    it('finishes the swap when Cancel lands in the middle of it', async () => {
      const local = join(dir, 'app.conf')
      writeFileSync(local, 'x')
      remote.set('/srv/app.conf', { mode: 0o644, ...ME })
      const run = sftpUpload(wc, KEY, [local], '/srv')
      await started()
      const ch = transferCh()
      ch.posixRename = false
      ch.held = []
      ch.pending.shift()?.(null)
      await vi.waitFor(() => expect(ch.held).toHaveLength(1))

      sftpCancel(KEY)
      expect(ch.ended).toBe(false)
      ch.held.shift()?.()
      await vi.waitFor(() => expect(ch.held).toHaveLength(1))
      ch.held.shift()?.()
      const r = await run

      expect(ch.renamed).toEqual([
        ['/srv/app.conf', old(ch)],
        [ch.put[0], '/srv/app.conf']
      ])
      expect(r.data?.uploaded).toEqual(['app.conf'])
      expect(r.data?.cancelled).toBe(true)
      // Nothing but the moved-aside old file was deleted, and only after.
      expect(ch.unlinked).toEqual([old(ch)])
      expect(cached().unlinked).toEqual([])
      expect(ch.ended).toBe(true)
    })
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
    // Removed over the cached channel, because the transfer's own is closing —
    // and again once the cut-off put settles, in case it created the file late.
    expect(new Set(cached().unlinked)).toEqual(new Set([tmp]))
    expect([...cached().renamed, ...transferCh().renamed]).toEqual([])
    expect(transferCh().unlinked).toEqual([])
  })
})

/**
 * What the old in-place write kept, and a rename does not.
 *
 * Writing into the target preserved its mode and owner, wrote THROUGH a
 * symlink, and needed only the file to be writable. A temp-then-rename swap
 * loses all three unless it is made to keep them.
 */
describe('what an upload keeps of the file it replaces', () => {
  async function upload(name: string, dirPath: string, inPlace?: string[]): Promise<Awaited<ReturnType<typeof sftpUpload>>> {
    const local = join(dir, name)
    writeFileSync(local, 'new')
    const before = channels.length
    const run = sftpUpload(wc, KEY, [local], dirPath, inPlace)
    // Let each put complete as soon as it starts.
    await vi.waitFor(() => expect(channels.length).toBeGreaterThan(before))
    const ch = channels[before]
    const tick = setInterval(() => ch.pending.shift()?.(null), 1)
    try {
      return await run
    } finally {
      clearInterval(tick)
    }
  }

  it('keeps the permissions, so a 0755 script stays executable', async () => {
    remote.set('/srv/deploy.sh', { mode: 0o755, ...ME })
    const r = await upload('deploy.sh', '/srv')
    expect(r.data?.uploaded).toEqual(['deploy.sh'])
    expect(remote.get('/srv/deploy.sh')?.mode).toBe(0o755)
  })

  it('keeps the owner and group when they can be given', async () => {
    remote.set('/srv/app.conf', { mode: 0o640, uid: 1000, gid: 33 })
    await upload('app.conf', '/srv')
    expect(remote.get('/srv/app.conf')).toMatchObject({ mode: 0o640, uid: 1000, gid: 33 })
  })

  it('asks rather than silently taking ownership when they cannot', async () => {
    remote.set('/srv/app.conf', { mode: 0o644, uid: 0, gid: 0 })
    chownDenied = true
    const r = await upload('app.conf', '/srv')
    expect(r.data?.needsInPlace).toEqual([{ name: 'app.conf', reason: 'owner' }])
    expect(r.data?.uploaded).toEqual([])
    // Nothing was sent, and nothing is left behind.
    expect(transferCh().put).toEqual([])
    expect([...remote.keys()]).toEqual(['/srv/app.conf'])
  })

  it('overwrites in place, keeping the owner, once the user agrees', async () => {
    remote.set('/srv/app.conf', { mode: 0o644, uid: 0, gid: 0 })
    chownDenied = true
    const r = await upload('app.conf', '/srv', ['app.conf'])
    expect(r.data?.uploaded).toEqual(['app.conf'])
    expect(transferCh().put).toEqual(['/srv/app.conf'])
    expect(remote.get('/srv/app.conf')).toMatchObject({ uid: 0, gid: 0 })
  })

  it('writes through a symlink instead of replacing it', async () => {
    remote.set('/etc/nginx/sites-enabled/foo', { mode: 0o777, ...ME, link: '../sites-available/foo' })
    remote.set('/etc/nginx/sites-available/foo', { mode: 0o644, ...ME })
    const r = await upload('foo', '/etc/nginx/sites-enabled')
    expect(r.data?.uploaded).toEqual(['foo'])
    expect(remote.get('/etc/nginx/sites-enabled/foo')?.link).toBe('../sites-available/foo')
    expect(transferCh().renamed.at(-1)?.[1]).toBe('/etc/nginx/sites-available/foo')
    // The temporary file went beside the real file, not beside the link.
    expect(transferCh().put[0]).toMatch(/^\/etc\/nginx\/sites-available\/\.foo\.opx-part-/)
  })

  it('asks before overwriting in place when the folder is not writable', async () => {
    remote.set('/srv/app.conf', { mode: 0o644, ...ME })
    readonlyDirs.add('/srv')
    const r = await upload('app.conf', '/srv')
    expect(r.data?.needsInPlace).toEqual([{ name: 'app.conf', reason: 'dir' }])
    expect(r.data?.failed).toEqual([])
    const again = await upload('app.conf', '/srv', ['app.conf'])
    expect(again.data?.uploaded).toEqual(['app.conf'])
  })

  it('reports an in-place overwrite that was cancelled as possibly incomplete', async () => {
    remote.set('/srv/app.conf', { mode: 0o644, ...ME })
    const local = join(dir, 'app.conf')
    writeFileSync(local, 'new')
    const run = sftpUpload(wc, KEY, [local], '/srv', ['app.conf'])
    await started()
    sftpCancel(KEY)
    const r = await run
    expect(r.data?.incomplete).toEqual(['/srv/app.conf'])
    expect(remote.has('/srv/app.conf')).toBe(true)
  })

  // Some Windows OpenSSH builds support neither. Nothing to keep there, so
  // asking about every overwrite would be noise.
  it('swaps as usual on a server that does not support modes at all', async () => {
    remote.set('/srv/app.conf', { mode: 0o644, ...ME })
    attrError = sftpError(8, 'Operation unsupported')
    const r = await upload('app.conf', '/srv')
    expect(r.data?.uploaded).toEqual(['app.conf'])
    expect(r.data?.needsInPlace).toBeUndefined()
  })

  it('still asks when setting the mode is refused', async () => {
    remote.set('/srv/app.conf', { mode: 0o644, ...ME })
    attrError = sftpError(3, 'Permission denied')
    const r = await upload('app.conf', '/srv')
    expect(r.data?.needsInPlace).toEqual([{ name: 'app.conf', reason: 'owner' }])
  })

  // posix.resolve would fill a relative path in from this machine's cwd.
  it('refuses a relative destination folder', async () => {
    const local = join(dir, 'a.txt')
    writeFileSync(local, 'x')
    const r = await sftpUpload(wc, KEY, [local], 'srv')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not an absolute path/)
    expect(channels).toHaveLength(1)
  })
})

