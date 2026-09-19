import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { dayCount } from '../src/renderer/src/lib/capacity'

const require_ = createRequire(import.meta.url)

/**
 * The card must not give two answers for one forecast.
 *
 * `span` rounds, so 12.7 days reads as "13 days". Two other places on the same
 * card floored it, so the headline said "Fills in 13 days" while the line
 * under it said "90% in 12 day(s)" and the estate column said "12d" — one
 * forecast, three renderings, two answers, with no way for a reader to tell
 * which was meant.
 *
 * Pinned as an INVARIANT between the two functions rather than as a table of
 * expected strings: a table would have to be rewritten the day the wording
 * changes and would still not say what the rule is.
 */
describe('days are said the same way wherever they are said', () => {
  it('is the rule span itself uses, not a second copy of it', () => {
    // `span` DELEGATES to dayCount. That makes the two incapable of
    // disagreeing, which is the point — but it also means a loop comparing
    // them would pass whatever either did, so the check that carries weight is
    // that no call site has gone back to rolling its own.
    const src = require_('node:fs').readFileSync(
      require_('node:path').resolve(__dirname, '..', 'src/renderer/src/lib/capacity.ts'),
      'utf8'
    ) as string
    const body = src.slice(src.indexOf('export function span'), src.indexOf('export function dayCount'))
    expect(body).toContain('dayCount(')
    expect(body).not.toContain('Math.round(d * 10)')
  })

  it('is what the panel uses everywhere it prints a number of days', () => {
    // The bug was three renderings of one forecast: the headline through
    // `span`, and two others through `Math.floor`. A floor on a days value
    // anywhere in the panel is that bug returning.
    const panel = require_('node:fs').readFileSync(
      require_('node:path').resolve(
        __dirname,
        '..',
        'src/renderer/src/components/monitor/CapacityPanel.tsx'
      ),
      'utf8'
    ) as string
    expect(panel).not.toMatch(/Math\.floor\(\s*(r|row|trend|f)\??\.?[A-Za-z.]*days/)
    expect(panel).toContain('dayCount(')
  })

  it('keeps one decimal below ten days and whole days above', () => {
    // The reason the two ever differed: floor throws away the tenth that
    // matters most, on the short horizons where a day is a large fraction of
    // the answer.
    expect(dayCount(9.74)).toBe(9.7)
    expect(dayCount(12.7)).toBe(13)
    expect(dayCount(12.4)).toBe(12)
  })

  it('rounds up rather than down, so a deadline is never overstated', () => {
    // 12.7 days to full is nearer 13 than 12. Flooring told the reader they
    // had less time than the projection actually gave them — which is the
    // safe direction to be wrong in, but it was not the direction the
    // headline beside it was wrong in, and that is the bug.
    expect(dayCount(12.7)).toBeGreaterThan(Math.floor(12.7))
  })
})
