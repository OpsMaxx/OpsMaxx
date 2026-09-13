// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { FleetMonitor } from '../src/renderer/src/components/monitor/FleetMonitor'
import { useApp } from '../src/renderer/src/store/app'
import { useNav } from '../src/renderer/src/store/nav'
import { defaultModuleState } from '../src/shared/modules'
import type { Server } from '../src/renderer/src/types'

// The `More` popover would not go away.
//
// The read modules do not all fit one row, so the strip has a ceiling and the
// overflow lives behind `More` — see the comment at `MAX_STRIP_TABS`. What the
// overflow shipped without was any way to dismiss it except pressing the same
// button again. It is positioned over the page, so a person who opened it to
// look and then went back to the table was reading the table through a menu.
//
// The app already had the answer: `useClickOutside`, which the workspace
// switcher, the context menu, the command palette and every modal use. This
// file is the behaviour, asserted through the DOM rather than by reading the
// source, because the part that was wrong is what the browser does with the
// press — which handler sees it first, and whether the toggle then undoes the
// dismissal.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE NOW ARRANGES ITS OWN OVERFLOW
// ---------------------------------------------------------------------------
//
// It used to rely on the shipped defaults producing one, and asserted `Docker`
// inside the popover to prove it. Both of those are now wrong, and deliberately:
// Docker, Kubernetes, CI/CD and local processes have their own activity-bar
// buttons (see PROMOTED_MODULE_IDS), which took the default enabled strip set
// down to exactly the six slots the row has. A default install renders no
// overflow control at all — pinned below as `the default install`, because that
// is the outcome promotion was for and a regression would quietly undo it.
//
// The dismissal behaviour still matters for anyone who switches more modules on,
// so the rest of this file turns two extra modules on to get an overflow and
// asserts against those. `Scheduled jobs` and `Server services` are the two that
// land in it, being last in registry order among the enabled set.

// The strip only exists once there is something to monitor: with no servers
// the page is an empty state and there is no `More` to press.
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

/** The two tabs pushed past the ceiling by `overflowing()`, by label. */
const OVERFLOWED = ['Scheduled jobs', 'Server services']

/**
 * Switch on enough strip modules to need an overflow.
 *
 * The default enabled strip set is exactly six — the number of slots — so
 * something has to be added. `drift` and `services` are read modules that stay
 * in the strip, and adding them puts `cron` and `services` past the ceiling.
 */
function overflowing(): void {
  useApp.setState((st) => ({
    settings: {
      ...st.settings,
      modules: { ...defaultModuleState(), drift: true, services: true }
    }
  }))
}

beforeEach(() => {
  stubBridge({})
  useApp.setState({ servers: [SERVER] })
  useApp.setState((st) => ({ settings: { ...st.settings, modules: defaultModuleState() } }))
  useNav.setState({ monitorTab: 'overview', fleetRail: 'monitor' })
})

/** The trigger. Named by its label so the test breaks if the label moves. */
function moreButton(): HTMLElement {
  return screen.getByRole('button', { name: /More/ })
}

/** The popover itself, scoped to the trigger's host so neither the sibling
 *  "switched off" popover nor a mounted-but-hidden panel can answer for it. */
function menu(): HTMLElement | null {
  return moreButton().closest('.mon-pop-host')!.querySelector('.mon-pop')
}

describe('the default install', () => {
  // The point of promoting Docker, Kubernetes, CI/CD and local processes to the
  // activity bar. Eight read modules used to ship on against six slots, so two
  // arrived behind `More` on a machine nobody had configured. Six ship on now.
  //
  // Asserted as the ABSENCE of the control rather than as a count, because that
  // is what a user sees: there is no dropdown, not a shorter one.
  it('needs no overflow control at all', () => {
    render(<FleetMonitor />)
    expect(screen.queryByRole('button', { name: /More/ })).toBeNull()
  })

  // The other half: the promoted modules must not simply have vanished. They are
  // reached from the activity bar, and the strip must not be advertising them.
  it('keeps the promoted modules out of the strip', () => {
    render(<FleetMonitor />)
    for (const label of ['Docker', 'Kubernetes']) {
      expect(screen.queryByRole('button', { name: label }), label).toBeNull()
    }
  })
})

describe('the overflow menu in Monitoring', () => {
  it('opens on the trigger and lists the tabs that did not fit', async () => {
    overflowing()
    render(<FleetMonitor />)
    expect(menu()).toBeNull()
    await userEvent.click(moreButton())
    expect(menu()).not.toBeNull()
    expect(moreButton().getAttribute('aria-expanded')).toBe('true')
    for (const label of OVERFLOWED) {
      expect(within(menu()!).getByRole('button', { name: label }), label).toBeTruthy()
    }
  })

  it('closes when the press lands anywhere else', async () => {
    // The reported bug, in one line: clicking another tab left the menu
    // sitting over the page.
    overflowing()
    render(<FleetMonitor />)
    await userEvent.click(moreButton())
    expect(menu()).not.toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Overview' }))
    expect(menu()).toBeNull()
    expect(moreButton().getAttribute('aria-expanded')).toBe('false')
  })

  it('closes on Escape', async () => {
    overflowing()
    render(<FleetMonitor />)
    await userEvent.click(moreButton())
    await userEvent.keyboard('{Escape}')
    expect(menu()).toBeNull()
  })

  it('hands focus back to the trigger when Escape comes from inside the menu', async () => {
    // The case that matters, and the one a test written from the mouse would
    // miss: focus is on a ROW, and closing the menu unmounts the element that
    // has it. Left alone, focus falls to the body and the next Tab starts from
    // the top of the document -- so a keyboard user who looks in the menu and
    // changes their mind loses their place in the strip.
    overflowing()
    render(<FleetMonitor />)
    await userEvent.click(moreButton())
    await userEvent.tab()
    expect(menu()!.contains(document.activeElement)).toBe(true)
    await userEvent.keyboard('{Escape}')
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(moreButton())
  })

  it('still toggles shut from the trigger, without reopening on the same click', async () => {
    // The failure mode of a badly wired outside-click: the document handler
    // closes the menu on mousedown and the button's onClick opens it again on
    // mouseup, so the trigger appears dead. The listener ignores presses
    // inside the host, which contains the trigger.
    overflowing()
    render(<FleetMonitor />)
    await userEvent.click(moreButton())
    expect(menu()).not.toBeNull()
    await userEvent.click(moreButton())
    expect(menu()).toBeNull()
  })

  it('closes when a tab is picked, and picks it', async () => {
    overflowing()
    render(<FleetMonitor />)
    await userEvent.click(moreButton())
    await userEvent.click(within(menu()!).getByRole('button', { name: 'Server services' }))
    expect(useNav.getState().monitorTab).toBe('services')
    expect(menu()).toBeNull()
  })
})
