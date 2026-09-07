import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The type scale, checked against the stylesheets that ship rather than against
// a copy of them.
//
// What was measured before this existed: 22 semibold gauge value · 20–21 page
// title · 16–17 panel heading and dialog title · 14 card titles · 13, the
// default for almost everything · 12–12.5 callout prose and secondary meta · 12
// mono log lines · 11 caps labels and table headers · 11 mono addresses · 10.5
// mono hostnames. Twelve steps.
//
// Two of them were the problem. 13 and 12 carried most of the product's text
// and are a 7% difference — not a rank anybody reads, just a decision every
// author had to make and nobody could verify. And the same job appeared at two
// sizes in two places: "Modules" was a 20px heading and "Advanced" a 16px one
// at the same rank; the big-metric number was 22px on a server card and 17px in
// the fleet strip.
//
// So: five roles, and a test that can tell when a sixth appears.

const DIR = join(__dirname, '../src/renderer/src/styles')
const read = (f: string): string => readFileSync(join(DIR, f), 'utf8')

// Comments are stripped before anything is matched. These files explain
// themselves at length and quote the values they replaced — `--fs-sm: 12px`
// appears verbatim inside a paragraph saying why it does not any more — and a
// regex over the raw text happily reads a dead value out of the prose that
// buried it. contrast.test.ts learned this first.
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')

const TOKENS = strip(read('tokens.css'))
/** The three stylesheets this scale is enforced across. dialogs.css is not
 *  ours to hold to it; it is named in the report instead. */
const OWNED: Record<string, string> = {
  'tokens.css': TOKENS,
  'global.css': strip(read('global.css')),
  'monitorNav.css': strip(read('monitorNav.css'))
}

/** The literal value of a custom property in tokens.css, un-resolved. */
function raw(name: string): string {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(TOKENS)
  expect(m, `--${name} must be defined in tokens.css`).not.toBeNull()
  return m![1].trim()
}

/** Follows a chain of `var(--x)` aliases down to the literal. */
function resolve(name: string, depth = 0): string {
  expect(depth, `--${name} is a circular alias`).toBeLessThan(8)
  const v = raw(name)
  const m = /^var\(--([a-z0-9-]+)\)$/.exec(v)
  return m ? resolve(m[1], depth + 1) : v
}

const px = (name: string): number => {
  const v = resolve(name)
  expect(v, `--${name} must be a px length, got "${v}"`).toMatch(/^\d+(\.\d+)?px$/)
  return parseFloat(v)
}

describe('the five roles', () => {
  // Size and weight together. A role is a pair — "16px" alone does not say
  // whether it outranks the 16px next to it, and the two headings that
  // disagreed disagreed about weight as much as about size.
  it.each([
    ['display', 20, 600],
    ['title', 16, 600],
    ['subtitle', 14, 500],
    ['body', 13, 400],
    ['caption', 11, 500]
  ])('%s is %ipx at weight %i', (role, size, weight) => {
    expect(px(`fs-${role}`)).toBe(size)
    expect(resolve(`fw-${role}`)).toBe(String(weight))
  })

  it('is exactly five sizes — a sixth step is the thing this test exists to catch', () => {
    const sizes = ['display', 'title', 'subtitle', 'body', 'caption'].map((r) => px(`fs-${r}`))
    expect(new Set(sizes).size).toBe(5)
  })
})

describe('the numeric steps behind the roles', () => {
  // The six --fs-* names are spelled ~70 times across global.css and are kept
  // as aliases rather than renamed, so they have to land on the scale too — a
  // rule that says `var(--fs-lg)` must not be able to reach a size no role has.
  const STEPS = ['fs-xs', 'fs-sm', 'fs-md', 'fs-lg', 'fs-xl', 'fs-2xl']

  it('every step is one of the five role sizes', () => {
    const roles = new Set([11, 13, 14, 16, 20])
    for (const s of STEPS) {
      expect(roles.has(px(s)), `--${s} is ${px(s)}px, which is not a role`).toBe(true)
    }
  })

  it('the 12px step is gone, merged into 13', () => {
    // --fs-sm WAS 12px and is the single most-used size token in the product.
    // Merging it is what makes the merge land everywhere at once instead of one
    // component at a time.
    expect(px('fs-sm')).toBe(13)
    expect(STEPS.map(px)).not.toContain(12)
  })

  it('the 21/22px step is gone, merged into 20', () => {
    expect(px('fs-2xl')).toBe(20)
    for (const s of STEPS) expect(px(s)).toBeLessThanOrEqual(20)
  })
})

