/**
 * The T2 public profile: the small set of preferences addy stores in
 * PLAINTEXT, deliberately.
 *
 * WHY ANY PLAINTEXT AT ALL. A brand-new device should pull a usable-looking
 * OpsMaxx before any pairing has happened -- the right theme, the right
 * terminal font -- rather than presenting defaults and then rearranging itself
 * once the user finds their phrase. That is the entire justification, and it is
 * why the list is as short as it is.
 *
 * WHO MAY READ IT. An authenticated device of that account, and nobody else. A
 * world-readable profile would leak the estate's technology profile to anyone
 * who guessed an account id, and inventing a password to protect it would add
 * an unanalysed server-side brute-force target to a design that deliberately
 * has none.
 *
 * THE DEFAULT IS T0. A key not on this allowlist is SECRET. That is the only
 * version of the rule that survives a year of feature work: a blocklist means
 * every new setting is public until somebody remembers to classify it, and the
 * one nobody remembers is the one that mattered.
 *
 * This file is the TypeScript half of a contract; `internal/profile/profile.go`
 * in the addy repo is the other, and `tests/addyTrustBoundary.test.ts` pins
 * them against each other and against `AppSettings`.
 */

export type T2Field =
  | { name: string; kind: 'bool' }
  | { name: string; kind: 'int'; min: number; max: number }
  | { name: string; kind: 'enum'; values: readonly string[] }

/**
 * The allowlist.
 *
 * TWO THINGS ARE DELIBERATELY ABSENT.
 *
 * `modules` was on an early version of this list and security review moved it
 * to T0. It is a CAPABILITY SWITCH, not a preference: a hostile server serving
 * a plaintext profile could enable the entire privileged surface -- keyRevoke,
 * broadcast, jobs, patch, rules, cicdTrigger -- on every device in the account.
 * `backfillModules` exists precisely so that an UPGRADE is not consent; letting
 * a plaintext profile do what an upgrade may not would invert that rule.
 *
 * AND NO KEY WHOSE ABSENCE GRANTS SOMETHING MAY BE HERE. `AppSettings` merges
 * saved-over-default, so several keys read absence as "on" --
 * `localTerminalEnabled` is the sharp one. Against that polarity an OMISSION is
 * an attack, which is why the guardrail asserts not just "every key is
 * classified" but "no capability-gating key is in T2".
 */
export const T2_ALLOWLIST: readonly T2Field[] = [
  { name: 'theme', kind: 'enum', values: ['light', 'dark', 'system'] },
  { name: 'terminalFontSize', kind: 'int', min: 8, max: 32 },
  {
    name: 'terminalScheme',
    kind: 'enum',
    values: ['default', 'solarized-dark', 'solarized-light', 'nord', 'dracula', 'gruvbox', 'custom'],
  },
  { name: 'compactDensity', kind: 'bool' },
  { name: 'dbSchemaWidth', kind: 'int', min: 120, max: 2000 },
  { name: 'dbEditorHeight', kind: 'int', min: 80, max: 2000 },
  { name: 'cicdStepsWidth', kind: 'int', min: 120, max: 2000 },
  { name: 'cicdDetailHeight', kind: 'int', min: 80, max: 2000 },
  { name: 'showMonitorStrip', kind: 'bool' },
  { name: 'closeTabOnShellExit', kind: 'bool' },
  { name: 'switchHiddenWorkspaces', kind: 'bool' },
] as const

export const T2_NAMES: readonly string[] = T2_ALLOWLIST.map((f) => f.name)

/**
 * Keys whose ABSENCE grants something, and which therefore may never be T2.
 *
 * Named individually rather than pattern-matched, so the next person to add a
 * field meets the polarity trap rather than reading past it.
 */
export const CAPABILITY_GATING_KEYS: readonly string[] = [
  'modules',
  'localTerminalEnabled',
  'aiPolicy',
  'allowEscalation',
  'credentialProxyEnabled',
]

/**
 * Validate a profile that arrived from the server.
 *
 * A PLAINTEXT PROFILE FROM A HOSTILE SERVER IS UNTRUSTED INPUT, and it feeds a
 * client-side parser. Every value is checked for type and range on arrival --
 * the server can set any number it likes and this process will render it.
 */
export function validateT2(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('addy: a public profile is a flat object')
  }
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const field = T2_ALLOWLIST.find((f) => f.name === name)
    if (!field) {
      // Named, because the fix is to classify it rather than to widen the
      // allowlist by reflex.
      throw new Error(`addy: ${name} is not in the T2 allowlist, so it is secret`)
    }
    switch (field.kind) {
      case 'bool':
        if (typeof value !== 'boolean') throw new Error(`addy: ${name} wants a boolean`)
        break
      case 'int':
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          throw new Error(`addy: ${name} wants a whole number`)
        }
        if (value < field.min || value > field.max) {
          throw new Error(`addy: ${name} is ${value}, allowed ${field.min} to ${field.max}`)
        }
        break
      case 'enum':
        if (typeof value !== 'string' || !field.values.includes(value)) {
          throw new Error(`addy: ${name} is not one of ${field.values.join(', ')}`)
        }
        break
    }
    out[name] = value
  }
  return out
}
