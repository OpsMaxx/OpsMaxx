// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { VaultUnlockModal } from '../src/renderer/src/components/vault/VaultUnlockModal'
import {
  VaultWaitingPrompt,
  resetVaultWaitingPromptForTests
} from '../src/renderer/src/components/vault/VaultWaitingPrompt'
import { useApp } from '../src/renderer/src/store/app'
import { useVaultPrompt } from '../src/renderer/src/store/vaultPrompt'

/**
 * The prompt that was missing — docs/plans/vault-ux.md §5.1.
 *
 * At launch the vault is locked, the unattended surfaces decline, and nothing
 * ever raises the question. These assert what the user actually sees: the
 * sentence when something is waiting, silence when nothing is, and — the
 * constraint that keeps it from being a nag — exactly one appearance per
 * launch however many times the app re-renders or the component remounts.
 */

interface Stub {
  waiting?: string[]
  status?: { exists: boolean; unlocked: boolean; stage: string; entryCount: number; damaged?: boolean }
  blocked?: number
}

const waiting = vi.fn(async () => [] as string[])
const fleetStatus = vi.fn(async () => ({ vaultBlockedCount: 0 }))

function bridge({ waiting: parts = [], status, blocked = 0 }: Stub = {}): void {
  waiting.mockImplementation(async () => parts)
  fleetStatus.mockImplementation(async () => ({ vaultBlockedCount: blocked }))
  stubBridge({
    vault: {
      status: vi.fn(async () => status ?? { exists: true, unlocked: false, stage: 'locked', entryCount: 3 }),
      list: vi.fn(async () => ({ ok: true, entries: [] })),
      waiting
    },
    fleet: { status: fleetStatus }
  })
}

/** Both halves, because the prompt is only real if the dialog it raises says
 *  the sentence. VaultWaitingPrompt renders nothing of its own. */
function launch(): ReturnType<typeof render> {
  return render(
    <>
      <VaultUnlockModal />
      <VaultWaitingPrompt />
    </>
  )
}

const settled = (): Promise<void> => waitFor(() => expect(fleetStatus).toHaveBeenCalled())

beforeEach(() => {
  resetVaultWaitingPromptForTests()
  waiting.mockClear()
  fleetStatus.mockClear()
  // Hydration is the gate: until the saved data is in, the fleet sampler has
  // not been told what to watch and its blocked count is the honest answer for
  // an empty estate.
  useApp.setState({ hydrated: true })
})

describe('the launch prompt', () => {
  it('says nothing when nothing is waiting on the vault', async () => {
    bridge({ waiting: [], blocked: 0 })
    launch()
    await settled()
    expect(useVaultPrompt.getState().open).toBe(false)
    expect(screen.queryByText(/waiting on the vault/)).toBeNull()
  })

  it('names what is waiting, in one sentence, in the dialog', async () => {
    bridge({
      waiting: ['VPN “office”', '2 CI accounts', 'a backup to “wasabi-nightly”'],
      blocked: 4
    })
    launch()

    await screen.findByText(
      'VPN “office”, 2 CI accounts, a backup to “wasabi-nightly” and 4 monitored servers are waiting on the vault.'
    )
    expect(screen.getByText('Vault locked')).toBeTruthy()
  })

  it('agrees the verb with a single thing', async () => {
    bridge({ waiting: ['VPN “office”'], blocked: 0 })
    launch()
    await screen.findByText('VPN “office” is waiting on the vault.')
  })

  it('leaves the fleet out when the sampler is blocking nothing', async () => {
    bridge({ waiting: ['1 CI account'], blocked: 0 })
    launch()
    await screen.findByText('1 CI account is waiting on the vault.')
    expect(screen.queryByText(/monitored server/)).toBeNull()
  })

  it('does not ask when the vault is already unlocked', async () => {
    bridge({
      waiting: ['2 CI accounts'],
      status: { exists: true, unlocked: true, stage: 'open', entryCount: 3 }
    })
    launch()
    await waitFor(() => expect(useApp.getState().hydrated).toBe(true))
    expect(waiting).not.toHaveBeenCalled()
    expect(useVaultPrompt.getState().open).toBe(false)
  })

  it('does not ask when there is no vault on this machine', async () => {
    bridge({
      waiting: ['2 CI accounts'],
      status: { exists: false, unlocked: false, stage: 'locked', entryCount: 0 }
    })
    launch()
    await waitFor(() => expect(useApp.getState().hydrated).toBe(true))
    expect(waiting).not.toHaveBeenCalled()
    expect(useVaultPrompt.getState().open).toBe(false)
  })

  it('does not offer an unlock for a vault no password can open', async () => {
    // A damaged file is a dead end, not a locked door. Asking for a master
    // password here is the contradiction VaultStatus.damaged exists to end.
    bridge({
      waiting: ['2 CI accounts'],
      status: { exists: true, unlocked: false, stage: 'locked', entryCount: 0, damaged: true }
    })
    launch()
    await waitFor(() => expect(useApp.getState().hydrated).toBe(true))
    expect(waiting).not.toHaveBeenCalled()
  })

  it('waits for the saved data before counting anything', async () => {
    useApp.setState({ hydrated: false })
    bridge({ waiting: ['2 CI accounts'], blocked: 4 })
    launch()
    await waitFor(() => expect(useVaultPrompt.getState().open).toBe(false))
    expect(waiting).not.toHaveBeenCalled()
  })

  it('is dismissed for the session — it does not come back', async () => {
    bridge({ waiting: ['2 CI accounts'], blocked: 0 })
    const first = launch()
    await screen.findByText('2 CI accounts are waiting on the vault.')

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(useVaultPrompt.getState().open).toBe(false))
    first.unmount()

    // A remount is a re-render, a hot reload, or React's development double
    // mount. None of them is a second launch.
    launch()
    await waitFor(() => expect(waiting).toHaveBeenCalledTimes(1))
    expect(useVaultPrompt.getState().open).toBe(false)
    expect(screen.queryByText(/waiting on the vault/)).toBeNull()
  })

  it('does not take over a dialog somebody is already answering', async () => {
    // A click that beat the launch check. Replacing its reason with an
    // unrelated list would swap the answer to what the user just did.
    bridge({ waiting: ['2 CI accounts'], blocked: 0 })
    void useVaultPrompt.getState().request('Connecting to Bastion')
    launch()
    await settled()
    expect(useVaultPrompt.getState().reason).toBe('Connecting to Bastion')
  })
})
