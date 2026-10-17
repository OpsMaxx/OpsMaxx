// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { VaultUnlockModal } from '../src/renderer/src/components/vault/VaultUnlockModal'
import { useVaultPrompt } from '../src/renderer/src/store/vaultPrompt'
import { useVault } from '../src/renderer/src/store/vault'

// The dialog every unlock in this app funnels into, and it was unusable from
// most of them.
//
// `checking` is `exists === null`, `exists` starts null in the vault store, and
// `ready` — the submit button's enabled gate — requires `!checking`. The modal
// refreshed BIOMETRICS when it opened and never the vault's own status, so
// unless something else had already loaded that status the dialog sat forever
// on "Checking this machine for a vault…" with a live password field above a
// button that could not be pressed.
//
// It never showed up in use because the Vault view and Settings both refresh on
// mount — and those are the only two places anyone had opened it by hand. Every
// unlock added for the locked-vault work (SweepEmpty, PanelError,
// VaultLockedHosts, withVaultUnlock) opens it from a monitoring panel instead,
// which has no reason to have loaded vault status. Found by driving the built
// app against a real locked vault, not by a test.

function stubVaultBridge(status: { exists: boolean; unlocked: boolean }): {
  statusCalls: () => number
} {
  let calls = 0
  ;(window as unknown as { opsmaxx: unknown }).opsmaxx = {
    vault: {
      status: async () => {
        calls += 1
        return { ...status, entryCount: 0 }
      },
      list: async () => ({ ok: true, entries: [] }),
      unlock: async () => ({ ok: true })
    },
    biometrics: { support: async () => ({ available: false }), enabled: async () => false }
  }
  return { statusCalls: () => calls }
}

beforeEach(() => {
  // The state a monitoring panel raises the prompt from: nothing has loaded
  // vault status, so `exists` is still null.
  useVault.setState({ exists: null, unlocked: false, busy: false, error: null })
  useVaultPrompt.setState({ open: false, reason: '' })
  vi.restoreAllMocks()
})

describe('the vault prompt, opened from a screen that never loaded vault status', () => {
  it('asks for the status itself instead of waiting forever', async () => {
    const { statusCalls } = stubVaultBridge({ exists: true, unlocked: false })
    render(<VaultUnlockModal />)
    useVaultPrompt.setState({ open: true, reason: 'Reading services needs a credential.' })

    await waitFor(() => expect(statusCalls()).toBeGreaterThan(0))
    await waitFor(() => expect(useVault.getState().exists).toBe(true))
  })

  it('offers a submit that can actually be pressed', async () => {
    stubVaultBridge({ exists: true, unlocked: false })
    render(<VaultUnlockModal />)
    useVaultPrompt.setState({ open: true, reason: 'Reading services needs a credential.' })

    // The regression, stated as the user meets it: the button said "Checking…"
    // and stayed disabled, so the dialog could be typed into and never
    // completed.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Unlock and continue/ })).toBeTruthy()
    )
    expect(screen.queryByRole('button', { name: /Checking/ })).toBeNull()
  })

  it('says the vault is locked rather than that it is still looking for one', async () => {
    stubVaultBridge({ exists: true, unlocked: false })
    render(<VaultUnlockModal />)
    useVaultPrompt.setState({ open: true, reason: 'Reading services needs a credential.' })

    await waitFor(() =>
      expect(screen.getByText(/This credential is stored in your vault/)).toBeTruthy()
    )
    expect(screen.queryByText(/Checking this machine for a vault/)).toBeNull()
  })

  it('still offers to create one when this machine has no vault at all', async () => {
    // The other branch of the same status read, and it must not be collapsed
    // into "locked": there is nothing to unlock here.
    stubVaultBridge({ exists: false, unlocked: false })
    render(<VaultUnlockModal />)
    useVaultPrompt.setState({ open: true, reason: 'Reading services needs a credential.' })

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Create vault and continue/ })).toBeTruthy()
    )
  })

  it('does not read the status while it is closed', async () => {
    const { statusCalls } = stubVaultBridge({ exists: true, unlocked: false })
    render(<VaultUnlockModal />)
    await new Promise((r) => setTimeout(r, 10))
    expect(statusCalls()).toBe(0)
  })
})

describe('a vault file that cannot be read', () => {
  it('offers to delete it here rather than sending the user to the Finder', async () => {
    // This branch told the truth -- nothing is lost, the file is still there --
    // and then offered Close as the only action, with the way forward written
    // as prose: "move it aside to start a new vault". That is an instruction to
    // go and find a file in the application support directory, which is not
    // something to ask of the person this screen is shown to. `vaultDestroy`
    // was already wired from here and simply had no caller.
    ;(window as unknown as { opsmaxx: unknown }).opsmaxx = {
      vault: {
        status: async () => ({ exists: true, damaged: true, unlocked: false, stage: 'locked' }),
        list: async () => ({ ok: true, entries: [] }),
        unlock: async () => ({ ok: false, error: 'unreadable' }),
        destroy: async () => ({ ok: true }),
        bioSupport: async () => ({ available: false, kind: 'none' }),
        bioEnabled: async () => false,
        bioScope: async () => null
      }
    }
    render(<VaultUnlockModal />)
    useVaultPrompt.setState({ open: true, reason: 'Reading services needs a credential.' })

    await waitFor(() => expect(screen.getByText(/Vault file unreadable/i)).toBeTruthy())
    // Close stays: abandoning a damaged vault must remain a choice, not the
    // only one.
    // getAllBy: the Modal chrome has its own Close as well as this branch's.
    expect(screen.getAllByRole('button', { name: /Close/ }).length).toBeGreaterThan(0)
    expect(screen.getByText(/Lost your master password/i)).toBeTruthy()
    expect(screen.queryByText(/move it aside/i)).toBeNull()
    expect(screen.getByText(/delete it here and start a new vault/i)).toBeTruthy()
  })
})
