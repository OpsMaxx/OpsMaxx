// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { LocalHostCard } from '../src/renderer/src/components/monitor/LocalHostCard'
import { useApp } from '../src/renderer/src/store/app'
import { isLocalTarget } from '../src/shared/execTarget'

/**
 * "This machine" in the fleet overview — ports and addresses, asked for.
 *
 * Two properties matter more than the markup.
 *
 * It must ask through the ON-DEMAND probes, with a local target. The sampler's
 * `facts` are keyed by server id and read from the durable history store, which
 * is exactly where this machine must not appear: that store is what the MCP
 * bridge reads back, and local targets are kept off that surface by
 * construction rather than by a capability check.
 *
 * And it must vanish when local support is switched off. The switch is a
 * statement about whether this machine is a target at all, so a row that
 * remained and reported a refusal would be answering a question the user has
 * already closed.
 */

const PORTS = {
  ports: [
    { proto: 'tcp' as const, address: '0.0.0.0', port: 22, process: 'sshd', pid: 812 },
    { proto: 'tcp' as const, address: '127.0.0.1', port: 5432 }
  ],
  partialOwners: true,
  source: 'mixed' as const
}

const NET = { interfaces: [{ name: 'en0', addresses: [] }], dns: [], dnsSource: null }

describe('LocalHostCard', () => {
  beforeEach(() => {
    useApp.setState({
      settings: { ...useApp.getState().settings, localTerminalEnabled: true }
    })
  })

  it('asks the on-demand probes with a local target', async () => {
    const listeningPorts = vi.fn().mockResolvedValue(PORTS)
    const network = vi.fn().mockResolvedValue(NET)
    stubBridge({ fleet: { listeningPorts, network } })

    render(<LocalHostCard />)
    await waitFor(() => expect(listeningPorts).toHaveBeenCalled())

    // The target, not a server id — and it must actually be the local marker.
    expect(isLocalTarget(listeningPorts.mock.calls[0][0])).toBe(true)
    expect(isLocalTarget(network.mock.calls[0][0])).toBe(true)
  })

  it('lists the ports with their owners', async () => {
    stubBridge({
      fleet: {
        listeningPorts: vi.fn().mockResolvedValue(PORTS),
        network: vi.fn().mockResolvedValue(NET)
      }
    })
    render(<LocalHostCard />)

    // Opened first: the table is collapsed on arrival, because on the fleet
    // overview it buried the estate's own servers under local sockets.
    fireEvent.click(await screen.findByRole('button', { name: /listening socket/i }))

    expect(await screen.findByText('22')).toBeTruthy()
    expect(screen.getByText('sshd')).toBeTruthy()
    expect(screen.getByText('5432')).toBeTruthy()
  })

  /**
   * The distinction the em dash carries. Unprivileged `lsof` on macOS cannot
   * see other users' sockets, so the list is joined with `netstat` to stay
   * complete — which leaves the OWNERS partial rather than the list short. A
   * table that looked complete and was not is the failure being avoided, so the
   * card has to say which of the two it is showing.
   */
  /**
   * The caveat travels WITH the rows it is about.
   *
   * The socket table is now closed by default — on the fleet overview it took
   * most of the viewport and pushed the estate's own servers below the fold —
   * so this note is behind the same toggle. That is the right place for it: it
   * qualifies the Process column, and a warning about a column nobody is
   * looking at is noise. What stays visible is the count.
   */
  it('says the owners are partial rather than implying nothing owns them', async () => {
    stubBridge({
      fleet: {
        listeningPorts: vi.fn().mockResolvedValue(PORTS),
        network: vi.fn().mockResolvedValue(NET)
      }
    })
    render(<LocalHostCard />)

    // The summary is on screen without opening anything.
    const toggle = await screen.findByRole('button', { name: /listening socket/i })
    fireEvent.click(toggle)

    expect(await screen.findByText(/Every listening socket is listed/)).toBeTruthy()
  })

  // The count is the overview-level fact and must not need a click.
  it('shows how many sockets are listening without opening the table', async () => {
    stubBridge({
      fleet: {
        listeningPorts: vi.fn().mockResolvedValue(PORTS),
        network: vi.fn().mockResolvedValue(NET)
      }
    })
    render(<LocalHostCard />)

    expect(await screen.findByRole('button', { name: /listening socket/i })).toBeTruthy()
    // And the rows themselves are not on screen yet.
    expect(screen.queryByText(/Every listening socket is listed/)).toBeNull()
  })

  it('disappears entirely when this machine is not an allowed target', async () => {
    const listeningPorts = vi.fn().mockResolvedValue(PORTS)
    stubBridge({ fleet: { listeningPorts, network: vi.fn() } })
    useApp.setState({
      settings: { ...useApp.getState().settings, localTerminalEnabled: false }
    })

    render(<LocalHostCard />)

    expect(screen.queryByText('This machine')).toBeNull()
    // And it must not have asked: main would refuse the call anyway.
    expect(listeningPorts).not.toHaveBeenCalled()
  })

  it('reports a failed read instead of showing an empty list as fact', async () => {
    stubBridge({
      fleet: {
        listeningPorts: vi.fn().mockResolvedValue({ error: 'no POSIX shell was found' }),
        network: vi.fn().mockResolvedValue(NET)
      }
    })
    render(<LocalHostCard />)

    // "Nothing is listening" would be a fabrication here.
    expect(await screen.findByText(/no POSIX shell was found/)).toBeTruthy()
    expect(screen.queryByText('Nothing is listening.')).toBeNull()
  })
})
