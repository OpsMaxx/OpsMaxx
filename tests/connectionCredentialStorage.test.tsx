// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { AddServerModal } from '../src/renderer/src/components/connections/AddServerModal'
import { AddDatabaseModal } from '../src/renderer/src/components/databases/AddDatabaseModal'
import { useApp } from '../src/renderer/src/store/app'
import { useVault } from '../src/renderer/src/store/vault'
import { useVaultPrompt } from '../src/renderer/src/store/vaultPrompt'
import { stubBridge } from './setup/renderer'

const password = 'test credential'

function prepare(hasVault: boolean) {
  const set = vi.fn(async (_id: string, _value: string) => true)
  const request = vi.fn(async () => false)
  stubBridge({ secrets: { set }, ssh: { defaultKeys: async () => [] } })
  useVault.setState({ exists: hasVault })
  useVaultPrompt.setState({ request })
  return { set, request }
}

it('saves a password from the SSH editor in secure storage when no vault exists', async () => {
  const { set, request } = prepare(false)
  const user = userEvent.setup()
  render(<AddServerModal />)
  await user.type(screen.getByPlaceholderText('Production API'), 'Test SSH')
  await user.type(screen.getByPlaceholderText('10.20.0.10'), 'ssh.example')
  await user.click(screen.getByRole('button', { name: 'Password' }))
  await user.type(document.querySelector<HTMLInputElement>('input[type="password"]')!, password)
  await user.click(screen.getByRole('button', { name: 'Add Server' }))
  await waitFor(() => expect(set).toHaveBeenCalledWith(expect.any(String), JSON.stringify({ password })))
  expect(request).not.toHaveBeenCalled()
})

it('honours the keychain preference in the database editor even with an existing vault', async () => {
  const { set, request } = prepare(true)
  useApp.getState().setSettings({ preferVaultForNewCredentials: false })
  const user = userEvent.setup()
  render(<AddDatabaseModal />)
  await user.type(screen.getByPlaceholderText(/Production|Name|name/i), 'Test database')
  await user.type(document.querySelector<HTMLInputElement>('input[type="password"]')!, password)
  await user.click(screen.getByRole('button', { name: 'Add database' }))
  await waitFor(() => expect(set).toHaveBeenCalledWith(expect.any(String), JSON.stringify({ password })))
  expect(request).not.toHaveBeenCalled()
})
