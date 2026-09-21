import { execFile } from 'node:child_process'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { VpnEngineInfo, VpnKind } from '../../../shared/vpn'
import { isEngineBundledOn } from '../../../shared/vpnEngines'
import { VpnError } from './errors'
import { readCommand } from './netstate'
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
          ['OpenVPN Connect', '/Applications/OpenVPN Connect.app'],
          // The official WireGuard client, which Windows has looked for since
          // this function was written and macOS did not. It brings no
          // `openvpn` with it, so it is here for the coexistence warning only
          // — `openVpnClientSentence` drops it for exactly that reason.
          ['WireGuard', '/Applications/WireGuard.app']
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
 * "Tunnelblick is installed, but its copy of OpenVPN belongs to that app", or
 * empty when no such app is here. Composed once because both ways of failing
 * to resolve an engine need it — see `resolveSystem`.
 *
 * WireGuard is dropped, and only here: it is worth naming as a tunnel client
 * that may already be up (`coexistenceAdvisories`), but it ships no `openvpn`
 * at all, so telling someone its copy of OpenVPN belongs to that app names a
 * file that does not exist and sends them hunting for it.
 */
async function openVpnClientSentence(): Promise<string> {
  const others = (await otherVpnClients()).filter((label) => label !== 'WireGuard')
  if (!others.length) return ''
  return (
    `${others.join(' and ')} ${others.length > 1 ? 'are' : 'is'} installed, but ${
      others.length > 1 ? 'their' : 'its'
    } copy of OpenVPN belongs to that app and OpsMaxx does not run it.`
  )
}

/** What a tunnel interface is called, on every platform OpsMaxx runs on.
 *  Shared by the two sources below so they cannot drift into disagreeing
 *  about which names count. */
const TUNNEL_NAME = /^(utun|tun|tap|wg|ppp)\d*/i

/**
 * The destinations that mean "this interface is taking the traffic".
 *
 * `0/1` + `128.0/1` is a default route in disguise, and it is what a
 * full-tunnel VPN actually installs: the pair covers the whole address space
 * at a longer prefix than `default`, so it wins on specificity without ever
 * replacing the route it is beating. Measured on a Mac with OpenVPN up:
 *
 *     0/1        10.107.0.1   UGScg   utun6
 *     128.0/1    10.107.0.1   UGSc    utun6
 *
 * `default` itself is here for the tunnels that do replace it outright.
 *
 * A literal set rather than a pattern: `netstat` trims trailing zero octets,
 * but not on every macOS version, so both spellings of the same two routes
 * have to be named. Matching the prefix length with a regex instead would
 * start accepting `64.0/2` and every other partial route a policy VPN adds.
 */
const DEFAULT_ROUTE_DESTINATIONS = new Set([
  'default',
  '0.0.0.0/0',
  '0/1',
  '0.0.0.0/1',
  '128.0/1',
  '128.0.0.0/1'
])

/**
 * Tunnel interfaces named as the `Netif` of a default route in
 * `netstat -rn -f inet` output.
 *
 * Exported for `tests/vpnTunnelRoutes.test.ts`, which drives it with real
 * captures rather than with a live machine.
 *
 * `routing/darwin.ts` says `netstat -rn` is not used there, and that is still
 * right for what it is doing: it needs to turn a destination back into a
 * prefix, and netstat's classful abbreviations ("127" for 127.0.0.0/8) cannot
 * be. Nothing here reconstructs a prefix. It compares the destination against
 * a fixed set of spellings and reads the interface column, which the
 * abbreviation does not touch.
 *
 * Never throws: it is on the path of every engine resolve, and a routing table
 * that does not parse must cost an advisory rather than a VPN connection.
 */
export function defaultRouteTunnels(routeTable: string): string[] {
  const out = new Set<string>()
  for (const line of routeTable.split(/\r?\n/)) {
    // Destination, Gateway, Flags, Netif, and Expire — which is the column
    // that may be missing, so Netif is always the fourth and never the last.
    const cols = line.trim().split(/\s+/)
    if (cols.length < 4) continue
    if (!DEFAULT_ROUTE_DESTINATIONS.has(cols[0])) continue
    // The `Netif` filter is what keeps the ordinary `default -> en0` that
    // every networked machine has out of the answer. Without it this would
    // report a tunnel on every render, which is the same false positive
    // `carriesTraffic` below was written to kill.
    if (TUNNEL_NAME.test(cols[3])) out.add(cols[3])
  }
  return [...out].sort()
}

