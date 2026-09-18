import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import {
  BundledBinaryError,
  forgetManifest,
  resolveBundledBinary,
  sha256File,
} from '../src/main/services/bundledBinary'

// The point of this module, and the reason it exists apart from
// `services/vpn/binaries.ts`: a bundled binary that is NOT a VPN engine has to
// reach the same manifest check. `kindOf()` throws for any name absent from
// `VpnKind`, so before the lift `addyd` had a choice between a fake engine kind
// and an unverified exec path. Both were wrong; this is the third option.
const PLATFORM_DIR = `${process.platform}-${process.arch}`
const ADDYD = process.platform === 'win32' ? 'addyd.exe' : 'addyd'
const SANDBOX = resolve(__dirname, '..', '.tmp-tests')

let root: string
let binRoot: string
let previousBinDir: string | undefined

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function writeManifest(entries: Record<string, { sha256: string; size?: number; version?: string }>): void {
  writeFileSync(join(binRoot, 'manifest.json'), JSON.stringify({ version: '0.1.0', binaries: entries }))
}

function writeBinary(body: string): string {
  const file = join(binRoot, PLATFORM_DIR, ADDYD)
  writeFileSync(file, body)
  chmodSync(file, 0o755)
  return file
}

beforeEach(() => {
  // Beside the repo rather than under os.tmpdir(), for the same reason
  // tests/vpnBinaries.test.ts is: /tmp is world-writable on Linux.
  mkdirSync(SANDBOX, { recursive: true })
  root = mkdtempSync(join(SANDBOX, 'sp-bundled-'))
  binRoot = join(root, 'bin')
  mkdirSync(join(binRoot, PLATFORM_DIR), { recursive: true })
  previousBinDir = process.env.OPSMAXX_VPN_BIN_DIR
  process.env.OPSMAXX_VPN_BIN_DIR = binRoot
  forgetManifest()
})

afterEach(() => {
  if (previousBinDir === undefined) delete process.env.OPSMAXX_VPN_BIN_DIR
  else process.env.OPSMAXX_VPN_BIN_DIR = previousBinDir
  forgetManifest()
  rmSync(root, { recursive: true, force: true })
})

describe('bundled binary resolution, independent of VPN', () => {
  it('resolves a non-engine binary whose hash matches the manifest', async () => {
    const body = 'not really a sidecar, but it hashes just as well'
    const file = writeBinary(body)
    writeManifest({
      [`${PLATFORM_DIR}/${ADDYD}`]: {
        sha256: hash(body),
        size: body.length,
        version: '0.1.0',
      },
    })

    const info = await resolveBundledBinary('addyd', 'npm run build:addyd')
    expect(info.path).toBe(file)
    expect(info.sha256).toBe(await sha256File(file))
    // Carried from the manifest rather than probed: the caller decides whether
    // running an unverified binary to ask its version is acceptable.
    expect(info.version).toBe('0.1.0')
  })

  it('refuses a binary whose bytes disagree with the manifest', async () => {
    writeBinary('the bytes we expected')
    writeManifest({
      [`${PLATFORM_DIR}/${ADDYD}`]: { sha256: hash('the bytes we expected') },
    })
    writeBinary('the bytes we got')

    await expect(resolveBundledBinary('addyd', 'npm run build:addyd')).rejects.toMatchObject({
      reason: 'untrusted',
    })
  })

  it('refuses a binary the manifest does not mention at all', async () => {
    writeBinary('unlisted')
    writeManifest({
      [`${PLATFORM_DIR}/something-else`]: { sha256: hash('unlisted') },
    })

    // Refused, but as `missing` rather than `untrusted`, and that choice is
    // load-bearing: an unbuilt dev checkout reaches this branch on every run,
    // so calling it a tamper would teach people to ignore the word on the day
    // it is true. What matters is that nothing unverified is returned.
    await expect(resolveBundledBinary('addyd', 'npm run build:addyd')).rejects.toMatchObject({
      reason: 'missing',
    })
  })

  it('names the build script when the binary is absent', async () => {
    writeManifest({
      [`${PLATFORM_DIR}/${ADDYD}`]: { sha256: hash('never built') },
    })

    // The hint is the whole value of the `missing` case: a developer who has
    // not built the sidecar gets told which script builds it.
    const err = await resolveBundledBinary('addyd', 'npm run build:addyd').catch((e) => e)
    expect(err).toBeInstanceOf(BundledBinaryError)
    expect(err.reason).toBe('missing')
    expect(err.message).toContain('npm run build:addyd')
  })

  it('forgetManifest lets a second fixture tree be read on its own terms', async () => {
    const body = 'first tree'
    writeBinary(body)
    writeManifest({ [`${PLATFORM_DIR}/${ADDYD}`]: { sha256: hash(body) } })
    await resolveBundledBinary('addyd', 'npm run build:addyd')

    // Same path, different bytes and a manifest that agrees with them. Without
    // the reset the first tree's parsed manifest answers for the second, and
    // the check silently compares against hashes from a tree that is gone.
    writeBinary('second tree')
    writeManifest({
      [`${PLATFORM_DIR}/${ADDYD}`]: { sha256: hash('second tree') },
    })
    await expect(resolveBundledBinary('addyd', 'npm run build:addyd')).rejects.toMatchObject({
      reason: 'untrusted',
    })
    forgetManifest()
    await expect(resolveBundledBinary('addyd', 'npm run build:addyd')).resolves.toMatchObject({
      sha256: hash('second tree'),
    })
  })
})
