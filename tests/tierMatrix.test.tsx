// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { AI_CAPABILITIES } from '../src/shared/mcp'

// Five cards of prose, each opening with a near-identical sentence, with the
// differences buried mid-paragraph as single clauses — "asks you first before
// writing files" against "can write files without asking". Answering "which of
// these should I pick?" meant reading a few hundred words and diffing them
// mentally. The naming does not help either: `Sudo Access` sounds like the most
// dangerous option while `Full Access` sits above it, grants MORE, and asks for
// LESS.

const SRC = readFileSync(
  join(__dirname, '../src/renderer/src/components/ai/AiAccessGroups.tsx'),
  'utf8'
)

describe('the comparison is derived, never written down', () => {
  // The load-bearing property. A hand-written comparison keeps describing the
  // presets after somebody edits a group, which is worse than having none — the
  // cards are generated from live capabilities for exactly this reason and the
  // matrix has to hold to the same rule.
  it('reads every row from AI_CAPABILITIES rather than a local list', () => {
    expect(SRC).toMatch(/AI_CAPABILITIES\.map\(\(c\) => \(/)
  })

  it('reads every cell from the group being rendered', () => {
    expect(SRC).toMatch(/g\.capabilities\[c\.id\]/)
  })

  // An absent capability evaluates as DENY everywhere else in the app. A blank
  // cell would read as "not applicable", which is a different claim and not the
  // one the policy makes.
  it('renders an absent capability as deny rather than as an empty cell', () => {
    expect(SRC).toMatch(/g\.capabilities\[c\.id\] \?\? 'deny'/)
  })

  it('covers every capability the bridge can gate', () => {
    expect(AI_CAPABILITIES.length).toBeGreaterThan(10)
    // Anti-vacuity: the assertion above is only meaningful while the registry
    // is the thing the matrix iterates.
    expect(SRC.includes('AI_CAPABILITIES')).toBe(true)
  })
})

describe('what the cells say', () => {
  // `ask` is the value that matters most on this screen and has no natural
  // glyph; a tick/cross scheme would have to round it to one of the other two.
  it('prints the permission word rather than a symbol', () => {
    expect(SRC).toMatch(/\{v\}<\/span>/)
    expect(SRC).not.toMatch(/['"]✓['"]|['"]✗['"]/)
  })

  // allow is the loud one: it is the value that lets an agent act with nobody
  // watching, so it cannot be the quiet cell in a grid about risk.
  it('tones allow as the alarming value, not deny', () => {
    const i = SRC.indexOf('const PERM_TONE')
    expect(i).toBeGreaterThan(-1)
    const block = SRC.slice(i, SRC.indexOf('}', i))
    expect(block).toMatch(/allow: 'danger'/)
    expect(block).toMatch(/deny: ''/)
  })

  // "Server metrics" understated its grant once already — it meant CPU and
  // memory when consent was given and now also returns a service and port
  // inventory. A comparison that repeats the label teaches nothing the grid
  // does not already show.
  it('carries each capability detail, not only its label', () => {
    expect(SRC).toMatch(/title=\{c\.detail\}/)
  })
})

describe('it does not pretend to compare one thing', () => {
  it('renders nothing below two groups', () => {
    expect(SRC).toMatch(/if \(groups\.length < 2\) return null/)
  })
})
