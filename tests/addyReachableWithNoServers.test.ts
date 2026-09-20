import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The Sync panel has to be reachable on a machine with no servers.
 *
 * THIS IS THE STATE EVERY NEW INSTALL STARTS IN. FleetMonitor returns an
 * empty state early when the estate is empty — "Nothing to monitor. Add a
 * server to start streaming live CPU, memory, disk and network metrics" — and
 * that return sat in front of every panel this component mounts, including two
 * that have nothing to do with servers.
 *
 * `addy` is this app's own account on a relay: it takes no `servers` prop and
 * there is no estate host anywhere on it. `processes` is this machine. So
 * pressing Sync on a fresh install answered a question nobody asked with a
 * remedy that does not apply, and the one panel that would enrol the machine,
 * pair it with one that already works, or recover it from a phrase was
 * unreachable until an unrelated server had been added.
 *
 * The rail button was lit and the sidebar header said SYNC & DEVICES above it,
 * so the app disagreed with itself on screen — which is why this is asserted on
 * the source rather than left to a reviewer to notice.
 */
describe('the Sync panel on a machine with no servers', () => {
  const src = readFileSync(
    join(__dirname, '..', 'src', 'renderer', 'src', 'components', 'monitor', 'FleetMonitor.tsx'),
    'utf8'
  )

  it('does not let the empty-estate early return swallow a server-independent panel', () => {
    // The guard exists at all.
    const guard = src.match(/if \(servers\.length === 0([^)]*)\)/)
    expect(guard, 'the empty-estate early return has moved or been renamed').not.toBeNull()

    // And it is qualified rather than unconditional.
    expect(
      guard![1].trim(),
      'servers.length === 0 returns unconditionally, so every promoted panel is unreachable ' +
        'on a fresh install — including Sync, which is how a new machine would be enrolled'
    ).not.toBe('')
  })

  it('names both panels that do not need a server', () => {
    const needs = src.match(/const needsAServer =([^\n]*)/)
    expect(needs, 'needsAServer has gone; the qualification above is no longer computed').not.toBeNull()
    for (const id of ['addy', 'processes']) {
      expect(
        needs![1],
        `${id} is not about the estate and must still render with no servers`
      ).toContain(`'${id}'`)
    }
  })

  it('still shows the empty state for the estate views, which is what it is for', () => {
    // The parser sanity check: if this file stops looking like FleetMonitor,
    // the assertions above are passing over nothing.
    expect(src.length, 'the parser is wrong, not the code').toBeGreaterThan(5000)
    expect(src).toContain('Nothing to monitor')
    // Overview is the estate view and must not be exempted.
    const needs = src.match(/const needsAServer =([^\n]*)/)![1]
    expect(needs).not.toContain("'overview'")
  })
})
