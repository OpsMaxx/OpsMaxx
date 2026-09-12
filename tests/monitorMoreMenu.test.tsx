// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { FleetMonitor } from '../src/renderer/src/components/monitor/FleetMonitor'
import { useApp } from '../src/renderer/src/store/app'
import { useNav } from '../src/renderer/src/store/nav'
import type { Server } from '../src/renderer/src/types'

// The `More` popover would not go away.
//
// Thirteen read modules do not fit one row, so the strip has a ceiling and the
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

beforeEach(() => {
  stubBridge({})
  useApp.setState({ servers: [SERVER] })
  // The default module state leaves eight read modules on and the strip holds
  // six besides Overview and Alerts, so the overflow is the shipped shape
  // rather than something this test arranged.
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

describe('the overflow menu in Monitoring', () => {
  it('opens on the trigger and lists the tabs that did not fit', async () => {
    render(<FleetMonitor />)
    expect(menu()).toBeNull()
    await userEvent.click(moreButton())
    expect(menu()).not.toBeNull()
    expect(moreButton().getAttribute('aria-expanded')).toBe('true')
    expect(within(menu()!).getByRole('button', { name: 'Docker' })).toBeTruthy()
  })

  it('closes when the press lands anywhere else', async () => {
    // The reported bug, in one line: clicking another tab left the menu
    // sitting over the page.
    render(<FleetMonitor />)
    await userEvent.click(moreButton())
    expect(menu()).not.toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Overview' }))
    expect(menu()).toBeNull()
    expect(moreButton().getAttribute('aria-expanded')).toBe('false')
  })

  it('closes on Escape', async () => {
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
    render(<FleetMonitor />)
    await userEvent.click(moreButton())
    expect(menu()).not.toBeNull()
    await userEvent.click(moreButton())
    expect(menu()).toBeNull()
  })

  it('closes when a tab is picked, and picks it', async () => {
    render(<FleetMonitor />)
    await userEvent.click(moreButton())
    await userEvent.click(within(menu()!).getByRole('button', { name: 'Docker' }))
    expect(useNav.getState().monitorTab).toBe('docker')
    expect(menu()).toBeNull()
  })
})
