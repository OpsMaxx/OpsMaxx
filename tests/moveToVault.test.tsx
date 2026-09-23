// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useVault } from '../src/renderer/src/store/vault'
import { MoveToVaultDialog } from '../src/renderer/src/components/http/dialogs/MoveToVaultDialog'

function vault(state: { exists: boolean; unlocked: boolean }): {
  create: ReturnType<typeof vi.fn>
  unlock: ReturnType<typeof vi.fn>
  createEntry: ReturnType<typeof vi.fn>
} {
  const open = (): void => useVault.setState({ exists: true, unlocked: true, stage: 'open' })
  const create = vi.fn(async () => (open(), true))
  const unlock = vi.fn(async () => (open(), true))
  const createEntry = vi.fn(async () => 'v_new')
  useVault.setState({ ...state, stage: state.unlocked ? 'open' : 'locked', busy: false, error: null, create, unlock, createEntry })
  return { create, unlock, createEntry }
}

function open(): { onMoved: ReturnType<typeof vi.fn> } {
  const onMoved = vi.fn()
  render(<MoveToVaultDialog defaultName="httpbin · token" value="s3cret" onMoved={onMoved} onClose={() => {}} />)
  return { onMoved }
}

describe('Move to vault', () => {
  it('stores the value in an open vault and hands back a reference', async () => {
    const v = vault({ exists: true, unlocked: true })
    const { onMoved } = open()
    expect((screen.getByLabelText('Entry name') as HTMLInputElement).value).toBe('httpbin · token')
    await userEvent.click(screen.getByRole('button', { name: 'Move to vault' }))
    expect(v.createEntry).toHaveBeenCalledWith('login', expect.objectContaining({ name: 'httpbin · token', password: 's3cret' }))
    expect(onMoved).toHaveBeenCalledWith('vault:v_new#password')
  })

  it('unlocks a closed vault in the same dialog', async () => {
    const v = vault({ exists: true, unlocked: false })
    const { onMoved } = open()
    const go = screen.getByRole('button', { name: 'Unlock and move' })
    expect((go as HTMLButtonElement).disabled).toBe(true)
    await userEvent.type(screen.getByLabelText(/^Vault password/), 'master-pass')
    await userEvent.click(go)
    expect(v.unlock).toHaveBeenCalledWith('master-pass')
    expect(v.createEntry).toHaveBeenCalledOnce()
    expect(onMoved).toHaveBeenCalledWith('vault:v_new#password')
  })

  it('creates the vault when there is none, with a long enough password', async () => {
    const v = vault({ exists: false, unlocked: false })
    const { onMoved } = open()
    const go = screen.getByRole('button', { name: 'Create vault and move' })
    await userEvent.type(screen.getByLabelText(/^Master password(?! again)/), 'short')
    expect(screen.getByText(/At least 12 characters/)).toBeTruthy()
    await userEvent.clear(screen.getByLabelText(/^Master password(?! again)/))
    await userEvent.type(screen.getByLabelText(/^Master password(?! again)/), 'a long master password')
    await userEvent.type(screen.getByLabelText(/^Master password again/), 'a long master password')
    await userEvent.click(go)
    expect(v.create).toHaveBeenCalledWith('a long master password')
    expect(onMoved).toHaveBeenCalledWith('vault:v_new#password')
  })

  it('does not report a move the vault refused', async () => {
    const v = vault({ exists: true, unlocked: true })
    v.createEntry.mockResolvedValueOnce(null)
    const { onMoved } = open()
    await userEvent.click(screen.getByRole('button', { name: 'Move to vault' }))
    expect(onMoved).not.toHaveBeenCalled()
    expect(screen.getByText('The value could not be stored in the vault.')).toBeTruthy()
  })
})
