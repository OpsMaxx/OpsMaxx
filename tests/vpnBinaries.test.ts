import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  resetBinaryCache,
  resolveBundled,
  resolveEngineBinary,
  resolveSystem,
  sha256File,
  tooOld
} from '../src/main/services/vpn/binaries'
import { isVpnError } from '../src/main/services/vpn/errors'

const PLATFORM_DIR = `${process.platform}-${process.arch}`
const NETD = process.platform === 'win32' ? 'opsmaxx-netd.exe' : 'opsmaxx-netd'
const SHIM = '#!/bin/sh\necho "OpenVPN 2.6.99 fixture"\n'

let root: string
let binRoot: string
let previousBinDir: string | undefined
let previousPath: string | undefined
let platformDescriptor: PropertyDescriptor | undefined

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function writeManifest(entries: Record<string, { sha256: string; size?: number }>): void {
  writeFileSync(join(binRoot, 'manifest.json'), JSON.stringify({ version: '0.1.0', binaries: entries }))
}

function stubPlatform(value: NodeJS.Platform): void {
  platformDescriptor ??= Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

/** An executable that answers `--version`, so the resolver's version probe has
 *  something real to read rather than a mock of itself. */
function writeShim(dir: string, name: string): string {
  const file = join(dir, name)
  writeFileSync(file, SHIM)
  chmodSync(file, 0o755)
  return file
}

// A private scratch root for binary fixtures. `.tmp-tests` is gitignored via
// the repo's existing ignore of build output; it is removed after each case.
const SANDBOX = resolve(__dirname, '..', '.tmp-tests')

beforeEach(() => {
  // Not under os.tmpdir(). On Linux that is /tmp, which is world-writable, and
  // `resolveSystem` correctly refuses any binary with a world-writable
  // ancestor — so a fixture placed there exercises the rejection path rather
  // than the resolution path the test is named for. It passed on macOS only
  // because mkdtemp there lands in a per-user /var/folders directory.
  //
  // A directory the test creates itself, beside the repo, is private enough
  // for the rule and identical on every platform.
  mkdirSync(SANDBOX, { recursive: true })
  root = mkdtempSync(join(SANDBOX, 'sp-bin-'))
  binRoot = join(root, 'bin')
  mkdirSync(join(binRoot, PLATFORM_DIR), { recursive: true })
  previousBinDir = process.env.OPSMAXX_VPN_BIN_DIR
  previousPath = process.env.PATH
  process.env.OPSMAXX_VPN_BIN_DIR = binRoot
  resetBinaryCache()
})

afterEach(() => {
  if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
  platformDescriptor = undefined
  if (previousBinDir === undefined) delete process.env.OPSMAXX_VPN_BIN_DIR
  else process.env.OPSMAXX_VPN_BIN_DIR = previousBinDir
  if (previousPath === undefined) delete process.env.PATH
  else process.env.PATH = previousPath
  resetBinaryCache()
  rmSync(root, { recursive: true, force: true })
})

describe('bundled binary integrity', () => {
  it('accepts a binary whose hash matches the manifest', async () => {
    const body = 'not really a sidecar, but it hashes just as well'
    const file = writeShim(join(binRoot, PLATFORM_DIR), NETD)
    writeFileSync(file, body)
    writeManifest({ [`${PLATFORM_DIR}/${NETD}`]: { sha256: hash(body), size: body.length } })

    const info = await resolveBundled('opsmaxx-netd')
    expect(info.available).toBe(true)
    expect(info.bundled).toBe(true)
    expect(info.kind).toBe('wireguard')
    expect(info.path).toBe(file)
    expect(info.sha256).toBe(await sha256File(file))
  })

  it('refuses a binary whose bytes disagree with the manifest', async () => {
    const file = join(binRoot, PLATFORM_DIR, NETD)
    writeFileSync(file, 'the bytes we expected')
    writeManifest({ [`${PLATFORM_DIR}/${NETD}`]: { sha256: hash('the bytes we expected') } })
    // Tampered after the manifest was written, which is exactly the case the
    // per-run verification exists to catch (E42).
    writeFileSync(file, 'the bytes we got')

    await expect(resolveBundled('opsmaxx-netd')).rejects.toMatchObject({
      code: 'binary-untrusted'
    })
  })

  it('reports a missing binary by path and mentions antivirus', async () => {
    writeManifest({ [`${PLATFORM_DIR}/${NETD}`]: { sha256: hash('anything') } })
    const err = await resolveBundled('opsmaxx-netd').catch((e) => e)
    expect(isVpnError(err) && err.code).toBe('binary-missing')
    expect(err.detail).toContain(join(binRoot, PLATFORM_DIR, NETD))
    expect(err.detail).toContain('antivirus')
  })

  it('treats a zero-length file as missing, not as a hash mismatch', async () => {
    // Quarantine leaves an empty stub behind; calling that "untrusted" would
    // point the user at the wrong fix.
    writeFileSync(join(binRoot, PLATFORM_DIR, NETD), '')
    writeManifest({ [`${PLATFORM_DIR}/${NETD}`]: { sha256: hash('') } })

    await expect(resolveBundled('opsmaxx-netd')).rejects.toMatchObject({
      code: 'binary-missing'
    })
  })

  it('treats an unlisted binary as missing, not as tampered', async () => {
    // A dev checkout before the sidecar has been built: an absence, and
    // calling it a tamper would train people to ignore the word.
    writeFileSync(join(binRoot, PLATFORM_DIR, NETD), 'built, but never recorded')
    writeManifest({})

    const err = await resolveBundled('opsmaxx-netd').catch((e) => e)
    expect(isVpnError(err) && err.code).toBe('binary-missing')
    expect(err.detail).toContain('build-sidecar')
  })

  it('verifies once per app run rather than once per spawn', async () => {
    const body = 'stable bytes'
    const file = join(binRoot, PLATFORM_DIR, NETD)
    writeFileSync(file, body)
    writeManifest({ [`${PLATFORM_DIR}/${NETD}`]: { sha256: hash(body) } })

    const first = await resolveBundled('opsmaxx-netd')
    rmSync(file)
    // Still cached: the check is a per-run gate before first exec, not a
    // filesystem watch.
    expect((await resolveBundled('opsmaxx-netd')).sha256).toBe(first.sha256)
  })
})

describe('system binary resolution', () => {
  it('accepts a confirmed absolute path and reports its hash and version', async () => {
    const dir = join(root, 'sbin')
    mkdirSync(dir, { mode: 0o755 })
    const file = writeShim(dir, 'openvpn')

    const info = await resolveSystem('openvpn', { binaryPath: file, confirmed: true })
    expect(info.available).toBe(true)
    expect(info.bundled).toBe(false)
    // The real path, not the one that was typed: the symlink is not what runs.
    expect(info.path).toBe(realpathSync(file))
    expect(info.sha256).toBe(await sha256File(file))
    expect(info.version).toContain('OpenVPN 2.6.99')
  })

  it('ignores an override the user never confirmed', async () => {
    const dir = join(root, 'sbin2')
    mkdirSync(dir, { mode: 0o755 })
    const file = writeShim(dir, 'openvpn')

    const err = await resolveSystem('openvpn', { binaryPath: file }).catch((e) => e)
    expect(isVpnError(err) && err.code).toBe('config-invalid')
    expect(err.detail).toContain('not been confirmed')
  })

  it('refuses a relative path', async () => {
    const err = await resolveSystem('openvpn', {
      binaryPath: 'bin/openvpn',
      confirmed: true
    }).catch((e) => e)
    expect(isVpnError(err) && err.code).toBe('config-invalid')
    expect(err.detail).toContain('relative path')
  })

  it('refuses a binary sitting in a world-writable directory', async () => {
    const dir = join(root, 'open')
    mkdirSync(dir)
    chmodSync(dir, 0o777)
    const file = writeShim(dir, 'openvpn')

    const err = await resolveSystem('openvpn', { binaryPath: file, confirmed: true }).catch((e) => e)
    expect(isVpnError(err) && err.code).toBe('config-invalid')
    expect(err.detail).toContain('world-writable')
  })

  it('refuses a symlink that leaves the directory it was found in', async () => {
    const visible = join(root, 'visible')
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(visible, { mode: 0o755 })
    mkdirSync(elsewhere, { mode: 0o755 })
    const real = writeShim(elsewhere, 'real-openvpn')
    const link = join(visible, 'openvpn')
    symlinkSync(real, link)

    const err = await resolveSystem('openvpn', { binaryPath: link, confirmed: true }).catch((e) => e)
    expect(isVpnError(err) && err.code).toBe('config-invalid')
    expect(err.detail).toContain('outside')
  })

  it('never searches PATH on Windows', async () => {
    const dir = join(root, 'hijack')
    mkdirSync(dir, { mode: 0o755 })
    // The textbook hijack: a writable directory early on PATH holding
    // something named like the real thing (E44).
    writeShim(dir, 'openvpn.exe')
    writeShim(dir, 'openvpn')
    process.env.PATH = dir
    stubPlatform('win32')

    const err = await resolveSystem('openvpn', {}).catch((e) => e)
    expect(isVpnError(err) && err.code).toBe('binary-missing')
    expect(err.detail).toContain('does not search PATH on Windows')
    expect(err.detail).not.toContain(dir)
  })

  it.skipIf(
    ['/usr/sbin/openvpn', '/usr/local/sbin/openvpn', '/opt/homebrew/sbin/openvpn', '/usr/bin/openvpn'].some(
      (p) => existsSync(p)
    )
  )('falls back to PATH on POSIX once the fixed locations come up empty', async () => {
    const dir = join(root, 'pathdir')
    mkdirSync(dir, { mode: 0o755 })
    const file = writeShim(dir, 'openvpn')
    process.env.PATH = dir

    const info = await resolveSystem('openvpn', {})
    expect(info.path).toBe(realpathSync(file))
    expect(info.bundled).toBe(false)
  })
})

describe('bundled first, system second', () => {
  // OpsMaxx ships `openvpn` on macOS and Linux but not on Windows, and a
  // user may still have their own copy anywhere. `resolveEngineBinary` is the
  // one place that decides between them, and the order it decides in is a
  // security property rather than a preference — so each rung is asserted
  // separately.
  const OPENVPN = process.platform === 'win32' ? 'openvpn.exe' : 'openvpn'

  function bundleOpenVpn(body: string): string {
    const file = writeShim(join(binRoot, PLATFORM_DIR), OPENVPN)
    writeFileSync(file, body)
    chmodSync(file, 0o755)
    writeManifest({
      [`${PLATFORM_DIR}/${OPENVPN}`]: { sha256: hash(body), size: body.length }
    })
    return file
  }

  it('prefers the copy OpsMaxx ships', async () => {
    const file = bundleOpenVpn('#!/bin/sh\necho "OpenVPN 2.6.22 bundled"\n')

    const info = await resolveEngineBinary('openvpn', {})
    expect(info.path).toBe(file)
    expect(info.bundled).toBe(true)
    expect(info.kind).toBe('openvpn')
  })

  it('falls back to a system install when nothing is bundled', async () => {
    // No manifest and no file: the ordinary state of a Windows build, and of a
    // dev checkout before `npm run build:engines`.
    const dir = join(root, 'pathdir')
    mkdirSync(dir, { mode: 0o755 })
    const file = writeShim(dir, 'openvpn')
    process.env.PATH = dir

    const info = await resolveEngineBinary('openvpn', {})
    expect(info.bundled).toBe(false)
    // On a machine that really has OpenVPN in /usr/sbin the allowlist wins
    // before PATH is reached, which is correct and is not what this asserts.
    expect(info.path).toBeTruthy()
    if (info.path !== realpathSync(file)) {
      expect(existsSync(info.path as string)).toBe(true)
    }
  })

  it('refuses outright when the bundled copy has been tampered with', async () => {
    // The distinction that matters: a bundled binary that is *absent* is a
    // reason to look elsewhere, and one whose bytes are wrong is not. Falling
    // through to a system copy here would turn the only tamper signal we have
    // into no signal at all.
    const file = bundleOpenVpn('the bytes we expected')
    writeFileSync(file, 'the bytes we got')
    const dir = join(root, 'pathdir')
    mkdirSync(dir, { mode: 0o755 })
    writeShim(dir, 'openvpn')
    process.env.PATH = dir

    await expect(resolveEngineBinary('openvpn', {})).rejects.toMatchObject({
      code: 'binary-untrusted'
    })
  })

  it('lets a confirmed profile path win over the bundled copy', async () => {
    bundleOpenVpn('#!/bin/sh\necho bundled\n')
    const dir = join(root, 'usr', 'sbin')
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    const chosen = writeShim(dir, 'openvpn')

    // The user pointed at a file. Running a different one would answer a
    // question they did not ask — even when ours is the safer bet.
    const info = await resolveEngineBinary('openvpn', { binaryPath: chosen, confirmed: true })
    expect(info.path).toBe(realpathSync(chosen))
    expect(info.bundled).toBe(false)
  })

  it('does not quietly fall back to the bundled copy when the chosen path is refused', async () => {
    bundleOpenVpn('#!/bin/sh\necho bundled\n')
    // An unconfirmed path is refused outright (E44). Reverting to the bundled
    // binary here would run something the user did not pick while the profile
    // still claimed to be pointing somewhere else.
    const err = await resolveEngineBinary('openvpn', {
      binaryPath: join(root, 'somewhere', 'openvpn')
    }).catch((e) => e)
    expect(isVpnError(err) && err.code).toBe('config-invalid')
  })

  it('reports both halves when a platform that should have one has neither', async () => {
    // "Install openvpn" on its own would be wrong on a build that was supposed
    // to ship one: the reader would go and install something while the missing
    // bundled binary — the actual fault — stayed unexplained.
    process.env.PATH = ''

    const err = await resolveEngineBinary('openvpn', {}).catch((e) => e)
    expect(isVpnError(err) && err.code).toBe('binary-missing')
    expect(err.detail).toContain(join(binRoot, PLATFORM_DIR, OPENVPN))
    expect(err.detail).toContain('scripts/build-openvpn.sh')
    expect(err.detail).toContain('Looked in')
  })

  it('does not mention a bundled OpenVPN on Windows, where there is none', async () => {
    // The opposite failure: telling a Windows user to run a build script for a
    // target OpsMaxx deliberately does not produce.
    process.env.PATH = ''
    stubPlatform('win32')

    const err = await resolveEngineBinary('openvpn', {}).catch((e) => e)
    expect(isVpnError(err) && err.code).toBe('binary-missing')
    expect(err.detail).not.toContain('build-openvpn.sh')
    expect(err.detail).toContain('does not search PATH on Windows')
  })
})

describe('frpc, which OpsMaxx never ships', () => {
  // Antivirus flags upstream frpc as a hacktool, so it is the user's install —
  // found on the same allowlist-then-PATH ladder as a system OpenVPN, held to
  // the same rules, and additionally refused when it is too old to drive.
  const FRPC_ALLOWLIST = [
    '/usr/local/bin/frpc',
    '/opt/homebrew/bin/frpc',
    '/opt/local/bin/frpc',
    '/usr/bin/frpc',
    '/run/current-system/sw/bin/frpc'
  ]
  const installed = FRPC_ALLOWLIST.some((p) => existsSync(p))

  function frpcShim(dir: string, version: string, name = 'frpc'): string {
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    const file = join(dir, name)
    // The real binary prints the bare version and nothing else.
    writeFileSync(file, `#!/bin/sh\necho ${version}\n`)
    chmodSync(file, 0o755)
    return file
  }

  it('ignores a copy in the bundled-engine directory, manifest and all', async () => {
    // The old layout, as an upgrade could leave it. Shipping frpc is over, so
    // finding one there must not quietly bring it back.
    const body = '#!/bin/sh\necho 0.71.0\n'
    const file = join(binRoot, PLATFORM_DIR, 'frpc')
    writeFileSync(file, body)
    chmodSync(file, 0o755)
    writeManifest({ [`${PLATFORM_DIR}/frpc`]: { sha256: hash(body) } })
    process.env.PATH = ''

    const result = await resolveEngineBinary('frpc', {}).catch((e) => e)
    if (isVpnError(result)) {
      expect(result.detail).not.toContain(binRoot)
    } else {
      // Only reachable on a machine with a real frpc on the allowlist.
      expect(result.bundled).toBe(false)
      expect(result.path).not.toContain(binRoot)
    }
  })

  it.skipIf(installed || process.platform === 'win32')(
    'looks on the fixed allowlist, then PATH, and says where with install advice',
    async () => {
      process.env.PATH = ''
      const err = await resolveEngineBinary('frpc', {}).catch((e) => e)
      expect(isVpnError(err) && err.code).toBe('binary-missing')
      expect(err.detail).toContain(`Looked in ${FRPC_ALLOWLIST.join(', ')} and on PATH.`)
      expect(err.detail).toContain('github.com/fatedier/frp/releases')
      expect(err.detail).toContain('Set the path')
      expect(err.detail).not.toContain('build-frpc')
      if (process.platform === 'darwin') expect(err.detail).toContain('brew install frpc')
    }
  )

  it('keeps every allowlisted location inside a root only an administrator writes', () => {
    // The list is asserted rather than exercised: its entries are real system
    // paths a test cannot create. What makes them safe to auto-accept is that
    // each one lives under a root the symlink check enforces.
    const roots = ['/usr', '/opt', '/bin', '/sbin', '/nix', '/snap', '/run/current-system']
    for (const p of FRPC_ALLOWLIST) {
      expect(roots.some((r) => p.startsWith(`${r}/`))).toBe(true)
    }
    // /snap/bin/frpc would resolve to /usr/bin/snap, which is not frpc.
    expect(FRPC_ALLOWLIST.some((p) => p.startsWith('/snap/'))).toBe(false)
  })

  it.skipIf(installed || process.platform === 'win32')('falls back to PATH on POSIX', async () => {
    const file = frpcShim(join(root, 'pathdir'), '0.71.0')
    process.env.PATH = join(root, 'pathdir')

    const info = await resolveEngineBinary('frpc', {})
    expect(info.kind).toBe('frp')
    expect(info.path).toBe(realpathSync(file))
    expect(info.bundled).toBe(false)
    expect(info.version).toBe('0.71.0')
  })

  it('never searches PATH for it on Windows, and points at the confirmed path instead', async () => {
    const dir = join(root, 'hijack')
    frpcShim(dir, '0.71.0', 'frpc.exe')
    frpcShim(dir, '0.71.0')
    process.env.PATH = dir
    stubPlatform('win32')

    const err = await resolveEngineBinary('frpc', {}).catch((e) => e)
    expect(isVpnError(err) && err.code).toBe('binary-missing')
    expect(err.detail).toContain('does not search PATH on Windows')
    expect(err.detail).toContain('frpc.exe')
    expect(err.detail).toContain('Set the path')
    expect(err.detail).not.toContain(dir)
  })

  it('runs a confirmed path wherever the user keeps it', async () => {
    const file = frpcShim(join(root, 'tools'), '0.72.0')
    const info = await resolveEngineBinary('frpc', { binaryPath: file, confirmed: true })
    expect(info.path).toBe(realpathSync(file))
    expect(info.version).toBe('0.72.0')
  })

  it('refuses an unconfirmed path, like any other engine', async () => {
    const file = frpcShim(join(root, 'tools'), '0.72.0')
    const err = await resolveEngineBinary('frpc', { binaryPath: file }).catch((e) => e)
    expect(isVpnError(err) && err.code).toBe('config-invalid')
  })

  it('refuses a confirmed frpc that is too old, leading with both versions', async () => {
    const file = frpcShim(join(root, 'tools'), '0.51.3')
    const err = await resolveEngineBinary('frpc', { binaryPath: file, confirmed: true }).catch(
      (e) => e
    )
    expect(isVpnError(err) && err.code).toBe('binary-outdated')
    // First, because it is the headline: the program IS there.
    expect(err.detail.startsWith('frpc 0.51.3 is too old; OpsMaxx needs 0.62.0 or newer.')).toBe(true)
    expect(err.detail).toContain('github.com/fatedier/frp/releases')
  })

  it('says why a binary that will not run reported no version', async () => {
    // What Gatekeeper does to an unsigned download, and what a broken binary
    // does anywhere: killed before it prints a thing. "Did not report a
    // version" sent people to check the version of a program that never ran.
    const dir = join(root, 'killed')
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    const file = join(dir, 'frpc')
    writeFileSync(file, '#!/bin/sh\nkill -9 $$\n')
    chmodSync(file, 0o755)
    const err = await resolveEngineBinary('frpc', { binaryPath: file, confirmed: true }).catch(
      (e) => e
    )
    expect(isVpnError(err) && err.code).toBe('binary-missing')
    expect(err.detail).toContain('was killed (SIGKILL)')
    expect(err.detail).toContain('0.62.0 or newer')
  })

  it.runIf(process.platform === 'darwin')(
    'names the quarantine attribute, and the command that clears it, on macOS',
    async () => {
      const dir = join(root, 'download')
      mkdirSync(dir, { recursive: true, mode: 0o755 })
      const file = join(dir, 'frpc')
      writeFileSync(file, '#!/bin/sh\nkill -9 $$\n')
      chmodSync(file, 0o755)
      execFileSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0081;00000000;Safari;', file])
      const err = await resolveEngineBinary('frpc', { binaryPath: file, confirmed: true }).catch(
        (e) => e
      )
      expect(err.detail).toContain(`xattr -d com.apple.quarantine ${realpathSync(file)}`)
    }
  )

  it('carries none of the OpenVPN coexistence talk', async () => {
    // frpc creates no tun device and claims no route; "utun6 already carries
    // traffic" or "Tunnelblick is installed" under an frp row is about
    // somebody else's problem.
    const file = frpcShim(join(root, 'tools'), '0.71.0')
    const info = await resolveEngineBinary('frpc', { binaryPath: file, confirmed: true })
    expect(info.advisories).toBeUndefined()
    const old = frpcShim(join(root, 'old'), '0.61.0')
    const err = await resolveEngineBinary('frpc', { binaryPath: old, confirmed: true }).catch((e) => e)
    expect(err.detail).not.toContain('copy of OpenVPN')
  })

  it.skipIf(installed || process.platform === 'win32')(
    'passes over a too-old frpc on PATH and reports it as found but not used',
    async () => {
      const old = frpcShim(join(root, 'old'), '0.61.0')
      process.env.PATH = join(root, 'old')
      const err = await resolveEngineBinary('frpc', {}).catch((e) => e)
      // Every refusal was the version, so the version is the headline.
      expect(isVpnError(err) && err.code).toBe('binary-outdated')
      expect(err.detail).toContain('frpc 0.61.0 is too old; OpsMaxx needs 0.62.0 or newer.')
      expect(err.detail).toContain(`Found ${old} (0.61.0)`)

      // And a newer one later on PATH still gets its turn.
      const good = frpcShim(join(root, 'new'), '0.62.0')
      process.env.PATH = [join(root, 'old'), join(root, 'new')].join(':')
      expect((await resolveEngineBinary('frpc', {})).path).toBe(realpathSync(good))
    }
  )

  it('compares versions numerically and refuses one it cannot read', () => {
    expect(tooOld('frpc', '0.62.0')).toBeNull()
    expect(tooOld('frpc', '0.71.0')).toBeNull()
    expect(tooOld('frpc', '1.0.0')).toBeNull()
    expect(tooOld('frpc.exe', '0.9.0')).toContain('0.62.0 or newer')
    expect(tooOld('frpc', '0.61.9')).toContain('frpc 0.61.9')
    expect(tooOld('frpc', undefined)).toContain('did not report a version')
    expect(tooOld('frpc', 'usage: frpc [flags]')).toContain('did not report a version')
    // No minimum for an engine whose version OpsMaxx chose.
    expect(tooOld('openvpn', undefined)).toBeNull()
  })
})
