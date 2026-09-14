import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ssh2 is patched, and this is what notices when it is not.
//
// Certificate authentication - the whole Microsoft Entra ID login path - needs
// four lines inside ssh2 that cannot live in this repo: `Protocol.authPK` wrote
// one algorithm name into both the userauth request and the signature blob, and
// a certificate needs the certificate spelling in the first and the plain one in
// the second. The packet writers it has to sit between are module-private, so
// there is nothing to subclass or wrap. See patches/ssh2+1.17.0.patch.
//
// The failure mode without this test is nasty and quiet. An unpatched ssh2 does
// not throw: it sends a signature the server rejects, and the server answers
// "Permission denied (publickey)" - indistinguishable from a wrong credential.
// So a dependency reinstall that skipped the postinstall hook would look exactly
// like an Azure permissions problem, on a machine where nothing about Azure had
// changed.
//
// It is also genuinely easy to hit here: a git worktree shares node_modules with
// the main checkout, so an `npm ci` run from a branch that predates this feature
// reverts ssh2 for every worktree at once.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Asked of the resolver rather than assumed to be `../node_modules`: a fresh
// worktree has no node_modules of its own and resolves to the main checkout's.
const require_ = createRequire(import.meta.url)
const SSH2_DIR = dirname(require_.resolve('ssh2'))

const FIX = 'Run `npx patch-package` (or `npm ci`, which does it via postinstall).'

function ssh2Source(rel: string): string {
  const path = join(SSH2_DIR, rel)
  expect(existsSync(path), `ssh2 source not found at ${path}`).toBe(true)
  return readFileSync(path, 'utf8')
}

describe('the ssh2 certificate patch is applied', () => {
  it('separates the request algorithm from the signature algorithm', () => {
    const protocol = ssh2Source('protocol/Protocol.js')
    expect(
      protocol.includes('sigAlgo'),
      `ssh2 is NOT patched, so OpenSSH certificate authentication is broken and will fail as ` +
        `"Permission denied (publickey)" with no hint that the cause is a missing patch. ${FIX}`
    ).toBe(true)

    // The specific thing that has to be true: the signature blob names the
    // plain algorithm, derived by stripping the certificate suffix.
    expect(protocol).toMatch(/-cert-v0\[01\]@openssh\\?\.com\$/)
    expect(protocol).toMatch(/packet\.utf8Write\(sigAlgo, p \+= 4, sigAlgoLen\)/)
  })

  it('picks a SHA-2 hash for an RSA certificate', () => {
    // Without this an RSA certificate signs with the key's own default of
    // SHA-1 while the request announces SHA-2, and every current server
    // refuses it.
    const client = ssh2Source('client.js')
    expect(
      client.includes('rsa-sha2-256-cert-v01@openssh.com'),
      `ssh2's getKeyAlgos is NOT patched, so RSA certificates sign with SHA-1. ${FIX}`
    ).toBe(true)
  })

  it('still ships the patch file and the hook that applies it', () => {
    // The patch surviving in node_modules while the file that produces it has
    // been deleted would pass the two checks above and fail on the next clean
    // install, which is the worst moment to find out.
    const patch = join(ROOT, 'patches', 'ssh2+1.17.0.patch')
    expect(existsSync(patch), 'patches/ssh2+1.17.0.patch is missing').toBe(true)

    const text = readFileSync(patch, 'utf8')
    expect(text).toMatch(/lib\/protocol\/Protocol\.js/)
    expect(text).toMatch(/lib\/client\.js/)
    // Native build output leaks absolute paths from whoever generated it, and
    // this repo is public. Regenerate with:
    //   npx patch-package ssh2 --exclude 'crypto/build/'
    expect(text, 'the patch touches native build artefacts').not.toMatch(/crypto\/build\//)

    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    expect(pkg.scripts?.postinstall, 'no postinstall hook to apply the patch').toMatch(
      /patch-package/
    )
    expect(pkg.devDependencies?.['patch-package'], 'patch-package is not a devDependency').toBeTruthy()
  })

  it('pins the patch to the version that is installed', () => {
    // patch-package matches on the version in the filename and refuses to
    // apply to a different one, silently leaving certificates broken after a
    // bump. Naming it here means the bump fails a test instead.
    const installed = JSON.parse(readFileSync(join(SSH2_DIR, '..', 'package.json'), 'utf8')) as {
      version: string
    }
    expect(
      existsSync(join(ROOT, 'patches', `ssh2+${installed.version}.patch`)),
      `ssh2 is at ${installed.version} but there is no patches/ssh2+${installed.version}.patch. ` +
        `Re-cut it against the new version: npx patch-package ssh2 --exclude 'crypto/build/'`
    ).toBe(true)
  })
})
