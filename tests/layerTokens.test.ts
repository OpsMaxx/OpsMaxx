import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// The approval dialog rendered a bare `.scrim`, which is z-index 100 — the same
// layer as every other dialog, and under the command palette (200), a toast
// (300) and the walkthrough (900). An agent blocked on an approval is refused
// when the fuse runs out, so a dialog anything can cover is a refusal the
// operator never saw coming.
//
// The fix is one layer order in tokens.css and every z-index reading from it.
// These tests resolve the rules the way the browser would, rather than
// comparing class names, so a new rule with a bare number cannot quietly slot
// itself above the approval.

const ROOT = join(__dirname, '../src/renderer/src')
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')
const TOKENS = strip(readFileSync(join(ROOT, 'styles/tokens.css'), 'utf8'))
const GLOBAL = strip(readFileSync(join(ROOT, 'styles/global.css'), 'utf8'))

const layers = Object.fromEntries(
  [...TOKENS.matchAll(/--(z-[a-z-]+):\s*(\d+);/g)].map((m) => [m[1], Number(m[2])])
)

/** A z-index value as a number: a token, or a token plus a constant. */
const resolve = (value: string): number => {
  const m = value.match(/var\(--(z-[a-z-]+)\)(?:\s*\+\s*(\d+))?/)
  expect(m, `"${value}" is not a layer token`).not.toBeNull()
  expect(layers[m![1]], `--${m![1]} must be defined`).toBeTypeOf('number')
  return layers[m![1]] + Number(m![2] ?? 0)
}

const zOf = (selector: string): number => {
  const i = GLOBAL.indexOf(`${selector} {`)
  expect(i, `${selector} must exist`).toBeGreaterThan(-1)
  const body = GLOBAL.slice(i, GLOBAL.indexOf('}', i))
  const m = body.match(/z-index:\s*([^;]+);/)
  expect(m, `${selector} must declare a z-index`).not.toBeNull()
  return resolve(m![1])
}

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : [p]
  })

describe('layer tokens', () => {
  it('makes the approval layer the top one', () => {
    const top = Math.max(...Object.values(layers))
    expect(layers['z-approval']).toBe(top)
    expect(Object.entries(layers).filter(([, v]) => v === top)).toHaveLength(1)
  })

  it('paints the approval scrim above everything that could cover it', () => {
    const approval = zOf('.scrim.approval-scrim')
    for (const sel of ['.palette-scrim', '.toasts', '.tour-card', '.tip-card', '.setup-scrim', '.menu']) {
      expect(approval, sel).toBeGreaterThan(zOf(sel))
    }
    // ...and above the fiftieth stacked Modal, which is as high as `.scrim` goes
    // before it would meet `--z-menu`.
    expect(approval).toBeGreaterThan(layers['z-modal'] + 50)
  })

  it('keeps the order the rules had before they were tokens', () => {
    expect(zOf('.scrim')).toBeLessThan(zOf('.menu'))
    expect(zOf('.menu')).toBeLessThan(zOf('.palette-scrim'))
    expect(zOf('.palette-scrim')).toBeLessThan(zOf('.toasts'))
    expect(zOf('.toasts')).toBeLessThan(zOf('.tip-card'))
    expect(zOf('.tip-card')).toBeLessThan(zOf('.tour-card'))
    expect(zOf('.tab-overflow-scrim')).toBeLessThan(zOf('.tab-overflow-menu'))
  })

  it('has no bare z-index anywhere in the renderer', () => {
    const bare: string[] = []
    for (const f of files(ROOT)) {
      if (!/\.(css|tsx?)$/.test(f)) continue
      const src = f.endsWith('.css') ? strip(readFileSync(f, 'utf8')) : readFileSync(f, 'utf8')
      for (const m of src.matchAll(/(?:z-index:|zIndex:)\s*([^;,}\n]+)/g)) {
        if (!/var\(--z-|--modal-layer/.test(m[1]) && !f.endsWith('tokens.css')) bare.push(`${f}: ${m[0]}`)
      }
    }
    expect(bare).toEqual([])
  })
})
