// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { VaultUnlockModal } from '../src/renderer/src/components/vault/VaultUnlockModal'
import { useVaultPrompt } from '../src/renderer/src/store/vaultPrompt'
import { useVault } from '../src/renderer/src/store/vault'
import { useApp } from '../src/renderer/src/store/app'

// After a sleep the terminal reconnects on `resume`, at the lock screen, and the
// vault prompt opens there. macOS will not offer Touch ID while the screen is
// locked, so the one automatic prompt failed and the dialog never asked again:
// the user unlocked the screen into "No enrolled Touch ID fingerprint" and had
// to close the dialog and reconnect to get a fingerprint prompt.

const UNAVAILABLE = { available: false, kind: 'none', reason: 'macOS is not offering Touch ID right now.' }

beforeEach(() => {
  useVault.setState({ exists: null, unlocked: false, busy: false, error: null, bioAvailable: false, bioEnabled: false })
  useVaultPrompt.setState({ open: false, reason: '' })
  useApp.setState((s) => ({ settings: { ...s.settings, vaultAutoBiometricPrompt: true } }))
})

describe('Touch ID that was unavailable when the vault prompt opened', () => {
  it('asks again once macOS offers it, and clears the stale error', async () => {
    let screenLocked = true
    const bioUnlock = vi.fn(async () =>
      screenLocked ? { ok: false, error: UNAVAILABLE.reason } : { ok: false, error: 'cancelled' }
    )
    stubBridge({
      vault: {
        status: async () => ({ exists: true, unlocked: false, entryCount: 0 }),
        list: async () => ({ ok: true, entries: [] }),
        // Available as of the last check before sleep, refused at the lock screen.
        bioSupport: async () =>
          screenLocked && bioUnlock.mock.calls.length > 0 ? UNAVAILABLE : { available: true, kind: 'touch-id' },
        bioEnabled: async () => true,
        bioScope: async () => 'session',
        bioUnlock
      }
    } as never)

    render(<VaultUnlockModal />)
    act(() => useVaultPrompt.setState({ open: true, reason: 'Connecting to a server' }))

    await waitFor(() => expect(bioUnlock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(useVault.getState().bioAvailable).toBe(false))
    expect(useVault.getState().error).toBe(UNAVAILABLE.reason)

    // The user unlocks the screen; the window gets focus back.
    screenLocked = false
    fireEvent.focus(window)

    await waitFor(() => expect(bioUnlock).toHaveBeenCalledTimes(2))
  })

  it('does not ask again after the user cancelled', async () => {
    const bioUnlock = vi.fn(async () => ({ ok: false, error: 'cancelled' }))
    stubBridge({
      vault: {
        status: async () => ({ exists: true, unlocked: false, entryCount: 0 }),
        list: async () => ({ ok: true, entries: [] }),
        bioSupport: async () => ({ available: true, kind: 'touch-id' }),
        bioEnabled: async () => true,
        bioScope: async () => 'session',
        bioUnlock
      }
    } as never)

    render(<VaultUnlockModal />)
    act(() => useVaultPrompt.setState({ open: true, reason: 'Connecting to a server' }))

    await waitFor(() => expect(bioUnlock).toHaveBeenCalledTimes(1))
    fireEvent.focus(window)
    await new Promise((r) => setTimeout(r, 50))
    expect(bioUnlock).toHaveBeenCalledTimes(1)
  })
})
