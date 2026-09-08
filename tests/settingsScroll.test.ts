import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Found by opening the shipped build: Settings and AI & MCP could not scroll.
//
// `.settings` is a grid with `height: 100%`, and a grid item's default
// `min-height: auto` means it will NOT shrink below its own content. So
// `.settings-content` grew past the row instead of scrolling inside it, its
// `overflow-y: auto` never engaged, and everything past the fold was simply
// unreachable — no scrollbar, no wheel response, and nothing on screen saying
// there was more.
//
// Both surfaces use this layout, so it was every long page of both: the
// Monitoring settings below "Also send when it recovers", the access-group
// editor with its twenty-one path rules, and the group comparison.
//
// The `height: 100%` was doing its job. What was missing is permission for the
// children to be smaller than what is in them.

const CSS = readFileSync(
  join(__dirname, '../src/renderer/src/styles/global.css'),
  'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '')

const rule = (selector: string): string => {
  const i = CSS.indexOf(`${selector} {`)
  expect(i, `${selector} must exist`).toBeGreaterThan(-1)
  return CSS.slice(i, CSS.indexOf('}', i))
}

describe('a scroll container is allowed to be smaller than its contents', () => {
  // THE fix. Without it the declaration below is decorative.
  it.each(['.settings-content', '.settings-nav'])('%s can shrink', (sel) => {
    expect(rule(sel)).toMatch(/min-height:\s*0/)
  })

  it('still declares the overflow it needs to scroll', () => {
    expect(rule('.settings-content')).toMatch(/overflow-y:\s*auto/)
    expect(rule('.settings-nav')).toMatch(/overflow-y:\s*auto/)
  })

  // A bare implicit row is `auto`-sized, which is the other half of the same
  // mistake: the row grows with its content rather than bounding it.
  it('bounds the grid row rather than letting it grow', () => {
    const block = rule('.settings')
    expect(block).toMatch(/grid-template-rows:\s*minmax\(\s*0\s*,\s*1fr\s*\)/)
    expect(block).toMatch(/height:\s*100%/)
  })
})

describe('the layout is shared, so the fix has to be', () => {
  // AiPanel renders `.settings` too. If it ever grew its own class the fix
  // would silently stop covering half the surfaces it was written for.
  it('is used by both Settings and AI & MCP', () => {
    for (const f of [
      '../src/renderer/src/components/ai/AiPanel.tsx',
      '../src/renderer/src/components/settings/Settings.tsx'
    ]) {
      const src = readFileSync(join(__dirname, f), 'utf8')
      expect(src, f).toContain('className="settings"')
      expect(src, f).toContain('settings-content')
    }
  })
})

// ---------------------------------------------------------------------------
// The same mistake, swept for
// ---------------------------------------------------------------------------
//
// `.modal-body` already carries this fix with a comment explaining it, so the
// rule was known in this codebase and two places simply never got it. The
// second was `.palette-list` — Cmd+K, which is how the app expects you to reach
// anything, clipped instead of scrolled once the result list outgrew its 60vh
// cap. It fits on a small estate and silently loses results on a real one.
describe('every scroll container in the sheet can actually shrink', () => {
  it('leaves no scroll container without a height constraint of some kind', () => {
    const rules = [...CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    const bad = rules
      .filter(([, , body]) => /overflow(-y)?:\s*(auto|scroll)/.test(body))
      .filter(([, , body]) => !/min-height:\s*0/.test(body))
      .filter(([, , body]) => !/\b(height|max-height|flex):/.test(body))
      .map(([, sel]) => sel.trim().split('\n').pop()!.trim())
      // `.scrim` is `position: fixed; inset: 0` — already viewport-bounded, so
      // it has nothing to shrink relative to and needs no min-height.
      .filter((sel) => sel !== '.scrim')
    expect(bad, `scroll containers that cannot shrink: ${bad.join(', ')}`).toEqual([])
  })

  // Anti-vacuity: a regex that stopped matching would pass with an empty list.
  it('finds scroll containers to check', () => {
    expect([...CSS.matchAll(/overflow(-y)?:\s*(auto|scroll)/g)].length).toBeGreaterThan(5)
  })

  it('fixes the palette specifically, since that is the one people use most', () => {
    expect(rule('.palette-list')).toMatch(/min-height:\s*0/)
  })
})
