import { readdir, readFile, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import type {
  FrpSpec,
  OpenVpnSpec,
  VpnImportResult,
  VpnKind,
  VpnSecretRef,
  VpnSpec,
  WireGuardSpec,
  DiscoveredVpnProfile
} from '../../../shared/vpn'
import { isVaultLockedError } from '../credentialResolver'
import { openVpnRegistryPaths, winProgramRoots } from './binaries'
import { toVpnResult, VpnError } from './errors'
import { detectVpnKind, parseVpnConfig } from './parsers'
import { deleteVpnSecrets as dropVpnSecrets, stageImportedSecrets } from './vaultBridge'
import type { StagedVpnSecretRefs } from './vaultBridge'

// The import handler: the boundary a hostile file has to cross.
//
// Two calls, deliberately split:
//
//   vpnImport()       parses and reports. Nothing is stored, nothing is
//                     started. The renderer gets a spec and — always — the
//                     full list of what was dropped or rejected, so the user
//                     sees it BEFORE deciding to keep the profile.
//   vpnCommitImport() re-parses the same text, puts the key material in the
//                     vault, and returns a spec whose refs point at it.
//
// It re-parses rather than caching the first parse, and that is on purpose.
// Caching would mean holding a private key in a module-level map between two
// IPC calls, for as long as the user leaves the dialog open — and the parse is
// pure and cheap, so the only thing caching would buy is that risk.

/** What the import dialogs call each kind, for the one message that has to name
 *  a different one than the user picked. */
const KIND_LABEL: Record<VpnKind, string> = {
  wireguard: 'WireGuard',
  openvpn: 'OpenVPN',
  frp: 'frp',
  ngrok: 'ngrok',
  tailscale: 'Tailscale'
}

/** Parse and report. Never stores anything, never returns key material. */
export function vpnImport(kind: VpnKind, text: string, baseDir?: string): VpnImportResult {
  try {
    const parsed = parseVpnConfig(kind, text, { baseDir })
    // A WireGuard .conf dropped into the OpenVPN dialog used to fail with
    // "This profile carries no certificate authority" — true of the bytes, and
    // an answer to a question nobody asked, because the file is not an OpenVPN
    // profile at all. `detectVpnKind` existed for exactly this and had no
    // caller; here is the one place every path (paste, drop, chooser and the
    // discovery scan) goes through, so it only has to be said once.
    //
    // Only when nothing was REJECTED: a rejected directive is a real finding
    // about the file the user actually handed over, and it outranks a guess
    // about which dialog they should have used.
    if (!parsed.ok && !parsed.stripped.some((d) => d.severity === 'rejected')) {
      const looksLike = detectVpnKind(text)
      if (looksLike && looksLike !== kind) {
        return {
          ok: false,
          error: `This looks like a ${KIND_LABEL[looksLike]} configuration rather than ${KIND_LABEL[kind]}. Import it with the Import ${KIND_LABEL[looksLike]} button instead.`,
          errorCode: 'unsupported',
          stripped: parsed.stripped,
          warnings: parsed.warnings
        }
      }
    }
    // Drop `secrets` on the floor: the internal type carries it, the wire type
    // does not, and this is the one place the two meet.
    const { secrets: _secrets, ...wire } = parsed
    return wire
  } catch (e) {
    const r = toVpnResult(e)
    return { ok: false, error: r.error, errorCode: r.errorCode, stripped: [], warnings: [] }
  }
}

export interface VpnCommitResult {
  ok: boolean
  error?: string
  errorCode?: VpnImportResult['errorCode']
  spec?: VpnSpec
  vaultEntryId?: string
}

/** Store the credentials and return a spec that points at them. */
export async function vpnCommitImport(
  name: string,
  workspaceId: string,
  kind: VpnKind,
  text: string,
  baseDir?: string
): Promise<VpnCommitResult> {
  try {
    const parsed = parseVpnConfig(kind, text, { baseDir })
    if (!parsed.ok || !parsed.spec) {
      return {
        ok: false,
        error: parsed.error ?? 'This configuration could not be imported.',
        errorCode: parsed.errorCode ?? 'config-rejected'
      }
    }

    const staged = await stageImportedSecrets(name, workspaceId, kind, parsed.secrets ?? {})
    const spec = applyRefs(parsed.spec, staged.refs)
    return { ok: true, spec, vaultEntryId: staged.vaultEntryId }
  } catch (e) {
    if (isVaultLockedError(e)) {
      return {
        ok: false,
        error: 'Unlock the vault before importing a VPN profile — its key material is stored there.',
        errorCode: 'vault-locked'
      }
    }
    const r = toVpnResult(e)
    return { ok: false, error: r.error, errorCode: r.errorCode }
  }
}

// ------------------------------------------------------- pre-existing files
//
// Someone who already has OpenVPN set up has already done the work once: the
// profiles are on disk, in the directory their client keeps them in. Making
// them paste each one back in is asking them to do it again.
//
// Two calls again, and the split is the same one as above — except that here
// main has the file rather than the renderer, so the *text* never crosses IPC
// at all. `discoverVpnProfiles` reports what is there and what parsing it
// said; `vpnCommitImportFile` reads it and stores it. An inline private key
// in an `.ovpn` therefore goes from disk to the vault without the renderer
// ever holding it.

/** A place to look, and what it holds. Kept together because the extension
 *  that means "profile" is different per kind and the directory is the only
 *  thing that says which one we are in. */
interface ScanDir {
  dir: string
  kind: DiscoveredVpnProfile['kind']
}

/**
 * Absolute directories a pre-installed VPN client keeps profiles in.
 *
 * A directory that is not there is skipped, so this is a list of places to
 * look and not a claim about which client is installed. Third-party clients
 * are read from — reading somebody's `.ovpn` is not the same decision as
 * executing their bundled binary, which `otherVpnClients` in binaries.ts
 * declines to do and says why.
 */
export async function profileDirs(kinds: DiscoveredVpnProfile['kind'][]): Promise<ScanDir[]> {
  const home = homedir()
  const out: ScanDir[] = []
  const add = (kind: DiscoveredVpnProfile['kind'], ...dirs: string[]): void => {
    if (kinds.includes(kind)) for (const dir of dirs) out.push({ dir, kind })
  }

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    const programData = process.env.ProgramData ?? 'C:\\ProgramData'
    const reg = kinds.includes('openvpn')
      ? await openVpnRegistryPaths()
      : { exe: [], configDirs: [] }
    add(
      'openvpn',
      // The registry's own `config_dir`, which is what the official GUI reads
      // and the only entry that survives a non-default install.
      ...reg.configDirs,
      // openvpn-gui's per-user default, and the machine-wide one beside the
      // program itself.
      join(home, 'OpenVPN', 'config'),
      ...winProgramRoots().map((r) => join(r, 'OpenVPN', 'config')),
      // OpenVPN Connect's own store. Which of the two app-data trees a given
      // version writes to has varied, so both are looked at rather than one
      // being asserted.
      join(appData, 'OpenVPN Connect', 'profiles'),
      join(localAppData, 'OpenVPN Connect', 'profiles')
    )
    add(
      'wireguard',
      // The official WireGuard client's tunnel store. Most of what is in here
      // is `.conf.dpapi` rather than `.conf` — see `readProfile`.
      ...winProgramRoots().map((r) => join(r, 'WireGuard', 'Data', 'Configurations')),
      join(programData, 'WireGuard', 'Configurations')
    )
  } else if (process.platform === 'darwin') {
    const tunnelblick = '/Library/Application Support/Tunnelblick'
    add(
      'openvpn',
      join(home, 'Library', 'Application Support', 'OpenVPN Connect', 'profiles'),
      // Tunnelblick keeps `.tblk` BUNDLES here, not loose files: a directory
      // named `Work.tblk` with the real config a few levels inside it. See
      // `filesIn` for the one place that is special-cased.
      join(home, 'Library', 'Application Support', 'Tunnelblick', 'Configurations'),
      // And it MOVES them out of there. "Secure" configurations — the default
      // for every configuration Tunnelblick installs — live in a root-owned
      // tree under /Library instead, per-user or shared. Scanning only the
      // per-user Configurations folder meant the ordinary Tunnelblick user
      // found nothing at all; `deniedEntry` covers the case where those
      // directories are readable only by root.
      join(tunnelblick, 'Users', userInfo().username),
      join(tunnelblick, 'Shared'),
      join(home, 'Library', 'Application Support', 'Viscosity', 'OpenVPN'),
      join(home, '.config', 'openvpn'),
      // Where a profile emailed by an administrator actually lands, and the
      // one directory a person who has never installed a VPN client will have
      // put it in.
      join(home, 'Downloads'),
      join(home, '.openvpn'),
      '/etc/openvpn'
    )
    // Both Homebrew prefixes, because `wg-quick` reads whichever one it was
    // installed under and the user has no say in which.
    add(
      'wireguard',
      '/opt/homebrew/etc/wireguard',
      '/usr/local/etc/wireguard',
      // `wg-quick up <name>` resolves <name> here on macOS exactly as it does
      // on Linux. It was in the Linux branch and missing from this one, so a
      // macOS tunnel set up by hand was invisible.
      '/etc/wireguard',
      join(home, '.config', 'wireguard')
    )
  } else {
    // `/etc/openvpn/client` is the systemd-era split (openvpn-client@.service
    // reads it) used by Debian, Ubuntu, Fedora, RHEL, Arch and openSUSE;
    // `/etc/openvpn` flat is the older layout Alpine and older Debian use.
    // Both, because a machine upgraded in place has files in both.
    add('openvpn', join(home, '.config', 'openvpn'), '/etc/openvpn/client', '/etc/openvpn')
    // `wg-quick up <name>` resolves `<name>` in /etc/wireguard, so that is
    // where every distribution puts them.
    add('wireguard', '/etc/wireguard', join(home, '.config', 'wireguard'))
  }

  const seen = new Set<string>()
  return out.filter((s) => {
    const key = `${s.kind}\u0000${s.dir.toLowerCase()}`
    if (!s.dir || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Profile stores OpsMaxx cannot read, and the reason.
 *
 * Listed rather than scanned. Both of these hold real profiles and neither can
 * be opened by anything but the app that wrote it, so a scan that simply found
 * nothing in them would read as OpsMaxx having missed the profiles the user can
 * see in another window. Same shape as the DPAPI entry in `readProfile`: the
 * dialog lists it with its reason and no Import button.
 *
 * A directory that is not there produces nothing, so this is a list of places
 * to look and not a claim about which app is installed.
 */
interface NoteDir extends ScanDir {
  /** Shown in place of the path; the whole point of the entry. */
  note: string
}

export function noteDirs(kinds: DiscoveredVpnProfile['kind'][]): NoteDir[] {
  const home = homedir()
  const out: NoteDir[] = []
  const connect =
    'OpenVPN Connect 3 keeps imported profiles in its own database rather than as files, and that database is not a format OpsMaxx can read. Export the profile from OpenVPN Connect, or import the original .ovpn file here.'

  if (kinds.includes('openvpn')) {
    if (process.platform === 'darwin') {
      out.push({
        kind: 'openvpn',
        dir: join(home, 'Library', 'Application Support', 'OpenVPN Connect'),
        note: connect
      })
    } else if (process.platform === 'win32') {
      const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
      out.push({ kind: 'openvpn', dir: join(appData, 'OpenVPN Connect'), note: connect })
    }
  }
  if (kinds.includes('wireguard') && process.platform === 'darwin') {
    out.push({
      kind: 'wireguard',
      // The App Store build is sandboxed and keeps its tunnels in the login
      // keychain, not in this container — the container only proves the app is
      // installed. Nothing here is readable by design, so nothing is attempted.
      dir: join(home, 'Library', 'Containers', 'com.wireguard.macos'),
      note: 'The WireGuard app from the App Store stores its tunnels where only it can read them. Export a tunnel from WireGuard, then import the .conf file here.'
    })
  }
  return out
}

/** Anything larger is not a profile. A `.ovpn` with every certificate inline
 *  is a few kilobytes; the cap is there so a stray file in the directory
 *  cannot make this read a gigabyte. */
const MAX_PROFILE_BYTES = 1 << 20
/** And a cap on how many, for the same reason. */
const MAX_PROFILES = 200
/**
 * A wall-clock bound on the whole scan, which the file count alone does not
 * give: a network-mounted home directory can take seconds to answer a single
 * `readdir`, and twenty of those is a modal that sits on a spinner. Reached,
 * the scan returns what it has — an incomplete list is recoverable, a frozen
 * dialog is not — and declines to cache it, so the next open tries again.
 */
const SCAN_BUDGET_MS = 3_000

/** The result of one scan, before `knownSourcePaths` is applied. Cached; the
 *  filtering is not, because what is already imported changes as the user
 *  imports things and the files on disk do not. */
interface Scan {
  profiles: DiscoveredVpnProfile[]
  complete: boolean
}

/**
 * Held so that opening the import dialog twice is one scan, not two.
 *
 * Invalidated three ways: a TTL, because a file appearing in
 * `/etc/wireguard` while the app is open should turn up without a restart; an
 * incomplete scan is never stored at all; and `resetDiscoveryCache()` drops
 * it outright, which is what the tests use between fixture trees.
 */
const scanCache = new Map<string, { at: number; scan: Scan }>()
const SCAN_TTL_MS = 30_000

/** Drops the discovery cache. */
export function resetDiscoveryCache(): void {
  scanCache.clear()
}

export interface DiscoverVpnOptions {
  /** Paths already imported, excluded from the result. */
  knownSourcePaths?: string[]
  /**
   * Which kinds to look for. Defaults to OpenVPN alone, which is what the
   * import dialog asks for; `frp`, `ngrok` and `tailscale` are absent from
   * the type because no installer lays their configuration down in a standard
   * place, so scanning for them would walk directories to find nothing.
   */
  kinds?: DiscoveredVpnProfile['kind'][]
  /** Overridable so the budget is testable without a slow filesystem. */
  budgetMs?: number
}

/**
 * Find VPN profiles the machine already has.
 *
 * Idempotent on `sourcePath`, not on content hash, and the choice matters:
 * the file on disk stays where it is after an import, so it is found again on
 * every scan. Keyed on the path, a re-scan offers nothing new; keyed on a
 * content hash, the day the user edits that file upstream — a new server
 * address, a renewed certificate — it would hash differently and be offered
 * as a second profile beside the first. The path is the identity of the
 * thing; the bytes are its current state.
 */
export async function discoverVpnProfiles(
  opts: DiscoverVpnOptions = {}
): Promise<DiscoveredVpnProfile[]> {
  const kinds = opts.kinds?.length ? opts.kinds : (['openvpn'] as const).slice()
  const key = [...kinds].sort().join(',')
  const cached = scanCache.get(key)
  const scan =
    cached && Date.now() - cached.at < SCAN_TTL_MS
      ? cached.scan
      : await runScan(kinds, opts.budgetMs ?? SCAN_BUDGET_MS)
  if (scan.complete) scanCache.set(key, { at: Date.now(), scan })

  const known = new Set((opts.knownSourcePaths ?? []).map((p) => p.toLowerCase()))
  return scan.profiles.filter((p) => !known.has(p.sourcePath.toLowerCase()))
}

async function runScan(
  kinds: DiscoveredVpnProfile['kind'][],
  budgetMs: number
): Promise<Scan> {
  const deadline = Date.now() + budgetMs
  const profiles: DiscoveredVpnProfile[] = []
  // Two directories can be the same tree by a different route — the
  // registry's `config_dir` is usually one of the guesses — and a profile
  // offered twice in one scan is the duplicate this exists to prevent.
  const seen = new Set<string>()
  const push = (p: DiscoveredVpnProfile): void => {
    if (seen.has(p.sourcePath.toLowerCase())) return
    seen.add(p.sourcePath.toLowerCase())
    profiles.push(p)
  }

  for (const { dir, kind } of await profileDirs(kinds)) {
    if (profiles.length >= MAX_PROFILES || Date.now() > deadline) {
      return { profiles, complete: false }
    }
    const { files, denied } = await filesIn(dir, kind)
    // A directory we are not allowed to read is reported, not skipped. On
    // Linux `/etc/wireguard` is 0700 root, so this is the ordinary case
    // there — and a profile the user can see in a terminal and not here
    // reads as OpsMaxx having missed it.
    for (const path of denied) push(deniedEntry(kind, path, true))
    for (const file of files) {
      if (profiles.length >= MAX_PROFILES || Date.now() > deadline) {
        return { profiles, complete: false }
      }
      const entry = await readProfile(file, kind)
      if (entry) push(entry)
    }
  }

  // Last, and only for a store that gave up nothing. The note exists so an
  // unreadable store is not met with silence — but OpenVPN Connect 2 wrote
  // plain `.ovpn` files into the same tree that 3 keeps its database in, so on
  // a machine that has those files there is nothing to explain and the note
  // would just be noise beside the profiles it is claiming cannot be read.
  for (const { dir, kind, note } of noteDirs(kinds)) {
    // And only when the directory is actually there: this is about a store this
    // machine has, not a lecture about software it has never run.
    const st = await stat(dir).catch(() => null)
    if (!st?.isDirectory()) continue
    const prefix = `${dir.toLowerCase()}${sep}`
    if (profiles.some((p) => p.sourcePath.toLowerCase().startsWith(prefix))) continue
    push({
      kind,
      sourcePath: dir,
      name: basename(dir),
      report: { ok: false, error: note, errorCode: 'unsupported', stripped: [], warnings: [] }
    })
  }
  return { profiles, complete: true }
}

/** A path we can see and cannot read, presented like any other find so the
 *  dialog lists it with its reason and no Import button. */
function deniedEntry(
  kind: DiscoveredVpnProfile['kind'],
  path: string,
  isDir: boolean
): DiscoveredVpnProfile {
  return {
    kind,
    sourcePath: path,
    name: basename(path),
    report: {
      ok: false,
      error: isDir
        ? `${path} needs administrator rights to read, so OpsMaxx cannot list what is in it.`
        : `${path} needs administrator rights to read.`,
      errorCode: 'config-invalid',
      stripped: [],
      warnings: []
    }
  }
}

/**
 * The name a bundled profile actually has.
 *
 * Tunnelblick and Viscosity both keep a profile as a DIRECTORY named after it —
 * `Work.tblk`, `Work.visc` — with the config inside always called `config.ovpn`
 * or `config.conf`. Taking the file's stem therefore listed every profile from
 * either client as "config", which is no name at all once there are two of
 * them. The directory is where the name lives, so read it from there.
 */
/** Viscosity numbers its connection folders — `OpenVPN/3/config.conf` — and
 *  keeps the name the user gave the connection in a comment at the top of the
 *  file. Without reading it the profile is called "3", or before that "config".
 */
const VISCOSITY_NAME = /^#\s*viscosity\s+name\s+(.+)$/im

export function bundleName(file: string): string | null {
  const parts = dirname(file).split(/[\\/]/)
  while (parts.length > 0) {
    const seg = parts.pop() as string
    // Tunnelblick's config sits at `Work.tblk/Contents/Resources/config.ovpn`,
    // so the two wrapper directories are stepped over rather than named.
    if (!seg || /^(contents|resources)$/i.test(seg)) continue
    const stem = seg.replace(/\.(tblk|visc|ovpn|conf)$/i, '')
    return stem || null
  }
  return null
}

export async function readProfile(
  file: string,
  kind: DiscoveredVpnProfile['kind']
): Promise<DiscoveredVpnProfile | null> {
  const stem = basename(file).replace(/\.(ovpn|conf|conf\.dpapi)$/i, '')
  // The official Windows WireGuard client encrypts every tunnel it stores
  // with DPAPI, bound to the LocalSystem account. There is no key to ask for
  // and nothing to parse, so this is listed with the reason rather than read
  // and reported as a corrupt config.
  if (/\.dpapi$/i.test(file)) {
    return {
      kind,
      sourcePath: file,
      name: stem,
      report: {
        ok: false,
        error:
          'The WireGuard app encrypted this tunnel with Windows DPAPI. Export it from WireGuard, then import the file here.',
        errorCode: 'config-invalid',
        stripped: [],
        warnings: []
      }
    }
  }

  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (e) {
    // 0600 root is the normal mode for a file under /etc/openvpn.
    if (isDenied(e)) return deniedEntry(kind, file, false)
    return null
  }
  // What this profile is actually called. The file's own stem first, because
  // that is what the user named it — except when the stem is `config`, which is
  // what BOTH Tunnelblick and Viscosity call the file inside a per-profile
  // folder, so every profile from either client was listed as "config".
  const name =
    VISCOSITY_NAME.exec(text)?.[1]?.trim() ||
    (/^config$/i.test(stem) ? bundleName(file) : null) ||
    stem
  // `dirname`, so a path-form `ca ca.crt` resolves against the directory the
  // profile actually lives in — which is the normal shape of a Community
  // config and would otherwise be rejected (E37).
  const report = vpnImport(kind, text, dirname(file))
  return { kind, sourcePath: file, name: name || report.name || 'VPN', report }
}

function isDenied(e: unknown): boolean {
  const code = (e as { code?: string })?.code
  return code === 'EACCES' || code === 'EPERM'
}

/** Which file names mean "profile" in a directory of this kind. */
const PROFILE_EXT: Record<DiscoveredVpnProfile['kind'], RegExp> = {
  openvpn: /\.(ovpn|conf)$/i,
  // `.conf.dpapi` is included so it can be listed as unreadable rather than
  // leaving the user's tunnels apparently undetected.
  wireguard: /\.conf(\.dpapi)?$/i
}

/**
 * Profile files in a directory and one level below it — the OpenVPN GUI lets
 * people file configs in subfolders, and its own default directory is the one
 * people already did that in.
 *
 * Symlinked DIRECTORIES are not followed, which is what makes a symlink loop
 * impossible here regardless of depth: `readdir(withFileTypes)` reports a link
 * as `isSymbolicLink()` and never as `isDirectory()`, so recursion only ever
 * goes through real directories, and only twice. Symlinked FILES are followed,
 * because a config symlinked into `/etc/openvpn/client` is a normal way to
 * keep one.
 */
async function filesIn(
  dir: string,
  kind: DiscoveredVpnProfile['kind'],
  depth = 1
): Promise<{ files: string[]; denied: string[] }> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (e) {
    return { files: [], denied: isDenied(e) ? [dir] : [] }
  }

  const files: string[] = []
  const denied: string[] = []
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      // A Tunnelblick `.tblk` is a bundle: the config sits at
      // `Contents/Resources/config.ovpn`, deeper than the one level a plain
      // subfolder gets. Given its own allowance rather than raising the
      // depth everywhere, which would walk every unrelated directory too.
      const inner = /\.tblk$/i.test(e.name) ? 3 : depth - 1
      if (inner >= 0) {
        const sub = await filesIn(full, kind, inner)
        files.push(...sub.files)
        denied.push(...sub.denied)
      }
      continue
    }
    if (!PROFILE_EXT[kind].test(e.name)) continue
    // A symlink reports neither `isFile` nor `isDirectory`; `stat` follows it,
    // and a link to a directory is rejected here by `isFile()`.
    const st = await stat(full).catch(() => null)
    if (!st || !st.isFile() || st.size === 0 || st.size > MAX_PROFILE_BYTES) continue
    files.push(full)
  }
  return { files: files.sort(), denied }
}

/**
 * Commit a profile that is already on disk. The text is read here and handed
 * straight to `vpnCommitImport`, so the only thing that crosses IPC for a
 * discovered profile is the path it came from.
 */
export async function vpnCommitImportFile(
  name: string,
  workspaceId: string,
  kind: VpnKind,
  sourcePath: string
): Promise<VpnCommitResult> {
  let text: string
  try {
    const st = await stat(sourcePath)
    if (!st.isFile()) throw new VpnError('config-invalid', `${sourcePath} is not a file.`)
    if (st.size > MAX_PROFILE_BYTES) {
      throw new VpnError('config-invalid', `${sourcePath} is too large to be a VPN profile.`)
    }
    text = await readFile(sourcePath, 'utf8')
  } catch (e) {
    return toVpnResult(e)
  }
  const res = await vpnCommitImport(name, workspaceId, kind, text, dirname(sourcePath))
  // Recorded on the spec so the next scan knows this file has been taken.
  //
  // BOTH discoverable kinds. It used to be OpenVPN alone, and the scan
  // de-duplicates by source path, so every WireGuard tunnel on the machine was
  // offered again on every scan and "Import all" added another copy of it each
  // time it was pressed.
  if (res.ok && (res.spec?.kind === 'openvpn' || res.spec?.kind === 'wireguard')) {
    return { ...res, spec: { ...res.spec, sourcePath } }
  }
  return res
}

/** Release the vault entry behind a deleted profile, so its key material does
 *  not linger with nothing in the UI pointing at it. */
export async function vpnDeleteSecrets(vaultEntryId: string): Promise<void> {
  if (!vaultEntryId) return
  await dropVpnSecrets(vaultEntryId)
}

// Parsers cannot invent a vault id, so every ref they produce carries an empty
// one. This walks the spec and fills them in from what staging actually wrote —
// including the fallback cases, where a value did not fit its preferred slot
// and staging recorded a named field instead.
function applyRefs(spec: VpnSpec, refs: StagedVpnSecretRefs): VpnSpec {
  switch (spec.kind) {
    case 'wireguard':
      return applyWireGuardRefs(spec, refs)
    case 'openvpn':
      return applyOpenVpnRefs(spec, refs)
    case 'frp':
      return applyFrpRefs(spec, refs)
    case 'ngrok':
      // The authtoken is chosen from the vault in the form, not carried in by a
      // parser, so there is no staged ref to graft on.
      return spec
    case 'tailscale':
      // No secret refs to fill in, because this app stores no Tailscale
      // credential at all — the daemon owns its own login.
      return spec
  }
}

function applyWireGuardRefs(spec: WireGuardSpec, refs: StagedVpnSecretRefs): WireGuardSpec {
  return {
    ...spec,
    privateKeyRef: require(refs.privateKey, 'private key'),
    peers: spec.peers.map((p) => {
      // A peer only gets a preshared-key ref if the file actually carried one;
      // an absent PSK is normal, not a missing credential.
      const psk = refs.presharedKeys?.[p.publicKey]
      return psk ? { ...p, presharedKeyRef: psk } : { ...p, presharedKeyRef: undefined }
    })
  }
}

function applyOpenVpnRefs(spec: OpenVpnSpec, refs: StagedVpnSecretRefs): OpenVpnSpec {
  return {
    ...spec,
    configRef: require(refs.configBody, 'configuration'),
    usernameRef: refs.username,
    passwordRef: refs.password,
    keyPassphraseRef: refs.keyPassphrase
  }
}

function applyFrpRefs(spec: FrpSpec, refs: StagedVpnSecretRefs): FrpSpec {
  return {
    ...spec,
    auth: {
      ...spec.auth,
      tokenRef: refs.token,
      oidc: spec.auth.oidc ? { ...spec.auth.oidc, clientSecretRef: refs.password } : undefined
    },
    proxies: spec.proxies.map((p) => ({
      ...p,
      secretKeyRef: refs.proxySecretKeys?.[p.name],
      plugin: p.plugin
        ? { ...p.plugin, passwordRef: refs.proxySecretKeys?.[`plugin:${p.name}`] }
        : undefined
    })),
    visitors: spec.visitors.map((v) => ({
      ...v,
      secretKeyRef: refs.proxySecretKeys?.[v.name]
    }))
  }
}

// A ref the spec cannot work without. Failing here rather than storing a
// profile with an empty vault id means the error names the missing credential,
// instead of turning up later as an unexplained failure to start.
function require(ref: VpnSecretRef | undefined, what: string): VpnSecretRef {
  if (!ref) throw new VpnError('config-invalid', `The imported profile has no ${what}.`)
  return ref
}
