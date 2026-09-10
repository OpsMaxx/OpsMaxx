// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { MonitorView } from '../src/renderer/src/components/panel/MonitorView'
import { LOCAL_ID, LOCAL_NAME, isLocalTarget } from '../src/shared/execTarget'
import type { Server } from '../src/renderer/src/types'

/**
 * This machine's Monitor tab.
 *
 * The local machine's card used to sit at the bottom of the fleet overview,
 * carrying its network and its listening sockets and nothing else — half a
 * monitor on a screen about the estate. It was removed, and everything it
 * showed has to be on the local terminal's Monitor tab instead, or the removal
 * is a deletion rather than a move.
 *
 * The other half is HOW those reads are addressed. The network and
 * listening-socket bridges take a connection config, and this machine is not
 * reached by connecting to it: `isLocalTarget` in main is deliberately exact,
 * so the marker has to arrive as itself rather than as an SSH target that
 * happens to name a host called `localhost`.
 */

/** The transient stand-in WorkspacePanel builds. Never persisted. */
const localHost = {
  id: LOCAL_ID,
  workspaceId: '',
  folderId: null,
  name: LOCAL_NAME,
  host: 'localhost',
  port: 0,
  username: '',
  auth: 'key',
  status: 'online',
  tags: [],
  favorite: false,
  os: 'linux',
  route: [],
  vpnProfileId: null,
  demo: false
} as unknown as Server

const server = { ...localHost, id: 's1', name: 'web-1', host: 'web-1.internal', port: 22 } as Server

function bridge(): { network: ReturnType<typeof vi.fn>; listeningPorts: ReturnType<typeof vi.fn> } {
  const network = vi.fn(async () => ({
    interfaces: [
      {
        name: 'en0',
        addresses: [{ family: 'ipv4', address: '192.168.1.5', prefix: 24 }]
      }
    ],
    dns: ['1.1.1.1'],
    dnsSource: 'resolv.conf'
  }))
  const listeningPorts = vi.fn(async () => ({
    ports: [
      { port: 5177, proto: 'tcp', address: '127.0.0.1', process: 'OpsMaxx' },
      { port: 9000, proto: 'tcp', address: '127.0.0.1', process: 'php-fpm' }
    ],
    partialOwners: false
  }))
  stubBridge({
    fleet: { network, listeningPorts },
    metrics: {
      sample: vi.fn(async () => ({
        ok: true,
        data: {
          cpu: 12, cpuCores: null, memPct: 44, memUsed: 8e9, memTotal: 18e9,
          memAvailable: 10e9, memFree: 4e9, memCache: null,
          diskPct: 40, diskUsed: 18e9, diskTotal: 45e9, inodePct: 0.1, mounts: [],
          load1: 1.2, netRx: 1e9, netTx: 5e8, uptime: 3600,
          hostname: 'this-mac', kernel: 'Darwin 24.6.0', cores: 12,
          services: null, listeners: null, listenerSource: null
        }
      }))
    }
  })
  return { network, listeningPorts }
}

describe('what the local Monitor tab shows', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists the listening sockets the fleet overview used to carry', async () => {
    bridge()
    render(<MonitorView server={localHost} visible={true} />)
    expect(await screen.findByText('Listening ports')).toBeTruthy()
    expect(await screen.findByText('OpsMaxx')).toBeTruthy()
  })

  it('shows the network read too', async () => {
    bridge()
    render(<MonitorView server={localHost} visible={true} />)
    // The address, not the word "Network" — the metrics grid has a throughput
    // tile with that label, so the heading alone matches twice.
    expect(await screen.findByText(/192\.168\.1\.5/)).toBeTruthy()
    expect(await screen.findByText(/1\.1\.1\.1/)).toBeTruthy()
  })

  it('asks for this machine with the marker, not an SSH target', async () => {
    // The distinction that decides whether a command runs here or on somebody
    // else's host. `isLocalTarget` is exact, so a config that merely names
    // `localhost` would be sent over SSH to a host called localhost.
    const { network, listeningPorts } = bridge()
    render(<MonitorView server={localHost} visible={true} />)
    await waitFor(() => expect(listeningPorts).toHaveBeenCalled())
    expect(isLocalTarget(network.mock.calls[0][0])).toBe(true)
    expect(isLocalTarget(listeningPorts.mock.calls[0][0])).toBe(true)
  })

  it('still sends a real SSH target for a real server', async () => {
    // The same code path serves both, so the local branch must not leak.
    const { network, listeningPorts } = bridge()
    render(<MonitorView server={server} visible={true} />)
    await waitFor(() => expect(listeningPorts).toHaveBeenCalled())
    expect(isLocalTarget(network.mock.calls[0][0])).toBe(false)
    expect(isLocalTarget(listeningPorts.mock.calls[0][0])).toBe(false)
  })

  it('does not claim this machine is polled over SSH', async () => {
    bridge()
    render(<MonitorView server={localHost} visible={true} />)
    expect(await screen.findByText(/polling every 2s on this machine/)).toBeTruthy()
    expect(screen.queryByText(/over SSH/)).toBeNull()
  })

  it('keeps the sockets on screen when the metrics poll fails', async () => {
    // The card this replaced showed ports unconditionally, so hiding them
    // behind a metrics error would be a straight loss on this machine. These
    // reads do not come from the metrics poll and do not fail with it.
    const network = vi.fn(async () => ({ error: 'no route' }))
    const listeningPorts = vi.fn(async () => ({
      ports: [{ port: 5177, proto: 'tcp', address: '127.0.0.1', process: 'OpsMaxx' }],
      partialOwners: false
    }))
    stubBridge({
      fleet: { network, listeningPorts },
      metrics: { sample: vi.fn(async () => ({ ok: false, error: 'the collector did not run' })) }
    })

    render(<MonitorView server={localHost} visible={true} />)
    expect(await screen.findByText('Metrics unavailable')).toBeTruthy()
    // And the answer that DID arrive is still there.
    expect(await screen.findByText('Listening ports')).toBeTruthy()
    expect(await screen.findByText('OpsMaxx')).toBeTruthy()
  })

  it('still says over SSH for a server', async () => {
    bridge()
    render(<MonitorView server={server} visible={true} />)
    expect(await screen.findByText(/polling every 2s over SSH/)).toBeTruthy()
  })
})
