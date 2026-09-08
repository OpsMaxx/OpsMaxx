import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import {
  isLocalFileSession,
  localFilesConnect,
  localFilesDelete,
  localFilesDisconnect,
  localFilesList,
  localFilesMkdir,
  localFilesRead,
  localFilesRename,
  localFilesUpload,
  localFilesWrite
} from '../src/main/services/localFiles'

/**
 * The Files view, backed by this machine.
 *
 * SFTP is a protocol rather than a command, so this half is a parallel
 * implementation and not a swapped transport. What the tests hold is that it
 * answers the SAME contract sftp.ts answers — same result shape, same entry
 * shape, same sort order — because the view is one component with no branch.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sp-localfiles-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('listing', () => {
  it('reports directories, files and symlinks apart', async () => {
    mkdirSync(join(dir, 'folder'))
    writeFileSync(join(dir, 'file.txt'), 'x')
    symlinkSync(join(dir, 'file.txt'), join(dir, 'link.txt'))

    const r = await localFilesList(dir)
    expect(r.ok).toBe(true)
    const byName = Object.fromEntries((r.data ?? []).map((e) => [e.name, e]))
    expect(byName['folder'].dir).toBe(true)
    expect(byName['file.txt'].dir).toBe(false)
    // lstat, not stat: a symlink is reported AS one, which is what SFTP's
    // readdir attrs give and what the view draws differently.
    expect(byName['link.txt'].link).toBe(true)
    expect(byName['link.txt'].dir).toBe(false)
  })

  // The SSH side takes this from SFTP's longname, which is the remote `ls`
  // output. An octal string beside an rwx string in the same column would read
  // as a different kind of value.
  it('spells permissions the way ls does', async () => {
    writeFileSync(join(dir, 'file.txt'), 'x', { mode: 0o644 })
    mkdirSync(join(dir, 'folder'), { mode: 0o755 })

    const r = await localFilesList(dir)
    const byName = Object.fromEntries((r.data ?? []).map((e) => [e.name, e]))
    expect(byName['file.txt'].perms).toBe('-rw-r--r--')
    expect(byName['folder'].perms).toBe('drwxr-xr-x')
  })

  it('sorts directories first, then by name', async () => {
    writeFileSync(join(dir, 'b.txt'), '')
    writeFileSync(join(dir, 'a.txt'), '')
    mkdirSync(join(dir, 'zeta'))
    mkdirSync(join(dir, 'alpha'))

    const r = await localFilesList(dir)
    expect((r.data ?? []).map((e) => e.name)).toEqual(['alpha', 'zeta', 'a.txt', 'b.txt'])
  })

  it('reports a missing directory as a failure, not an empty one', async () => {
    const r = await localFilesList(join(dir, 'nope'))
    expect(r.ok).toBe(false)
    // An empty listing would say "this folder has nothing in it", which is a
    // different and wrong statement.
    expect(r.data).toBeUndefined()
  })
})

describe('reading and writing', () => {
  it('round-trips a file', async () => {
    await localFilesWrite(join(dir, 'note.txt'), 'hello')
    const r = await localFilesRead(join(dir, 'note.txt'))
    expect(r.data).toBe('hello')
  })

  it('reports a read that failed rather than returning nothing', async () => {
    const r = await localFilesRead(join(dir, 'absent.txt'))
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('renames and deletes', async () => {
    writeFileSync(join(dir, 'from.txt'), 'x')
    expect((await localFilesRename(join(dir, 'from.txt'), join(dir, 'to.txt'))).ok).toBe(true)
    expect(readFileSync(join(dir, 'to.txt'), 'utf8')).toBe('x')
    expect((await localFilesDelete(join(dir, 'to.txt'), false)).ok).toBe(true)
  })

  it('makes one directory, not a chain', async () => {
    expect((await localFilesMkdir(join(dir, 'one'))).ok).toBe(true)
    // Matching SFTP's mkdir: silently creating the parents would hide a typo
    // in a typed path.
    expect((await localFilesMkdir(join(dir, 'a', 'b'))).ok).toBe(false)
  })

  /**
   * `rmdir`, never a recursive remove.
   *
   * SFTP's rmdir refuses a directory with anything in it, and the Files view's
   * confirmation is written for one thing going away. A recursive delete behind
   * the same button would remove a tree the user was told was a folder.
   */
  it('refuses to delete a directory that is not empty', async () => {
    mkdirSync(join(dir, 'full'))
    writeFileSync(join(dir, 'full', 'child.txt'), 'x')
    const r = await localFilesDelete(join(dir, 'full'), true)
    expect(r.ok).toBe(false)
    expect(statSync(join(dir, 'full', 'child.txt')).isFile()).toBe(true)
  })
})

describe('copying files in', () => {
  const wc = (): WebContents =>
    ({ isDestroyed: () => false, send: vi.fn() }) as unknown as WebContents

  it('copies and reports progress', async () => {
    const send = vi.fn()
    const sender = { isDestroyed: () => false, send } as unknown as WebContents
    const src = join(dir, 'src.bin')
    writeFileSync(src, Buffer.alloc(1024, 7))
    mkdirSync(join(dir, 'dest'))

    const r = await localFilesUpload(sender, 'k', [src], join(dir, 'dest'))
    expect(r.ok).toBe(true)
    expect(r.data?.uploaded).toEqual(['src.bin'])
    expect(readFileSync(join(dir, 'dest', 'src.bin')).length).toBe(1024)
    expect(send).toHaveBeenCalled()
  })

  /**
   * Copying a file onto itself truncates it to nothing, and the view cannot
   * tell that the source it was handed is already the destination.
   */
  it('refuses to copy a file over itself', async () => {
    const src = join(dir, 'same.txt')
    writeFileSync(src, 'precious')
    const r = await localFilesUpload(wc(), 'k', [src], dir)
    expect(r.ok).toBe(false)
    expect(readFileSync(src, 'utf8')).toBe('precious')
  })

  it('refuses a directory rather than failing with an opaque EISDIR', async () => {
    mkdirSync(join(dir, 'folder'))
    mkdirSync(join(dir, 'dest'))
    const r = await localFilesUpload(wc(), 'k', [join(dir, 'folder')], join(dir, 'dest'))
    expect(r.ok).toBe(false)
    expect(r.data?.failed[0].error).toMatch(/folders cannot be copied/)
  })

  it('reports what did land when one of several fails', async () => {
    const good = join(dir, 'good.txt')
    writeFileSync(good, 'ok')
    mkdirSync(join(dir, 'dest'))
    const r = await localFilesUpload(wc(), 'k', [good, join(dir, 'missing.txt')], join(dir, 'dest'))
    expect(r.ok).toBe(false)
    expect(r.data?.uploaded).toEqual(['good.txt'])
    expect(r.data?.failed.map((f) => f.name)).toEqual(['missing.txt'])
  })
})

describe('which half answers', () => {
  /**
   * Registered at connect, because every later call carries only a key and a
   * path. Sniffing a target on each one would mean trusting a value the
   * renderer could vary between calls in the same session.
   */
  it('remembers the session so later calls need no target', () => {
    expect(isLocalFileSession('k1')).toBe(false)
    const r = localFilesConnect('k1')
    expect(r.ok).toBe(true)
    expect(r.data?.home).toBeTruthy()
    expect(isLocalFileSession('k1')).toBe(true)
    localFilesDisconnect('k1')
    expect(isLocalFileSession('k1')).toBe(false)
  })

  it('does not claim a key it never opened', () => {
    localFilesConnect('mine')
    expect(isLocalFileSession('someone-elses-server-id')).toBe(false)
    localFilesDisconnect('mine')
  })
})
