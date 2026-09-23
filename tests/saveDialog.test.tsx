// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaults, type ApiCollectionV2 } from '../src/shared/apiModel'
import { useApi } from '../src/renderer/src/store/api'
import { useApp } from '../src/renderer/src/store/app'
import { SaveRequestDialog } from '../src/renderer/src/components/http/dialogs/SaveRequestDialog'
import { useHttp } from '../src/renderer/src/store/http'

function seed(): void {
  const ws = useApp.getState().activeWorkspaceId
  useApp.setState({
    servers: [
      { id: 'srv_web', name: 'web-01', workspaceId: ws, tags: [] },
      { id: 'srv_bastion', name: 'bastion', workspaceId: ws, tags: [] }
    ]
  } as never)
  const a: ApiCollectionV2 = { ...defaults.collection(ws, 'httpbin'), id: 'col_a', viaServerId: 'srv_web' }
  const b: ApiCollectionV2 = { ...defaults.collection(ws, 'insecure'), id: 'col_b', insecureTls: true, caPem: 'x' }
  useApi.setState({ collections: [a, b] })
}

const request = { ...defaults.http(), id: 'req_s', name: 'GET /users', url: 'https://api.example/users' }

describe('SaveRequestDialog', () => {
  it('names the connection the destination will send from, against the one this request used', async () => {
    seed()
    render(<SaveRequestDialog request={request} route={{ kind: 'direct' }} onSaved={() => {}} onClose={() => {}} />)
    const line = (): string => document.querySelector('.hc-effective')!.textContent!
    expect(line()).toBe('Sends from web-01 (collection setting) — this request used This machine')
    await userEvent.selectOptions(screen.getByLabelText('Save to'), 'insecure')
    expect(line()).toBe('Sends from This machine (collection setting)')
    expect(screen.getByText('This collection does not verify certificates')).toBeTruthy()
    expect(screen.getByText('Uses a custom CA')).toBeTruthy()
  })

  it('saves into the chosen collection with a fresh id', async () => {
    seed()
    const onSaved = vi.fn()
    render(<SaveRequestDialog request={request} route={{ kind: 'direct' }} onSaved={onSaved} onClose={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    const saved = useApi.getState().collections[0].items[0]
    expect(saved.name).toBe('GET /users')
    expect(saved.id).not.toBe('req_s')
    expect(onSaved).toHaveBeenCalledWith({ collectionId: 'col_a', requestId: saved.id })
  })

  it('makes a new collection that inherits the scratch route', async () => {
    seed()
    render(
      <SaveRequestDialog request={request} route={{ kind: 'server', serverId: 'srv_bastion' }} onSaved={() => {}} onClose={() => {}} />
    )
    await userEvent.selectOptions(screen.getByLabelText('Save to'), 'New collection…')
    expect(document.querySelector('.hc-effective')!.textContent).toBe('Sends from bastion, which the new collection keeps')
    await userEvent.type(screen.getByLabelText(/^New collection name/), 'admin api')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    const made = useApi.getState().collections.find((c) => c.name === 'admin api')!
    expect(made.viaServerId).toBe('srv_bastion')
    expect(made.items.map((i) => i.name)).toEqual(['GET /users'])
  })
})

describe('SaveRequestDialog for a workbench tab', () => {
  it('turns the scratch tab into the saved request', async () => {
    seed()
    const tabId = useHttp.getState().openScratch('http', request, { route: { kind: 'server', serverId: 'srv_bastion' } })
    render(<SaveRequestDialog tabId={tabId} onClose={() => {}} />)
    expect(document.querySelector('.hc-effective')!.textContent).toBe('Sends from web-01 (collection setting) — this request used bastion')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    const tab = useHttp.getState().tabs.find((t) => t.id === tabId)!
    const saved = useApi.getState().collections[0].items[0]
    expect(tab.ref).toEqual({ collectionId: 'col_a', requestId: saved.id })
    expect(tab.draft).toBeUndefined()
  })
})
