import { readTargets } from './backup'
import { listConnections } from './cicd/wiring'
import { vpnProfiles } from './vpn/manager'

/**
 * How deep to look for a vault reference inside a VPN spec.
 *
 * The deepest one today is an frp plugin password —
 * `spec.proxies[i].plugin.passwordRef.vaultEntryId`, four objects down from the
 * spec — so six leaves room for a kind that nests one further without being an
 * unbounded walk over a structure that arrives from a file on disk.
 */
const MAX_SPEC_DEPTH = 6

/**
 * Does this VPN profile need the vault to start?
 *
 * Asked as "is there a `vaultEntryId` anywhere in the spec" rather than as a
 * per-kind list of ref slots. `VpnSecretRef` is the only thing on a profile
 * that carries one — shared/vpn.ts:30 says a literal secret must never appear
 * on a profile, because profiles are persisted into plain JSON — so the scan
 * is exact today and stays exact when a spec kind is added. An enumeration of
 * slots would not: it would quietly answer "no" for the new kind, and a count
 * that silently undercounts is worse here than no count at all.
 */
function referencesVault(v: unknown, depth = 0): boolean {
  if (v === null || typeof v !== 'object' || depth > MAX_SPEC_DEPTH) return false
  if (Array.isArray(v)) return v.some((x) => referencesVault(x, depth + 1))
  const o = v as Record<string, unknown>
  if (typeof o.vaultEntryId === 'string' && o.vaultEntryId !== '') return true
  return Object.values(o).some((x) => referencesVault(x, depth + 1))
}

/**
 * What is configured on this machine that cannot run while the vault is shut.
 *
 * For the launch prompt in docs/plans/vault-ux.md §5.1. At launch the vault is
 * locked, several surfaces decline — correctly, an unattended run must not put
 * a dialog on screen — and then nothing ever raises the question, so they sit
 * dead until the user happens to click something unrelated. This is what that
 * one prompt names.
 *
 * PHRASES, NOT COUNTS, and that is deliberate. Each surface's wording lives
 * next to the state it is counted from, which is the only place that knows
 * whether "2 CI accounts" or "a backup to X" is the honest way to say it. The
 * renderer has one more surface to add — the fleet sampler's own
 * `vaultBlockedCount`, which only the sampler can answer honestly because it
 * is hop-aware and scoped to the workspace actually being watched — and then
 * joins the lot into one sentence. A shared DTO for a value read once, by one
 * caller, to put in a dialog subtitle would be the more expensive half of this.
 *
 * SAYS NOTHING ABOUT THE VAULT'S OWN STATE. Whether to ask at all — a vault
 * that exists, is locked, and is not damaged — is the caller's gate, because
 * the renderer already holds all three and re-deriving them here would be a
 * second opinion for them to disagree with. This answers only "what is
 * waiting".
 *
 * Empty when nothing is: a user with no vault-backed anything gets no prompt.
 */
export function vaultWaiting(): string[] {
  const parts: string[] = []

  // Auto-start profiles whose secrets are in the vault. The manager already
  // remembers which ones a locked vault stopped, for
  // `vpnRetryVaultBlockedAutostarts` — but that set is filled by start
  // attempts still in flight when this is asked, so the profiles are
  // identified from their own configuration instead, which is true before the
  // first attempt has finished.
  const vpns = vpnProfiles().filter((p) => p.autoStart && referencesVault(p.spec))
  if (vpns.length === 1) parts.push(`VPN “${vpns[0].name}”`)
  else if (vpns.length > 1) parts.push(`${vpns.length} auto-starting VPNs`)

  // Every saved CI/CD connection carries a `vaultEntryId` — `cicd/wiring.ts`
  // drops a record without one rather than dialling it — so a configured
  // account is an account whose discovery and polling are waiting. The list is
  // loaded once at launch, before any window exists, so it is populated by the
  // time a renderer can ask.
  const cicd = listConnections().length
  if (cicd > 0) parts.push(`${cicd} CI account${cicd === 1 ? '' : 's'}`)

  // Scheduled destinations that take their passphrase from the vault. The two
  // exclusions are the two that are not waiting on anything: `everyHours === 0`
  // is manual-only and has a person present to type one, and
  // `passphraseSource === 'machine'` keeps the passphrase in the OS keychain
  // precisely so the run survives a restart with nobody there.
  //
  // A `readTargets()` that could not parse the file reports no destinations,
  // and this counts none — the right answer for a prompt, and one the backup
  // panel already says out loud in its own words.
  const backups = readTargets().destinations.filter(
    (d) => d.everyHours > 0 && d.passphraseSource !== 'machine' && !!d.passphraseVaultEntryId
  )
  if (backups.length === 1) parts.push(`a backup to “${backups[0].name}”`)
  else if (backups.length > 1) parts.push(`${backups.length} scheduled backups`)

  return parts
}
