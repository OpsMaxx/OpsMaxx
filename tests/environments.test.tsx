// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaults, type ApiCollectionV2, type Environment } from '../src/shared/apiModel'
import { globalsReviewKey, useApi } from '../src/renderer/src/store/api'
import { useApp } from '../src/renderer/src/store/app'
import { useHttp } from '../src/renderer/src/store/http'
import { EnvironmentsTab, openEnvironmentsTab } from '../src/renderer/src/components/http/env/EnvironmentsTab'
import { EnvironmentPicker } from '../src/renderer/src/components/http/env/EnvironmentPicker'
import { CREDENTIAL_WARNING, credentialVariables } from '../src/renderer/src/components/http/env/VariablesTable'

const ws = (): string => useApp.getState().activeWorkspaceId
const env = (id: string, name: string, extra: Partial<Environment> = {}): Environment => ({
  id,
  workspaceId: ws(),
  name,
  color: 'blue',
  production: false,
  variables: [],
  ...extra
})

describe('EnvironmentsTab', () => {
  it('creates an environment and ticks Production when it is renamed to one', async () => {
    render(<EnvironmentsTab tabId="tab_env" />)
    await userEvent.click(screen.getByRole('button', { name: /New/ }))
    const envs = useApi.getState().workspace.environments
    expect(envs.map((e) => [e.name, e.production])).toEqual([['New environment', false]])
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'prod-eu' } })
    expect(useApi.getState().workspace.environments[0].production).toBe(true)
    expect(screen.getAllByText('PROD').length).toBeGreaterThan(0)
  })

  it('asks before deleting an environment', async () => {
    useApi.getState().setEnvironment(env('env_a', 'staging', { variables: [{ id: 'var_1', key: 'k', value: 'v', enabled: true }] }))
    render(<EnvironmentsTab tabId="tab_env" />)
    await userEvent.click(screen.getByRole('option', { name: /staging/ }))
    await userEvent.click(screen.getByLabelText('Delete environment'))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/Its 1 variable is deleted/)).toBeTruthy()
    expect(useApi.getState().workspace.environments).toHaveLength(1)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete environment' }))
    expect(useApi.getState().workspace.environments).toHaveLength(0)
  })

  it('keeps the active environment per workspace', async () => {
    const api = useApi.getState()
    api.setEnvironment(env('env_a', 'staging'))
    api.setEnvironment({ ...env('env_b', 'other'), workspaceId: 'ws_other' })
    api.setActiveEnvironment('ws_other', 'env_b')
    render(<EnvironmentPicker />)
    await userEvent.click(screen.getByRole('button', { name: 'Environment: No environment' }))
    expect(screen.getAllByRole('menuitemradio').map((m) => m.querySelector('span:not([aria-hidden])')?.textContent)).toEqual([
      'No environment',
      'staging'
    ])
    expect(screen.getByRole('menuitemradio', { name: 'No environment' }).getAttribute('aria-checked')).toBe('true')
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'staging' }))
    const active = useApi.getState().workspace.activeEnvironment
    expect(active[ws()]).toBe('env_a')
    expect(active['ws_other']).toBe('env_b')
  })

  it('shows PROD beside a production environment in the picker', () => {
    const api = useApi.getState()
    api.setEnvironment(env('env_p', 'live', { production: true }))
    api.setActiveEnvironment(ws(), 'env_p')
    render(<EnvironmentPicker compact />)
    expect(screen.getByRole('button', { name: 'Environment: live, production' }).textContent).toContain('PROD')
  })

  it('warns about a credential kept as a literal, and offers Move to vault', () => {
    const c: ApiCollectionV2 = {
      ...defaults.collection(ws(), 'c'),
      items: [{ ...defaults.http(), auth: { type: 'bearer', token: '{{token}}' }, headers: [{ id: 'row_1', enabled: true, key: 'X-Api-Key', value: '{{apiKey}}' }] }]
    }
    useApi.setState({ collections: [c] })
    expect([...credentialVariables([c])].sort()).toEqual(['apiKey', 'token'])
    useApi.getState().setEnvironment(
      env('env_a', 'staging', {
        variables: [
          { id: 'var_1', key: 'token', value: 'eyJ.literal', enabled: true },
          { id: 'var_2', key: 'apiKey', value: 'vault:v1#password', enabled: true },
          { id: 'var_3', key: 'host', value: 'example.com', enabled: true }
        ]
      })
    )
    render(<EnvironmentsTab tabId="tab_env" />)
    fireEvent.click(screen.getByRole('option', { name: /staging/ }))
    expect(screen.getAllByRole('img', { name: CREDENTIAL_WARNING })).toHaveLength(1)
    fireEvent.contextMenu(screen.getByLabelText('Variable, token'))
    expect(screen.getByRole('menuitem', { name: 'Move to vault…' })).toBeTruthy()
  })

  it('opens one Environments tab per workspace', () => {
    const a = openEnvironmentsTab()
    const b = openEnvironmentsTab()
    expect(a).toBe(b)
    expect(useHttp.getState().tabs.filter((t) => t.kind === 'environments')).toHaveLength(1)
  })
})

