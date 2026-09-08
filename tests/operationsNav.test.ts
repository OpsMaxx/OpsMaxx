import { beforeEach, describe, expect, it } from 'vitest'
import { useApp } from '../src/renderer/src/store/app'
import { openMonitor, openOperations, useNav } from '../src/renderer/src/store/nav'

// What happens to a pointer when the thing it points at moves house.
//
// Every deep link into the fleet destination — the status-bar alert chip, an
// alert's "show me", a round trip through Settings › Modules — was written when
// Monitoring held all fifteen modules. Splitting two of them onto an Operations
// rail underneath those callers would have turned each into a click that opens
// Monitoring and shows Overview.
//
// tests/navDeepLinks.test.ts already states the rule this file inherits: a
// button on a message is only worth having if it lands on the page that
// resolves the message. The corollary, and the reason `openMonitor` routes
// rather than refuses: a pointer that opens the WRONG destination is worse than
// no pointer, because the user learns the button is broken instead of learning
// the feature moved.

beforeEach(() => {
  useApp.setState({ activity: 'connections' })
  useNav.setState({ monitorTab: 'overview', operationsTab: 'broadcast', fleetRail: 'monitor' })
})

describe('openMonitor', () => {
  it('opens Monitoring on a read tab', () => {
    openMonitor('cron')
    expect(useApp.getState().activity).toBe('monitor')
    expect(useNav.getState().fleetRail).toBe('monitor')
    expect(useNav.getState().monitorTab).toBe('cron')
  })

  it('still opens the fixed alerts tab, which is not a module at all', () => {
    // `alerts` is fixed rather than registered, deliberately: modules default
    // OFF for every existing install, so an alert inbox registered as one would
    // be invisible to everybody who already has the app while the status-bar
    // chip went on pointing at it.
    openMonitor('alerts')
    expect(useNav.getState().fleetRail).toBe('monitor')
    expect(useNav.getState().monitorTab).toBe('alerts')
  })

  it('routes an operate tab to Operations instead of showing an empty Monitoring', () => {
    openMonitor('patch')
    expect(useApp.getState().activity).toBe('monitor')
    expect(useNav.getState().fleetRail).toBe('operations')
    expect(useNav.getState().operationsTab).toBe('patch')
  })

  it('routes broadcast the same way', () => {
    openMonitor('broadcast')
    expect(useNav.getState().fleetRail).toBe('operations')
    expect(useNav.getState().operationsTab).toBe('broadcast')
  })

  it('leaves monitorTab alone when it routes, so coming back lands where you left', () => {
    openMonitor('logTail')
    openMonitor('patch')
    expect(useNav.getState().monitorTab).toBe('logTail')
  })
})

describe('openOperations', () => {
  it('opens the Operations rail on the panel asked for', () => {
    openOperations('patch')
    expect(useApp.getState().activity).toBe('monitor')
    expect(useNav.getState().fleetRail).toBe('operations')
    expect(useNav.getState().operationsTab).toBe('patch')
  })

  it('crosses back to Monitoring without disturbing the Operations tab', () => {
    // The rails are two destinations over one mounted tree: crossing hides a
    // subtree, it never resets one. A broadcast composed and left mid-run has
    // to still be there on the way back.
    openOperations('patch')
    openMonitor('overview')
    expect(useNav.getState().fleetRail).toBe('monitor')
    expect(useNav.getState().operationsTab).toBe('patch')
  })
})
