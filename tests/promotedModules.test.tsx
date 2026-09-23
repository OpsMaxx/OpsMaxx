// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { ActivityBar } from '../src/renderer/src/components/layout/ActivityBar'
import { useApp } from '../src/renderer/src/store/app'
import { useNav } from '../src/renderer/src/store/nav'
import {
  MODULES,
  PROMOTED_MODULE_IDS,
  defaultModuleState,
  isPromotedModule,
  modulesOnSurface,
  stripModules
} from '../src/shared/modules'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Modules with their own activity-bar button.
 *
 * Five read modules — Docker, Kubernetes, CI/CD, local processes and sync &
 * devices — are reached from the rail rather than from the Monitoring tab
 * strip, because each is a different SUBJECT rather than another fact about the
 * estate. The full argument is on PROMOTED_MODULE_IDS.
 *
 * What can go quietly wrong, and is therefore what this file is about:
 *
 *  1. A promoted module is still a `monitorTab` rendered inside FleetMonitor's
 *     one mounted tree. If it ever became an `ActivityView`, switching to it
 *     would unmount that tree and kill a running log tail.
 *  2. A rail button for a module that is switched OFF opens a tab FleetMonitor
 *     does not render — a pointer at nothing.
 *  3. An `operate` module promoted here would get a button that routes through
 *     `openMonitor` into `openOperations`, landing on a rail whose strip is
 *     built from a different list.
 *  4. Two destinations lit at once: standing on Docker used to light both the
 *     Docker button and Monitoring.
 */

const SRC = join(__dirname, '../src/renderer/src/components/layout/ActivityBar.tsx')
const CSS = readFileSync(join(__dirname, '../src/renderer/src/styles/global.css'), 'utf8')

/**
 * One CSS rule's body, by selector.
 *
 * Anchored to the start of a line, because `.activitybar {` is also a substring of
 * `.app-body > .activitybar {` -- a plain indexOf found the wrong rule and read as
 * a missing property.
 */
function rule(selector: string): string {
  const at = CSS.search(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{`, 'm'))
  if (at < 0) return ''
  return CSS.slice(at, CSS.indexOf('}', at))
}

beforeEach(() => {
  stubBridge({})
  useApp.setState((st) => ({
    activity: 'monitor',
    settings: { ...st.settings, modules: defaultModuleState() }
  }))
  useNav.setState({ monitorTab: 'overview', fleetRail: 'monitor' })
})

describe('which modules are promoted', () => {
  it('promotes exactly the five that are a different subject', () => {
    // Pinned as an exact list, the way OPERATE_MODULE_IDS is: a sixth added by
    // habit rather than by argument should be a failing test, not a wider rail.
    //
    // `addy` is the fifth and it passes the test this list is for more plainly
    // than any of the other four: Monitoring's subject is the estate, and not
    // one estate host appears on that panel. Its rows are the user's OWN
    // machines and its numbers are about an account on a relay. It is also the
    // module with the strongest reason to be reachable in one press -- it had
    // no nav entry at all, and its only door was three headings down the
    // Security page of Settings, which is the defect it was promoted to fix.
    expect([...PROMOTED_MODULE_IDS].sort()).toEqual([
      'addy',
      'cicd',
      'docker',
      'kubernetes',
      'processes'
    ])
  })

  it('promotes only read modules', () => {
    // Point 3. An operate id here would route itself to the other rail.
    for (const id of PROMOTED_MODULE_IDS) {
      const def = MODULES.find((m) => m.id === id)
      expect(def, `${id} is not in the registry`).toBeTruthy()
      expect(def!.surface, id).toBe('read')
    }
  })

  it('names only modules that exist', () => {
    const known = new Set(MODULES.map((m) => m.id))
    for (const id of PROMOTED_MODULE_IDS) expect(known.has(id), id).toBe(true)
  })

  it('gives every promoted module an icon and a tooltip', () => {
    // The icons cannot live in the registry — src/shared/modules.ts is imported
    // by main, which has no React — so they live in ActivityBar and this is what
    // keeps the two lists honest. A missing icon renders a button with nothing
    // in it, which is invisible on a 44px rail.
    const src = readFileSync(SRC, 'utf8')
    for (const id of PROMOTED_MODULE_IDS) {
      expect(src, `PROMOTED_ICONS is missing ${id}`).toMatch(new RegExp(`${id}: <`))
      expect(src, `PROMOTED_TITLES is missing ${id}`).toMatch(new RegExp(`${id}: '`))
    }
  })

  it('takes them out of the strip and leaves everything else in', () => {
    const strip = stripModules().map((m) => m.id)
    for (const id of PROMOTED_MODULE_IDS) expect(strip, id).not.toContain(id)
    for (const m of modulesOnSurface('read')) {
      if (isPromotedModule(m.id)) continue
      expect(strip, m.id).toContain(m.id)
    }
  })

  it('leaves the default strip set inside the row, with nothing overflowing', () => {
    // The measurable reason promotion happened rather than the ceiling being
    // raised. MAX_STRIP_TABS is 8 and two of those buttons are fixed, so six
    // module slots — and the default enabled strip set is exactly six.
    const on = stripModules().filter((m) => m.defaultEnabled)
    expect(on).toHaveLength(6)
  })
})

