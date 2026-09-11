import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Colours are declared once, in `tokens.css`, and used everywhere else.
 *
 * That is already the design -- five type roles, a full light override, and two
 * earned sub-palettes -- and it worked right up until a rule wrote a hex
 * directly. Those never got a light-theme counterpart, because there is nowhere
 * for one to live: `.log-line:hover` painted a white veil, which is exactly
 * nothing on the light theme's white ground, so the busiest surface in the app
 * had no hover at all for half its users. The brand mark hardcoded its gradient
 * and its ink the same way.
 *
 * A hex is not banned for being ugly. It is banned because a literal cannot
 * take part in a theme.
 */

const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')

/**
 * Deliberate literals, each with the reason it cannot be a token.
 *
 * Like the exception list in `typeScale.test.ts`, this is meant to shrink. An
 * entry earns its place by being a colour that must NOT change with the theme.
 */
const ALLOWED = new Map<string, string>([
  [
    '.rdp-surface',
    'The letterbox behind a remote desktop. Black in both themes on purpose: the ' +
      'session paints its own background and a light gap around a Windows login ' +
      'screen reads as a rendering fault.'
  ]
])

/** Property declarations carrying a raw hex, outside custom-property definitions. */
function rawHexRules(css: string): string[] {
  const out: string[] = []
  let selector = ''
  // Comments first, so a hex quoted in prose is not a finding.
  for (const line of css.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')) {
    const sel = /^\s*([.#:[a-zA-Z][^{}]*)\{\s*$/.exec(line)
    if (sel) selector = sel[1].trim()
    if (/^\s*--/.test(line)) continue // a token definition IS where hexes live
    if (!/#[0-9a-fA-F]{3,8}\b/.test(line)) continue
    if (/var\(--[a-z-]+,\s*#/.test(line)) continue // a fallback behind a token
    const first = selector.split(',')[0].trim()
    if ([...ALLOWED.keys()].some((a) => selector.includes(a))) continue
    out.push(`${first}: ${line.trim()}`)
  }
  return out
}

describe('every colour outside tokens.css comes from a token', () => {
  it('has no raw hex in global.css', () => {
    expect(rawHexRules(read('../src/renderer/src/styles/global.css'))).toEqual([])
  })

  it('keeps the allowlist honest', () => {
    // An entry with no reason written next to it is an entry nobody reviewed.
    for (const [sel, why] of ALLOWED) {
      expect(why.length, `${sel} needs a reason`).toBeGreaterThan(40)
    }
  })
})
