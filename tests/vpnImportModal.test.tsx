// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { VpnImportModal } from '../src/renderer/src/components/vpn/VpnImportModal'
import { useApp } from '../src/renderer/src/store/app'
import type { DiscoveredVpnProfile } from '../src/shared/vpn'

/**
 * The import dialog, from the two directions a config actually arrives.
 *
 * A dropped or chosen file comes with the folder it lives in, and that folder
 * is the whole of what makes the commonest `.ovpn` in existence importable: an
 * easy-rsa bundle names `ca ca.crt` beside itself. Pasted text comes with no
 * folder at all, and has to be told so rather than accused of pointing outside
 * one.
 *
 * And a profile found on this machine is REVIEWED here before it is stored —
 * which is what the modal's own subtitle has always promised and what the
 * found-profiles list used not to do.
 */

const okReport = {
  ok: true,
  name: 'vpn.example.com',
  spec: { kind: 'openvpn' },
  stripped: [],
  warnings: []
} as unknown as DiscoveredVpnProfile['report']

const found = (over: Partial<DiscoveredVpnProfile> = {}): DiscoveredVpnProfile => ({
  kind: 'openvpn',
  sourcePath: '/Users/x/OpenVPN/config/work.ovpn',
  name: 'work',
  report: okReport,
  ...over
})

const vpnImport = vi.fn()
const commitImport = vi.fn()
const commitImportFile = vi.fn()
const discoverProfiles = vi.fn()
const pathFor = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  useApp.setState({ vpns: [] })
  vpnImport.mockResolvedValue(okReport)
  commitImport.mockResolvedValue({ ok: true, spec: { kind: 'openvpn' }, vaultEntryId: 'v1' })
  commitImportFile.mockResolvedValue({ ok: true, spec: { kind: 'openvpn' }, vaultEntryId: 'v1' })
  discoverProfiles.mockResolvedValue([])
  pathFor.mockReturnValue('/Users/x/Downloads/work.ovpn')
  stubBridge({
    vpn: { import: vpnImport, commitImport, commitImportFile, discoverProfiles },
    sftp: { pathFor }
  })
})

/** A `File` the component can read, with a name the chooser would give it. */
const file = (name: string, body: string): File =>
  new File([body], name, { type: 'text/plain' })

const drop = async (el: Element, f: File): Promise<void> => {
  const { fireEvent } = await import('@testing-library/react')
  fireEvent.drop(el, { dataTransfer: { files: [f], types: ['Files'] } })
}

describe('the folder a dropped profile came from', () => {
  it('is sent to main, so `ca ca.crt` beside the file can be read', async () => {
    render(<VpnImportModal kind="openvpn" onClose={() => {}} />)
    const zone = screen.getByPlaceholderText(/Paste an .ovpn profile/).parentElement as Element
    await drop(zone, file('work.ovpn', 'client\nca ca.crt\n'))

    await waitFor(() => expect(vpnImport).toHaveBeenCalled())
    // The directory, not the file: main resolves inside it and nowhere else.
    expect(vpnImport.mock.calls[0][2]).toBe('/Users/x/Downloads')
  })

  it('is sent again at commit, because main re-parses there', async () => {
    render(<VpnImportModal kind="openvpn" onClose={() => {}} />)
    const zone = screen.getByPlaceholderText(/Paste an .ovpn profile/).parentElement as Element
    await drop(zone, file('work.ovpn', 'client\nca ca.crt\n'))
    await waitFor(() => expect(vpnImport).toHaveBeenCalled())

    await userEvent.click(await screen.findByText('Import profile'))
    await waitFor(() => expect(commitImport).toHaveBeenCalled())
    expect(commitImport.mock.calls[0][4]).toBe('/Users/x/Downloads')
  })

  it('is absent for pasted text, which has no folder to speak of', async () => {
    render(<VpnImportModal kind="openvpn" onClose={() => {}} />)
    await userEvent.type(screen.getByPlaceholderText(/Paste an .ovpn profile/), 'client')
    await waitFor(() => expect(vpnImport).toHaveBeenCalled())
    expect(vpnImport.mock.calls[0][2]).toBeUndefined()
  })

  it('survives a preload with no pathFor rather than taking the dialog down', async () => {
    stubBridge({ vpn: { import: vpnImport, commitImport, commitImportFile, discoverProfiles } })
    render(<VpnImportModal kind="openvpn" onClose={() => {}} />)
    const zone = screen.getByPlaceholderText(/Paste an .ovpn profile/).parentElement as Element
    await drop(zone, file('work.ovpn', 'client\n'))
    await waitFor(() => expect(vpnImport).toHaveBeenCalled())
    expect(vpnImport.mock.calls[0][2]).toBeUndefined()
  })
})

