// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { AgentPanel } from '../src/renderer/src/components/sshAgent/AgentPanel'
import { useVault } from '../src/renderer/src/store/vault'
import { useApp } from '../src/renderer/src/store/app'

/**
 * A locked vault is not an empty one.
 *
 * The agent's key list reads through `vaultEntriesForResolve`, which answers
 * nothing while the vault is locked. So every key disappeared from this panel
 * and it said "No SSH keys in the vault yet" — telling the user to add keys
 * they already have, and pointing at the wrong problem entirely.
 *
 * The agent is inert at the same moment: `canSign()` refuses every signature,
 * so `git push` falls back to `~/.ssh` without saying why. Of all the surfaces
 * audited for docs/plans/vault-ux.md this was the only one with no
 * vault-locked affordance anywhere.
 */

beforeEach(() => {
  vi.clearAllMocks()
  useApp.setState({ settings: { sshAgent: { enabled: true } } } as never)
  stubBridge({
    sshAgent: {
      status: async () => ({ running: false, identities: 0 }),
      identities: async () => [],
      start: async () => ({ running: false, identities: 0 }),
      stop: async () => ({ running: false, identities: 0 })
    }
  })
})

describe('the SSH agent panel with no keys listed', () => {
  it('blames the lock, not the user, when the vault is locked', async () => {
    useVault.setState({ exists: true, unlocked: false, stage: 'locked' } as never)
    render(<AgentPanel />)

    expect(await screen.findByText(/vault is locked/i)).toBeTruthy()
    // The sentence that was wrong, and the reason it was wrong: the keys are
    // still there.
    expect(screen.queryByText(/No SSH keys in the vault yet/i)).toBeNull()
    expect(screen.getByText(/keys are still there/i)).toBeTruthy()
  })

  it('offers the one action that fixes it', async () => {
    useVault.setState({ exists: true, unlocked: false, stage: 'locked' } as never)
    render(<AgentPanel />)
    expect(await screen.findByText(/Unlock/i)).toBeTruthy()
  })

  it('still says the vault is empty when it genuinely is', async () => {
    // The fix must not swallow the real empty case — that message is correct
    // and actionable when there is nothing in the vault.
    useVault.setState({ exists: true, unlocked: true, stage: 'open' } as never)
    render(<AgentPanel />)

    await waitFor(() => expect(screen.getByText(/No SSH keys in the vault yet/i)).toBeTruthy())
    expect(screen.queryByText(/vault is locked/i)).toBeNull()
  })

  it('says nothing about a lock on a machine with no vault at all', async () => {
    useVault.setState({ exists: false, unlocked: false, stage: 'locked' } as never)
    render(<AgentPanel />)

    await waitFor(() => expect(screen.getByText(/No SSH keys in the vault yet/i)).toBeTruthy())
    expect(screen.queryByText(/vault is locked/i)).toBeNull()
  })
})
