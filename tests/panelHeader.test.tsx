// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { InventoryPanel } from '../src/renderer/src/components/monitor/InventoryPanel'
import { PosturePanel } from '../src/renderer/src/components/monitor/PosturePanel'
import { DriftPanel } from '../src/renderer/src/components/monitor/DriftPanel'
import { CapacityPanel } from '../src/renderer/src/components/monitor/CapacityPanel'
import { ChangeLogPanel } from '../src/renderer/src/components/monitor/ChangeLogPanel'
import { CronPanel } from '../src/renderer/src/components/monitor/CronPanel'
import { RulesPanel } from '../src/renderer/src/components/monitor/RulesPanel'
import { ServicesPanel } from '../src/renderer/src/components/monitor/ServicesPanel'
import { JobsPanel } from '../src/renderer/src/components/monitor/JobsPanel'
import { BroadcastPanel } from '../src/renderer/src/components/monitor/BroadcastPanel'
import { FleetSearch } from '../src/renderer/src/components/monitor/FleetSearch'
import { PatchPanel } from '../src/renderer/src/components/monitor/PatchPanel'
import { AccessPanel } from '../src/renderer/src/components/monitor/AccessPanel'
import { LogTailPanel } from '../src/renderer/src/components/monitor/LogTailPanel'
import { CronEditPanel } from '../src/renderer/src/components/operations/CronEditPanel'
import { KeyRevokePanel } from '../src/renderer/src/components/operations/KeyRevokePanel'
import { UnitInstallPanel } from '../src/renderer/src/components/operations/UnitInstallPanel'
import type { Server } from '../src/renderer/src/types'

// One page template, held to.
//
// The finding this exists for was countable rather than aesthetic: Inventory,
// Security posture, Configuration drift and Docker put the icon, title,
// description and header actions INSIDE the bordered content card; Rules, Jobs
// and Server services put the same four OUTSIDE it, on the page background; and
// Fleet-wide search had no title, no description and no icon at all. Fifteen
// tabs, three different places to look for the header, so the eye re-learns
// where it is on every switch.
//
// Two of those panels were built out of `.panel-title` over `.panel-subtitle`.
// `.panel-title` is not defined anywhere in the stylesheet, and never was, so
// the heading drew as ordinary body text while the description under it drew
// bold and full-strength. The hierarchy was not merely inconsistent, it was
// inverted — and no test could see it, because both classes were present in the
// markup and only one of them meant anything.
//
// So this asserts the SHAPE rather than the styling: a panel-page whose first
// child is the header and whose second is the card. That is checkable in jsdom,
// it is the thing that differed, and it cannot be satisfied by markup that
// merely names the right classes.

function server(id: string, name: string): Server {
  return {
    id,
    workspaceId: 'ws-default',
    folderId: null,
    name,
    host: `${id}.example.internal`,
    port: 22,
    username: 'ops',
    auth: 'key',
    status: 'online',
    tags: [],
    favorite: false,
    os: 'linux',
    route: [],
    vpnProfileId: null
  }
}

const SERVERS = [server('srv-a', 'alpha')]

