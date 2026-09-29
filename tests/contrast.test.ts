import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The colour ramp, checked against the WCAG formula rather than against
// somebody's eye.
//
// The light theme shipped an accent of #0e9aa8: 3.38:1 carrying a white label
// and 3.13:1 used as body text, on the primary control of every panel. It was
// the only AA failure in the product, and it lived on the single most important
// thing on each screen — in a bright room, which is the reason a person picks
// the light theme in the first place.
//
// Alongside it, --text-faint measured 3.41:1 on --bg-card. That is the colour
// of "not collected yet" / "not identified" / NULL, which is the majority of
// the visible cells on the inventory, drift and posture tables. The least
// legible text on screen was the most common text on screen.
//
// This test reads the shipped stylesheet, so it fails on the values that would
// actually render — not on a copy of them kept in a fixture.

// Comments are stripped first. The explanatory notes in tokens.css quote the
// values they replaced — `--accent-hover: #12aebe` appears verbatim in the
// paragraph explaining why it is gone — and a regex over the raw file happily
// reads a dead value out of the prose that buried it.
const CSS = readFileSync(join(__dirname, '../src/renderer/src/styles/tokens.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
)

/** WCAG 2.x relative luminance. */
function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const chan = (i: number): number => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * chan(0) + 0.7152 * chan(2) + 0.0722 * chan(4)
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

type Theme = 'dark' | 'light' | 'opsmaxx' | 'opsmaxx-light'

/**
 * Read a token out of one theme's block.
 *
 * Each block is sliced between its own selector and the next one, so a token
 * missing from the light block is not silently read out of the block after
 * it -- which is the exact bug class this file exists to catch. The OpsMaxx
 * blocks restate only what differs from their base -- dark for OpsMaxx, light
 * for OpsMaxx Light -- so a token one does not define is read from its base:
 * that is what the cascade does with it too.
 *
 * OpsMaxx Light is located by its LAST occurrence: its name also appears in
 * the classic light block's selector list, which is how it inherits.
 */
function token(theme: Theme, name: string): string {
  const light = CSS.indexOf(":root[data-theme='light']")
  const opsmaxx = CSS.indexOf(":root[data-theme='opsmaxx']")
  const opsmaxxLight = CSS.lastIndexOf(":root[data-theme='opsmaxx-light']")
  expect(light, 'light theme block must exist').toBeGreaterThan(-1)
  expect(opsmaxx, 'opsmaxx theme block must exist').toBeGreaterThan(light)
  expect(opsmaxxLight, 'opsmaxx-light theme block must exist').toBeGreaterThan(opsmaxx)
  const blocks: Record<Theme, string> = {
    dark: CSS.slice(0, light),
    light: CSS.slice(light, opsmaxx),
    opsmaxx: CSS.slice(opsmaxx, opsmaxxLight),
    'opsmaxx-light': CSS.slice(opsmaxxLight)
  }
  const base: Partial<Record<Theme, Theme>> = { opsmaxx: 'dark', 'opsmaxx-light': 'light' }
  const find = (block: string): string | undefined =>
    new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block)?.[1]
  const from = base[theme]
  const value = find(blocks[theme]) ?? (from ? find(blocks[from]) : undefined)
  expect(value, `--${name} must be defined as a hex in the ${theme} theme`).toBeDefined()
  return value!
}

/** Every surface a piece of text can land on, per theme. Worst case governs. */
const SURFACES: Record<Theme, string[]> = {
  dark: ['bg-app', 'bg-sidebar', 'bg-panel', 'bg-card', 'bg-elevated', 'bg-input'],
  light: ['bg-app', 'bg-sidebar', 'bg-panel', 'bg-card', 'bg-elevated', 'bg-input'],
  opsmaxx: ['bg-app', 'bg-sidebar', 'bg-panel', 'bg-card', 'bg-elevated', 'bg-input'],
  'opsmaxx-light': ['bg-app', 'bg-sidebar', 'bg-panel', 'bg-card', 'bg-elevated', 'bg-input']
}

const AA = 4.5

