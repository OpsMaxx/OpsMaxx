// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { FleetMonitor } from '../src/renderer/src/components/monitor/FleetMonitor'
import { useApp } from '../src/renderer/src/store/app'
import { useNav } from '../src/renderer/src/store/nav'
import { defaultModuleState } from '../src/shared/modules'
import type { Server } from '../src/renderer/src/types'

/**
 * The Rules tab survives its own module switch while rules are still armed.
 *
 * THE DEFECT. The module toggle hides panels; it does not stop the rule engine,
 * which sweeps in the main process and reads no module state at all. So
 * switching Rules off in Settings hid the only screen that lists what is armed
 * and the only control that disarms it — while those rules carried on running
 * jobs on the estate every sweep. The registry comment said the toggle gated
 * "the PANEL and the sweep"; only the first half was ever true.
 *
 * Fixed by narrowing the claim and keeping the panel reachable while anything is
 * armed, rather than by gating the sweep — gating it would have turned this
 * switch into a master arm/disarm control, so flipping it back on would re-arm
 * every rule at once without anyone touching a rule. Module state is UI
 * visibility; `Rule.enabled` is consent. The fix must not merge the two.
 */

const SERVER = {
  id: 's1',
  workspaceId: 'ws-default',
  folderId: null,
  name: 'web-1',
  host: 'example.test',
  port: 22,
  username: 'root',
  auth: 'key',
  status: 'offline',
  tags: [],
  favorite: false,
  os: 'Linux',
  route: [],
  vpnProfileId: null
} as Server

/**
 * A rule as the panel receives it.
 *
 * Complete enough for `RuleCard` to render: it reads `action.type`, the status
 * and the verdict. A partial object here throws inside React and the failure
 * surfaces as an unhandled error rather than as a failing assertion.
 */
const ARMED_RULE = {
  id: 'r1',
  name: 'vacuum the journal',
  enabled: true,
  armedAt: 1,
  trigger: { kind: 'disk', event: 'raised' },
  filter: {},
  limit: { maxFirings: 1, windowMs: 3_600_000 },
  action: { type: 'notify' },
  status: { ruleId: 'r1', fired: [], suppressed: 0 },
  verdict: { ok: true }
}

/** Switch the Rules module off, and say whether a rule is left armed. */
function withRules(armed: boolean): void {
  stubBridge({
    rules: { list: async () => (armed ? [ARMED_RULE] : []) }
  } as never)
  useApp.setState((st) => ({
    servers: [SERVER],
    settings: { ...st.settings, modules: { ...defaultModuleState(), rules: false } }
  }))
  useNav.setState({ monitorTab: 'overview', fleetRail: 'monitor' })
}

const rulesTab = (): HTMLElement | null => screen.queryByRole('button', { name: 'Rules' })

beforeEach(() => {
  stubBridge({})
})

describe('Rules with its module switched off', () => {
  it('keeps the tab while a rule is still armed', async () => {
    withRules(true)
    render(<FleetMonitor />)
    // The read is async, so the tab arrives a tick after mount.
    await waitFor(() => expect(rulesTab(), 'the Rules tab was hidden while a rule was armed').toBeTruthy())
  })

  it('hides the tab once nothing is armed, which is what the switch is for', async () => {
    // The override must be narrow: an install that switched Rules off and has no
    // armed rules should see exactly what it asked for.
    withRules(false)
    render(<FleetMonitor />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Overview' })).toBeTruthy())
    expect(rulesTab(), 'the tab stayed after the last rule was disarmed').toBeNull()
  })

  it('says why the panel is still there', async () => {
    // A tab that reappears against an explicit setting is confusing unless it
    // explains itself. The notice is shown only in this combination.
    withRules(true)
    render(<FleetMonitor />)
    await waitFor(() => expect(rulesTab()).toBeTruthy())
    expect(
      screen.getByText(/switched off in Settings, but the rules below are still armed/i)
    ).toBeTruthy()
  })

  it('does not also advertise Rules as switched-off', async () => {
    // Otherwise the strip disagrees with itself: a tab the reader can see,
    // listed in the popover beside it under "switched off and available".
    withRules(true)
    const { container } = render(<FleetMonitor />)
    await waitFor(() => expect(rulesTab()).toBeTruthy())
    const offPopovers = [...container.querySelectorAll('.mon-pop')]
    for (const pop of offPopovers) {
      expect(pop.textContent ?? '', 'Rules is listed as off while it is on screen').not.toMatch(
        /^Rules$/m
      )
    }
  })

  it('shows no notice when the module is simply on', async () => {
    stubBridge({ rules: { list: async () => [ARMED_RULE] } } as never)
    useApp.setState((st) => ({
      servers: [SERVER],
      settings: { ...st.settings, modules: { ...defaultModuleState(), rules: true } }
    }))
    useNav.setState({ monitorTab: 'overview', fleetRail: 'monitor' })
    render(<FleetMonitor />)
    await waitFor(() => expect(rulesTab()).toBeTruthy())
    expect(screen.queryByText(/switched off in Settings, but the rules below/i)).toBeNull()
  })
})
