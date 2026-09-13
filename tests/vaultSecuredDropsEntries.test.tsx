// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { act } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { useVault, startVaultLockWatch } from '../src/renderer/src/store/vault'

/**
 * The renderer drops its plaintext whatever is on screen.
 *
 * This is the half of the idle timeout that was never actually happening. The
 * listener lived in VaultView, so it was wired only while the Vault screen was
 * mounted — which is almost never, because the point of the vault is that
 * other screens use it. Everywhere else, "the vault locked" zeroed a key in
 * main and left every decrypted entry, passwords and private keys included,
 * sitting in this store with `unlocked: true`.
 *
 * That matters more now, not less: securing the vault KEEPS the key in main so
 * background work carries on, which means the renderer's copy is the only
 * thing the timer still takes away. If this test fails, the idle timeout
 * protects nothing at all.
 *
 * No component is rendered here on purpose. That is the condition under test.
 */

const entry = {
  id: 'v1',
  name: 'Prod',
  kind: 'login' as const,
  url: '',
  username: 'deploy',
  password: 'hunter2',
  notes: '',
  tags: [],
  fields: [],
  createdAt: '',
  updatedAt: ''
}

let fireSecured: (() => void) | null = null
let fireLocked: (() => void) | null = null

beforeEach(() => {
  fireSecured = null
  fireLocked = null
  stubBridge({
    vault: {
      onSecured: vi.fn((cb: () => void) => {
        fireSecured = cb
        return () => {}
      }),
      onAutoLocked: vi.fn((cb: () => void) => {
        fireLocked = cb
        return () => {}
      })
    }
  })
  useVault.setState({ exists: true, unlocked: true, stage: 'open', entries: [entry], selectedId: 'v1' })
})

describe('when main secures or locks the vault', () => {
  it('empties the renderer store with no vault view mounted', () => {
    const stop = startVaultLockWatch()
    expect(useVault.getState().entries).toHaveLength(1)

    act(() => fireSecured?.())

    expect(useVault.getState().entries).toEqual([])
    expect(useVault.getState().selectedId).toBeNull()
    // `unlocked` in the renderer means "the entries are readable here", and
    // after this they are not. Main's own `unlocked` stays true, which is what
    // keeps monitoring and scheduled work running.
    expect(useVault.getState().unlocked).toBe(false)
    expect(useVault.getState().stage).toBe('secured')
    stop()
  })

  it('does the same on a full lock, and says so differently', () => {
    const stop = startVaultLockWatch()
    act(() => fireLocked?.())

    expect(useVault.getState().entries).toEqual([])
    expect(useVault.getState().stage).toBe('locked')
    stop()
  })

  it('refuses to write a new entry while secured', async () => {
    const stop = startVaultLockWatch()
    act(() => fireSecured?.())

    // Every mutator in this store appends to `entries` and saves the whole
    // list back. While secured that list is empty, so an unguarded write would
    // persist a vault containing one entry and nothing else. Main refuses it
    // too; this is the guard that stops the renderer believing it worked.
    const id = await useVault.getState().createEntry('login', { name: 'New' })
    expect(id).toBeNull()
    expect(useVault.getState().entries).toEqual([])
    stop()
  })
})
