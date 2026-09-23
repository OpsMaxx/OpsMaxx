// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useApi } from '../src/renderer/src/store/api'
import { useApp } from '../src/renderer/src/store/app'
import { useVault } from '../src/renderer/src/store/vault'
import { SetVariableDialog, looksLikeCredential } from '../src/renderer/src/components/http/dialogs/SetVariableDialog'

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig-part'
const globals = (): { key: string; value: string }[] =>
  (useApi.getState().workspace.globals[useApp.getState().activeWorkspaceId] ?? []).map(({ key, value }) => ({ key, value }))

describe('Set as variable with a credential (M-b)', () => {
  it('recognises credentials by name or by shape, but not a vault reference', () => {
    expect(looksLikeCredential('access_token', 'abc')).toBe(true)
    expect(looksLikeCredential('x', JWT)).toBe(true)
    expect(looksLikeCredential('x', 'Bearer abcdefghijk')).toBe(true)
    expect(looksLikeCredential('userId', '42')).toBe(false)
    expect(looksLikeCredential('token', 'vault:v1#password')).toBe(false)
  })

  it('says a plain value is fine without a warning', () => {
    render(<SetVariableDialog initialName="userId" value="42" onClose={() => {}} />)
    expect(screen.queryByRole('note')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Store in vault…' })).toBeNull()
  })

  it('warns that a token is saved as plain text, and can store it in the vault instead', async () => {
    useVault.setState({
      exists: true,
      unlocked: true,
      stage: 'open',
      busy: false,
      error: null,
      createEntry: vi.fn(async () => 'v_tok')
    })
    const onClose = vi.fn()
    render(<SetVariableDialog initialName="access_token" value={JWT} onClose={onClose} />)
    expect(screen.getByRole('note').textContent).toMatch(/saved and synced as plain text/)
    await userEvent.click(screen.getByRole('button', { name: 'Store in vault…' }))
    await userEvent.click(screen.getByRole('button', { name: 'Move to vault' }))
    expect(useVault.getState().createEntry).toHaveBeenCalledWith('login', expect.objectContaining({ password: JWT }))
    expect(globals()).toEqual([{ key: 'access_token', value: 'vault:v_tok#password' }])
    expect(onClose).toHaveBeenCalled()
  })

  it('still lets the user keep it as plain text, knowingly', async () => {
    render(<SetVariableDialog initialName="access_token" value={JWT} onClose={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Set variable' }))
    expect(globals()).toEqual([{ key: 'access_token', value: JWT }])
  })
})
