import { execFile } from 'node:child_process'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { VpnEngineInfo, VpnKind } from '../../../shared/vpn'
import { isEngineBundledOn } from '../../../shared/vpnEngines'
import { VpnError } from './errors'
import {
  BundledBinaryError,
  forgetManifest,
  resolveBundledBinary,
  sha256File,
  type BundledBinary
} from '../bundledBinary'

// Deciding which file to execute is the whole of this module, and it is the
// single most security-sensitive decision the VPN layer makes: everything
// downstream runs with the user's privileges and, in system mode, with the
// user's elevation. Two entirely separate paths:
//
//  - `resolveBundled` for what we ship. We know the exact bytes, so we check
//    them against a manifest on every app run before the first exec (E42).
//  - `resolveSystem` for an engine the user already has. We cannot know the
//    bytes, so we constrain *where* it may come from instead, with no PATH
//    search on Windows (E44) and no relative paths, world-writable parents,
//    or symlinks out of an allowlisted root (E45).
//
// `resolveEngineBinary` is the two in order, and is what the OpenVPN driver
// calls: OpsMaxx now ships `openvpn` on macOS and Linux, but a Windows
// build has none — and someone may still want the copy they installed
// themselves. See its own comment for why the ordering is not symmetric.

// Which engine each binary implements. The name alone reaches the caller, so
// this is where it turns back into a `VpnKind` for the returned info.
const ENGINE_KIND: Record<string, VpnKind> = {
  'opsmaxx-netd': 'wireguard',
  frpc: 'frp',
  openvpn: 'openvpn',
  // on why this engine is attached to rather than supervised. It still needs an
  // entry here, because `kindOf` throws for any name absent from this map and
  // that throw is the first line of resolution.
}

// The only directories a system-installed OpenVPN is accepted from, in the
// order they are tried. A fixed list rather than a search: on Windows the
// search *is* the vulnerability. Windows has no entry here because there is no
// fixed list to write — see `winCandidates`.
const SYSTEM_CANDIDATES: Record<string, { posix: string[] }> = {
  openvpn: {
    posix: [
      // Debian/Ubuntu, RHEL/Fedora, Alpine, openSUSE and Gentoo all package it
      // here; Arch merged sbin into bin, which is the fourth entry.
      '/usr/sbin/openvpn',
      '/usr/local/sbin/openvpn',
      // Homebrew on Apple silicon, then MacPorts. Intel Homebrew is
      // /usr/local/sbin, already above.
      '/opt/homebrew/sbin/openvpn',
      '/opt/local/sbin/openvpn',
      '/usr/bin/openvpn',
      // NixOS, which puts nothing in /usr at all. The path is a symlink into
      // /nix/store, so the store has to be an allowed root as well.
      '/run/current-system/sw/bin/openvpn'
    ]
  },
}

// A symlink is allowed to move a candidate around inside these roots — Homebrew
// keeps the real binary in `Cellar` and links it into `sbin` — but not out of
// them. `/usr/sbin/openvpn -> /tmp/evil` is the attack this rejects.
//
// `/nix` and `/snap` are here because on those systems every binary resolves
// into one of them and the allowlist would otherwise refuse the whole distro:
// both are root-owned immutable stores (/nix/store is 1775, sticky rather than
// world-writable), so they are exactly as good a guarantee as /usr.
//
// `/Applications` is deliberately NOT a root. See `otherVpnClients`.
const POSIX_ROOTS = ['/usr', '/opt', '/bin', '/sbin', '/nix', '/snap', '/run/current-system']

/** Drops empties and duplicates, preserving order. */
function dedupe(values: (string | undefined)[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    if (!v) continue
    const key = v.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(v)
  }
  return out
}

/**
 * Windows program directories, read from the environment rather than spelled
 * out.
 *
 * `C:\Program Files` is the English name, on an English install, whose system
 * drive is C:. None of those three is guaranteed. And inside a 32-bit process
 * on 64-bit Windows `%ProgramFiles%` points at the *x86* tree, so
 * `%ProgramW6432%` is the only way to reach the 64-bit one from there. The
 * hard-coded pair stays as a last resort, not as the answer.
 */