/**
 * The route read, held briefly.
 *
 * `activeTunnelInterfaces` is called from `resolveEngineBinary`, which is a UI
 * poll, and a subprocess per poll is not acceptable for an advisory.
 *
 * Held BRIEFLY and deliberately not for the app run like `winCandidateCache`
 * below. Which tunnels are up changes while the app is open, and
 * `coexistenceAdvisories` exists on the promise that it is recomputed rather
 * than stored — a per-run answer would go on saying "a tunnel is already up"
 * for the rest of the session after the user stopped it, which is the failure
 * that comment warns about in as many words. Five seconds is short enough that
 * nobody reads a stale claim and long enough that a poll is not a spawn.
 *
 * The PROMISE is cached, not the value, so two polls that overlap share one
 * netstat instead of racing to start two. Cleared by `resetBinaryCache()`.
 */
const ROUTE_CACHE_MS = 5_000
let routeCache: { at: number; tunnels: Promise<string[]> } | null = null

function readRouteTunnels(): Promise<string[]> {
  return readCommand(
    // Absolute, never a bare name. This module's header says the PATH search
    // IS the vulnerability, and `elevation/win32.ts` sets the same precedent:
    // a writable PATH entry ahead of /usr/sbin would otherwise choose what
    // runs here.
    '/usr/sbin/netstat',
    ['-rn', '-f', 'inet'],
    // Short, because the caller is a poll. `readCommand` never rejects, so a
    // netstat that is missing, renamed or hung arrives as a non-zero code and
    // costs the advisory rather than the resolve.
    { timeoutMs: 2_000 }
  )
    .then((res) => (res.code === 0 ? defaultRouteTunnels(res.stdout) : []))
    // `readCommand` documents that it never rejects and `defaultRouteTunnels`
    // never throws, so this catches nothing today. It is here because the
    // promise is CACHED: a rejection would be handed to every caller for the
    // next five seconds, and the one thing this must not do is fail a resolve.
    .catch(() => [])
}

async function routeTunnels(): Promise<string[]> {
  // macOS only. NetworkExtension is a macOS framework; on Linux and Windows a
  // tunnel is an ordinary interface the stdlib already sees, so a subprocess
  // there would buy nothing and `netstat -rn -f inet` is not even the same
  // command. Read at call time, like the other platform checks in this file,
  // so the resolver tests that stub `process.platform` still drive it.
  if (process.platform !== 'darwin') return []
  const now = Date.now()
  if (routeCache && now - routeCache.at < ROUTE_CACHE_MS) return routeCache.tunnels
  routeCache = { at: now, tunnels: readRouteTunnels() }
  return routeCache.tunnels
}

/**
 * Tunnel interfaces that already carry traffic: the ones with a routable
 * address, plus — on macOS — the ones that own a default route.
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
 *
 * ── WHY THERE ARE TWO SOURCES ───────────────────────────────────────────────
 *
 * `os.networkInterfaces()` does not expose a macOS NetworkExtension tunnel.
 * Measured twice, minutes apart, on a Mac with a live full-tunnel OpenVPN
 * connection: `ifconfig` showed utun6 with `inet 10.107.0.60 --> 10.107.0.1`
 * while `os.networkInterfaces()` listed utun0–utun5 and nothing else. utun6
 * was absent from it entirely. The second sample had a utun7 instead, and it
 * was absent too.
 *
 * The reason is the NetworkExtension framework: the tunnel belongs to
 * `/usr/libexec/nesessionmanager` rather than to any `openvpn` process, and
 * that is how OpenVPN Connect v3 and every App Store VPN work on a modern
 * macOS. So on the platform where the coexistence warning matters most, the
 * ordinary case was the one this could not see at all.
 *
 * The routing table closes that, and is the better signal anyway: the warning's
 * own sentence is about the default route, and the route is what decides the
 * fight it describes. The two are MERGED rather than one replacing the other,
 * because neither is a superset — a tunnel an application runs as its own
 * process (a plain `openvpn`, `wg-quick`) has an address Node can see, and a
 * NetworkExtension one has only a route.
 *
 * `-f inet` is not a detail. The inet6 table on a stock Mac with NO VPN at all
 * carries `default -> utun0` through `default -> utun5`, one per iCloud Private
 * Relay / AWDL / Continuity tunnel — so reading it would resurrect, exactly,
 * the every-Mac false positive that `carriesTraffic` below was written to kill.
 * The inet table on that same machine has no tunnel row at all.
 *
 * ── AN EMPTY RESULT IS STILL NOT EVIDENCE THAT NOTHING IS RUNNING ───────────
 *
 * Narrower than it was, and still true. What remains invisible is a macOS
 * split-tunnel NetworkExtension VPN: it claims no default route, so the route
 * table does not name it, and it shows no address, so the stdlib does not
 * either. Route-based detection cannot be widened to catch it without
 * reporting a tunnel for every partial route a policy VPN installs.
 *
 * So the honest reading stays asymmetric, and every caller has to keep it that
 * way: a NAME here means a tunnel really is up, and an EMPTY LIST means only
 * that none was visible. Nothing may say "no other VPN is running" on the
 * strength of it — which is why the caller stays silent on empty rather than
 * reporting an all-clear.
 */
