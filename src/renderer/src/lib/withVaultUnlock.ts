import { useVaultPrompt } from '../store/vaultPrompt'

// Matches the marker credentialResolver.ts puts in the message. Electron
// rewrites a rejected IPC handler's error, so the class does not survive but
// the token does.
const VAULT_LOCKED = 'OPSMAXX_VAULT_LOCKED'

/** The same condition, spelled as a code on a result object rather than thrown.
 *  Mirrors the `'vault-locked'` member of VpnErrorCode in shared/vpn.ts. */
const VAULT_LOCKED_CODE = 'vault-locked'

const hasMarker = (v: unknown): boolean => typeof v === 'string' && v.includes(VAULT_LOCKED)

/**
 * True when this failure is "the vault is locked" and nothing else.
 *
 * A locked vault reaches the renderer in two shapes, and both mean exactly the
 * same thing to the person looking at the screen:
 *
 *  - a rejection whose message still carries the marker (SSH, SFTP, database);
 *  - a *resolved* result carrying `errorCode: 'vault-locked'` (VPN start, VPN
 *    import), because those paths report failure rather than throwing.
 *
 * Recognising only the first meant every caller on the second shape had to
 * hand-roll the prompt, or — more often — silently did nothing and left the
 * user reading advice with no way to act on it.
 */
export function isVaultLocked(err: unknown): boolean {
  return scan(err, 0)
}

/**
 * How deep to look, and how much of it.
 *
 * A locked vault does NOT always arrive as a rejection, and assuming it did
 * was a real bug: the monitor's readers each catch everything and return a
 * probe, so the marker turns up as
 *
 *   { ok: false, reason: 'unknown', detail: 'OPSMAXX_VAULT_LOCKED: …' }   docker, k8s
 *   [{ serverName, reading: { detail: 'OPSMAXX_VAULT_LOCKED: …' } }, …]   services, cron
 *
 * and never as `message` or `error` at the top level. Checking only those two
 * fields meant every one of those panels silently declined to offer the
 * unlock, which is exactly the failure this module exists to prevent.
 *
 * So the shapes are not enumerated — there are too many and a new reader would
 * quietly miss out. The marker is scanned for instead, bounded so a probe
 * carrying two hundred containers cannot turn a failure check into real work.
 */
const MAX_DEPTH = 4
const MAX_NODES = 500

function scan(v: unknown, depth: number, budget = { n: MAX_NODES }): boolean {
  if (v === null || v === undefined || depth > MAX_DEPTH) return false
  if (budget.n-- <= 0) return false

  if (typeof v === 'string') return hasMarker(v)
  if (typeof v !== 'object') return false

  if (Array.isArray(v)) return v.some((x) => scan(x, depth + 1, budget))

  // `errorCode` is the shared result shape; `code` is what a VpnError carries
  // when one survives structured-cloning intact. Both are exact values rather
  // than marker text, so they are checked before the generic walk.
  const o = v as { errorCode?: unknown; code?: unknown }
  if (o.errorCode === VAULT_LOCKED_CODE || o.code === VAULT_LOCKED_CODE) return true

  // An Error's own `message` is not an enumerable property, so a plain
  // Object.values walk misses it entirely.
  if (v instanceof Error) return hasMarker(v.message)

  return Object.values(v).some((x) => scan(x, depth + 1, budget))
}

/**
 * Runs an operation that may need a vault credential. If it fails only because
 * the vault is locked, asks the user to unlock and runs it once more.
 *
 * Retrying once, not looping: if it fails again after a successful unlock the
 * cause is something else, and asking a second time would just be a dialog the
 * user cannot get rid of.
 */
export async function withVaultUnlock<T>(reason: string, run: () => Promise<T>): Promise<T> {
  try {
    const result = await run()
    // A resolved-but-failed result is the same situation as a rejection here,
    // so it gets the same offer rather than being returned as a dead end.
    if (!isVaultLocked(result)) return result
    const unlocked = await useVaultPrompt.getState().request(reason)
    return unlocked ? await run() : result
  } catch (err) {
    if (!isVaultLocked(err)) throw err
    const unlocked = await useVaultPrompt.getState().request(reason)
    if (!unlocked) throw err
    return await run()
  }
}
