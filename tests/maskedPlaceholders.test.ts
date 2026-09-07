import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// A placeholder must never be the field's own mask character.
//
// In a `type="password"` input the dots ARE what content looks like, so a dot
// placeholder cannot be told apart from a stored credential. Add Database
// showed eight dots in an empty box on a NEW connection — a field dressed as
// filled when nothing was in it — and Add Server showed them unconditionally,
// so on an edit the reader had no way to know whether a password was saved.
//
// That second one matters beyond cosmetics: leaving the field blank on an edit
// is exactly what keeps the stored secret, so the one state the user needs to
// recognise is the one the UI made unreadable.
//
// The webhook URL field is the counter-example and is left alone: it shows dots
// ONLY when something is genuinely stored (`cfg.hasUrl`) and pairs them with
// "paste to replace", so the dots are a true statement plus words that
// disambiguate them.

const ROOT = join(__dirname, '..', 'src', 'renderer', 'src')

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.tsx') ? [join(dir, e.name)] : []
  )
}

const FILES = walk(ROOT).map((f) => ({ file: f, text: readFileSync(f, 'utf8') }))

describe('no placeholder impersonates a stored secret', () => {
  it('finds files to check', () => {
    expect(FILES.length).toBeGreaterThan(20)
  })

  it('never uses the mask character as a bare placeholder', () => {
    const bad: string[] = []
    for (const { file, text } of FILES) {
      for (const m of text.matchAll(/placeholder=/g)) {
        // EVERY string literal in the placeholder expression, not just the
        // first. A ternary — `{editId ? 'Unchanged' : '••••••••'}` — has the
        // honest branch first and the dishonest one second, so a regex that
        // captured one literal reported the wrong branch and passed while the
        // defect sat beside it. This test was written that way, survived both
        // mutations of the thing it was written for, and had to be rebuilt.
        const start = m.index + 'placeholder='.length
        const chunk = text.slice(start, start + 200).split('\n')[0]
        for (const lit of chunk.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)) {
          const value = lit[1] ?? lit[2] ?? lit[3] ?? ''
          if (!value.includes('•')) continue
          // Allowed only when the dots sit beside words saying what they mean.
          // "••••••••  paste to replace" is a true statement about stored
          // state; "••••••••" alone is a lie about an empty field.
          if (!/[A-Za-z]{3,}/.test(value)) {
            bad.push(`${file.split('/src/renderer/src/')[1]}: "${value}"`)
          }
        }
      }
    }
    expect(bad, `bare mask placeholders: ${bad.join(' | ')}`).toEqual([])
  })

  // The two that were wrong, named, so a revert is caught by more than the
  // general rule above.
  it('leaves Add Database and Add Server empty rather than pre-masked', () => {
    for (const f of ['components/databases/AddDatabaseModal.tsx', 'components/connections/AddServerModal.tsx']) {
      const text = readFileSync(join(ROOT, f), 'utf8')
      expect(text, f).not.toMatch(/placeholder=["']•+["']/)
      expect(text, f).toMatch(/Unchanged/)
    }
  })
})