/** Every tab that wears the template, with the title it must announce. */
const PANELS: [string, string, () => React.JSX.Element][] = [
  ['Inventory', 'Inventory', () => <InventoryPanel servers={SERVERS} />],
  ['Security posture', 'Security posture', () => <PosturePanel servers={SERVERS} />],
  ['Configuration drift', 'Configuration drift', () => <DriftPanel servers={SERVERS} />],
  ['Capacity trends', 'Capacity trends', () => <CapacityPanel servers={SERVERS} />],
  ['Change log', 'Change log', () => <ChangeLogPanel servers={SERVERS} />],
  ['Scheduled jobs', 'Scheduled jobs', () => <CronPanel servers={SERVERS} />],
  ['Rules', 'Rules', () => <RulesPanel servers={SERVERS} />],
  ['Server services', 'Server services', () => <ServicesPanel servers={SERVERS} />],
  ['Jobs', 'Jobs', () => <JobsPanel servers={SERVERS} />],
  ['Run a command', 'Run a command', () => <BroadcastPanel servers={SERVERS} />],
  ['Patch and updates', 'Patch and updates', () => <PatchPanel servers={SERVERS} />],
  ['Keys and access', 'Keys and access', () => <AccessPanel servers={SERVERS} />],
  ['Log tail', 'Log tail', () => <LogTailPanel servers={SERVERS} />],
  // The one that had no header at all.
  ['Fleet-wide search', 'Fleet-wide search', () => <FleetSearch servers={SERVERS} onOpen={() => {}} />],
  // The Operations rail, which had the same split and the same undefined class.
  [
    'Change what a server runs on a schedule',
    'Change what a server runs on a schedule',
    () => <CronEditPanel servers={SERVERS} />
  ],
  ['Revoke a key', 'Revoke a key', () => <KeyRevokePanel servers={SERVERS} />],
  [
    'Install a service on a server',
    'Install a service on a server',
    () => <UnitInstallPanel servers={SERVERS} />
  ]
]

describe.each(PANELS)('%s', (_name, title, mount) => {
  it('puts the header on the page and the content in the card, in that order', () => {
    stubBridge({})
    const { container } = render(mount())

    const page = container.querySelector('section.panel-page')
    expect(page, 'no .panel-page — this panel is not on the template').not.toBeNull()

    const kids = [...page!.children]
    expect(kids.length, 'the template is exactly two blocks').toBe(2)
    expect(kids[0].className).toContain('panel-head')
    expect(kids[1].className).toContain('bc-panel')

    // The header is a SIBLING of the card, not inside it. This is the assertion
    // that fails if somebody moves it back in — which is what four of these
    // panels did and three did not.
    expect(kids[1].querySelector('.panel-head')).toBeNull()
  })

  it('announces itself with an icon and a real heading', () => {
    stubBridge({})
    const { container } = render(mount())

    const head = container.querySelector('.panel-head') as HTMLElement
    const heading = within(head).getByRole('heading', { level: 2 })
    expect(heading.textContent).toContain(title)
    // `.ui-section-title` is defined; `.panel-title` was not. Naming the class
    // is how this test notices a regression to an inert one.
    expect(heading.className).toContain('ui-section-title')
    expect(head.querySelector('.panel-head-icon svg'), 'no icon in the header').not.toBeNull()
  })
})

describe('the ⓘ beside the heading', () => {
  it('holds the panel description instead of standing it above the data', async () => {
    stubBridge({})
    render(<InventoryPanel servers={SERVERS} />)

    const purpose = /Read from package caches as they are/
    expect(screen.queryByText(purpose)).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'About Inventory' }))
    expect(screen.getByText(purpose)).toBeTruthy()
  })

  it('is named for its own panel, not just "info"', () => {
    // Fifteen tabs, fifteen identical icon buttons. A screen reader announcing
    // "button" fifteen times says nothing about which panel it belongs to.
    stubBridge({})
    render(<PosturePanel servers={SERVERS} />)
    expect(screen.getByRole('button', { name: 'About Security posture' })).toBeTruthy()
  })

  it('closes on Escape, so it cannot be left covering the first rows', async () => {
    stubBridge({})
    render(<InventoryPanel servers={SERVERS} />)
    const btn = screen.getByRole('button', { name: 'About Inventory' })

    await userEvent.click(btn)
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    await userEvent.keyboard('{Escape}')
    expect(btn.getAttribute('aria-expanded')).toBe('false')
  })

  it('closes on a click outside it, for the same reason', async () => {
    stubBridge({})
    render(<InventoryPanel servers={SERVERS} />)
    const btn = screen.getByRole('button', { name: 'About Inventory' })

    await userEvent.click(btn)
    await userEvent.click(document.body)
    expect(btn.getAttribute('aria-expanded')).toBe('false')
  })
})
