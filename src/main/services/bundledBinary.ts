import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Locating and integrity-checking a binary OpsMaxx ships.
 *
 * LIFTED OUT OF `vpn/binaries.ts` WITHOUT CHANGING WHAT IT DOES. That module
 * owns the most security-sensitive decision the VPN layer makes -- which file
 * to execute -- and the verification half of it was never VPN-specific. It was
 * only reachable through `kindOf()`, which THROWS for any binary absent from a
 * `VpnKind` map, so a non-VPN sidecar could not use the single manifest-verified
 * exec path in the app without either being given a fake VPN kind or getting a
 * second, unverified path of its own. Both are worse than this lift.
 *
 * The VPN module keeps its own wrapper and its own error type; nothing about
 * its behaviour changes. What moved here is the part that was always generic:
 * where the bin root is, how a manifest key is built, and the hash check.
 */

export interface ManifestEntry {
  sha256: string
  size?: number
  version?: string
}

export interface BinaryManifest {
  version?: number
  binaries?: Record<string, string | ManifestEntry>
}

/** What a verified bundled binary is, with nothing VPN-shaped about it. */
export interface BundledBinary {
  /** Absolute path to the file, already hash-checked. */
  path: string
  sha256: string
  version?: string
}

/** Why a resolution failed, so a caller can shape its own message. */
export type BundledFailure =
  /** Absent, zero-length, or not listed in the manifest. In a dev checkout
   *  this is the normal state before the engines are built, and calling it a
   *  tamper would train people to ignore the word. */
  | 'missing'
  /** Present and listed, and the bytes do not match. */
  | 'untrusted'

export class BundledBinaryError extends Error {
  constructor(
    readonly reason: BundledFailure,
    message: string,
    readonly path: string,
  ) {
    super(message)
    this.name = 'BundledBinaryError'
  }
}

// Read at call time, not module load: `process.platform` is stubbed in the
// resolver tests, and a constant captured at import would silently ignore it.
function exeSuffix(): string {
  return process.platform === 'win32' ? '.exe' : ''
}

/** `resources/bin` in a dev checkout, `<resourcesPath>/bin` when packaged.
 *  The relative shape below the root is identical in both, so nothing else has
 *  to know which one it got. */
export function bundledRoot(): string {
  // Still spelled VPN after the lift, deliberately: it is read by four test
  // files and nothing that ships, and one root is what makes the manifest
  // check mean anything — a second variable would let a caller point half the
  // binaries somewhere else.
  const override = process.env.OPSMAXX_VPN_BIN_DIR
  if (override) return override
  if (app?.isPackaged && process.resourcesPath) return join(process.resourcesPath, 'bin')
  const appPath = typeof app?.getAppPath === 'function' ? app.getAppPath() : process.cwd()
  return join(appPath, 'resources', 'bin')
}

/** POSIX-separated, relative to the `bin` root. This is the manifest key, so
 *  it must be built the same way on every platform. */
export function manifestKey(name: string): string {
  return `${process.platform}-${process.arch}/${name}${exeSuffix()}`
}

let manifestCache: BinaryManifest | null = null

/** Drop the cached manifest. Tests that stub the platform need this, and so
 *  does anything that rebuilds the engines while the app is running. */
export function forgetManifest(): void {
  manifestCache = null
}

export async function loadManifest(root: string): Promise<BinaryManifest | null> {
  if (manifestCache) return manifestCache
  try {
    const parsed = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as BinaryManifest
    manifestCache = parsed
    return parsed
  } catch {
    return null
  }
}

export function entryOf(manifest: BinaryManifest | null, key: string): ManifestEntry | null {
  const raw = manifest?.binaries?.[key]
  if (!raw) return null
  return typeof raw === 'string' ? { sha256: raw } : raw
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    // Streamed rather than readFile'd: these are tens of megabytes and the
    // main process is also drawing the UI.
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * Resolve a bundled binary and verify its bytes against the manifest.
 *
 * THROWS rather than returning an unavailable result, so a caller cannot
 * accidentally treat a tampered binary as merely absent. The two failure
 * reasons are distinct because they need different messages: a dev checkout
 * that has not built its engines is an absence, and saying "tampered" there
 * would teach people to ignore the word on the day it is true.
 *
 * `buildHint` is the command that would produce the file, named in the missing
 * message because "run something" is not an instruction.
 */
export async function resolveBundledBinary(name: string, buildHint: string): Promise<BundledBinary> {
  const root = bundledRoot()
  const key = manifestKey(name)
  const file = join(root, ...key.split('/'))

  const st = await stat(file).catch(() => null)
  if (!st || !st.isFile() || st.size === 0) {
    // A zero-length file is the shape antivirus quarantine leaves behind, and
    // it is indistinguishable from a truncated download, so both get the same
    // message naming the path.
    throw new BundledBinaryError(
      'missing',
      `Looked for ${file}. If this is a development checkout, run ${buildHint} to build it; otherwise antivirus software may have quarantined it.`,
      file,
    )
  }

  const manifest = await loadManifest(root)
  const entry = entryOf(manifest, key)
  if (!entry) {
    // A missing manifest or a missing entry is the normal state of a dev
    // checkout before the binaries have been built. That is an absence, not a
    // tamper, and calling it a tamper would train people to ignore the word.
    // The binary is refused either way; only the wording differs.
    throw new BundledBinaryError(
      'missing',
      `${file} is not listed in ${join(root, 'manifest.json')}, so it cannot be verified. Run ${buildHint} to produce both.`,
      file,
    )
  }

  const actual = await sha256File(file)
  if (actual !== entry.sha256) {
    throw new BundledBinaryError(
      'untrusted',
      `${file} hashes to ${actual} but the manifest records ${entry.sha256}.`,
      file,
    )
  }

  return { path: file, sha256: actual, version: entry.version }
}
