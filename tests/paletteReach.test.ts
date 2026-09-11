import { describe, expect, it } from 'vitest'
import { fuzzyScore } from '../src/renderer/src/lib/fuzzy'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const palette = readFileSync(
  fileURLToPath(new URL('../src/renderer/src/components/palette/CommandPalette.tsx', import.meta.url)),
  'utf8'
)

/**
 * The palette had eight hardcoded actions and a server list, and the
 * walkthrough told users it "reaches every server, workspace, tunnel and action
 * in the app". Databases, the vault, the HTTP client, AI & MCP, Operations,
 * twenty monitor modules and fourteen settings pages were all unreachable from
 * it. For this audience the palette is the primary navigation surface.
 */

describe('the palette is built from the registries, not from a copy', () => {
  it('lists destinations from the activity bar itself', () => {
    // A private copy of the destination list is exactly how six of them went
    // missing while the chrome kept showing them.
    expect(palette).toMatch(/ACTIVITY_ITEMS\.map/)
  })

  it('lists the modules this install has enabled', () => {
    expect(palette).toMatch(/MODULES\.filter\(\(m\) => moduleEnabled\(/)
  })

  it('routes operate modules to Operations and read modules to Monitoring', () => {
    // The two share one activity and are told apart by the rail, so a pointer
    // that ignores the split opens the wrong destination.
    expect(palette).toMatch(/isOperateModule\(m\.id\) \? openOperations/)
  })

  it('lists every settings page', () => {
    expect(palette).toMatch(/SETTINGS_SECTIONS\.map/)
  })
})

describe('fuzzy matching', () => {
  it('finds a name from its initials', () => {
    // The thing `String.includes` could not do, and the reason the palette made
    // you type the start of a word you would have to already know.
    expect(fuzzyScore('kbs', 'Keyboard Shortcuts')).toBeGreaterThan(0)
    expect(fuzzyScore('bkp', 'Backup & Restore')).toBeGreaterThan(0)
  })

  it('rejects characters that are not there, in order', () => {
    expect(fuzzyScore('zzz', 'Keyboard Shortcuts')).toBe(0)
    expect(fuzzyScore('stuohs', 'Shortcuts')).toBe(0)
  })

  it('ranks a whole-word match above a scattered one', () => {
    const exact = fuzzyScore('vault', 'Vault')
    const scattered = fuzzyScore('vault', 'Verify and load user access table')
    expect(exact).toBeGreaterThan(scattered)
  })

  it('ranks the shorter of two matches first', () => {
    expect(fuzzyScore('ssh', 'SSH')).toBeGreaterThan(fuzzyScore('ssh', 'SSH agent forwarding'))
  })

  it('prefers a match at the start of a word', () => {
    expect(fuzzyScore('mon', 'Monitoring')).toBeGreaterThan(fuzzyScore('mon', 'Daemon settings'))
  })

  it('treats an empty query as matching everything', () => {
    expect(fuzzyScore('', 'anything')).toBeGreaterThan(0)
    expect(fuzzyScore('   ', 'anything')).toBeGreaterThan(0)
  })
})