describe('overridden variables', () => {
  it('strikes a global through when the active environment defines it', () => {
    useApi.getState().setGlobals(ws(), [{ id: 'var_g', key: 'baseUrl', value: 'https://g', enabled: true }])
    useApi.getState().setEnvironment(env('env_a', 'staging', { variables: [{ id: 'var_e', key: 'baseUrl', value: 'https://e', enabled: true }] }))
    useApi.getState().setActiveEnvironment(ws(), 'env_a')
    render(<EnvironmentsTab tabId="tab_env" />)
    const cell = screen.getByLabelText('Value, baseUrl').closest('.hc-overridden')!
    expect(cell.getAttribute('title')).toBe('Overridden by environment staging')
  })
})

describe('EnvironmentPicker and ⌘E', () => {
  it('opens its menu when the workbench asks, and clears the request when it closes', async () => {
    render(<EnvironmentPicker />)
    act(() => useHttp.getState().setOverlay('env'))
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(useHttp.getState().overlay).toBe('env')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(useHttp.getState().overlay).toBeNull()
  })
})

describe('environment review (synced changes held until accepted)', () => {
  it('shows a banner on a pending environment, names the variables but not their values, and accepts', async () => {
    const api = useApi.getState()
    api.setEnvironment(env('env_a', 'staging', { variables: [{ id: 'v1', key: 'token', value: 's3cret-value', enabled: true }] }))
    api.setActiveEnvironment(ws(), 'env_a')
    const acceptEnvReview = vi.fn((key: string) => useApi.setState((s) => ({ envReview: s.envReview.filter((k) => k !== key) })))
    useApi.setState({ envReview: ['env_a'], acceptEnvReview } as never)
    render(<EnvironmentsTab tabId="tab_env" />)
    // Opens on the pending active environment.
    expect(screen.getByRole('option', { name: /staging/ }).getAttribute('aria-selected')).toBe('true')
    const banner = screen.getByRole('note')
    expect(banner.textContent).toMatch(/changed on another device/)
    expect(banner.textContent).toContain('1 variable: token')
    expect(banner.textContent).not.toContain('s3cret-value')
    await userEvent.click(screen.getByRole('button', { name: 'Accept these variables' }))
    expect(acceptEnvReview).toHaveBeenCalledWith('env_a')
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('holds the globals by their own key', async () => {
    useApi.getState().setGlobals(ws(), [{ id: 'g1', key: 'baseUrl', value: 'x', enabled: true }])
    const acceptEnvReview = vi.fn()
    useApi.setState({ envReview: [globalsReviewKey(ws())], acceptEnvReview } as never)
    render(<EnvironmentsTab tabId="tab_env" />)
    expect(screen.getByRole('option', { name: /Globals/ }).textContent).toContain('review')
    await userEvent.click(screen.getByRole('button', { name: 'Accept these variables' }))
    expect(acceptEnvReview).toHaveBeenCalledWith(globalsReviewKey(ws()))
  })

  it('marks a pending environment in the picker', async () => {
    const api = useApi.getState()
    api.setEnvironment(env('env_a', 'staging'))
    api.setActiveEnvironment(ws(), 'env_a')
    useApi.setState({ envReview: ['env_a'] })
    render(<EnvironmentPicker />)
    const button = screen.getByRole('button', { name: 'Environment: staging, needs review' })
    await userEvent.click(button)
    expect(screen.getByRole('menuitemradio', { name: 'staging · needs review' })).toBeTruthy()
  })
})