function worstOnSurfaces(theme: Theme, fg: string): { ratio: number; on: string } {
  let worst = { ratio: Infinity, on: '' }
  for (const s of SURFACES[theme]) {
    const r = contrast(fg, token(theme, s))
    if (r < worst.ratio) worst = { ratio: r, on: s }
  }
  return worst
}

describe.each(['dark', 'light', 'opsmaxx', 'opsmaxx-light'] as const)('%s theme', (theme) => {
  // The tokens that carry running text. --text-faint is in here deliberately:
  // "faint" is a hierarchy position, not a licence to fall below the floor.
  it.each(['text', 'text-muted', 'text-faint'])('--%s clears AA on every surface', (name) => {
    const { ratio, on } = worstOnSurfaces(theme, token(theme, name))
    expect(ratio, `--${name} is ${ratio.toFixed(2)}:1 on --${on}`).toBeGreaterThanOrEqual(AA)
  })

  it('--accent-ink clears AA on every surface, because it is used as text', () => {
    const { ratio, on } = worstOnSurfaces(theme, token(theme, 'accent-ink'))
    expect(ratio, `--accent-ink is ${ratio.toFixed(2)}:1 on --${on}`).toBeGreaterThanOrEqual(AA)
  })

  // --accent is a FILL. What has to be legible is the label sitting on it.
  it.each(['accent', 'accent-hover', 'accent-press'])(
    '--%s carries --accent-text at AA',
    (name) => {
      const ratio = contrast(token(theme, name), token(theme, 'accent-text'))
      expect(ratio, `${name} vs accent-text is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA)
    }
  )

  // Rendered as the engine name in the tab header, so they are text colours.
  it.each(['db-postgres', 'db-mysql', 'db-mssql', 'db-mongodb', 'db-redis'])(
    '--%s clears AA, because the engine name is drawn in it',
    (name) => {
      const { ratio, on } = worstOnSurfaces(theme, token(theme, name))
      expect(ratio, `--${name} is ${ratio.toFixed(2)}:1 on --${on}`).toBeGreaterThanOrEqual(AA)
    }
  )
})

describe('the two accent roles are genuinely separate', () => {
  // The point of splitting them. If one value satisfied both roles there would
  // be no reason for two tokens — and in the light theme it demonstrably
  // cannot: the fill is tuned against the white label ON it, the ink against
  // the surfaces BEHIND it, and those pull in opposite directions.
  it('the light fill would fail if it were used as text', () => {
    const asText = worstOnSurfaces('light', token('light', 'accent')).ratio
    expect(asText).toBeLessThan(AA)
  })

  it('so nothing may set colour from --accent — that is what --accent-ink is for', () => {
    const css = readFileSync(
      join(__dirname, '../src/renderer/src/styles/global.css'),
      'utf8'
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    // Anchored, because `color:` is a substring of `border-color:` and a
    // BORDER may legitimately take the fill token — only text may not. An
    // unanchored match here reported main's `border-color: var(--accent)` as a
    // violation, which is the same over-broad-assertion mistake in miniature.
    expect(css).not.toMatch(/(?:^|[\s;{])color:\s*var\(--accent\)\s*;/m)
  })
})

describe('hover and press darken on a light ground', () => {
  // --accent-hover used to be #12aebe, LIGHTER than the #0e9aa8 base. On a
  // light ground lightening a fill reduces its contrast with the white label on
  // top of it, so the hover state was less legible than the resting state —
  // 3.86:1 against 3.38:1. The direction is a consequence of the theme, not a
  // stylistic preference.
  it.each(['light', 'opsmaxx-light'] as const)(
    '%s hover and press are darker than the resting accent',
    (theme) => {
      const base = luminance(token(theme, 'accent'))
      expect(luminance(token(theme, 'accent-hover'))).toBeLessThan(base)
      expect(luminance(token(theme, 'accent-press'))).toBeLessThan(base)
    }
  )

  it.each(['dark', 'opsmaxx'] as const)(
    '%s hover is lighter than the resting accent, for the same reason inverted',
    (theme) => {
      expect(luminance(token(theme, 'accent-hover'))).toBeGreaterThan(
        luminance(token(theme, 'accent'))
      )
    }
  )
})
