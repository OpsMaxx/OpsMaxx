// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { WorkspaceManager } from '../src/renderer/src/components/workspace/WorkspaceManager'
import { useApp } from '../src/renderer/src/store/app'

// Renaming a workspace from the Workspaces dialog. A password-protected one
// that is locked keeps its name until someone with the password opens it.

beforeEach(() => {
  stubBridge({})
  useApp.setState({
    workspaces: [
      { id: 'w1', name: 'Prod', color: 'green', hidden: false, locked: false, hasPassword: false },
      { id: 'w2', name: 'Vault', color: 'red', hidden: false, locked: false, hasPassword: true }
    ],
    unlockedWorkspaces: []
  } as never)
})

describe('renaming a workspace', () => {
  it('renames from the row', async () => {
    render(<WorkspaceManager />)
    await userEvent.click(screen.getByTitle('Rename'))
    const input = screen.getByRole('textbox', { name: 'Workspace name' }) as HTMLInputElement
    expect(input.value).toBe('Prod')
    await userEvent.clear(input)
    await userEvent.type(input, 'Production{Enter}')
    expect(useApp.getState().workspaces[0].name).toBe('Production')
  })

  it('is not offered for a locked workspace until it is unlocked', () => {
    render(<WorkspaceManager />)
    expect((screen.getByTitle('Unlock Vault to rename it.') as HTMLButtonElement).disabled).toBe(true)
  })
})
