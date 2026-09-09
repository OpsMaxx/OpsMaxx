import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  localFilesRead, localFilesWrite, localFilesList, localFilesUpload, setLocalFilesProtectedRoot
} from '../src/main/services/localFiles'
import type { WebContents } from 'electron'

/**
 * The app's own data directory, and the three ways the first guard let people in.
 *
 * The vault, the access policy and the audit log all live in one directory, and
 * every constraint this app advertises is enforced by one of them — so a Files
 * view that can write there can grant itself anything, and one that can read
 * there hands over the vault. It also now holds the shell-integration snippets,
 * which a local zsh executes on every session: a write there is code execution
 * in the next shell.
 *
 * Each case below was a working bypass of the first version, confirmed against
 * the real module rather than reasoned about:
 *
 *   - CASE. `resolve()` does not case-fold and `startsWith` is case-sensitive,
 *     so on macOS and Windows the lower-cased path named the same file and was
 *     allowed. Now refused under either comparison, because this is a deny rule
 *     and refusing too much is the safe direction.
 *   - SYMLINK. `resolve()` normalises `..` but does not follow links, so a link
 *     in a writable directory resolved to itself and passed. Now the nearest
 *     existing ancestor is realpath'd, which follows every link on the way.
 *   - UPLOAD SOURCE. Only the destination was checked, so a copy OUT of the
 *     protected tree succeeded. Reading a file out discloses exactly as much as
 *     editing it in place.
 */
describe('protected data directory', () => {
  let root: string, out: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'PoCUserData-'))
    out = mkdtempSync(join(tmpdir(), 'poc-out-'))
    writeFileSync(join(root, 'vault.json'), 'SECRET')
    setLocalFilesProtectedRoot(root)
  })
  afterEach(() => {
    setLocalFilesProtectedRoot(join(tmpdir(), 'nonexistent-poc-root'))
    rmSync(root, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true })
  })

  it('case variant is refused', async () => {
    const lower = join(tmpdir(), basename(root).toLowerCase(), 'vault.json')
    expect((await localFilesRead(lower)).ok).toBe(false)
    expect((await localFilesWrite(lower, 'x')).ok).toBe(false)
  })

  it('symlink into the root is refused', async () => {
    const link = join(out, 'link')
    symlinkSync(root, link)
    expect((await localFilesRead(join(link, 'vault.json'))).ok).toBe(false)
    expect((await localFilesWrite(join(link, 'vault.json'), 'x')).ok).toBe(false)
    expect((await localFilesList(link)).ok).toBe(false)
    expect(readFileSync(join(root, 'vault.json'), 'utf8')).toBe('SECRET')
  })

  it('upload OUT of the root is refused', async () => {
    const wc = { isDestroyed: () => true, send: () => {} } as unknown as WebContents
    const r = await localFilesUpload(wc, 'k', [join(root, 'vault.json')], out)
    expect(r.ok).toBe(false)
  })

  it('a new file under a symlinked parent is refused', async () => {
    const link = join(out, 'link2')
    symlinkSync(root, link)
    expect((await localFilesWrite(join(link, 'brand-new.txt'), 'x')).ok).toBe(false)
  })

  it('still permits everything outside', async () => {
    expect((await localFilesWrite(join(out, 'fine.txt'), 'ok')).ok).toBe(true)
  })
})
