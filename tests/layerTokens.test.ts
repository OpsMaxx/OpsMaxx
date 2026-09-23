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
// Every stylesheet a layer rule lives in, not only global.css: the SSH agent
// prompt, the conflict chooser and the revocation screen each have their own.
const CSS = ['styles/global.css', 'components/sshAgent/agent.css', 'components/addy/addy.css']
  .map((f) => strip(readFileSync(join(ROOT, f), 'utf8')))
  .join('\n')

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
  const i = CSS.indexOf(`${selector} {`)
  expect(i, `${selector} must exist`).toBeGreaterThan(-1)
  const body = CSS.slice(i, CSS.indexOf('}', i))
  const m = body.match(/z-index:\s*([^;]+);/)
  expect(m, `${selector} must declare a z-index`).not.toBeNull()
  return resolve(m![1])
}

/** Captures the value of any z-index write. */
const Z_DECL = /(?:z-index['"]?\s*[:,]|zIndex\s*[:=])\s*([^;,}\n)]+)/g

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : [p]
  })

describe('layer tokens', () => {
  // Two layers go above it, deliberately. Toasts, because the kill switch's
  // failure and a fuse running out are reported by toast while an approval is
  // on screen. The revocation screen, because it replaces the app.
  it('puts the approval layer above every other layer but toasts and revocation', () => {
    for (const [name, z] of Object.entries(layers)) {
      if (['z-approval', 'z-toast', 'z-revoked'].includes(name)) continue
      expect(layers['z-approval'], name).toBeGreaterThan(z)
    }
    expect(layers['z-toast']).toBeGreaterThan(layers['z-approval'])
    expect(layers['z-revoked']).toBe(Math.max(...Object.values(layers)))
  })

  it('paints the approval scrim above everything that could cover it', () => {
    const approval = zOf('.scrim.approval-scrim')
    for (const sel of ['.palette-scrim', '.tour-card', '.tip-card', '.setup-scrim', '.menu', '.conflict-scrim']) {
      expect(approval, sel).toBeGreaterThan(zOf(sel))
    }
    // ...and above the fiftieth stacked Modal, which is as high as `.scrim` goes
    // before it would meet `--z-menu`.
    expect(approval).toBeGreaterThan(layers['z-modal'] + 50)
  })

  it('lets a toast be read while an approval is up', () => {
    expect(zOf('.toasts')).toBeGreaterThan(zOf('.scrim.approval-scrim'))
  })

  it('puts the SSH agent signing prompt on the approval layer', () => {
    expect(zOf('.agent-approval-scrim')).toBe(zOf('.scrim.approval-scrim'))
  })

  it('keeps the revocation screen above everything and the conflict chooser under approvals', () => {
    expect(zOf('.revoked-screen')).toBe(Math.max(...Object.values(layers)))
    expect(zOf('.revoked-screen')).toBeGreaterThan(zOf('.toasts'))
    expect(zOf('.conflict-scrim')).toBeGreaterThan(zOf('.tour-card'))
    expect(zOf('.conflict-scrim')).toBeLessThan(zOf('.scrim.approval-scrim'))
  })

  it('keeps the order the rules had before they were tokens', () => {
    expect(zOf('.scrim')).toBeLessThan(zOf('.menu'))
    expect(zOf('.menu')).toBeLessThan(zOf('.palette-scrim'))
    expect(zOf('.palette-scrim')).toBeLessThan(zOf('.tour-card'))
    expect(zOf('.tab-overflow-scrim')).toBeLessThan(zOf('.tab-overflow-menu'))
  })

  // The one layer moved DOWN. A feature tip is a note beside a view; at 880 it
  // drew over the command palette's scrim and over every dialog.
  it('keeps a feature tip under the palette and every dialog', () => {
    expect(zOf('.tip-card')).toBeLessThan(zOf('.scrim'))
    expect(zOf('.tip-card')).toBeLessThan(zOf('.palette-scrim'))
    expect(zOf('.tip-card')).toBeGreaterThan(zOf('.panel-info-pop'))
  })

  // A CSS declaration, a style object, an assignment, or `setProperty`.
  it('recognises every way a z-index can be written', () => {
    for (const src of [
      'z-index: 5;',
      '{ zIndex: 5 }',
      "el.style.zIndex = '5'",
      "el.style.setProperty('z-index', '5')"
    ]) {
      expect([...src.matchAll(Z_DECL)].map((m) => m[1].trim()), src).toEqual([expect.stringMatching(/5/)])
    }
  })

  it('has no bare z-index anywhere in the renderer', () => {
    const bare: string[] = []
    for (const f of files(ROOT)) {
      if (!/\.(css|tsx?)$/.test(f)) continue
      // Comments stripped in both, or prose such as "one z-index, so" reads as a
      // declaration. The `[^:]` keeps a URL's `https://` from being taken for one.
      const raw = readFileSync(f, 'utf8')
      const src = f.endsWith('.css') ? strip(raw) : strip(raw).replace(/(^|[^:])\/\/.*$/gm, '$1')
      for (const m of src.matchAll(Z_DECL)) {
        if (!/var\(--z-|--modal-layer/.test(m[1]) && !f.endsWith('tokens.css')) bare.push(`${f}: ${m[0]}`)
      }
    }
    expect(bare).toEqual([])
  })
})
