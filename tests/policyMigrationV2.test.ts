import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(
  fileURLToPath(new URL('../src/main/services/policyStore.ts', import.meta.url)),
  'utf8'
)

/**
 * The one-time clear-out that came with making the session's group the grant.
 *
 * Every assignment on disk was written under the OLD rule, where an assignment
 * was the grant and a target without one was denied. Under the new rule an
 * assignment means the opposite thing -- an optional restriction -- so carrying
 * them forward would turn each one into a cap the user never asked for, which
 * is the exact pain that prompted the change.
 *
 * CLEARING THEM WIDENS WHAT AN AI SESSION CAN REACH. That was chosen
 * deliberately by the user. These tests exist so the next person to read this
 * file finds the decision written down rather than inferring it from a diff.
 */

describe('the version-2 migration', () => {
  it('runs once, gated on the version stamp', () => {
    expect(SRC).toMatch(/ASSIGNMENTS_CLEARED_VERSION = 2/)
    expect(SRC).toMatch(/if \(\(state\.version \?\? 1\) >= ASSIGNMENTS_CLEARED_VERSION\) return state/)
  })

  it('empties the assignments rather than rewriting them', () => {
    // Rewriting them into the new meaning would be the app deciding which of a
    // user's old restrictions it thinks they still want.
    expect(SRC).toMatch(/assignments: \[\]/)
  })

  it('keeps a record of what it removed', () => {
    // A migration that widens access does not get to do it quietly: the UI has
    // to be able to name the targets that used to carry a restriction.
    expect(SRC).toMatch(/clearedAssignments/)
  })

  it('is applied on the read path, not only to fresh installs', () => {
    expect(SRC).toMatch(/dropLegacyAssignments\(/)
  })

  it('seeds new installs already at version 2', () => {
    // Otherwise a fresh install would run a migration over an empty array and
    // then claim it had cleared something.
    expect(SRC).toMatch(/version: ASSIGNMENTS_CLEARED_VERSION/)
  })
})
