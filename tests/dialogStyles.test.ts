import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// dialogs.css read as text, for the same reason tests/styleContract.test.ts
// reads global.css that way: jsdom loads no stylesheet, so a component test
// renders `className="btn quiet size-24"`, finds the button, asserts the label
// and passes whether or not either of those classes resolves to anything.
//
// What is asserted here is the inventory itself. The measured button heights
// across this app were 30, 28, 28, 26, 25, 22, 18 and 16; the fix is not "add
// some more rules", it is that there are exactly three heights and they are
// 32, 28 and 24. A test that only checked the three existed would not notice a
// fourth being added next to them.

const ROOT = join(__dirname, '..')
const CSS = readFileSync(join(ROOT, 'src/renderer/src/styles/dialogs.css'), 'utf8')
/** Comments carry example values and the odd hex-looking word; every rule
 *  below is about declarations, so they come out first. */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '')

describe('the button size system has three sizes and no more', () => {
  it('defines exactly 32, 28 and 24', () => {
    const sizes = [...RULES.matchAll(/\.btn\.size-(\d+)\s*\{/g)].map((m) => m[1])
    expect(sizes.sort()).toEqual(['24', '28', '32'])
  })

  it('each size class actually sets that height', () => {
    for (const px of ['32', '28', '24']) {
      const rule = new RegExp(`\\.btn\\.size-${px}\\s*\\{[^}]*height:\\s*${px}px`, 'm')
      expect(rule.test(RULES)).toBe(true)
    }
  })

  it('sets no height anywhere else, so a fourth size cannot arrive sideways', () => {
    const heights = [...RULES.matchAll(/height:\s*(\d+)px/g)].map((m) => m[1])
    expect([...new Set(heights)].sort()).toEqual(['24', '28', '32'])
  })
})

describe('the four variants', () => {
  it.each([
    ['secondary', /\.btn\.secondary\s*\{[^}]*background:\s*var\(--bg-card\)/],
    ['secondary border', /\.btn\.secondary\s*\{[^}]*border-color:\s*var\(--border\)/],
    ['danger outline', /\.btn\.danger\.outline\s*\{[^}]*border-color:\s*var\(--danger\)/],
    ['danger fill', /\.btn\.danger\.fill\s*\{[^}]*background:\s*var\(--danger\)/]
  ])('%s is defined against the token it is named for', (_what, re) => {
    expect(re.test(RULES)).toBe(true)
  })

  it('the ghost variant reads as clickable at rest, not only on hover', () => {
    // The whole finding: a tertiary action with no chrome is 13px body text
    // standing beside a filled button, and users never find it. An underline
    // that only appears on hover does not help someone who never hovers.
    const rest = /\.btn\.quiet\s*\{([^}]*)\}/.exec(RULES)
    expect(rest).not.toBeNull()
    expect(rest![1]).toContain('text-decoration: underline')
  })

  it('the ghost variant grows a border on hover rather than a fill', () => {
    const hover = /\.btn\.quiet:hover\s*\{([^}]*)\}/.exec(RULES)
    expect(hover).not.toBeNull()
    expect(hover![1]).toContain('border-color: var(--border)')
    expect(hover![1]).toContain('background: transparent')
  })
})

describe('the footer contract', () => {
  it('a dialog footer is right-aligned by the stylesheet, not by each caller', () => {
    expect(/\.modal-footer\s*\{[^}]*justify-content:\s*flex-end/.test(RULES)).toBe(true)
  })

  it('an inline commit panel gets the same right-aligned footer, under a divider', () => {
    const rule = /\.inline-panel-footer\s*\{([^}]*)\}/.exec(RULES)
    expect(rule).not.toBeNull()
    expect(rule![1]).toContain('justify-content: flex-end')
    expect(rule![1]).toContain('border-top: 1px solid var(--border-subtle)')
  })
})

describe('field validation styling', () => {
  it('an invalid control is drawn in --danger, not merely described as invalid', () => {
    expect(/\.field-control\.invalid[^{]*\{[^}]*border-color:\s*var\(--danger\)/.test(RULES)).toBe(
      true
    )
  })

  it('the message under the field is --danger too', () => {
    expect(/\.field-error\s*\{[^}]*color:\s*var\(--danger\)/.test(RULES)).toBe(true)
  })
})

describe('the compact empty state', () => {
  it('is left-aligned and drops the height the full variant claims', () => {
    const rule = /\.empty\.compact\s*\{([^}]*)\}/.exec(RULES)
    expect(rule).not.toBeNull()
    expect(rule![1]).toContain('align-items: flex-start')
    expect(rule![1]).toContain('text-align: left')
    expect(rule![1]).toContain('height: auto')
  })
})

describe('colours come from tokens', () => {
  it('names no hex literal', () => {
    // Every colour in this file is a role. A literal here is a colour that
    // cannot follow the light theme, which is where the app's only WCAG
    // failure lived the last time one was measured.
    expect(RULES.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull()
  })

  it('uses only tokens the theme actually defines', () => {
    const tokens = readFileSync(join(ROOT, 'src/renderer/src/styles/tokens.css'), 'utf8')
    const used = new Set([...RULES.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]))
    const missing = [...used].filter((t) => !new RegExp(`\\s${t}\\s*:`).test(tokens))
    expect(missing).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The destructive role, applied
// ---------------------------------------------------------------------------
//
// `danger` had two treatments across the app — red text with a neutral border
// in one place, a red-outlined button in another, and a fill somewhere else —
// so the one role that has to be recognised instantly was the one the eye had
// to work out per screen.
//
// `outline` is the default and `fill` is reserved for something that cannot be
// undone. A fill on anything reversible spends the treatment that should still
// mean something when it is genuinely needed, which is the same argument the
// typed-word confirmations make about their word.
describe('every destructive button says which kind it is', () => {
  const FILES = [
    'src/renderer/src/components/settings/BackupPanel.tsx',
    'src/renderer/src/components/settings/CredProxyPanel.tsx',
    'src/renderer/src/components/settings/BackupDestinations.tsx',
    'src/renderer/src/components/ai/CliPairingBanner.tsx',
    'src/renderer/src/components/ai/AiSecurity.tsx',
    'src/renderer/src/components/ai/AiAgents.tsx',
    'src/renderer/src/components/vpn/useVpnProfiles.tsx',
    'src/renderer/src/components/processes/ProcessesPanel.tsx',
    'src/renderer/src/components/tunnels/TunnelManager.tsx'
  ]

  it.each(FILES)('%s uses outline or fill, never bare danger', (file) => {
    const src = readFileSync(join(ROOT, file), 'utf8')
    // Every `btn … danger …` occurrence must be qualified. A bare one is the
    // ambiguous treatment this rule exists to remove.
    const bare = [...src.matchAll(/className="btn[^"]*\bdanger\b[^"]*"/g)]
      .map((m) => m[0])
      .filter((c) => !/\boutline\b|\bfill\b/.test(c))
    expect(bare, `${file} has unqualified danger buttons: ${bare.join(', ')}`).toEqual([])
  })

  // Anti-vacuity: a regex that stopped matching would pass every file at once.
  it('finds danger buttons to check', () => {
    const all = FILES.map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n')
    expect([...all.matchAll(/className="btn[^"]*\bdanger\b[^"]*"/g)].length).toBeGreaterThan(4)
  })
})
