// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { VaultView } from '../src/renderer/src/components/vault/VaultView'
import { useVault } from '../src/renderer/src/store/vault'

// The tags field re-joined the parsed list on every keystroke, so the comma
// that starts a second tag vanished the moment it was typed.

describe('the tags field', () => {
  it('keeps a typed comma so a second tag can follow', async () => {
    const entry = {
      id: 'k1',
      name: 'deploy key',
      kind: 'sshkey' as const,
      url: '',
      username: '',
      password: '',
      notes: '',
      tags: [],
      fields: [],
      createdAt: '',
      updatedAt: ''
    }
    stubBridge({
      vault: {
        status: async () => ({ exists: true, unlocked: true, stage: 'open' }),
        list: async () => ({ ok: true, entries: [entry] }),
        bioSupport: async () => ({ available: false, kind: 'none' }),
        bioEnabled: async () => false,
        bioScope: async () => null
      }
    } as never)
    const updateEntry = vi.fn(async () => true)
    useVault.setState({ exists: true, unlocked: true, stage: 'open', entries: [entry], selectedId: 'k1', updateEntry } as never)
    render(<VaultView />)

    const input = (await waitFor(() => screen.getByPlaceholderText('prod, aws'))) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'prod,' } })
    expect(input.value).toBe('prod,')
    fireEvent.change(input, { target: { value: 'prod, aws' } })
    expect(input.value).toBe('prod, aws')
    expect(updateEntry).toHaveBeenLastCalledWith('k1', { tags: ['prod', 'aws'] })
  })
})