export function winProgramRoots(): string[] {
  return dedupe([
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    'C:\\Program Files',
    'C:\\Program Files (x86)'
  ])
}

/** The Windows equivalent of `POSIX_ROOTS`: trees only an administrator can
 *  write, so a candidate that resolves inside one has not been planted. */
function winRoots(): string[] {
  return dedupe([...winProgramRoots(), process.env.SystemRoot, 'C:\\Windows'])
}

/** One `reg query` value, or undefined for a key or value that is not there.
 *  `name` empty reads the key's default value (`/ve`). */
function regQuery(key: string, name: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(
        'reg',
        ['query', key, ...(name ? ['/v', name] : ['/ve'])],
        { timeout: 5_000, windowsHide: true, maxBuffer: 1 << 20 },
        (err, stdout) => {
          if (err) return resolve(undefined)
          // `reg query` prints a blank line, the key, then one indented
          // "<name>    REG_SZ    <value>" per value. The default value prints
          // under the name `(Default)`.
          const m = String(stdout ?? '').match(
            /^\s+(?:\(Default\)|\S+)\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)$/m
          )
          resolve(m?.[1]?.trim() || undefined)
        }
      )
    } catch {
      resolve(undefined)
    }
  })
}

/**
 * What the OpenVPN Community installer recorded about itself.
 *
 * This is the authoritative answer, and the only one that survives an install
 * to a non-default directory. `HKLM\SOFTWARE\OpenVPN` is world-readable and
 * administrator-writable — which is exactly why a path from it is worth more
 * than a path we guessed — and is the same key the official GUI reads for its
 * own `exe_path` and `config_dir`. A 32-bit installer on 64-bit Windows lands
 * under `WOW6432Node` instead, so both are asked.
 */
export async function openVpnRegistryPaths(): Promise<{ exe: string[]; configDirs: string[] }> {
  if (process.platform !== 'win32') return { exe: [], configDirs: [] }
  const exe: (string | undefined)[] = []
  const configDirs: (string | undefined)[] = []
  for (const key of ['HKLM\\SOFTWARE\\OpenVPN', 'HKLM\\SOFTWARE\\WOW6432Node\\OpenVPN']) {
    const [exePath, installDir, configDir] = await Promise.all([
      regQuery(key, 'exe_path'),
      regQuery(key, ''),
      regQuery(key, 'config_dir')
    ])
    exe.push(exePath)
    // The key's default value is the install directory; `bin\openvpn.exe`
    // under it is the layout the installer has always produced.
    if (installDir) exe.push(join(installDir, 'bin', 'openvpn.exe'))
    configDirs.push(configDir)
    if (installDir) configDirs.push(join(installDir, 'config'))
  }
  return { exe: dedupe(exe), configDirs: dedupe(configDirs) }
}

/**
 * OpenVPN Connect — the official GUI client, and what the reporter had
 * installed — puts itself in `<ProgramFiles>\OpenVPN Connect`. Its own CLI
 * (`ovpnconnect.exe`) is deliberately NOT returned: it takes an entirely
 * different command line from `openvpn`, so handing it to the driver would
 * swap "not found" for a launch that fails in a stranger way. What is wanted
 * is the `openvpn.exe` core binary shipped alongside it, and which
 * subdirectory holds that has moved between versions — so this is a bounded
 * scan for that one file name, one level down, inside a directory only an
 * administrator can write, rather than a guess at the current layout.
 */
async function scanFor(dir: string, exe: string, depth = 1): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: string[] = []
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isFile()) {
      if (e.name.toLowerCase() === exe) out.push(full)
    } else if (e.isDirectory() && depth > 0) {
      out.push(...(await scanFor(full, exe, depth - 1)))
    }
  }
  return out
}