describe('a profile found on this machine', () => {
  it('is not stored by pressing the button next to it', async () => {
    discoverProfiles.mockResolvedValue([found()])
    render(<VpnImportModal kind="openvpn" onClose={() => {}} />)
    await userEvent.click(await screen.findByText('Review'))

    // THE PROMISE IN THE SUBTITLE. This used to commit on the press, with the
    // stripped report sitting unread in the renderer's own hands.
    expect(commitImportFile).not.toHaveBeenCalled()
    expect(useApp.getState().vpns).toHaveLength(0)
  })

  it('is committed by path once the footer button is pressed', async () => {
    discoverProfiles.mockResolvedValue([found()])
    render(<VpnImportModal kind="openvpn" onClose={() => {}} />)
    await userEvent.click(await screen.findByText('Review'))
    await userEvent.click(screen.getByText('Import profile'))

    // By path: main reads the file, so an inline private key never crosses IPC.
    await waitFor(() => expect(commitImportFile).toHaveBeenCalledTimes(1))
    expect(commitImportFile.mock.calls[0][3]).toBe('/Users/x/OpenVPN/config/work.ovpn')
    expect(commitImport).not.toHaveBeenCalled()
  })

  it('actually reaches the profile list', async () => {
    // The other half of the same bug: the commit result was never put in the
    // store at all, so a discovered profile went into the vault and then
    // vanished from the screen.
    discoverProfiles.mockResolvedValue([found()])
    render(<VpnImportModal kind="openvpn" onClose={() => {}} />)
    await userEvent.click(await screen.findByText('Review'))
    await userEvent.click(screen.getByText('Import profile'))

    await waitFor(() => expect(useApp.getState().vpns).toHaveLength(1))
    const stored = useApp.getState().vpns[0]
    expect(stored.name).toBe('work')
    expect(stored.id).toMatch(/^vpn-/)
    expect(stored).not.toHaveProperty('vaultEntryId')
  })

  it('shows what was stripped, and will not import until it has been seen', async () => {
    discoverProfiles.mockResolvedValue([
      found({
        report: {
          ...okReport,
          stripped: [{ directive: 'comp-lzo', reason: 'Compression is a plaintext-recovery vector.', severity: 'removed' }]
        } as unknown as DiscoveredVpnProfile['report']
      })
    ])
    render(<VpnImportModal kind="openvpn" onClose={() => {}} />)
    await userEvent.click(await screen.findByText('Review'))
    expect(screen.getByText('comp-lzo')).toBeTruthy()
    expect(screen.getByText(/1 directive was removed/)).toBeTruthy()
  })
})

describe('what the dialog scans for', () => {
  it('asks for its own kind, not always OpenVPN', async () => {
    render(<VpnImportModal kind="wireguard" onClose={() => {}} />)
    // It asked for `openvpn` whatever it was opened as, so the WireGuard
    // tunnels main can already find were unreachable from every screen.
    await waitFor(() => expect(discoverProfiles).toHaveBeenCalled())
    expect(discoverProfiles.mock.calls[0][1]).toEqual(['wireguard'])
  })

  it('does not scan for frp, which no installer lays down in a known place', () => {
    render(<VpnImportModal kind="frp" onClose={() => {}} />)
    expect(discoverProfiles).not.toHaveBeenCalled()
  })
})