describe('the rail buttons', () => {
  it('shows a button for a promoted module that is on', () => {
    // docker, kubernetes and addy ship on; cicd and processes ship off.
    render(<ActivityBar />)
    expect(screen.getByTitle(/^Docker —/)).toBeTruthy()
    expect(screen.getByTitle(/^Kubernetes —/)).toBeTruthy()
    // The whole point of shipping it on: the feature had no nav entry at all,
    // so a fresh install must arrive with this button already there.
    expect(screen.getByTitle(/^Sync & devices —/)).toBeTruthy()
  })

  it('shows no button for a promoted module that is off', () => {
    // Point 2, and the reason the icon is gated at all: CI/CD and local
    // processes are off by default, and a button for either would open a tab
    // FleetMonitor is not rendering.
    render(<ActivityBar />)
    expect(screen.queryByTitle(/^CI\/CD —/)).toBeNull()
    expect(screen.queryByTitle(/^Local processes —/)).toBeNull()
  })

  it('makes the button appear when the module is switched on', () => {
    // What gives a first-run answer visible consequence: ticking the CI/CD
    // question makes an icon show up.
    const { rerender } = render(<ActivityBar />)
    expect(screen.queryByTitle(/^CI\/CD —/)).toBeNull()
    useApp.setState((st) => ({
      settings: { ...st.settings, modules: { ...st.settings.modules, cicd: true } }
    }))
    rerender(<ActivityBar />)
    expect(screen.getByTitle(/^CI\/CD —/)).toBeTruthy()
  })

  it('opens the module on the monitoring rail without changing activity away', async () => {
    // Point 1. `openMonitor` keeps `activity === 'monitor'`, so FleetMonitor is
    // never unmounted and a running log tail survives the crossing.
    render(<ActivityBar />)
    await userEvent.click(screen.getByTitle(/^Docker —/))
    expect(useNav.getState().monitorTab).toBe('docker')
    expect(useNav.getState().fleetRail).toBe('monitor')
    expect(useApp.getState().activity).toBe('monitor')
  })

  it('lights exactly one destination while a promoted tab is open', () => {
    // Point 4. Monitoring and Docker share `activity === 'monitor'`, so without
    // the `!onPromotedTab` guard the rail claimed both.
    useNav.setState({ monitorTab: 'docker', fleetRail: 'monitor' })
    render(<ActivityBar />)
    expect(screen.getByTitle(/^Docker —/).className).toContain('active')
    expect(screen.getByTitle(/^Monitoring/).className).not.toContain('active')
  })

  it('lights Monitoring, not a module, while a monitoring tab is open', () => {
    useNav.setState({ monitorTab: 'overview', fleetRail: 'monitor' })
    render(<ActivityBar />)
    expect(screen.getByTitle(/^Monitoring/).className).toContain('active')
    expect(screen.getByTitle(/^Docker —/).className).not.toContain('active')
  })

  it('leaves a promoted tab rather than sitting dead when Monitoring is pressed', async () => {
    // `monitorTab` holds the promoted tabs too, so `openMonitor(monitorTab)`
    // from Docker would have re-opened Docker while lighting Monitoring.
    useNav.setState({ monitorTab: 'docker', fleetRail: 'monitor' })
    render(<ActivityBar />)
    await userEvent.click(screen.getByTitle(/^Monitoring/))
    expect(useNav.getState().monitorTab).toBe('overview')
  })

  it('keeps Settings reachable however many icons are on the rail', () => {
    // The regression promotion caused, and the reason `.activity-scroll` exists.
    //
    // The rail is a fixed column inside `.app-body { overflow: hidden }` and the
    // window minimum is 640px tall, leaving 576px for it. Eleven buttons needed
    // about 520px and fit. The promoted icons take it to sixteen and past 700px,
    // so 120px fell off the BOTTOM -- where Report a bug and Settings live, the
    // latter being the only route to the page that switches a module back off.
    //
    // Asserted structurally rather than by measuring: jsdom has no layout, so a
    // height assertion here would pass whatever the CSS said. What can be checked
    // is that the two fixed controls are NOT inside the scrolling section, which is
    // the property that makes them reachable at any window size.
    useApp.setState((st) => ({
      settings: {
        ...st.settings,
        modules: {
          ...st.settings.modules,
          docker: true,
          kubernetes: true,
          cicd: true,
          processes: true,
          addy: true
        }
      }
    }))
    const { container } = render(<ActivityBar />)
    const scroll = container.querySelector('.activity-scroll')
    expect(scroll, 'the rail has no scrolling section').toBeTruthy()

    // All the promoted icons are inside it, so a cramped window scrolls them.
    expect(scroll!.querySelectorAll('button').length).toBeGreaterThanOrEqual(12)

    // And the two that must never scroll away are outside it.
    const settings = screen.getByTitle(/^Settings/)
    const bug = screen.getByTitle(/^Report a bug/)
    expect(scroll!.contains(settings), 'Settings can scroll out of reach').toBe(false)
    expect(scroll!.contains(bug), 'Report a bug can scroll out of reach').toBe(false)
  })

  it('does not let the rail squash its buttons instead of scrolling', () => {
    // Measured in a real browser at the app's 640px minimum: without `flex: none`
    // the twelve buttons compressed from 40px to 30px each and the scroll never
    // engaged, because a flex item shrinks below its stated height by default. The
    // result was a column of squashed icons rather than a column of correct ones
    // with a scroll -- and 40px is a pointer target as much as a look.
    //
    // Asserted against the stylesheet because jsdom has no layout: a height check
    // here would pass whatever the CSS said.
    expect(rule('.activity-btn')).toMatch(/flex:\s*none/)
    // And the two halves that make the scroll possible at all. Without either, the
    // column grows past the viewport and `.app-body`'s clip eats the bottom.
    expect(rule('.activitybar')).toMatch(/min-height:\s*0/)
    expect(rule('.activitybar')).toMatch(/overflow:\s*hidden/)
    expect(rule('.activity-scroll')).toMatch(/overflow-y:\s*auto/)
    expect(rule('.activity-scroll')).toMatch(/min-height:\s*0/)
  })

  it('fades the cut-off end of the rail instead of clipping it hard', () => {
    // Seen at 1280x680: the scroll worked, but with no scrollbar the half-scrolled
    // Kubernetes button was clipped flush against Report bug and read as the two
    // overlapping. The fade is what says "more below". Its trigger is a
    // scroll-state query, not a scroll timeline: the timeline left a stale fade
    // painted after the window grew tall enough not to scroll.
    expect(rule('.activity-scroll')).toMatch(/container-type:\s*scroll-state/)
    expect(CSS).toMatch(/@container scroll-state\(scrollable: bottom\)\s*\{\s*\.activity-scroll::after/)
    expect(CSS).toMatch(/@container scroll-state\(scrollable: top\)\s*\{\s*\.activity-scroll::before/)
    expect(CSS).not.toMatch(/animation-timeline:\s*scroll\(self\)/)
    // And keyboard focus stops clear of the fade rather than under it.
    expect(rule('.activity-scroll')).toMatch(/scroll-padding-block:/)
  })

  it('does not add an ActivityView for any of them', () => {
    // Point 1, stated where it cannot be worked around. A promoted module that
    // became its own `activity` would mount a second subtree and unmount
    // FleetMonitor every time somebody crossed between them.
    const types = readFileSync(join(__dirname, '../src/renderer/src/types.ts'), 'utf8')
    const union = types.slice(types.indexOf('export type ActivityView'))
    const head = union.slice(0, union.indexOf('\n\n'))
    for (const id of PROMOTED_MODULE_IDS) expect(head, id).not.toContain(`'${id}'`)
  })
})

describe('a promoted module gets its own page, not Monitoring\'s', () => {
  /**
   * Defect 5, and the one a person sees first.
   *
   * The panels are mounted inside FleetMonitor's tree on purpose (defect 1
   * above), so they inherited the chrome wrapped around it: a page titled
   * "Monitoring", a subtitle counting servers, a "New group" button that makes
   * a MONITOR group, and a tab strip whose every tab is somewhere else.
   * Pressing Docker on the rail landed you somewhere that said it was
   * something else and offered eight ways to leave.
   *
   * Two of the four make the subtitle wrong rather than merely irrelevant:
   * local processes run on THIS machine and say so, and CI/CD talks to Jenkins
   * and GitLab and may have no server in it at all — so "5 of 5 servers online"
   * is a claim about neither.
   *
   * Asserted against the SOURCE rather than by mounting FleetMonitor, which
   * needs the whole fleet store, every panel and a bridge. What has to stay
   * true is structural: the header is behind the promoted check, and the
   * Monitoring chrome is behind its negation.
   */
  const FM = readFileSync(
    join(__dirname, '../src/renderer/src/components/monitor/FleetMonitor.tsx'),
    'utf8'
  )

  it('decides from the module registry, not a hand-copied list', () => {
    // A fifth promoted module must get this for free. A literal list here
    // would be a second place to add it, and the one nobody remembers.
    expect(FM).toContain('isPromotedModule(activeTab)')
  })

  it('renders the module label and detail as the page title', () => {
    expect(FM).toMatch(/\{promoted\.label\}/)
    expect(FM).toMatch(/\{promoted\.detail\}/)
  })

  it('only offers a header for a module that is actually mounted', () => {
    // Looked up in `enabledRead`: a module switched off renders no panel, and a
    // header over an empty page is worse than the inherited one.
    expect(FM).toMatch(/enabledRead\.find\(\(m\) => m\.id === activeTab\)/)
  })

  it('puts the Monitoring title, the group button and the strip behind it', () => {
    // The three pieces that made the page claim to be something else. If the
    // ternary is ever flattened, this is what notices.
    const idx = FM.indexOf('promoted ? (')
    expect(idx, 'the promoted header branch is gone').toBeGreaterThan(-1)
    const after = FM.slice(idx)
    for (const chrome of ['ui-page-title">Monitoring', 'New group', 'monitor-tabs monitor-strip']) {
      expect(after, `${chrome} escaped the promoted branch`).toContain(chrome)
      expect(
        after.indexOf(chrome),
        `${chrome} renders before the promoted check`
      ).toBeGreaterThan(after.indexOf(') : ('))
    }
  })

  it('still mounts every promoted panel in the same tree', () => {
    // The header swap must not have turned any of them into a route: that is
    // defect 1, and it kills a running log tail.
    for (const id of PROMOTED_MODULE_IDS) {
      expect(FM, `${id} is no longer mounted in FleetMonitor`).toContain(`show('${id}')`)
    }
  })
})
