// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UnlockVaultButton } from '../src/renderer/src/components/common/UnlockVaultButton'
import { useVaultPrompt } from '../src/renderer/src/store/vaultPrompt'

// Several screens named a locked vault and stopped there — the monitoring
// panels, the status-bar chip, the credential proxy's parked calls, the S3
// destination picker, the Docker env writer. Each told the reader to go and
// unlock it somewhere else and come back. store/toast.ts already wrote the
// argument down: that "means: find the vault, work out what a vault is, unlock
// it, come back". withVaultUnlock applies the rule to operations that FAIL on
// a locked vault; this applies it to the screens that disable themselves
// first and so never get as far as failing.

describe('the inline unlock', () => {
  beforeEach(() => {
    useVaultPrompt.setState({ open: false, reason: '', resolve: null })
  })

  it('raises the app dialog rather than routing somewhere', async () => {
    render(<UnlockVaultButton reason="Because the panel needs it." />)
    await userEvent.click(screen.getByRole('button', { name: /unlock vault/i }))
    expect(useVaultPrompt.getState().open).toBe(true)
    // The reason reaches the dialog, so it says why THIS screen asked.
    expect(useVaultPrompt.getState().reason).toBe('Because the panel needs it.')
  })

  it('runs the follow-up once the unlock succeeds', async () => {
    const after = vi.fn()
    render(<UnlockVaultButton reason="r" onUnlocked={after} />)
    await userEvent.click(screen.getByRole('button', { name: /unlock vault/i }))
    useVaultPrompt.getState().finish(true)
    await vi.waitFor(() => expect(after).toHaveBeenCalledTimes(1))
  })

  it('does not run it when the prompt is cancelled', async () => {
    // The whole point of the boolean. A panel that sweeps anyway runs the same
    // sweep that is still breaking on the same lock, and reports no change —
    // which reads to the user as the unlock having failed.
    const after = vi.fn()
    render(<UnlockVaultButton reason="r" onUnlocked={after} />)
    await userEvent.click(screen.getByRole('button', { name: /unlock vault/i }))
    useVaultPrompt.getState().finish(false)
    await new Promise((r) => setTimeout(r, 10))
    expect(after).not.toHaveBeenCalled()
  })

  it('carries a label a person can act on', async () => {
    render(<UnlockVaultButton reason="r" label="Unlock to resume checking" />)
    expect(screen.getByRole('button', { name: /unlock to resume checking/i })).toBeTruthy()
  })
})
