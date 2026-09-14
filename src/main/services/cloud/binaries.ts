/**
 * Finding the provider CLI the user already installed.
 *
 * OpsMaxx never installs one, never bundles one and never offers to. It finds
 * what is there, says where it found it and which version it is, and refuses to
 * run anything it cannot vouch for.
 *
 * ── Why this is not vpn/binaries.ts ─────────────────────────────────────────
 *
 * That module resolves engines OpsMaxx SHIPS, so it can demand a fixed install
 * location and a SHA-256 that matches a manifest. Neither applies here. These
 * are third-party tools the user installed however their organisation installs
 * things, and the documented locations include the home directory:
 * `~/google-cloud-sdk/bin/gcloud` is Google's own installer's default, and both
 * `aws` and `az` arrive in `~/.local/bin` when installed with pipx. Insisting on
 * /usr and /opt the way the VPN resolver does would reject the majority of real
 * installs, and there is no manifest to hash against because we did not build
 * them.
 *
 * So the check that survives is the one that actually defends against
 * substitution for a home install: no world-writable directory anywhere above
 * the resolved file. A binary under a directory any user can write is a binary
 * any user can replace, and no amount of version-recording makes that safe.
 */

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { realpath, stat } from 'node:fs/promises'

import { debugRecord } from '../debugLog'
import {
  CLOUD_PROVIDER_BINARY,
  CLOUD_PROVIDER_CLI_NAME,
  type CloudProvider
} from '../../../shared/cloud'
import { VERSION_ARGS } from '../../../shared/cloudCommands'
import {
  parseAwsVersion,
  parseAzVersion,
  parseGcloudVersion
} from '../../../shared/cloudCommands'

/** What detection answers, per provider. */
export interface ProviderDetectionResult {
  installed: boolean
  executablePath?: string
  version?: string
  /** False when it is installed but OpsMaxx will not use it. */
  supported: boolean
  /** Why not, when `installed` or `supported` is false. */
  error?: string
}

/**
 * Where each tool actually lands, in the order we try.
 *
 * `~` entries are expanded at call time. This list is tried BEFORE PATH so that
 * the answer is stable: a user with two installs gets the same one every run,
 * and the panel that shows the path is telling the truth about what will be
 * executed.
 */
const CANDIDATES: Record<CloudProvider, { posix: string[]; win32: string[] }> = {
  gcp: {
    posix: [
      '/opt/homebrew/bin/gcloud',
      '/usr/local/bin/gcloud',
      '~/google-cloud-sdk/bin/gcloud',
      '/usr/lib/google-cloud-sdk/bin/gcloud',
      '/snap/bin/gcloud',
      '/usr/bin/gcloud'
    ],
    win32: [
      'C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd',
      'C:\\Program Files\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd',
      '~\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd'
    ]
  },
  aws: {
    posix: [
      '/opt/homebrew/bin/aws',
      '/usr/local/bin/aws',
      '/usr/bin/aws',
      '~/.local/bin/aws'
    ],
    win32: [
      'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe',
      'C:\\Program Files (x86)\\Amazon\\AWSCLIV2\\aws.exe'
    ]
  },
  azure: {
    posix: [
      '/opt/homebrew/bin/az',
      '/usr/local/bin/az',
      '/usr/bin/az',
      '~/.local/bin/az'
    ],
    win32: [
      'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd',
      'C:\\Program Files (x86)\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd'
    ]
  }
}

/** Extensions a Windows PATH lookup has to try; POSIX needs none. */
const WIN_EXTENSIONS = ['.cmd', '.exe', '.bat']

function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

/**
 * Reject anything we cannot vouch for.
 *
 * Returns null when the file is acceptable, or the reason it is not. Mirrors
 * the shape of vpn/binaries.ts's own check deliberately, minus the allowlisted
 * roots (see the header) and minus the manifest hash (there is nothing to
 * compare against for a tool we did not build).
 */
async function checkExecutable(candidate: string): Promise<string | null> {
  if (!isAbsolute(candidate)) {
    return 'is a relative path, which depends on the working directory.'
  }

  let real: string
  try {
    real = await realpath(candidate)
  } catch {
    return 'does not exist.'
  }

  const st = await stat(real).catch(() => null)
  if (!st || !st.isFile()) return 'is not a file.'
  if (st.size === 0) return 'is empty, which is what antivirus quarantine leaves behind.'

  // POSIX modes say nothing on Windows - every file reports 0666 - so checking
  // them there rejects everything for no gain.
  if (process.platform === 'win32') return null

  if ((st.mode & 0o111) === 0) return 'is not executable.'

  // Anyone who can write a directory can replace the file inside it. The sticky
  // bit does not help: /tmp is sticky and still lets anyone create.
  for (let dir = dirname(real); ; dir = dirname(dir)) {
    const dst = await stat(dir).catch(() => null)
    if (dst && (dst.mode & 0o002) !== 0) {
      return `is inside the world-writable directory ${dir}, so any user could replace it.`
    }
    if (dirname(dir) === dir) break
  }
  return null
}

