// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { FoundProfilesBanner } from '../src/renderer/src/components/vpn/FoundProfilesBanner'
import { useApp } from '../src/renderer/src/store/app'
import type { DiscoveredVpnProfile } from '../src/shared/vpn'

/**
 * The offer that brings an existing OpenVPN setup to the user.
 *
 * Discovery used to live only inside the import dialog, which is a worse
 * answer than it sounds: somebody who already has OpenVPN configured does not
 * think of themselves as importing anything, so the one place the offer
 * appeared was behind a button they had no reason to press. The report was
 * "if pre-installed it should automatically import everything".
 *
 * What is pinned here is behaviour, not markup: that it asks, that it counts
 * what it found, that pressing the button actually commits each one, that
 * declining survives a remount, and — the two that matter most — that a
 * machine with no OpenVPN shows NOTHING, and that an older preload cannot take
 * the screen down.
 */

const found = (over: Partial<DiscoveredVpnProfile> = {}): DiscoveredVpnProfile => ({
  kind: 'openvpn',
  sourcePath: '/Users/x/OpenVPN/config/work.ovpn',
  name: 'work',
  report: {
    ok: true,
    stripped: [],
    warnings: [],
    spec: { kind: 'openvpn' }
  } as unknown as DiscoveredVpnProfile['report'],
  ...over
})

const discoverProfiles = vi.fn()
const commitImportFile = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useApp.setState({ vpns: [] })
  discoverProfiles.mockResolvedValue([])
  commitImportFile.mockResolvedValue({ ok: true, spec: { kind: 'openvpn' }, vaultEntryId: 'v1' })
  stubBridge({ vpn: { discoverProfiles, commitImportFile } })
})

