import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A "Check now" has to actually collect.
 *
 * `sampleNow()` sweeps, and a sweep collects metrics every time — but facts,
 * keys, packages, posture and drift each sit behind their own hourly due time
 * that a plain sweep does not clear. So a panel calling `sampleNow()` on an
 * estate swept within the hour re-collected metrics, skipped the probe it
 * displays, and re-rendered the same cached values. Indistinguishable from a
 * dead button, and silent everywhere it happens.
 *
 * This was made independently in SIX panels — inventory, keys and access,
 * capacity, patches, posture, drift and fleet-wide search — which is what a
 * rule that is easy to state and nowhere enforced looks like. Hence a test
 * rather than another comment.
 */

const MONITOR = join(__dirname, '../src/renderer/src/components/monitor')

/**
 * The one legitimate caller.
 *
 * FleetMonitor sweeps once when the estate screen is opened, so the health
 * panel is not showing what the last scheduled sweep found. That is a
 * courtesy refresh and not a request for the hourly probes: forcing facts,
 * keys, posture and drift on every server every time somebody opens a screen
 * would put the estate under a full deep collection on a mouse click.
 */
const ALLOWED = new Set(['FleetMonitor.tsx'])

/** Comments say the word constantly; only a call counts. */
const CALLS_SAMPLE_NOW = /\bfleet\??\.\s*sampleNow\s*\(/

const strip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('Check now collects rather than only sweeping', () => {
  const files = readdirSync(MONITOR).filter((f) => f.endsWith('.tsx'))

  it('has monitor panels to check', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it('routes every panel-initiated collection through collectNow', () => {
    const offenders = files.filter(
      (f) => !ALLOWED.has(f) && CALLS_SAMPLE_NOW.test(strip(readFileSync(join(MONITOR, f), 'utf8')))
    )
    expect(offenders).toEqual([])
  })

  it('keeps the shared helper reaching for collectNow first', () => {
    const src = readFileSync(
      join(__dirname, '../src/renderer/src/lib/collectNow.ts'),
      'utf8'
    )
    // The fallback exists only for preload skew under dev, so collectNow has
    // to be the branch that is tried first or the helper is decorative.
    expect(src.indexOf("'collectNow'")).toBeLessThan(src.indexOf("'sampleNow'"))
  })
})
