// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { StatusBar } from '../src/renderer/src/components/layout/StatusBar'
import { ActivityBar } from '../src/renderer/src/components/layout/ActivityBar'
import { useAlerts } from '../src/renderer/src/store/alerts'
import { useApp } from '../src/renderer/src/store/app'
import { useFleetStatus } from '../src/renderer/src/store/fleetStatus'
import { useNav } from '../src/renderer/src/store/nav'

// The status bar, rendered — the third component in this suite and the one that
// is here to show the harness is not shaped around DockerPanel.
//
// It is also where a real defect lived. The alert chip's tooltip used to build
// its label with a ternary over two kinds; when `disk` became a third
// AlertKind, every disk alert arrived in the status bar labelled "Memory". The
// fix was `LABEL[a.kind]` — a Record, so a fourth kind is a type error rather
// than a mislabelled alarm — and the comment in StatusBar.tsx says so. Nothing
// tested it: the tooltip is a string built during render, which is exactly what
// a readFileSync-and-regex test cannot evaluate.

/** One active alert, in the shape store/alerts.ts keys them by. */
function raise(kind: 'cpu' | 'ram' | 'disk', value: number): void {
  useAlerts.setState({
    active: {
      [`s1:${kind}`]: { serverId: 's1', serverName: 'web-1', kind, value, since: Date.now() }
    }
  })
}

const chip = (): HTMLElement => screen.getByRole('button', { name: /alert/ })

describe('StatusBar', () => {
  it('labels a disk alert "Disk", not "Memory"', () => {
    stubBridge({})
    raise('disk', 91)

    render(<StatusBar />)

    expect(chip().getAttribute('title')).toContain('web-1: Disk 91%')
    expect(chip().getAttribute('title')).not.toContain('Memory')
  })

  it('still labels the other two kinds correctly', () => {
    stubBridge({})
    useAlerts.setState({
      active: {
        's1:ram': { serverId: 's1', serverName: 'web-1', kind: 'ram', value: 88, since: Date.now() },
        's2:cpu': { serverId: 's2', serverName: 'db-1', kind: 'cpu', value: 97, since: Date.now() }
      }
    })

    render(<StatusBar />)

    const title = chip().getAttribute('title') ?? ''
    expect(title).toContain('web-1: Memory 88%')
    expect(title).toContain('db-1: CPU 97%')
    expect(chip().textContent).toContain('2 alerts')
  })

  // The negative case matters as much: a bar that always shows a chip cannot
  // tell you anything by showing one. This is also the assertion that proves
  // the previous test's store writes were rolled back rather than inherited.
  it('shows no alert chip when nothing is alerting', () => {
    stubBridge({})

    render(<StatusBar />)

    expect(screen.queryByRole('button', { name: /alert/ })).toBeNull()
    // ...and the pristine store really is pristine.
    expect(useAlerts.getState().list()).toEqual([])
  })

  it('renders the active workspace and the session count', () => {
    stubBridge({})
    useApp.setState({ tabs: [] })

    render(<StatusBar />)

    expect(document.body.textContent).toContain('Personal')
    expect(document.body.textContent).toContain('0 sessions')
  })

  // The sampler warning is the other thing this bar is responsible for saying,
  // and it is the one an operator most needs: an alert count of zero means
  // nothing when the thing that counts them has stopped.
  it('warns when background checking is enabled but not running', () => {
    stubBridge({})
    useApp.getState().setSettings({ fleetSamplingEnabled: true })
    useFleetStatus.getState().setStatus({
      running: false,
      idleReason: 'vault-locked',
      targetCount: 3
    })

    render(<StatusBar />)

    expect(screen.getByRole('button', { name: /Checks paused/ })).toBeTruthy()
  })

  // The chip's tooltip has always named its destination. Its click did not go
  // there: `setActivity('settings')` opens Settings on whichever page was last
  // shown, so pressing "Backup out of date" while Appearance was the last page
  // landed on Appearance. A pointer that opens the wrong page teaches the user
  // the button is broken.
  it('lands on Backup & Restore, not on whatever Settings page was last open', () => {
    stubBridge({})
    useNav.setState({ settingsSection: 'appearance' })
    useApp.getState().setSettings({ backupDirty: true })

    render(<StatusBar />)
    fireEvent.click(screen.getByRole('button', { name: /Backup out of date/ }))

    expect(useApp.getState().activity).toBe('settings')
    expect(useNav.getState().settingsSection).toBe('backup')
  })
})

// Same signal, second surface. `settings.backupDirty` also raises a dot on the
// activity bar's Settings button, and a bare dot on a button called "Settings"
// is indistinguishable from "an update is available" or "something is broken".
// Tested here rather than in a file of its own because the two halves of one
// bug are easier to keep honest side by side.
describe('ActivityBar', () => {
  const settingsBtn = (): HTMLElement => screen.getByRole('button', { name: /^Settings/ })

  it('says what the badge means when the backup is stale', () => {
    stubBridge({})
    useApp.getState().setSettings({ backupDirty: true })

    render(<ActivityBar />)

    // Accessible name, not just a hover: the dot itself is decoration, so the
    // meaning has to be reachable on the button.
    expect(settingsBtn().getAttribute('title')).toContain('backup out of date')
    expect(settingsBtn().getAttribute('title')).toContain('since the last export')
    expect(settingsBtn().querySelector('.activity-badge')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('says nothing extra when the backup is current', () => {
    stubBridge({})
    useApp.getState().setSettings({ backupDirty: false })

    render(<ActivityBar />)

    expect(settingsBtn().getAttribute('title')).toBe('Settings')
    expect(settingsBtn().querySelector('.activity-badge')).toBeNull()
  })
})