describe('machine-readable values have a floor', () => {
  it('the floor is 12px', () => {
    expect(px('fs-identifier')).toBe(12)
  })

  it('the mono face carries the floor, so no call site has to remember it', () => {
    // Hostnames shipped at 10.5px and addresses at 11px — the two strings a
    // sysadmin most often retypes into another window were the smallest text on
    // the screen. The rule lives on `.mono` because everything drawn in the mono
    // face here IS a machine-readable value, so the two sets are the same set.
    // Anchored to the start of a line: `.mono` is a substring of every
    // descendant selector that ends in it (`.metric-card .m-head > .mono`),
    // and an unanchored match found one of those instead of the rule that
    // actually carries the floor — reporting a defect that was not there.
    const mono = /^\.mono\s*\{[^}]*\}/m.exec(OWNED['global.css'])
    expect(mono, '.mono must be defined in global.css').not.toBeNull()
    expect(mono![0]).toMatch(/font-size:\s*max\(\s*var\(--fs-identifier\)\s*,\s*1em\s*\)/)
  })
})

describe('the scale is enforced, not merely declared', () => {
  it.each(Object.keys(OWNED))('%s declares no raw px font-size', (file) => {
    // A literal `font-size: 12px` is how the twelve steps accumulated: each one
    // was locally reasonable and none of them was visible from anywhere else.
    const offenders = [...OWNED[file].matchAll(/font-size:\s*[0-9.]+px/g)].map((m) => m[0])
    expect(offenders).toEqual([])
  })

  it('every font-size in the owned stylesheets resolves through the scale', () => {
    const allowed = new Set([
      ...['xs', 'sm', 'md', 'lg', 'xl', '2xl'].map((s) => `var(--fs-${s})`),
      ...['display', 'title', 'subtitle', 'body', 'caption', 'identifier'].map(
        (r) => `var(--fs-${r})`
      ),
      ...['page-size', 'section-size', 'subtitle-size', 'body-size', 'note-size', 'label-size'].map(
        (t) => `var(--type-${t})`
      ),
      // Relative, and therefore on the scale by construction: they can only
      // land where their parent already is, and the two that go DOWN are
      // floored by `max()`.
      'inherit',
      '1em',
      'max(var(--fs-identifier), 1em)',
      'max(var(--fs-identifier), 0.95em)'
    ])
    const bad: string[] = []
    for (const [file, css] of Object.entries(OWNED)) {
      for (const m of css.matchAll(/font-size:\s*([^;}]+)/g)) {
        const v = m[1].trim()
        if (!allowed.has(v)) bad.push(`${file}: ${v}`)
      }
    }
    expect(bad).toEqual([])
  })
})

describe('11px is only for labels recognised by shape', () => {
  // The caption role is 11px BECAUSE it is tracked all-caps: those are read as
  // a silhouette rather than letter by letter, which is the only reason a size
  // below the identifier floor is defensible at all. Running text at 11px is
  // not the caption role, it is the caption size borrowed by something that
  // needed a smaller step and did not have one.
  //
  // The exceptions below are real and are debt, not licence. Each is a short
  // chrome token on a surface this change does not own; they are listed here so
  // they can be counted and so that a NEW one fails this test.
  const EXCEPTIONS = new Set([
    '.statusbar', // app chrome, fixed 24px band; growing the text regrows the band
    '.chip', // a badge of one or two words, sized to sit inside a table row
    '.field-hint', // components/common — owned elsewhere
    '.sc-conflict', // components/common — owned elsewhere
    '.alerts .alerts-meta, .alerts .alerts-quiet-line', // AlertsPanel, owned elsewhere this cycle
    '.alerts .alert-snooze-group .btn' // a segmented control's labels
  ])

  it('has no unlisted 11px rule carrying running text', () => {
    const offenders: string[] = []
    for (const [file, css] of Object.entries(OWNED)) {
      // Split into rules the crude way — these files have no nesting, and the
      // `@media` blocks that exist set no font-size.
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = m[1].trim().replace(/\s+/g, ' ')
        const body = m[2]
        if (!/font-size:\s*var\(--fs-(xs|caption)\)/.test(body)) continue
        if (/text-transform:\s*uppercase/.test(body)) continue
        if (EXCEPTIONS.has(selector)) continue
        offenders.push(`${file}: ${selector}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the exception list is shrinking territory, not a parking space', () => {
    // If this number goes UP, something added an 11px rule and reached for the
    // list instead of the scale.
    expect(EXCEPTIONS.size).toBeLessThanOrEqual(6)
  })
})
