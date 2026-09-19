import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
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
import { parseVpnConfig } from './parsers'
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

/** Parse and report. Never stores anything, never returns key material. */
export function vpnImport(kind: VpnKind, text: string, baseDir?: string): VpnImportResult {
  try {
    const parsed = parseVpnConfig(kind, text, { baseDir })
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

/** Absolute directories a pre-installed OpenVPN client keeps profiles in. A
 *  directory that is not there is skipped, so this is a list of places to
 *  look and not a claim about which client is installed. */
async function openVpnProfileDirs(): Promise<string[]> {
  const home = homedir()
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    const reg = await openVpnRegistryPaths()
    return dedupeDirs([
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
    ])
  }
  if (process.platform === 'darwin') {
    return dedupeDirs([
      join(home, 'Library', 'Application Support', 'OpenVPN Connect', 'profiles'),
      join(home, '.config', 'openvpn'),
      '/etc/openvpn'
    ])
  }
  return dedupeDirs([join(home, '.config', 'openvpn'), '/etc/openvpn/client', '/etc/openvpn'])
}

function dedupeDirs(dirs: string[]): string[] {
  return [...new Map(dirs.filter(Boolean).map((d) => [d.toLowerCase(), d])).values()]
}

/** A profile found on disk. Carries the report, never the file's text. */

/** Anything larger is not a profile. A `.ovpn` with every certificate inline
 *  is a few kilobytes; the cap is there so a stray file in the directory
 *  cannot make this read a gigabyte. */
const MAX_PROFILE_BYTES = 1 << 20
/** And a cap on how many, for the same reason. */
const MAX_PROFILES = 200

/**
 * Find OpenVPN profiles the machine already has.
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
  opts: { knownSourcePaths?: string[] } = {}
): Promise<DiscoveredVpnProfile[]> {
  const known = new Set((opts.knownSourcePaths ?? []).map((p) => p.toLowerCase()))
  const found: DiscoveredVpnProfile[] = []

  for (const dir of await openVpnProfileDirs()) {
    for (const file of await ovpnFilesIn(dir)) {
      if (found.length >= MAX_PROFILES) return found
      if (known.has(file.toLowerCase())) continue
      // Marked as seen straight away: two of the directories above can be the
      // same tree by a different route (the registry's `config_dir` is
      // usually one of the guesses), and a profile offered twice in one scan
      // is the duplicate this is supposed to prevent.
      known.add(file.toLowerCase())
      const text = await readFile(file, 'utf8').catch(() => null)
      if (text === null) continue
      // `dirname`, so a path-form `ca ca.crt` resolves against the directory
      // the profile actually lives in — which is the normal shape of a
      // Community config and would otherwise be rejected (E37).
      const report = vpnImport('openvpn', text, dirname(file))
      found.push({
        kind: 'openvpn',
        sourcePath: file,
        name: basename(file).replace(/\.(ovpn|conf)$/i, '') || report.name || 'OpenVPN',
        report
      })
    }
  }
  return found
}

/** `.ovpn` and `.conf` files in a directory and one level below it — the
 *  official GUI lets people file configs in subfolders, and its own default
 *  directory is the one people already did that in. */
async function ovpnFilesIn(dir: string, depth = 1): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: string[] = []
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (depth > 0) out.push(...(await ovpnFilesIn(full, depth - 1)))
      continue
    }
    if (!e.isFile() || !/\.(ovpn|conf)$/i.test(e.name)) continue
    const st = await stat(full).catch(() => null)
    if (!st || st.size === 0 || st.size > MAX_PROFILE_BYTES) continue
    out.push(full)
  }
  return out.sort()
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
  if (res.ok && res.spec?.kind === 'openvpn') {
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