/** A place to look, and any root the ordinary allowlist would not cover. */
interface Candidate {
  path: string
  /** Set only for a registry-reported install: HKLM is administrator-only, so
   *  a directory it names is as trustworthy as `%ProgramFiles%` even when it
   *  is on another drive. Everything else is inside `winRoots()` already. */
  extraRoots?: string[]
}

/**
 * Other people's VPN clients, detected but never executed.
 *
 * Tunnelblick, Viscosity and OpenVPN Connect all ship an `openvpn` of their
 * own, and running THEIRS is a bad idea for three separate reasons:
 *
 *  - It is a private implementation detail of that app. Tunnelblick's copies
 *    are version-suffixed (`openvpn/openvpn-2.6.14-openssl-3.5.4/openvpn`) and
 *    several sit side by side, so picking one is picking an OpenVPN version on
 *    the user's behalf, and the path a profile stored yesterday is gone after
 *    that app updates itself tonight.
 *  - `/Applications` is writable by any administrator account without
 *    authenticating, which is the exact property `POSIX_ROOTS` exists to
 *    require. Adding it as a root to reach one binary would weaken the check
 *    for every binary.
 *  - OpenVPN Connect's CLI (`ovpnconnect.exe`, and the macOS equivalent) is
 *    not a drop-in for `openvpn` at all: different arguments entirely.
 *
 * So they are detected and named, and nothing more. "Tunnelblick is installed,
 * but OpsMaxx needs an `openvpn` program of its own" is a sentence somebody
 * can act on; "not found" on a machine with a working VPN client in the Dock
 * reads as OpsMaxx being broken.
 */
export async function otherVpnClients(): Promise<string[]> {
  const probes: [string, string][] =
    process.platform === 'darwin'
      ? [
          ['Tunnelblick', '/Applications/Tunnelblick.app'],
          ['Viscosity', '/Applications/Viscosity.app'],
          ['OpenVPN Connect', '/Applications/OpenVPN Connect/OpenVPN Connect.app'],
          ['OpenVPN Connect', '/Applications/OpenVPN Connect.app']
        ]
      : process.platform === 'win32'
        ? winProgramRoots().flatMap((root): [string, string][] => [
            ['OpenVPN Connect', join(root, 'OpenVPN Connect')],
            ['OpenVPN', join(root, 'OpenVPN')],
            ['WireGuard', join(root, 'WireGuard')]
          ])
        : // Linux has no app-bundle convention to look in, and a packaged
          // client puts its binary on PATH — where the resolver already looks.
          []
  const found: string[] = []
  for (const [label, path] of probes) {
    if (found.includes(label)) continue
    if (await stat(path).then(() => true, () => false)) found.push(label)
  }
  return found
}

/**
 * Tunnel interfaces that already have an address, from `os.networkInterfaces()`
 * — no process spawned, no privilege needed.
 *
 * What this DOES tell us: something on this machine already has a tunnel up,
 * so a second one may fight it for the default route or, on Windows, for the
 * single TAP adapter a `dev tun` profile wants.
 *
 * What it does NOT tell us, and no cheap check can: which application owns it,
 * whether it is the same profile we are about to start, or whether the two
 * would actually conflict. Two tunnels to different networks coexist fine.
 * So this is reported and never acted on — nothing here refuses a start or
 * tries to take an interface over.
 */
export function activeTunnelInterfaces(): string[] {
  const ifaces = networkInterfaces()
  return Object.entries(ifaces)
    .filter(([name, addrs]) => /^(utun|tun|tap|wg|ppp)\d*/i.test(name) && (addrs?.length ?? 0) > 0)
    .map(([name]) => name)
    .sort()
}

// One `reg query` pair and two directory scans per resolve is fine once and
// wasteful on a UI poll, so the answer is held for the app run like the
// bundled hashes above it. Cleared by `resetBinaryCache()`.
let winCandidateCache: Map<string, Candidate[]> | null = null