/** Every place to look, in order: known locations first, then PATH. */
function searchPaths(provider: CloudProvider): string[] {
  const win32 = process.platform === 'win32'
  const name = CLOUD_PROVIDER_BINARY[provider]
  const fixed = (win32 ? CANDIDATES[provider].win32 : CANDIDATES[provider].posix).map(expandHome)

  // Looked at before anything else. Mirrors OPSMAXX_VPN_BIN_DIR: it exists so a
  // user whose organisation installs these tools somewhere unusual is not stuck,
  // and so tests can point detection at a fixture tree instead of at whatever
  // happens to be installed on the machine running them. It is still subject to
  // every check below - an override says where to look, not what to trust.
  const override = process.env.OPSMAXX_CLOUD_BIN_DIR
  const overrides = override
    ? (win32 ? WIN_EXTENSIONS.map((e) => join(expandHome(override), name + e)) : [join(expandHome(override), name)])
    : []

  /**
   * PATH is searched on POSIX only.
   *
   * The same rule vpn/binaries.ts applies, and for the same reason: on Windows
   * the search IS the vulnerability. A directory earlier on PATH that the user
   * (or anything running as them) can write is enough to decide which program
   * gets run as `gcloud`, and none of the checks below can catch it there -
   * POSIX mode bits are meaningless on NTFS, so the world-writable test that
   * guards a home-directory install on macOS and Linux returns nothing useful.
   *
   * The fixed lists above already cover what every official Windows installer
   * produces. An install somewhere else is reachable through
   * OPSMAXX_CLOUD_BIN_DIR, which is an explicit choice by the person running
   * the app rather than whatever their PATH happened to contain.
   */
  const fromPath: string[] = []
  if (!win32) {
    for (const dir of (process.env.PATH ?? '').split(':')) {
      if (!dir) continue
      fromPath.push(join(expandHome(dir), name))
    }
  }

  return [...overrides, ...fixed, ...fromPath]
}

/** Per-run cache: detection runs on every panel open and shells out. */
const detectionCache = new Map<CloudProvider, ProviderDetectionResult>()

/** Drops the cache. Tests use it between fixture trees. */
export function resetCloudBinaryCache(): void {
  detectionCache.clear()
}

function parseVersion(provider: CloudProvider, stdout: string): string {
  if (provider === 'gcp') return parseGcloudVersion(stdout)
  if (provider === 'aws') return parseAwsVersion(stdout)
  return parseAzVersion(stdout)
}

/**
 * Ask the tool its version.
 *
 * Best effort on the exit code: some of these report a non-zero status while
 * still printing a usable version, and refusing to proceed over that would
 * block a working install. The output is what matters.
 */
function probeVersion(file: string, provider: CloudProvider): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...VERSION_ARGS[provider]],
      { timeout: 20_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (_err, stdout, stderr) => {
        resolve(parseVersion(provider, `${stdout || ''}${stderr || ''}`))
      }
    )
  })
}

/**
 * Find the provider CLI, or explain why not.
 *
 * Never throws: a missing tool is an ordinary, expected state that the UI shows
 * as "not detected" with installation instructions, not an error condition.
 */
export async function detectProvider(
  provider: CloudProvider,
  /**
   * Skip the cache and look again.
   *
   * The "Check again" button exists for exactly one situation - the user has
   * just installed the tool, or just signed in - and the cache made it a
   * no-op: it returned the same "not detected" for the life of the process, so
   * the one control offered on that screen did nothing at all.
   */
  force = false
): Promise<ProviderDetectionResult> {
  const cached = force ? undefined : detectionCache.get(provider)
  if (cached) return cached

  const rejected: string[] = []
  let result: ProviderDetectionResult | null = null

  for (const candidate of searchPaths(provider)) {
    const problem = await checkExecutable(candidate)
    if (problem === null) {
      const version = await probeVersion(candidate, provider)
      result = { installed: true, executablePath: candidate, version, supported: true }
      break
    }
    // "does not exist" is the normal answer for most candidates and is noise.
    // Anything else is a file that IS there and was refused, which the user
    // needs to be told about - a rejected binary looks identical to a missing
    // one otherwise.
    if (problem !== 'does not exist.') rejected.push(`${candidate} ${problem}`)
  }

  if (!result) {
    result = {
      installed: false,
      supported: false,
      error:
        rejected.length > 0
          ? `${CLOUD_PROVIDER_CLI_NAME[provider]} was found but not used: ${rejected[0]}`
          : `${CLOUD_PROVIDER_CLI_NAME[provider]} was not detected.`
    }
  }

  detectionCache.set(provider, result)
  // "Record which binary/version was executed" - and this is the moment it is
  // decided, once per run, for every command that follows. The path is the
  // whole point: a product that runs someone else's tooling on their behalf
  // should be able to say afterwards exactly which file it ran.
  debugRecord('cloud.binary', {
    provider,
    installed: result.installed,
    path: result.executablePath,
    version: result.version
  })
  return result
}
