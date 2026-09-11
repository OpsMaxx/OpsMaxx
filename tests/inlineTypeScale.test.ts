import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../src/renderer/src', import.meta.url))

/**
 * The type scale, enforced where the type actually is.
 *
 * `typeScale.test.ts` guards three CSS files and nothing else, so the ratchet
 * was green while the screen carried 234 inline `fontSize` declarations across
 * the components -- most of them 11px, and 76 of them at a 12px step the tokens
 * describe as "gone, merged into 13". A test that certifies a hierarchy the
 * product does not have is worse than no test.
 *
 * Closing that in one pass would be 234 edits to a hundred files with no way to
 * see the result, so this is a ratchet instead: the number may fall and may not
 * rise. Sub-scale sizes are gone already -- 9px and 10px were below the scale's
 * own floor -- and what remains is on-scale but inline.
 *
 * To remove one: use a class, or `fontSize: 'var(--fs-xs)'` where the value has
 * to stay inline. Then lower CEILING.
 */
const CEILING = 227

/** Sizes the scale does not contain at all. These may never come back. */
const BELOW_SCALE = /fontSize: (?:[0-9]|10)\b/

function tsx(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) tsx(p, out)
    else if (p.endsWith('.tsx') || p.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('inline font sizes', () => {
  const files = tsx(ROOT).map((p) => ({ p, src: readFileSync(p, 'utf8') }))

  it('never uses a size the scale does not have', () => {
    // 9px and 10px are below --fs-xs, the smallest step the tokens define. A
    // caption that needs to be smaller than the smallest size is a caption in
    // the wrong place.
    const bad = files
      .filter((f) => BELOW_SCALE.test(f.src))
      .map((f) => f.p.slice(ROOT.length + 1))
    expect(bad).toEqual([])
  })

  it('does not grow the pile of inline sizes', () => {
    const count = files.reduce(
      (n, f) => n + (f.src.match(/fontSize: [0-9]+/g)?.length ?? 0),
      0
    )
    expect(
      count,
      count > CEILING
        ? `New inline fontSize. Use a class, or fontSize: 'var(--fs-*)'.`
        : `CEILING is stale -- lower it to ${count}.`
    ).toBe(CEILING)
  })
})
