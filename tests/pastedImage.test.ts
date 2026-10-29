import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Client } from 'ssh2'
import {
  PASTED_IMAGE_MAX_BYTES,
  isPastableImage,
  removePastedImages,
  uploadPastedImage
} from '../src/main/services/pastedImage'

// An image pasted into a remote terminal is copied to the server and its path
// pasted, because Claude Code there reads the SERVER's clipboard, never this
// one. What it does accept is a pasted absolute path matching the pattern
// below, which it reads on the spot -- copied from Claude Code's own check.
const CLAUDE_CODE_IMAGE_PATH = /\.(png|jpe?g|gif|webp)$/i

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

type Cb = (err?: Error | null) => void

function fakeServer(fail: { sftp?: boolean; mkdir?: boolean; write?: boolean } = {}): {
  client: Client
  calls: Array<[string, ...unknown[]]>
  ended: () => number
} {
  const calls: Array<[string, ...unknown[]]> = []
  let ended = 0
  const sftp = {
    mkdir: (p: string, attrs: unknown, cb: Cb) => {
      calls.push(['mkdir', p, attrs])
      cb(fail.mkdir ? new Error('Permission denied') : null)
    },
    writeFile: (p: string, data: Buffer, opts: unknown, cb: Cb) => {
      calls.push(['writeFile', p, data.byteLength, opts])
      cb(fail.write ? new Error('Failure') : null)
    },
    unlink: (p: string, cb: Cb) => {
      calls.push(['unlink', p])
      cb(null)
    },
    rmdir: (p: string, cb: Cb) => {
      calls.push(['rmdir', p])
      cb(null)
    },
    end: () => {
      ended += 1
    }
  }
  const client = {
    sftp: (cb: (err: Error | undefined, s: typeof sftp) => void) =>
      fail.sftp ? cb(new Error('subsystem request failed'), sftp) : cb(undefined, sftp)
  } as unknown as Client
  return { client, calls, ended: () => ended }
}

describe('what is copied', () => {
  it('takes PNG bytes up to the cap and nothing else', () => {
    expect(isPastableImage(PNG)).toBe(true)
    expect(isPastableImage(Buffer.from(PNG))).toBe(true)
    expect(isPastableImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0]))).toBe(false)
    expect(isPastableImage(PNG.slice(0, 8))).toBe(false)
    expect(isPastableImage('iVBORw0KGgo=')).toBe(false)
    expect(isPastableImage(null)).toBe(false)
    const big = new Uint8Array(PASTED_IMAGE_MAX_BYTES + 1)
    big.set(PNG)
    expect(isPastableImage(big)).toBe(false)
  })
})

describe('where it lands', () => {
  it('writes one 0600 file, exclusively, in a fresh 0700 directory in /tmp', async () => {
    const s = fakeServer()
    const path = await uploadPastedImage(s.client, PNG)
    expect(path).toMatch(/^\/tmp\/opsmaxx-paste-[0-9a-f]{16}\/clipboard\.png$/)
    const dir = path.slice(0, path.lastIndexOf('/'))
    expect(s.calls).toEqual([
      ['mkdir', dir, { mode: 0o700 }],
      ['writeFile', path, PNG.byteLength, { mode: 0o600, flag: 'wx' }]
    ])
    expect(s.ended()).toBe(1)
  })

  it('is a path Claude Code takes as an image, with nothing in it to quote', async () => {
    const path = await uploadPastedImage(fakeServer().client, PNG)
    expect(path).toMatch(CLAUDE_CODE_IMAGE_PATH)
    expect(path).toMatch(/^[A-Za-z0-9/._-]+$/)
  })

  it('never reuses a directory, so a name planted in /tmp is never written through', async () => {
    const a = await uploadPastedImage(fakeServer().client, PNG)
    const b = await uploadPastedImage(fakeServer().client, PNG)
    expect(a).not.toBe(b)
  })

  it('says why when the server will not take it, and leaves nothing half-written', async () => {
    const noSftp = fakeServer({ sftp: true })
    await expect(uploadPastedImage(noSftp.client, PNG)).rejects.toThrow(/does not offer SFTP/)

    const noTmp = fakeServer({ mkdir: true })
    await expect(uploadPastedImage(noTmp.client, PNG)).rejects.toThrow(/\/tmp on the server: Permission denied/)
    expect(noTmp.ended()).toBe(1)

    const noWrite = fakeServer({ write: true })
    await expect(uploadPastedImage(noWrite.client, PNG)).rejects.toThrow(/Could not write/)
    expect(noWrite.calls.at(-1)?.[0]).toBe('rmdir')
    expect(noWrite.ended()).toBe(1)
  })
})

describe('cleaning up', () => {
  it('removes each file and its directory', async () => {
    const s = fakeServer()
    await removePastedImages(s.client, ['/tmp/opsmaxx-paste-aa/clipboard.png', '/tmp/opsmaxx-paste-bb/clipboard.png'])
    expect(s.calls).toEqual([
      ['unlink', '/tmp/opsmaxx-paste-aa/clipboard.png'],
      ['rmdir', '/tmp/opsmaxx-paste-aa'],
      ['unlink', '/tmp/opsmaxx-paste-bb/clipboard.png'],
      ['rmdir', '/tmp/opsmaxx-paste-bb']
    ])
    expect(s.ended()).toBe(1)
  })

  it('does not throw when the connection is already gone', async () => {
    await expect(removePastedImages(fakeServer({ sftp: true }).client, ['/tmp/x/clipboard.png'])).resolves.toBeUndefined()
  })
})

// sessions in ssh.ts is private, so these hold the shape of the guards in place.
describe('the terminal session that owns it', () => {
  const ssh = readFileSync(resolve(__dirname, '../src/main/services/ssh.ts'), 'utf8')
  const fn = ssh.slice(ssh.indexOf('export async function sshPasteImage'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))

  it("uploads over that session's own connection and no other", () => {
    expect(body).toMatch(/const client = s\.conn\.client/)
    expect(body).not.toMatch(/acquire\(|openChain\(|sshOpenFresh\(/)
  })

  it("refuses a container shell, which cannot see the host's /tmp", () => {
    expect(ssh).toMatch(/\.\.\.\(cfg\.initialCommand \? \{ container: true \} : \{\}\)/)
    expect(body).toMatch(/if \(s\.container\) throw/)
  })

  it('removes what it pasted before handing the connection back', () => {
    const cleanup = ssh.slice(ssh.indexOf('function cleanup('))
    expect(cleanup.slice(0, cleanup.indexOf('\n}\n'))).toMatch(
      /removePastedImages\(conn\.client, s\.pastedImages\)\.finally\(\(\) => release\(conn\)\)/
    )
  })

  it('validates the bytes in main, not only in the renderer', () => {
    expect(body).toMatch(/if \(!isPastableImage\(png\)\) throw/)
  })
})
