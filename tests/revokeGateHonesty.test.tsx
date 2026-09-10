// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { KeyRevokePanel } from '../src/renderer/src/components/operations/KeyRevokePanel'
import { useApp } from '../src/renderer/src/store/app'
import type { Server } from '../src/renderer/src/types'

/**
 * What the revoke screen says when it will not revoke.
 *
 * It used to say one thing for three different reasons: "Changing authorized
 * keys is not enabled in this build." Two of those reasons are not the build,
 * and in the common case the sentence was not even true — the build constant
 * is a ceiling the operator's own switch rises above, so somebody who had
 * simply never turned that switch on was told the release had decided it for
 * them, with no switch named and nothing to act on.
 *
 * That is the difference between a screen that is off and a screen that is
 * broken, and it was reported as broken.
 */

const server = (id: string, name: string): Server =>
  ({
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
  }) as Server

const SERVERS = [server('s1', 'Scanner01'), server('s2', 'Bastion')]

/** One collected host with one key on it, and one host never read. */
const accessBridge = (extra: Record<string, unknown> = {}): void =>
  stubBridge({
    fleet: {
      access: vi.fn(async (id: string) =>
        id === 's1'
          ? {
              access: {
                accounts: [
                  { user: 'root', keys: [{ fingerprint: 'SHA256:aaa', comment: 'ops@laptop' }] }
                ]
              }
            }
          : null
      ),
      onProgress: vi.fn(() => () => undefined),
      ...extra
    }
  })

describe('the revoke screen names the gate that is actually shut', () => {
  beforeEach(() => {
    useApp.setState({ settings: { ...useApp.getState().settings, accessWriteEnabled: false } })
  })

  it('names the operator switch, not the build, when the switch is off', async () => {
    accessBridge({ accessPlan: vi.fn() })
    render(<KeyRevokePanel servers={SERVERS} />)

    const note = await screen.findByTestId('write-gated')
    expect(note.textContent).toMatch(/switched off/i)
    // The claim that was wrong. The build is not what is stopping this.
    expect(note.textContent).not.toMatch(/not enabled in this build/i)
    // And a way to act on it, rather than the name of a setting to go hunting for.
    expect(screen.getByRole('button', { name: /open the setting/i })).toBeTruthy()
  })

  it('blames the stale preload when that is the real reason', async () => {
    // No accessPlan on the bridge: the renderer is newer than the process.
    accessBridge()
    render(<KeyRevokePanel servers={SERVERS} />)
    const note = await screen.findByTestId('write-gated')
    expect(note.textContent).toMatch(/restart opsmaxx/i)
    // Not the operator's switch — turning it on would change nothing here.
    expect(screen.queryByRole('button', { name: /open the setting/i })).toBeNull()
  })

  it('stops refusing once the operator turns the switch on', async () => {
    accessBridge({ accessPlan: vi.fn() })
    useApp.setState({ settings: { ...useApp.getState().settings, accessWriteEnabled: true } })
    render(<KeyRevokePanel servers={SERVERS} />)

    await waitFor(() => expect(screen.queryByTestId('write-gated')).toBeNull())
    // Still disabled with nothing chosen — but for THAT reason, which the
    // button now says, rather than a gate the reader cannot see.
    const plan = (await screen.findByTestId('revoke-plan')) as HTMLButtonElement
    expect(plan.title).toMatch(/choose a key/i)

    // And it goes live once a key is picked.
    await userEvent.click(await screen.findByText('SHA256:aaa'))
    await waitFor(() =>
      expect((screen.getByTestId('revoke-plan') as HTMLButtonElement).disabled).toBe(false)
    )
  })

  it('says why the plan button is greyed out, on the button', async () => {
    accessBridge({ accessPlan: vi.fn() })
    render(<KeyRevokePanel servers={SERVERS} />)
    const plan = (await screen.findByTestId('revoke-plan')) as HTMLButtonElement
    expect(plan.disabled).toBe(true)
    // A disabled control whose reason lives in a paragraph at the top of the
    // screen is one the reader concludes is broken.
    expect(plan.title).toMatch(/switched off/i)
  })

  it('offers to collect the servers it has not read', async () => {
    accessBridge({ accessPlan: vi.fn() })
    render(<KeyRevokePanel servers={SERVERS} />)

    // The other half of the report: one host collected showed one host's keys
    // and no way at all to reach the rest.
    expect(await screen.findByTestId('revoke-unchecked')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /check now/i }).length).toBeGreaterThan(0)
  })
})
