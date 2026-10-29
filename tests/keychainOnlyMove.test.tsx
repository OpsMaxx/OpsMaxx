// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { useApp } from '../src/renderer/src/store/app'
import { useVault } from '../src/renderer/src/store/vault'
import { KeychainOnly } from '../src/renderer/src/components/vault/KeychainOnly'

describe('connections whose credential is stored only on this computer', () => {
  it('offers to move them, reloads the vault copy first, then links the records', async () => {
    const order: string[] = []
    const moveToVault = vi.fn().mockResolvedValue({ ok: true, moved: [{ id: 's1', vaultEntryId: 'v-new' }], skipped: [] })
    const list = vi.fn(async () => (order.push('vault reloaded'), { ok: true, entries: [] }))
    stubBridge({
      secrets: { keychainOnly: vi.fn().mockResolvedValue(['s1']), moveToVault },
      vault: { status: vi.fn().mockResolvedValue({ exists: true, unlocked: true, stage: 'open' }), list }
    })
    useVault.setState({ stage: 'open', unlocked: true })
    useApp.setState({
      servers: [{ id: 's1', name: 'Chain305', host: 'h', port: 22, username: 'root' } as never],
      databases: []
    })
    const link = useApp.getState().linkVaultEntries
    useApp.setState({ linkVaultEntries: (l) => (order.push('linked'), link(l)) })

    render(<KeychainOnly />)
    fireEvent.click(await screen.findByRole('button', { name: /Move into the vault/ }))
    await waitFor(() => expect(useApp.getState().servers[0]!.vaultEntryId).toBe('v-new'))
    expect(moveToVault).toHaveBeenCalledWith(['s1'])
    // The vault store saves its whole list back on the next edit; a copy that
    // missed the new entry would erase it.
    expect(order).toEqual(['vault reloaded', 'linked'])
  })

  it('says nothing when every credential is already in the vault', async () => {
    const keychainOnly = vi.fn().mockResolvedValue([])
    stubBridge({ secrets: { keychainOnly } })
    useApp.setState({ servers: [{ id: 's1', name: 'x' } as never], databases: [] })
    const { container } = render(<KeychainOnly />)
    await waitFor(() => expect(keychainOnly).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })
})
