import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import ceiling from './fixtures/i18n/literalCeiling.json'

// A ratchet on hardcoded English in the renderer, while the strings are moved
// into shared/locales a file at a time.
//
// Counted per file: JSX text with words in it, and string literals in the
// attributes a user reads (title, placeholder, aria-label, alt, label). A file
// may not go above its number — new UI text goes through `t()` — and when a file
// goes BELOW it, the number in literalCeiling.json comes down with it, so the
// room a translated string leaves cannot be quietly spent on a new English one.
// A file not listed has a ceiling of zero.
//
// Deliberately narrow: template literals, toasts and object props are English
// too (see the localization estimate), but they are not countable without
// guessing, and a ratchet that guesses is one people learn to bump.

const ROOT = 'src/renderer/src'
const ATTRS = new Set(['title', 'placeholder', 'aria-label', 'alt', 'label'])
const WORDY = /[A-Za-z]{2,}/

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return tsxFiles(p)
    return e.name.endsWith('.tsx') ? [p] : []
  })
}

function countLiterals(file: string): number {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let n = 0
  const isWordyString = (e: ts.Node | undefined): boolean =>
    !!e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) && WORDY.test(e.text)
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node) && WORDY.test(node.text)) n++
    else if (ts.isJsxAttribute(node) && ATTRS.has(node.name.getText(src))) {
      const init = node.initializer
      if (isWordyString(init) || (init && ts.isJsxExpression(init) && isWordyString(init.expression))) n++
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return n
}

describe('hardcoded UI text ratchet', () => {
  const counts = Object.fromEntries(
    tsxFiles(ROOT)
      .map((f) => [relative(ROOT, f).split('\\').join('/'), countLiterals(f)] as const)
      .filter(([, n]) => n > 0)
  )
  const limits: Record<string, number> = ceiling

  it('adds no English text outside t()', () => {
    const over = Object.entries(counts)
      .filter(([f, n]) => n > (limits[f] ?? 0))
      .map(([f, n]) => `${f}: ${n} literals, ceiling ${limits[f] ?? 0} — put the new text in shared/locales/en.json`)
    expect(over).toEqual([])
  })

  it('lowers a ceiling as soon as a file gets under it', () => {
    const stale = Object.entries(limits)
      .filter(([f, max]) => (counts[f] ?? 0) < max)
      .map(([f]) => `${f}: set to ${counts[f] ?? 0} in tests/fixtures/i18n/literalCeiling.json`)
    expect(stale).toEqual([])
  })
})