export async function activeTunnelInterfaces(): Promise<string[]> {
  const addressed = Object.entries(networkInterfaces())
    .filter(([name, addrs]) => TUNNEL_NAME.test(name) && (addrs ?? []).some(carriesTraffic))
    .map(([name]) => name)
  return [...new Set([...addressed, ...(await routeTunnels())])].sort()
}

/**
 * Whether this address means the interface is carrying traffic somewhere.
 *
 * "Has any address at all" is not that test, and on macOS it is never true of
 * nothing: a stock Mac holds utun0 through utun5 open for iCloud Private
 * Relay, AWDL/Handoff and Continuity, each with a single `fe80::` link-local
 * address and no route off the machine. Under the old check every macOS user
 * with an OpenVPN profile was told, permanently and on every render, that
 * "utun0, utun1, utun2, utun3, utun4, utun5 already have addresses, so
 * something on this machine has a tunnel up" — an advisory that was false on
 * every Mac and therefore trained people to ignore the true one. The real
 * tunnel on the same machine was utun6, `inet 10.107.0.60 --> 10.107.0.1`.
 *
 * A routable address is what separates them: link-local (`fe80::/10`, and its
 * IPv4 equivalent `169.254.0.0/16`, which is what an interface gets when
 * nothing assigned it one) reaches only the link it is on, and `internal`
 * marks a loopback that reaches only this host.
 */
function carriesTraffic(addr: { address: string; internal: boolean }): boolean {
  if (addr.internal) return false
  const a = addr.address.toLowerCase()
  // fe80:: through febf:: is the whole of fe80::/10, so the first two nibbles
  // are not enough on their own to decide it.
  return !/^fe[89ab]/.test(a) && !a.startsWith('169.254.')
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
  // The route read too, or a test that sets up a second routing-table fixture
  // is answered from the first one for five seconds and passes or fails for a
  // reason that has nothing to do with what it set up.
  routeCache = null
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
    if (problem) {
      // The same sentence the "nothing was found" branch composes, and for a
      // more pressing reason. That message is what the UI turns into a "Set
      // the path" button; someone who presses it and then browses to the
      // `openvpn` inside Tunnelblick or OpenVPN Connect lands here — so the
      // one user who has already gone looking for another app's copy was the
      // only one never told why theirs will not be run.
      const others = await openVpnClientSentence()
      throw new VpnError(
        'config-invalid',
        [`${opts.binaryPath} ${problem}`, others].filter(Boolean).join(' ')
      )
    }
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
  parts.push(loginPathCaveat(name))
  parts.push(await openVpnClientSentence())
  parts.push(await installAdvice(name))
  throw new VpnError('binary-missing', parts.filter(Boolean).join(' '))
}

/**
 * Why a copy the user's own terminal finds may still not be found here.
 *
 * The PATH search above reads `process.env.PATH`, which is the PATH THIS
 * PROCESS was started with. A desktop-launched Electron app does not get the
 * login shell's: on macOS it inherits launchd's, which is frequently just
 * /usr/bin:/bin. So an openvpn from nix, asdf, or any custom prefix answers
 * `which openvpn` in a terminal and is invisible to this search — and the app
 * says "not installed" about a program the user is looking at. That is the
 * worst shape a bug report takes, so the message names the limitation instead
 * of leaving someone to deduce it.
 *
 * ── AND IS NOT FIXED BY READING THE LOGIN SHELL'S PATH ──────────────────────
 *
 * `localExec.ts` already has exactly the helper that would do it —
 * `resolveLoginPath`, which runs `$SHELL -l -c 'printf %s "$PATH"'` and caches
 * the answer. Importing it here fails tests/localTerminalNotExposed.test.ts on
 * two assertions, because this module is inside the import closure that test
 * keeps free of anything that runs a local command:
 *
 *   mcpServer.ts -> cicd/wiring.ts -> httpClient.ts -> netTransport.ts
 *     -> vpn/manager.ts -> vpn/supervisor.ts -> vpn/binaries.ts
 *
 * Lifting the helper into a neutral module would pass that guard — its argv is
 * fixed and it takes no command from any caller, which is the same property the
 * `services/cloud` widening is argued from. It still is not worth it. On macOS
 * and Linux `resolveSystem` is reached only after the BUNDLED openvpn has
 * already failed its hash or gone missing, and Windows never searches PATH at
 * all, so the fix would serve a fallback of a fallback while permanently
 * widening a boundary every future security review has to re-examine. The
 * sentence below costs nothing and reaches the same user.
 *
 * openvpn only, like `installAdvice`, and for the same kind of reason: "Set the
 * path" is rendered for this engine and no other (see the `engineMissing` block
 * in useVpnProfiles.tsx), so naming it on a WireGuard or frp failure would
 * point at a button that is not on the screen.
 */
