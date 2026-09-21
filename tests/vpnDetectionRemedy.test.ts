// @vitest-environment jsdom
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { useApp } from '../src/renderer/src/store/app'
import { useVpnProfiles } from '../src/renderer/src/components/vpn/useVpnProfiles'
import type { VpnEngineInfo, VpnKind, VpnProfile } from '../src/renderer/src/types'

/**
 * The row for a profile whose engine came with OpsMaxx and is not there.
 *
 * Antivirus quarantining the WireGuard sidecar produced the worst row in the
 * app: a disabled Start, a sentence naming `scripts/build-sidecar.sh` — an
 * instruction for whoever builds OpsMaxx — and not one button. Nothing on
 * screen told the user what had happened or gave them anything to press.
 *
 * What is pinned here is that the row says something a non-developer can act
 * on and offers the action that actually repairs it, and that the openvpn
 * case it has to share the block with is untouched.
 */

const probe = vi.fn()

function profile(kind: VpnKind): VpnProfile {
  return {
    id: `p-${kind}`,
    workspaceId: 'w1',
    name: `${kind} profile`,
    spec:
      kind === 'wireguard'
        ? { kind: 'wireguard', mode: 'userspace', peers: [] }
        : { kind: 'openvpn', remotes: [] }
  } as unknown as VpnProfile
}

/** What a driver reports when the binary it ships is not on disk — the real
 *  shape, including the build-script sentence that was reaching the user. */
function missing(kind: VpnKind): VpnEngineInfo {
  return {
    kind,
    available: false,
    bundled: true,
    reason:
      'The program that runs this tunnel could not be found. ' +
      'It should be at bin/darwin-arm64/opsmaxx-netd — run scripts/build-sidecar.sh.'
  } as unknown as VpnEngineInfo
}

/** Renders one profile's row through the hook that owns it. */
function Row({ p }: { p: VpnProfile }): React.JSX.Element {
  return useVpnProfiles().row(p)
}

function show(p: VpnProfile, platform: NodeJS.Platform): void {
  useApp.setState({ vpns: [p], workspaces: [{ id: 'w1', name: 'W' }] } as never)
  stubBridge({
    platform: () => Promise.resolve(platform),
    vpn: { probe }
  })
  render(createElement(Row, { p }))
}

beforeEach(() => {
  vi.clearAllMocks()
  probe.mockImplementation((k: VpnKind) => Promise.resolve(missing(k)))
})

describe('a bundled engine that is not on disk', () => {
  it('says what happened without naming a build script', async () => {
    show(profile('wireguard'), 'darwin')
    expect(await screen.findByText(/ships inside OpsMaxx/)).toBeTruthy()
    // The developer-facing text still exists — it is the best diagnostic there
    // is — but behind the Details disclosure rather than as the headline.
    expect(screen.getByText(/build-sidecar\.sh/).closest('details')).not.toBeNull()
  })

  it('offers the repair rather than leaving the row with no control at all', async () => {
    show(profile('wireguard'), 'darwin')
    expect(await screen.findByRole('button', { name: 'Reinstall OpsMaxx' })).toBeTruthy()
  })

  it('does the same for OpenVPN where OpsMaxx ships it', async () => {
    show(profile('openvpn'), 'darwin')
    // Both, and they do not contradict each other: the copy we shipped is
    // gone, and pointing at one the user installed themselves is still valid.
    expect(await screen.findByRole('button', { name: 'Reinstall OpsMaxx' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Set the path' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Install OpenVPN' })).toBeNull()
  })

  it('leaves the Windows OpenVPN case alone, where the user really does install it', async () => {
    show(profile('openvpn'), 'win32')
    expect(await screen.findByRole('button', { name: 'Install OpenVPN' })).toBeTruthy()
    // Windows ships no OpenVPN of ours, so there is nothing for a reinstall to
    // put back and saying otherwise would send the reader to the wrong place.
    expect(screen.queryByRole('button', { name: 'Reinstall OpsMaxx' })).toBeNull()
    await waitFor(() => expect(screen.queryByText(/ships inside OpsMaxx/)).toBeNull())
  })
})
