import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Nowhere may say "the vault is locked" and stop there.
 *
 * store/toast.ts already had the argument written down: telling somebody to
 * unlock the vault and try again "means: find the vault, work out what a vault
 * is, unlock it, come back". `withVaultUnlock` applied it to operations that
 * FAIL on a locked vault, and `UnlockVaultButton` to the screens that disable
 * themselves before failing — but the rule was applied one screen at a time,
 * so each new surface had to remember it.
 *
 * A user reported the gap the way it is always found: a job row reading
 * "Paused: the vault is locked, so this server cannot be polled" with nothing
 * to press. This is the ratchet, so the next one fails a build rather than
 * reaching somebody.
 */

/**
 * COMPONENTS that mention a locked vault, with comments stripped.
 *
 * Both narrowings matter. Comments are stripped because a file explaining WHY
 * a control behaves a certain way near a locked vault is not a screen telling
 * somebody it is locked — InventoryPanel's note about Check now is exactly
 * that, and flagging it would train people to add exemptions.
 *
 * And only components: a store that produces the sentence is not the thing
 * that shows it. `fleetStatus` builds those strings for two consumers, the
 * status-bar chip and Settings, and both offer the unlock — checking the store
 * would demand an affordance from a file that renders nothing.
 */
function offenders(): string[] {
  let hits = ''
  try {
    hits = execFileSync(
      'git',
      ['grep', '-l', '-i', '-E', 'vault is locked|vault locked', '--', 'src/renderer/src/components'],
      { encoding: 'utf8' }
    )
  } catch (e) {
    // git grep exits 1 with no matches, which would mean the copy was reworded
    // rather than that the rule is satisfied — so that is a failure here.
    const err = e as { status?: number; stdout?: string }
    if (err.status !== 1) throw e
    hits = err.stdout ?? ''
  }
  return hits
    .split('\n')
    .filter(Boolean)
    .filter((file) => {
      const src = readFileSync(join(process.cwd(), file), 'utf8')
      const prose = src
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      return /vault is locked|vault locked/i.test(prose)
    })
}

/**
 * The two ways a screen may satisfy this, plus the helpers themselves.
 *
 * `UnlockVaultButton` is the affordance; `withVaultUnlock` prompts and retries
 * around a call that failed. Either discharges the duty — what is forbidden is
 * naming the state and offering neither.
 */
const SATISFIES = ['UnlockVaultButton', 'withVaultUnlock', 'useVaultPrompt', 'VaultLockedHosts']

/** Files that are allowed to name it without offering one, each for a reason. */
const EXEMPT = new Map<string, string>([
  // The vault's own screens: the unlock IS the screen.
  ['src/renderer/src/components/vault/VaultSidebar.tsx', 'the vault view itself'],
  ['src/renderer/src/components/vault/VaultView.tsx', 'the vault view itself'],
  // Settings' switch label — "Ask for Touch ID when the vault is locked" is the
  // name of a preference, not a report that it is locked right now.
  ['src/renderer/src/components/settings/Settings.tsx', 'also carries the unlock; see FleetSamplerLine']
])

describe('a locked vault always comes with a way to unlock it', () => {
  it('names no screen that reports it and offers nothing', () => {
    const bad: string[] = []
    for (const file of offenders()) {
      if (EXEMPT.has(file)) continue
      const src = readFileSync(join(process.cwd(), file), 'utf8')
      if (!SATISFIES.some((s) => src.includes(s))) bad.push(file)
    }
    expect(
      bad,
      `these tell the user the vault is locked and offer no way to unlock it:\n${bad.join('\n')}`
    ).toEqual([])
  })

  /**
   * The marker, not the wording, is what renderers match on. A note tagged
   * with it can be recognised without pattern-matching an English sentence —
   * which is what let the paused job row grow an unlock without PatchPanel
   * knowing anything about how that sentence is phrased.
   */
  it('tags the detached-job pause so a renderer can recognise it', () => {
    const detached = readFileSync('src/main/services/jobDetached.ts', 'utf8')
    expect(detached).toContain('VAULT_LOCKED')
    const patch = readFileSync('src/renderer/src/components/monitor/PatchPanel.tsx', 'utf8')
    expect(patch).toContain('isVaultLocked(')
  })

  // The marker is machinery. It must never be shown to a person.
  it('strips the marker before showing the text', () => {
    const patch = readFileSync('src/renderer/src/components/monitor/PatchPanel.tsx', 'utf8')
    expect(patch).toContain('withoutVaultMarker(')
  })
})
