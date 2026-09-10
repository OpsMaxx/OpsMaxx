// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { VaultUnlockModal } from '../src/renderer/src/components/vault/VaultUnlockModal'
import { useVault } from '../src/renderer/src/store/vault'
import { useVaultPrompt } from '../src/renderer/src/store/vaultPrompt'

/**
 * Unlocking, from the dialog every locked operation raises.
 *
 * Two reports, both about the same second of dead time. The biometric prompt
 * waited for a click even though the dialog itself is already the answer to
 * one — so reaching Touch ID took two presses where one carried no decision.
 */

const opened = (reason = 'Connecting to Bastion'): void => {
  act(() => {
    void useVaultPrompt.getState().request(reason)
  })
}

describe('the unlock dialog', () => {
  beforeEach(() => {
    useVault.setState({ exists: true, unlocked: false, busy: false, error: null })
  })

  it('raises the biometric prompt as soon as it opens', async () => {
    const bioUnlock = vi.fn(async () => ({ ok: true }))
    stubBridge({
      vault: {
        status: vi.fn(async () => ({ exists: true, unlocked: false })),
        bioSupport: vi.fn(async () => ({ available: true, kind: 'touch-id' })),
        bioEnabled: vi.fn(async () => true),
        bioUnlock,
        list: vi.fn(async () => ({ ok: true, entries: [] }))
      }
    })

    render(<VaultUnlockModal />)
    opened()

    // Without a click. Every path that opens this dialog is downstream of
    // something the user just did, so the prompt is not unbidden.
    await waitFor(() => expect(bioUnlock).toHaveBeenCalledTimes(1))
  })

  it('closes the dialog once biometrics succeed', async () => {
    stubBridge({
      vault: {
        status: vi.fn(async () => ({ exists: true, unlocked: true })),
        bioSupport: vi.fn(async () => ({ available: true, kind: 'touch-id' })),
        bioEnabled: vi.fn(async () => true),
        bioUnlock: vi.fn(async () => ({ ok: true })),
        list: vi.fn(async () => ({ ok: true, entries: [] }))
      }
    })

    render(<VaultUnlockModal />)
    opened()
    await waitFor(() => expect(useVaultPrompt.getState().open).toBe(false))
  })

  it('asks once, then leaves the reader with the password field', async () => {
    // The original concern, kept: a prompt that re-fires after a refusal is
    // the reflex-training this was cautious about. A refusal is final for as
    // long as the dialog stays open.
    const bioUnlock = vi.fn(async () => ({ ok: false, error: 'cancelled' }))
    stubBridge({
      vault: {
        status: vi.fn(async () => ({ exists: true, unlocked: false })),
        bioSupport: vi.fn(async () => ({ available: true, kind: 'touch-id' })),
        bioEnabled: vi.fn(async () => true),
        bioUnlock,
        list: vi.fn(async () => ({ ok: true, entries: [] }))
      }
    })

    render(<VaultUnlockModal />)
    opened()
    await waitFor(() => expect(bioUnlock).toHaveBeenCalledTimes(1))

    // Typing must not set it off again.
    await userEvent.type(screen.getByPlaceholderText(/master password/i), 'hunter2')
    expect(bioUnlock).toHaveBeenCalledTimes(1)
    // And the button is still there to try again deliberately.
    expect(screen.getByRole('button', { name: /unlock with touch id/i })).toBeTruthy()
  })

  it('does not raise it where biometrics are not enrolled', async () => {
    const bioUnlock = vi.fn(async () => ({ ok: true }))
    stubBridge({
      vault: {
        status: vi.fn(async () => ({ exists: true, unlocked: false })),
        // Available on the machine, deliberately NOT turned on for this vault.
        bioSupport: vi.fn(async () => ({ available: true, kind: 'touch-id' })),
        bioEnabled: vi.fn(async () => false),
        bioUnlock,
        list: vi.fn(async () => ({ ok: true, entries: [] }))
      }
    })

    render(<VaultUnlockModal />)
    opened()
    await screen.findByPlaceholderText(/master password/i)
    expect(bioUnlock).not.toHaveBeenCalled()
  })

  it('does not raise it while creating a vault', async () => {
    // There is nothing to unlock yet, and a biometric prompt over a
    // create-vault form is asking for consent to nothing.
    const bioUnlock = vi.fn(async () => ({ ok: true }))
    useVault.setState({ exists: false })
    stubBridge({
      vault: {
        status: vi.fn(async () => ({ exists: false, unlocked: false })),
        bioSupport: vi.fn(async () => ({ available: true, kind: 'touch-id' })),
        bioEnabled: vi.fn(async () => true),
        bioUnlock,
        list: vi.fn(async () => ({ ok: true, entries: [] }))
      }
    })

    render(<VaultUnlockModal />)
    opened()
    await screen.findByText(/there is no vault on this machine yet/i)
    expect(bioUnlock).not.toHaveBeenCalled()
  })
})
