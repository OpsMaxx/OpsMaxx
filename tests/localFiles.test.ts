import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
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
  localFilesWrite,
  setLocalFilesProtectedRoot
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

/**
 * The app's own data directory is off limits.
 *
 * The module header names the stakes: the vault, the access policy and the
 * audit log are files on this disk, and every constraint the app advertises is
 * enforced by one of them. A Files view that can rewrite the policy store can
 * grant itself anything; one that can truncate the audit log can do it
 * unobserved. Nobody edits those through a file browser on purpose, so refusing
 * them costs nothing real.
 *
 * The root is injected, so these tests point it at a temp directory rather than
 * needing a stubbed Electron.
 */
describe('protected data directory', () => {
  let root: string
  let outside: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'om-protected-'))
    outside = mkdtempSync(join(tmpdir(), 'om-outside-'))
    writeFileSync(join(root, 'vault.json'), '{"sealed":true}')
    setLocalFilesProtectedRoot(root)
  })

  afterEach(() => {
    // Back to unrestricted, so the rest of the file keeps its own behaviour.
    setLocalFilesProtectedRoot(tmpdir() + '/om-nonexistent-protected-root')
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('refuses to write a file inside it', async () => {
    const r = await localFilesWrite(join(root, 'vault.json'), 'tampered')
    expect(r.ok).toBe(false)
    // And genuinely did not write.
    expect(readFileSync(join(root, 'vault.json'), 'utf8')).toBe('{"sealed":true}')
  })

  it('refuses to read, list, delete, rename into, or copy into it', async () => {
    expect((await localFilesRead(join(root, 'vault.json'))).ok).toBe(false)
    expect((await localFilesList(root)).ok).toBe(false)
    expect((await localFilesDelete(join(root, 'vault.json'), false)).ok).toBe(false)
    expect((await localFilesRename(join(outside, 'a'), join(root, 'b'))).ok).toBe(false)
    expect((await localFilesMkdir(join(root, 'sub'))).ok).toBe(false)
  })

  // Resolution happens before the check, so a walk lands where it points.
  it('refuses a path that traverses back into it', async () => {
    const sneaky = join(root, '..', basename(root), 'vault.json')
    expect((await localFilesWrite(sneaky, 'tampered')).ok).toBe(false)
    expect(readFileSync(join(root, 'vault.json'), 'utf8')).toBe('{"sealed":true}')
  })

  // A sibling whose name merely starts the same is not inside it.
  it('does not refuse a sibling directory with a similar name', async () => {
    const sibling = `${root}-backup`
    mkdirSync(sibling, { recursive: true })
    try {
      expect((await localFilesWrite(join(sibling, 'notes.txt'), 'fine')).ok).toBe(true)
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })

  it('leaves everything outside it alone', async () => {
    expect((await localFilesWrite(join(outside, 'notes.txt'), 'fine')).ok).toBe(true)
    expect((await localFilesRead(join(outside, 'notes.txt'))).data).toBe('fine')
  })
})