describe('the found-profiles offer', () => {
  it('asks for WireGuard as well as OpenVPN', async () => {
    render(<FoundProfilesBanner onReview={() => {}} />)
    await waitFor(() => expect(discoverProfiles).toHaveBeenCalled())
    expect(discoverProfiles.mock.calls[0][1]).toEqual(['openvpn', 'wireguard'])
  })

  it('says nothing on a machine that has no profiles', async () => {
    render(<FoundProfilesBanner onReview={() => {}} />)
    await waitFor(() => expect(discoverProfiles).toHaveBeenCalled())
    // The ordinary case, and it must be silent. A banner saying "found 0" is
    // an app talking about itself.
    expect(screen.queryByText(/already on this machine/)).toBeNull()
  })

  it('counts what it found, and says it in the singular for one', async () => {
    discoverProfiles.mockResolvedValue([found()])
    render(<FoundProfilesBanner onReview={() => {}} />)
    expect(
      await screen.findByText(/One OpenVPN profile is already on this machine/)
    ).toBeTruthy()
  })

  it('pluralises', async () => {
    discoverProfiles.mockResolvedValue([found(), found({ sourcePath: '/b.ovpn', name: 'b' })])
    render(<FoundProfilesBanner onReview={() => {}} />)
    expect(await screen.findByText(/2 VPN profiles are already on this machine/)).toBeTruthy()
  })

  it('excludes what is already imported, by source path', async () => {
    useApp.setState({
      vpns: [{ id: 'p1', spec: { kind: 'openvpn', sourcePath: '/Users/x/OpenVPN/config/work.ovpn' } }]
    } as never)
    render(<FoundProfilesBanner onReview={() => {}} />)
    await waitFor(() => expect(discoverProfiles).toHaveBeenCalled())
    // The path of the profile already held is what gets sent, so the scan can
    // skip it. Passing nothing would offer the user their own imports back.
    // Both kinds asked for: WireGuard discovery exists in main and defaults
    // off, so asking for OpenVPN alone would leave it unreachable.
    expect(discoverProfiles).toHaveBeenCalledWith(
      ['/Users/x/OpenVPN/config/work.ovpn'],
      ['openvpn', 'wireguard']
    )
  })

  it('does not offer a profile that cannot be imported', async () => {
    discoverProfiles.mockResolvedValue([
      found({
        report: { ok: false, error: 'bad' } as unknown as DiscoveredVpnProfile['report']
      })
    ])
    render(<FoundProfilesBanner onReview={() => {}} />)
    await waitFor(() => expect(discoverProfiles).toHaveBeenCalled())
    // "Import all" must not promise something that will fail. The dialog lists
    // these with their reason; the one-press path does not.
    expect(screen.queryByText(/already on this machine/)).toBeNull()
  })

  it('actually imports each one when pressed', async () => {
    discoverProfiles.mockResolvedValue([
      found(),
      found({ sourcePath: '/Users/x/OpenVPN/config/home.ovpn', name: 'home' })
    ])
    render(<FoundProfilesBanner onReview={() => {}} />)
    await userEvent.click(await screen.findByText('Import all'))

    // By path, not by text: the file is read in main so an inline private key
    // never crosses IPC.
    await waitFor(() => expect(commitImportFile).toHaveBeenCalledTimes(2))
    expect(commitImportFile.mock.calls[0][3]).toBe('/Users/x/OpenVPN/config/work.ovpn')
    expect(commitImportFile.mock.calls[1][3]).toBe('/Users/x/OpenVPN/config/home.ovpn')
  })

  it('puts a real profile in the store, not the commit result', async () => {
    // THE BUG THIS EXISTS FOR. The commit result is `{ ok, spec, vaultEntryId }`
    // and it was handed to the store cast straight to a profile, through an
    // `as unknown as` that the compiler could not object to. The import worked,
    // the keys reached the vault, and the list showed nothing — the profile the
    // user had just imported had vanished.
    //
    // Asserting on the STORE rather than on "was commitImportFile called" is
    // the whole point: the call was always being made.
    discoverProfiles.mockResolvedValue([found()])
    render(<FoundProfilesBanner onReview={() => {}} />)
    await userEvent.click(await screen.findByText('Import all'))

    await waitFor(() => expect(useApp.getState().vpns).toHaveLength(1))
    const stored = useApp.getState().vpns[0]
    expect(stored.name).toBe('work')
    expect(stored.workspaceId).toBeTruthy()
    // An id the list can key on. Without one the row cannot render at all.
    expect(stored.id).toMatch(/^vpn-/)
    expect(stored.spec?.kind).toBe('openvpn')
    // And none of the commit envelope leaked in as if it were profile data.
    expect(stored).not.toHaveProperty('ok')
    expect(stored).not.toHaveProperty('vaultEntryId')
  })

  it('stays gone once declined, across a remount', async () => {
    discoverProfiles.mockResolvedValue([found()])
    const first = render(<FoundProfilesBanner onReview={() => {}} />)
    await screen.findByText(/already on this machine/)
    await userEvent.click(screen.getByTitle('Not now'))
    first.unmount()

    render(<FoundProfilesBanner onReview={() => {}} />)
    // And it does not even ask again — a declined offer that still scans every
    // launch is doing the work for nothing.
    expect(screen.queryByText(/already on this machine/)).toBeNull()
  })

  it('survives a preload older than the renderer', async () => {
    stubBridge({ vpn: {} })
    // The dev-time mismatch. This used to be the shape that takes a whole view
    // down through the error boundary.
    expect(() => render(<FoundProfilesBanner onReview={() => {}} />)).not.toThrow()
    expect(screen.queryByText(/already on this machine/)).toBeNull()
  })

  it('hands the review button to the caller rather than importing', async () => {
    discoverProfiles.mockResolvedValue([found()])
    const onReview = vi.fn()
    render(<FoundProfilesBanner onReview={onReview} />)
    await userEvent.click(await screen.findByText('Review'))
    expect(onReview).toHaveBeenCalledOnce()
    expect(commitImportFile).not.toHaveBeenCalled()
  })
})