async function winCandidates(name: string): Promise<Candidate[]> {
  const cached = winCandidateCache?.get(name)
  if (cached) return cached
  const out: Candidate[] = []
  if (name === 'openvpn') {
    const reg = await openVpnRegistryPaths()
    // Registry first: every other entry below is a guess at a layout, and
    // this one is the installer's own record of what it did.
    for (const p of reg.exe) out.push({ path: p, extraRoots: [dirname(dirname(p))] })
    const roots = winProgramRoots()
    for (const root of roots) out.push({ path: join(root, 'OpenVPN', 'bin', 'openvpn.exe') })
    for (const root of roots) {
      for (const p of await scanFor(join(root, 'OpenVPN Connect'), 'openvpn.exe')) {
        out.push({ path: p })
      }
    }
  }
  const seen = new Set<string>()
  const unique = out.filter((c) => {
    const key = c.path.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  ;(winCandidateCache ??= new Map()).set(name, unique)
  return unique
}

// Which build script produces which engine. Named in the "it is not here"
// message, because "run scripts/build-sidecar.sh" — which this used to say for
// every engine — sends someone chasing a missing OpenVPN with the WireGuard
// build. An unknown name falls back to `npm run build:engines`, which is
// always right and only less specific.
const BUILD_SCRIPT: Record<string, string> = {
  'opsmaxx-netd': 'scripts/build-sidecar.sh',
  frpc: 'scripts/build-frpc.sh',
  openvpn: 'scripts/build-openvpn.sh'
}

// Verification is per app run, not per spawn: a supervised engine restarts on
// backoff and re-hashing a 30 MB sidecar on every restart would be pure cost.
// The manifest itself is cached one level down, in `bundledBinary`.
const bundledCache = new Map<string, VpnEngineInfo>()

/** Drops the per-run caches. Tests use it between fixture trees; production
 *  never calls it, which is the point of caching per run. */
export function resetBinaryCache(): void {
  bundledCache.clear()
  winCandidateCache = null
  // The lifted module holds the parsed manifest now, and a test that swaps
  // fixture trees has to clear both or the second tree is verified against the
  // first tree's hashes.
  forgetManifest()
}

// Re-exported rather than moved out of reach: the supervisor and the resolver
// tests both import it from here, and a lift that renames every call site is a
// lift that touches files it had no reason to.
export { sha256File }

function kindOf(name: string): VpnKind {
  const base = name.endsWith('.exe') ? name.slice(0, -4) : name
  const kind = ENGINE_KIND[base]
  if (!kind) throw new VpnError('internal', `Unknown VPN engine binary ${JSON.stringify(name)}.`)
  return kind
}

/**
 * Locate and integrity-check a binary OpsMaxx ships. Throws rather than
 * returning an unavailable `VpnEngineInfo` so a caller cannot accidentally
 * treat a tampered binary as merely absent; `VpnDriver.probe()` catches and
 * shapes it for the UI.
 */
export async function resolveBundled(name: string): Promise<VpnEngineInfo> {
  const cached = bundledCache.get(name)
  if (cached) return cached

  // `kindOf` first, and deliberately: it throws for a name this module does not
  // own, which is what stops a caller resolving an arbitrary binary through the
  // VPN path. A sidecar that is not an engine goes straight to
  // `resolveBundledBinary` rather than being given a kind it has no business
  // having.
  const kind = kindOf(name)

  let resolved: BundledBinary
  try {
    resolved = await resolveBundledBinary(name, BUILD_SCRIPT[name] ?? 'npm run build:engines')
  } catch (err) {
    // The lifted resolver's two reasons map onto this module's two codes.
    // Keeping the mapping here rather than down there is what lets the VPN
    // layer keep its own vocabulary while sharing the check itself.
    if (err instanceof BundledBinaryError) {
      throw new VpnError(err.reason === 'untrusted' ? 'binary-untrusted' : 'binary-missing', err.message)
    }
    throw err
  }

  const info: VpnEngineInfo = {
    kind,
    available: true,
    path: resolved.path,
    sha256: resolved.sha256,
    version: resolved.version ?? (await probeVersion(resolved.path)),
    bundled: true
  }
  bundledCache.set(name, info)
  return info
}

export interface SystemResolveOptions {
  /** An absolute path the user typed into the profile. */
  binaryPath?: string
  /** Whether the user confirmed that path in the UI. An unconfirmed path is
   *  ignored: a `binaryPath` that arrived inside an imported `.ovpn` is the
   *  file's opinion about what to execute, not the user's (E44). */
  confirmed?: boolean
}

/**
 * Locate an engine the user supplies. Ordered: the confirmed override, then a
 * fixed per-OS allowlist, then — on POSIX only — `PATH`.
 */
export async function resolveSystem(
  name: string,
  opts: SystemResolveOptions = {}
): Promise<VpnEngineInfo> {
  const kind = kindOf(name)
  const win32 = process.platform === 'win32'
  const roots = win32 ? winRoots() : POSIX_ROOTS

  if (opts.binaryPath) {
    if (!opts.confirmed) {
      throw new VpnError(
        'config-invalid',
        `The program path ${opts.binaryPath} has not been confirmed, so it was not run.`
      )
    }
    // A rejected override is reported rather than skipped: the user asked for
    // this exact file, and silently falling through to a different one would
    // run something they did not choose.
    const problem = await checkExecutable(opts.binaryPath, [dirname(opts.binaryPath), ...roots])
    if (problem) throw new VpnError('config-invalid', `${opts.binaryPath} ${problem}`)
    return describe(kind, opts.binaryPath)
  }

  const candidates: Candidate[] = win32
    ? await winCandidates(name)
    : (SYSTEM_CANDIDATES[name]?.posix ?? []).map((path) => ({ path }))
  // "Nothing is there" and "something is there and we would not run it" are
  // different problems with different fixes, and reporting them as one
  // sentence sent people to reinstall a program they already had.
  const refused: string[] = []
  for (const candidate of candidates) {
    const problem = await checkExecutable(candidate.path, [
      ...(candidate.extraRoots ?? []),
      ...roots
    ])
    if (!problem) return describe(kind, candidate.path)
    // `does not exist` is the ordinary case on any machine without this
    // engine, and listing forty of them buries the one that matters.
    if (!problem.startsWith('does not exist')) refused.push(`${candidate.path} ${problem}`)
  }

  // No PATH search on Windows, ever. `PATH` there routinely contains
  // per-user, user-writable directories, and the current directory has
  // historically been searched as well, so a PATH hit is not evidence that
  // the administrator installed anything (E44).
  if (!win32) {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (!dir) continue
      const candidate = join(dir, name)
      if (await checkExecutable(candidate, [dir, ...roots])) continue
      return describe(kind, candidate)
    }
  }

  // Where it looked, and nothing else. What to do about it — install the
  // engine, or point the profile at a copy — used to be tacked on here, which
  // put four sentences of advice in a toast with no control in it. The UI
  // renders the code's hint and a button that performs it, and shows this
  // detail behind a Details disclosure for whoever actually wants the paths.
  const where = candidates.length
    ? candidates.map((c) => c.path).join(', ')
    : 'the standard install locations'
  const parts = [
    win32
      ? `Looked in ${where}. OpsMaxx does not search PATH on Windows.`
      : `Looked in ${where} and on PATH.`
  ]
  // The distinction the reader needs first: a refused candidate means the
  // program IS installed, and no amount of installing it again will help.
  if (refused.length) parts.push(`Found but not used: ${refused.join('; ')}.`)
  const others = await otherVpnClients()
  if (others.length) {
    parts.push(
      `${others.join(' and ')} ${others.length > 1 ? 'are' : 'is'} installed, but ${
        others.length > 1 ? 'their' : 'its'
      } copy of OpenVPN belongs to that app and OpsMaxx does not run it.`
    )
  }
  parts.push(await installAdvice(name))
  throw new VpnError('binary-missing', parts.filter(Boolean).join(' '))
}

/** How to get this engine on THIS machine, in one sentence.
 *
 *  Windows says nothing: `installHint` in the OpenVPN driver already prints
 *  the full openvpn.net paragraph there — it is the one platform with no
 *  bundled copy — and two install instructions in one toast contradict each
 *  other about which to follow. */
async function installAdvice(name: string): Promise<string> {
  if (name !== 'openvpn' || process.platform === 'win32') return ''
  // AND NOT WHERE OPSMAXX SHIPS ONE.
  //
  // On macOS and Linux the bundled copy is the intended path, so reaching the
  // system search there means the bundled binary is missing — a build or
  // packaging state, not something the user failed to install. Telling them to
  // `brew install openvpn` sends them to fix the wrong thing, and the message
  // already ends with the real escape hatch: point the profile at a copy they
  // installed themselves. tests/vpnOpenvpnDriver.test.ts pins this, and its
  // comment says it plainly — "installing OpenVPN is not what fixes it".
  //
  // The distribution detection below is kept rather than deleted: it is the
  // correct answer for any engine on any platform OpsMaxx does not bundle for,
  // which is the case this whole branch exists to serve.
  if (isEngineBundledOn(name, process.platform)) return ''
  if (process.platform === 'darwin') return 'You can install one with `brew install openvpn`.'
  // The package is called `openvpn` on every family that ships it; the only
  // thing that varies is the command that installs it. Read from the file the
  // distributions themselves standardised on rather than guessed at.
  const release = await readFile('/etc/os-release', 'utf8').catch(() => '')
  const ids = `${/^ID=(.*)$/m.exec(release)?.[1] ?? ''} ${/^ID_LIKE=(.*)$/m.exec(release)?.[1] ?? ''}`
    .replace(/["']/g, '')
    .toLowerCase()
  const families: [RegExp, string][] = [
    [/\b(debian|ubuntu)\b/, 'sudo apt install openvpn'],
    [/\b(fedora|rhel|centos)\b/, 'sudo dnf install openvpn'],
    [/\b(arch|archlinux)\b/, 'sudo pacman -S openvpn'],
    [/\balpine\b/, 'sudo apk add openvpn'],
    [/\b(suse|opensuse)\b/, 'sudo zypper install openvpn']
  ]
  const install = families.find(([pattern]) => pattern.test(ids))?.[1]
  // NixOS and anything unrecognised land here: naming a command that does not
  // exist on the machine is worse than naming the package and stopping.
  return install
    ? `You can install one with \`${install}\`.`
    : "You can install your distribution's `openvpn` package."
}

/**
 * Locate an engine: the copy OpsMaxx ships if there is one, otherwise the
 * copy the user installed.
 *
 * The order is not symmetric, and each step is a separate decision:
 *
 *  1. **A confirmed `binaryPath` wins outright.** The user pointed at a file;
 *     running a different one instead would be answering a question they did
 *     not ask. Unconfirmed paths are still refused by `resolveSystem` (E44).
 *  2. **Then the bundled copy.** We built it, we know its bytes, and the
 *     manifest check runs before the first exec. A system install can be any
 *     version, patched or not, and on Windows arrives from a `PATH` we refuse
 *     to search at all.
 *  3. **Then the system allowlist.** OpsMaxx ships `openvpn` on macOS and
 *     Linux only, so on Windows this is the sole path — and on the other two
 *     it still serves the person who deliberately runs their distribution's
 *     build.
 *
 * A bundled binary that *exists* but fails its hash check is a tamper, and
 * that error is rethrown rather than falling through: silently running a
 * different copy would turn the one signal we have into nothing at all.
 */
export async function resolveEngineBinary(
  name: string,
  opts: SystemResolveOptions = {}
): Promise<VpnEngineInfo> {
  if (opts.binaryPath) return withAdvisories(resolveSystem(name, opts))
  // Nothing to look for, so nothing to report about not finding it. Reporting
  // "run scripts/build-openvpn.sh" on Windows would send the reader to build a
  // target that does not exist.
  // `process.platform` read here rather than inside the predicate, so the
  // resolver tests that stub it still drive this decision.
  if (!isEngineBundledOn(name, process.platform)) return withAdvisories(resolveSystem(name, opts))

  let bundledProblem: string
  try {
    // The bundled copy needs this as much as a system one — arguably more:
    // OpsMaxx ships its own openvpn on macOS and Linux, which is exactly
    // where Tunnelblick and Viscosity also live.
    return await withAdvisories(resolveBundled(name))
  } catch (e) {
    if (e instanceof VpnError && e.code === 'binary-untrusted') throw e
    // `detail`, not `message`: the message already carries the generic
    // "could not be found" sentence, and the error thrown below adds it back.
    bundledProblem = detailOf(e)
  }

  try {
    return await withAdvisories(resolveSystem(name, opts))
  } catch (e) {
    // Both halves in one detail. Reporting only the second would say "install
    // openvpn" on a build that was supposed to ship one, which sends the
    // reader to fix the wrong thing.
    throw new VpnError('binary-missing', `${bundledProblem} ${detailOf(e)}`)
  }
}

/** Attach the coexistence notes to a resolved engine. Never fails the
 *  resolve: an advisory that cannot be computed is not a reason to refuse a
 *  binary that was found. */
async function withAdvisories(info: Promise<VpnEngineInfo>): Promise<VpnEngineInfo> {
  const resolved = await info
  const advisories = await coexistenceAdvisories().catch(() => [])
  return advisories.length ? { ...resolved, advisories } : resolved
}

function detailOf(e: unknown): string {
  if (e instanceof VpnError) return e.detail ?? e.message
  return e instanceof Error ? e.message : String(e)
}

async function describe(kind: VpnKind, path: string): Promise<VpnEngineInfo> {
  // The real path is what actually executes, so that is what gets hashed and
  // reported: auditing the symlink would audit the wrong bytes.
  const real = await realpath(path)
  return {
    kind,
    available: true,
    path: real,
    sha256: await sha256File(real),
    version: await probeVersion(real),
    bundled: false
  }
}

/** What else on this machine might be in the way. Empty on the ordinary
 *  machine, which is why it is a list and not a flag.
 *
 *  Deliberately NOT stored on the cached `VpnEngineInfo`: which interfaces
 *  are up changes while the app is open, and a cached "a tunnel is already
 *  running" is wrong within seconds of the user stopping it. Recomputed by
 *  `resolveEngineBinary` on every call instead — two dozen `stat`s and one
 *  synchronous stdlib read. */
export async function coexistenceAdvisories(): Promise<string[]> {
  const out: string[] = []
  const others = await otherVpnClients()
  if (others.length) {
    out.push(
      `${others.join(', ')} ${others.length > 1 ? 'are' : 'is'} also installed. ` +
        'Running the same profile in both at once will not work — stop one before starting the other.'
    )
  }
  const up = activeTunnelInterfaces()
  if (up.length) {
    out.push(
      `${up.join(', ')} already ${up.length > 1 ? 'have addresses' : 'has an address'}, ` +
        'so something on this machine has a tunnel up. OpsMaxx cannot tell what owns it; ' +
        'if both claim the default route, the last one to start wins.'
    )
  }
  return out
}

/** Returns a sentence describing why the candidate is unacceptable, or null
 *  when it is fine. Phrased as a fragment so callers can prefix the path. */
/**
 * Clients that are NOT the engine, however much they look like it.
 *
 * OpenVPN Connect is the official GUI client and ships `OpenVPNConnect.exe`
 * beside a CLI called `ovpnconnect.exe`. Neither takes openvpn's command line.
 * The driver spawns with `--config`, `--management`, `--management-client`,
 * `--management-hold`, `--pull-filter` and `--auth-nocache`, and then WAITS for
 * the tunnel to dial back on a management socket it opened first — that
 * channel is how a vault credential reaches openvpn without touching a
 * command line or a file, so it is not optional.
 *
 * Nothing checked the name. A hand-typed path to the GUI passed every test
 * here (absolute, exists, inside Program Files, a non-empty file) and on
 * Windows this function returns before any of the POSIX checks, so the profile
 * saved, the engine reported AVAILABLE, and Start produced a UAC prompt, a GUI
 * window, and sixty seconds later `handshake-timeout` — "openvpn did not
 * connect within 60s" — which names nothing that happened.
 *
 * The scan in `winCandidates` already refuses to OFFER these; this refuses to
 * accept one typed in by hand, which is the path a user takes precisely when
 * detection has found nothing and they are looking for something plausible.
 */
const NOT_THE_ENGINE: Record<string, string> = {
  'openvpnconnect.exe': 'OpenVPN Connect',
  'ovpnconnect.exe': 'the OpenVPN Connect CLI'
}

async function checkExecutable(candidate: string, allowedRoots: string[]): Promise<string | null> {
  if (!isAbsolute(candidate)) return 'is a relative path, which depends on the working directory.'

  // Before touching the disk: this is about WHICH PROGRAM it is, and the
  // answer does not change with whether the file happens to be readable.
  const named = NOT_THE_ENGINE[basename(candidate).toLowerCase()]
  if (named) {
    return (
      `is ${named}, which cannot run tunnels for OpsMaxx. It does not accept openvpn's ` +
      'command line and has no management interface, so credentials could not be handed to it ' +
      'and a connection would simply time out. Point this at the community `openvpn.exe` — ' +
      'usually C:\\Program Files\\OpenVPN\\bin\\openvpn.exe — or clear the field to use an ' +
      'allowlisted system install.'
    )
  }

  let real: string
  try {
    real = await realpath(candidate)
  } catch {
    return 'does not exist.'
  }

  // The roots are realpath'd too. On macOS the temp and /var trees are
  // themselves symlinks, so comparing a resolved file against an unresolved
  // root would report an escape for every legitimate path.
  const roots = await Promise.all(allowedRoots.map((r) => realpath(r).catch(() => r)))
  if (!roots.some((root) => isInside(real, root))) {
    return `resolves to ${real}, which is outside ${allowedRoots.join(', ')}.`
  }

  const st = await stat(real).catch(() => null)
  if (!st || !st.isFile()) return 'is not a file.'
  if (st.size === 0) return 'is empty, which is what antivirus quarantine leaves behind.'

  // POSIX modes are not meaningful on Windows — every file reports 0666 — so
  // checking them there would reject everything for no gain. NTFS ACLs are
  // the equivalent check and are left to the allowlisted-root constraint.
  if (process.platform === 'win32') return null

  if ((st.mode & 0o111) === 0) return 'is not executable.'

  // Anyone who can write the directory can replace the file in it, so a
  // world-writable ancestor makes the hash we just took meaningless. The
  // sticky bit does not help: /tmp is sticky and still lets anyone create.
  for (let dir = dirname(real); ; dir = dirname(dir)) {
    const dst = await stat(dir).catch(() => null)
    if (dst && (dst.mode & 0o002) !== 0) {
      return `is inside the world-writable directory ${dir}, so any user could replace it.`
    }
    if (dirname(dir) === dir) break
  }
  return null
}

function isInside(child: string, root: string): boolean {
  const norm = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)
  const rel = relative(norm(root), norm(child))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** First non-empty line of `<binary> --version`, or undefined. Best effort:
 *  the version is shown in the UI and audited on change, but nothing refuses
 *  to run without it. */
function probeVersion(file: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    // OpenVPN exits 1 from `--version`, so the exit code is deliberately
    // ignored and only the output is read. ENOEXEC — a file that is executable
    // but is not a program for this machine — throws out of spawn rather than
    // arriving at the callback, and must not take the whole resolve down with
    // it: the version is decoration, the hash is the check that matters.
    try {
      execFile(
        file,
        ['--version'],
        { timeout: 5_000, windowsHide: true, maxBuffer: 1 << 20 },
        (_err, stdout, stderr) => {
          const line = `${stdout}\n${stderr}`
            .split(/\r?\n/)
            .map((s) => s.trim())
            .find(Boolean)
          resolve(line || undefined)
        }
      )
    } catch {
      resolve(undefined)
    }
  })
}
