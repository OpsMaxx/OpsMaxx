// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { defaults, type Folder, type HttpRequest } from '../src/shared/apiModel'
import { httpPaletteCommands } from '../src/renderer/src/components/http/paletteCommands'
import { CommandPalette } from '../src/renderer/src/components/palette/CommandPalette'
import { registerHttpHotkeys, useHttp } from '../src/renderer/src/store/http'
import { useApi } from '../src/renderer/src/store/api'
import { useApp } from '../src/renderer/src/store/app'
import { useNav } from '../src/renderer/src/store/nav'
import { useToasts } from '../src/renderer/src/store/toast'

// The HTTP client in the command palette (§2.7.4).

const cmds = (): ReturnType<typeof httpPaletteCommands> => httpPaletteCommands(useApp.getState())
const titled = (title: string): ReturnType<typeof httpPaletteCommands>[number] | undefined =>
  cmds().find((c) => c.title === title)

describe('httpPaletteCommands', () => {
  it('offers the actions from anywhere, and takes the user to the HTTP client', () => {
    useApp.setState({ activity: 'connections' })
    for (const title of [
      'New HTTP Request',
      'New WebSocket',
      'New GraphQL Request',
      'New Collection',
      'Import…',
      'Switch Environment…',
      'Manage Environments',
      'Cookies…',
      'Show Keyboard Shortcuts'
    ]) {
      expect(titled(title), title).toBeDefined()
    }
    titled('New WebSocket')!.run()
    expect(useApp.getState().activity).toBe('http')
    expect(useHttp.getState().tabs[0].draft?.kind).toBe('ws')
  })

  it('opens the overlays and tabs it names', () => {
    titled('Cookies…')!.run()
    expect(useHttp.getState().overlay).toBe('cookies')
    titled('Import…')!.run()
    expect(useHttp.getState().overlay).toBe('import')
    titled('Manage Environments')!.run()
    expect(useHttp.getState().tabs.at(-1)?.kind).toBe('environments')
    titled('Show Keyboard Shortcuts')!.run()
    expect(useNav.getState().settingsSection).toBe('shortcuts')
  })

  it('offers tab actions only in the HTTP client with its workbench mounted', () => {
    useApp.setState({ activity: 'http' })
    expect(titled('Send')).toBeUndefined()
    const send = vi.fn(() => true)
    registerHttpHotkeys({ 'http-send': send, 'http-toggle-response': () => true })
    titled('Send')!.run()
    expect(send).toHaveBeenCalledOnce()
    expect(titled('Toggle Response')).toBeDefined()
    useApp.setState({ activity: 'connections' })
    expect(titled('Send')).toBeUndefined()
  })

  it('lists every saved request by collection / folder / name, with its URL', () => {
    const col = useApi.getState().createCollection('httpbin')
    const req: HttpRequest = { ...defaults.http(), name: 'Get user', method: 'GET', url: '{{baseUrl}}/users/:id' }
    const folder: Folder = { kind: 'folder', id: 'fld_users', name: 'users', items: [req] }
    useApi.getState().addItem(col, null, folder)
    const cmd = titled('httpbin / users / Get user')!
    expect(cmd.sub).toBe('GET {{baseUrl}}/users/:id')
    cmd.run()
    expect(useHttp.getState().tabs[0].ref).toEqual({ collectionId: col, requestId: req.id })
  })

  it('switches environment by name', () => {
    const ws = useApp.getState().activeWorkspaceId
    useApi
      .getState()
      .setEnvironment({ id: 'env_prod', workspaceId: ws, name: 'prod', color: 'rust', production: true, variables: [] })
    useApi
      .getState()
      .setEnvironment({
        id: 'env_x',
        workspaceId: 'ws-other',
        name: 'elsewhere',
        color: 'blue',
        production: false,
        variables: []
      })
    expect(titled('Use Environment: elsewhere')).toBeUndefined()
    titled('Use Environment: prod')!.run()
    expect(useApi.getState().workspace.activeEnvironment[ws]).toBe('env_prod')
  })
})

describe('CommandPalette', () => {
  it('carries the HTTP commands', () => {
    render(<CommandPalette />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New GraphQL' } })
    expect(screen.getAllByText('New GraphQL Request').length).toBeGreaterThan(0)
  })
})

describe('Recover pre-upgrade HTTP data', () => {
  it('is offered only while the pre-upgrade copy is kept, and re-runs the migration', () => {
    expect(titled('Recover Pre-upgrade HTTP Data…')).toBeUndefined()
    const recoverLegacy = vi.fn(() => ['col_r', 'col_s'])
    useApi.setState({ legacy: { version: 1 }, recoverLegacy })
    titled('Recover Pre-upgrade HTTP Data…')!.run()
    expect(recoverLegacy).toHaveBeenCalledOnce()
    expect(useToasts.getState().toasts.at(-1)?.message).toBe('Recovered 2 collections from before the upgrade.')
  })
})
