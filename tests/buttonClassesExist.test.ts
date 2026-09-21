import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * A class name that matches no rule is an invisible control.
 *
 * `btn-ghost` was used in four places — the patch panel's "kernel" button, the
 * cron panel's "did it run?", and both of EnvValueWrite's — and it is not a
 * class this app defines anywhere. The ghost variant is `.btn.ghost`, two
 * classes, not one hyphenated one. So those buttons rendered with no button
 * styling at all: no border, no background, no height, no pointer cursor.
 * Plain text sitting in a table cell.
 *
 * Reported against 0.50.21 as "patches still not showing / just the count is
 * there" — about a panel that had shipped the package list behind exactly one
 * of those buttons. The channel worked; tests/patchPanel.test.tsx clicks it and
 * gets the list. Nobody could tell it was a button.
 *
 * This guards the one mistake rather than every class in the app: a general
 * "does this class exist" check would have to model clsx, template strings and
 * the CSS cascade, and would be wrong often enough that people would stop
 * reading it. A typo'd variant of a real class is a specific, repeatable error
 * with a specific, repeatable symptom.
 */

const ROOT = fileURLToPath(new URL('../src/renderer/src', import.meta.url))

/** Every class the button system actually defines, taken from the stylesheets
 *  rather than restated, so this cannot drift from them. */
function definedButtonClasses(): Set<string> {
  const css = ['global.css', 'dialogs.css']
    .map((f) => readFileSync(join(ROOT, 'styles', f), 'utf8'))
    .join('\n')
  const found = new Set<string>()
  for (const m of css.matchAll(/\.btn((?:[.:][a-z0-9-]+)*)/g)) {
    for (const part of m[1].split('.')) if (part !== '') found.add(part.split(':')[0])
  }
  return found
}

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (p.endsWith('.tsx') || p.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('button class names', () => {
  it('never uses btn-ghost, which no stylesheet defines', () => {
    const offenders = sources(ROOT)
      .filter((p) => readFileSync(p, 'utf8').includes('btn-ghost'))
      .map((p) => p.slice(ROOT.length + 1))
    expect(offenders, 'use "btn ghost" for an icon, "btn quiet" for a worded one').toEqual([])
  })

  it('defines the two variants those sites were moved onto', () => {
    // If either is ever renamed, the four buttons above go back to being
    // unstyled text and nothing else would say so.
    const defined = definedButtonClasses()
    expect(defined.has('ghost')).toBe(true)
    expect(defined.has('quiet')).toBe(true)
  })
})