function loginPathCaveat(name: string): string {
  // Not on Windows, which refuses the PATH search by design (E44) and says so
  // three lines up. Explaining that a search we did not do used the wrong PATH
  // would contradict the sentence next to it.
  if (name !== 'openvpn' || process.platform === 'win32') return ''
  return (
    'OpsMaxx searched the PATH it was started with, which is not your login shell’s — ' +
    'a desktop launcher hands the app the session’s PATH, so an openvpn installed by nix, ' +
    'asdf or into a custom prefix answers `which openvpn` in a terminal and is not found ' +
    'here. Use “Set the path” to point at it.'
  )
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
 *  Empty is also what a machine OpsMaxx cannot see into returns, and the two
 *  are not distinguishable from here — see `activeTunnelInterfaces`, which now
 *  reads the routing table as well but is still blind to a macOS split-tunnel
 *  NetworkExtension VPN. So the list says what was found and never that nothing
 *  is there. The UI renders it only when it is non-empty, which is the right
 *  shape for that: silence, not an all-clear.
 *
 *  Deliberately NOT stored on the cached `VpnEngineInfo`: which interfaces
 *  are up changes while the app is open, and a cached "a tunnel is already
 *  running" is wrong within seconds of the user stopping it. Recomputed by
 *  `resolveEngineBinary` on every call instead — two dozen `stat`s, one
 *  synchronous stdlib read, and a `netstat` held for five seconds so that the
 *  poll this sits on does not become a spawn. */
export async function coexistenceAdvisories(): Promise<string[]> {
  const out: string[] = []
  const others = await otherVpnClients()
  if (others.length) {
    out.push(
      `${others.join(', ')} ${others.length > 1 ? 'are' : 'is'} also installed. ` +
        'Running the same profile in both at once will not work — stop one before starting the other.'
    )
  }
  const up = await activeTunnelInterfaces()
  if (up.length) {
    out.push(
      `${up.join(', ')} already ${up.length > 1 ? 'carry' : 'carries'} traffic, ` +
        'so something on this machine has a tunnel up. OpsMaxx cannot tell what owns it; ' +
        'if both claim the default route, the last one to start wins. ' +
        // Said out loud because the reader is about to draw the wrong
        // conclusion from a short list. This used to say that a VPN macOS runs
        // for another app does not appear here at all, which was true until the
        // routing table was added as a second source and is now the opposite of
        // true — a stale caveat is worse than none, because it tells the reader
        // to discount the half of the answer that is usually the better one.
        // What is genuinely still missing is narrower, and named as such.
        'There may be others it cannot see: a split-tunnel VPN that claims ' +
        'neither the default route nor an address of its own does not appear here.'
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
  'ovpnconnect.exe': 'the OpenVPN Connect CLI',
  // The same two programs on macOS, where they carry no extension: the app's
  // executable inside `OpenVPN Connect.app/Contents/MacOS/` is named for the
  // app, space and all, and its CLI drops the `.exe`. A Mac user reaches for
  // these for the same reason a Windows user does — detection found nothing
  // and `/Applications` has something that looks right — and the allowlist
  // would refuse them anyway, but for "outside /usr, /opt, …", which reads as
  // a permissions problem rather than as "that is the wrong program".
  'openvpn connect': 'OpenVPN Connect',
  ovpnconnect: 'the OpenVPN Connect CLI'
}

async function checkExecutable(candidate: string, allowedRoots: string[]): Promise<string | null> {
  if (!isAbsolute(candidate)) return 'is a relative path, which depends on the working directory.'

  // Before touching the disk: this is about WHICH PROGRAM it is, and the
  // answer does not change with whether the file happens to be readable.
  const named = NOT_THE_ENGINE[basename(candidate).toLowerCase()]
  if (named) {
    // Where to point instead is the only platform-dependent half: Windows has
    // no bundled copy to fall back to, so clearing the field there leaves the
    // user with nothing, while on macOS and Linux it is the answer.
    const instead =
      process.platform === 'win32'
        ? 'Point this at the community `openvpn.exe` — usually ' +
          'C:\\Program Files\\OpenVPN\\bin\\openvpn.exe — or clear the field to use an ' +
          'allowlisted system install.'
        : 'Clear the field to use the copy OpsMaxx ships, or point this at a community ' +
          '`openvpn` such as the one `brew install openvpn` installs.'
    return (
      `is ${named}, which cannot run tunnels for OpsMaxx. It does not accept openvpn's ` +
      'command line and has no management interface, so credentials could not be handed to it ' +
      `and a connection would simply time out. ${instead}`
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
