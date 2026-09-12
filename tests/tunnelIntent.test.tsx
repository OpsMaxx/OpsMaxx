// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { Sidebar } from '../src/renderer/src/components/layout/Sidebar'
import { CommandPalette } from '../src/renderer/src/components/palette/CommandPalette'
import { TunnelsView } from '../src/renderer/src/components/tunnels/TunnelsView'
import { useApp } from '../src/renderer/src/store/app'
import { useNav } from '../src/renderer/src/store/nav'
import type { Tunnel } from '../src/renderer/src/types'

// Two controls that named a thing and then could not reach it.
//
// The sidebar's "New tunnel" button had no handler at all, and every palette
// row under "Tunnels" was titled with one tunnel's name, subtitled with its
// ports, and opened the Tunnels page without selecting it. Both for the same
// reason: `creating` and `editing` were local `useState` inside TunnelManager,
// so there was nothing outside the panel for either control to call.

const tunnel = (id: string, name: string, listen: string): Tunnel => ({
  id,
  workspaceId: 'ws-default',
  name,
  kind: 'local',
  status: 'inactive',
  serverId: null,
  listen,
  target: 'localhost:5432'
})

/** The app's own mounting rule, which is the half that matters here: App.tsx
 *  renders `{activity === 'tunnels' && <TunnelsView />}`, so leaving Tunnels
 *  UNMOUNTS the panel and coming back builds a new one with fresh local state.
 *  An intent left lying in the store is honoured again by that new panel. */
function App(): React.JSX.Element {
  const activity = useApp((s) => s.activity)
  return (
    <>
      <Sidebar />
      {activity === 'tunnels' && <TunnelsView />}
    </>
  )
}

const dialog = (): HTMLElement | null => screen.queryByRole('dialog')

beforeEach(() => {
  // `list` resolves to nothing and `onStatus` is absent: this is about which
  // form is on screen, not about what is running.
  stubBridge({
    tunnel: { list: async () => undefined, stop: async () => undefined },
    // Read by VpnManager, which the "was last on another tab" test mounts.
    platform: async () => 'darwin'
  })
  useApp.setState({
    activity: 'tunnels',
    tunnelsTab: 'tunnels',
    tunnels: [tunnel('t-db', 'web-db', '5432'), tunnel('t-cache', 'redis-cache', '6379')]
  })
})

describe('the sidebar "New tunnel" button', () => {
  it('opens the creation form', () => {
    render(<App />)

    fireEvent.click(screen.getByTitle('New tunnel'))

    const form = dialog()
    expect(form).not.toBeNull()
    expect(within(form!).getByRole('heading').textContent).toBe('Create tunnel')
  })

  it('shows the tunnel list even when the user was last on another tab', () => {
    // Tunnels, VPN, reverse proxies and Traffic share one destination, and the
    // creation form lives in the first of them. Landing on VPN with the intent
    // set would be the button doing nothing, again.
    useApp.setState({ tunnelsTab: 'vpn' })
    render(<App />)

    fireEvent.click(screen.getByTitle('New tunnel'))

    expect(useApp.getState().tunnelsTab).toBe('tunnels')
    expect(dialog()).not.toBeNull()
  })
})

describe('a palette entry named after a tunnel', () => {
  it('opens that tunnel, not just the page', () => {
    render(
      <>
        <CommandPalette />
        <App />
      </>
    )

    const input = screen.getByPlaceholderText(/Search servers/)
    fireEvent.change(input, { target: { value: 'redis-cache' } })
    // Scoped to the palette: the sidebar lists the same tunnel by name, and
    // clicking that row is not what this is about.
    fireEvent.click(within(input.closest('.palette') as HTMLElement).getByText('redis-cache'))

    const form = dialog()
    expect(form).not.toBeNull()
    expect(within(form!).getByRole('heading').textContent).toBe('Edit tunnel')
    // The tunnel the row was named after, and no other.
    expect((within(form!).getByPlaceholderText('web-db') as HTMLInputElement).value).toBe(
      'redis-cache'
    )
  })
})

describe('the intent does not outlive the visit', () => {
  it('does not re-open the form when Tunnels is opened again by other means', () => {
    render(<App />)
    fireEvent.click(screen.getByTitle('New tunnel'))
    expect(dialog()).not.toBeNull()

    fireEvent.click(screen.getByLabelText('Close'))
    expect(dialog()).toBeNull()

    // Away and back the way the activity bar does it — no intent involved.
    act(() => useApp.getState().setActivity('connections'))
    act(() => useApp.getState().setActivity('tunnels'))

    expect(dialog()).toBeNull()
    expect(useNav.getState().tunnelIntent).toBeNull()
  })

  it('is cleared even when it names a tunnel that has since been deleted', () => {
    render(<App />)

    act(() => useNav.setState({ tunnelIntent: { kind: 'select', tunnelId: 't-gone' } }))

    expect(dialog()).toBeNull()
    expect(useNav.getState().tunnelIntent).toBeNull()
  })
})
