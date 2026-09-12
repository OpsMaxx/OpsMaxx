// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { CheckNowButton } from '../src/renderer/src/components/monitor/CheckNowButton'
import { SftpView } from '../src/renderer/src/components/panel/SftpView'
import { useApp } from '../src/renderer/src/store/app'
import { useNav } from '../src/renderer/src/store/nav'
import { useToasts } from '../src/renderer/src/store/toast'
import type { Server } from '../src/renderer/src/types'

/**
 * Controls that name a destination and then do not go there.
 *
 * A sentence saying "turn it on in Settings" is a research task, not an
 * instruction: find Settings, find the page inside it, act, come back, and
 * remember what you were doing. The rule the app already follows elsewhere
 * (FleetHealth, SweepEmpty, store/toast.ts's own docstring) is that the prose
 * may say where, but a control has to go there.
 *
 * These assert the landing — activity AND page — rather than that a function
 * was called, because Settings opened on the wrong page is the same dead end.
 */

beforeEach(() => {
  useApp.setState({ activity: 'monitor' })
  useNav.setState({ settingsSection: 'appearance' })
  useToasts.getState().clear()
})

describe('Check now, refused because sampling is off', () => {
  it('opens Monitoring settings from the refusal instead of only naming it', async () => {
    // Background checking ships OFF, so this is the answer most people get the
    // first time they press the button — on Inventory, Access and Posture.
    stubBridge({
      fleet: { collectNow: vi.fn().mockResolvedValue({ swept: false, reason: 'disabled' }) }
    })
    render(<CheckNowButton collects="facts" />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /check now/i }))

    await screen.findByText(/Fleet sampling is switched off/)
    await user.click(screen.getByRole('button', { name: /Open Monitoring settings/i }))
    expect(useApp.getState().activity).toBe('settings')
    expect(useNav.getState().settingsSection).toBe('monitoring')
  })

  it('offers no settings button for a refusal Settings cannot fix', async () => {
    // "No servers are being sampled in this workspace" is not resolved by the
    // Monitoring page, so a button pointing there would be a second dead end.
    stubBridge({
      fleet: { collectNow: vi.fn().mockResolvedValue({ swept: false, reason: 'no-servers' }) }
    })
    render(<CheckNowButton collects="facts" />)
    await userEvent.setup().click(screen.getByRole('button', { name: /check now/i }))

    await screen.findByText(/nothing to collect/)
    expect(screen.queryByRole('button', { name: /Open Monitoring settings/i })).toBeNull()
  })
})

describe('the sample file list', () => {
  const demoServer: Server = {
    id: 'demo-1',
    workspaceId: 'ws-default',
    folderId: null,
    name: 'sample',
    host: 'sample.example.internal',
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

  it('says Upload does nothing here, and offers the way out', async () => {
    // Every other control in the pane says so. Upload was the one that failed
    // silently, which reads as broken rather than as a fixture.
    stubBridge({})
    render(<SftpView server={demoServer} />)
    await userEvent.setup().click(screen.getByRole('button', { name: /Upload/i }))

    const [said] = useToasts.getState().toasts
    expect(said?.message).toContain('Upload')
    expect(said?.message).toContain('not a real server')
    // Sticky, and carrying the one action that turns the fixture into a real
    // file list — the same offer the rest of the pane makes.
    expect(said?.action?.label).toBe('Add a real server')
    said!.action!.run()
    expect(useApp.getState().modal).toBe('add-server')
  })
})
