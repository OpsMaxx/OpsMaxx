// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaults, type ApiCollectionV2 } from '../src/shared/apiModel'
import { useApi } from '../src/renderer/src/store/api'
import { useApp } from '../src/renderer/src/store/app'
import { stubBridge } from './setup/renderer'
import { CollectionTab } from '../src/renderer/src/components/http/collection/CollectionTab'
import { useHttp } from '../src/renderer/src/store/http'

const CERT = '-----BEGIN CERTIFICATE-----\nMIIBabc\n-----END CERTIFICATE-----'
const KEY = '-----BEGIN PRIVATE KEY-----\nMIIEabc\n-----END PRIVATE KEY-----'

function seed(extra: Partial<ApiCollectionV2> = {}): ApiCollectionV2 {
  const c = { ...defaults.collection(useApp.getState().activeWorkspaceId, 'httpbin'), id: 'col_a', ...extra }
  useApi.setState({ collections: [c] })
  return c
}
const tabFor = (section?: 'connection'): string => useHttp.getState().openCollectionTab('col_a', section)
const col = (): ApiCollectionV2 => useApi.getState().collections[0]

async function connection(): Promise<void> {
  render(<CollectionTab tabId={tabFor()} />)
  await userEvent.click(screen.getByRole('tab', { name: /Connection/ }))
}

describe('CollectionTab › Connection', () => {
  it('asks before turning certificate verification off, not before turning it on', async () => {
    seed()
    await connection()
    await userEvent.click(screen.getByLabelText('Verify certificates'))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Stop verifying certificates for httpbin?')).toBeTruthy()
    expect(col().insecureTls).toBe(false)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop verifying' }))
    expect(col().insecureTls).toBe(true)
    expect(screen.getByText(/NOT verified/)).toBeTruthy()
    await userEvent.click(screen.getByLabelText('Verify certificates'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(col().insecureTls).toBe(false)
  })

  it('reads a CA through chooseCaFile and sets it only after a confirm', async () => {
    const chooseCaFile = vi.fn(async () => ({ pem: `${CERT}\n` }))
    stubBridge({ http: { chooseCaFile } })
    seed()
    await connection()
    await userEvent.click(screen.getByRole('button', { name: 'Choose file…' }))
    expect(chooseCaFile).toHaveBeenCalledOnce()
    const dialog = await screen.findByRole('dialog')
    expect(col().caPem).toBeUndefined()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Trust this CA' }))
    expect(col().caPem).toBe(`${CERT}\n`)
    expect(screen.getByText(/Custom CA set \(1 certificate\)/)).toBeTruthy()
  })

  it('shows the error main returns for a file with a key', async () => {
    stubBridge({ http: { chooseCaFile: vi.fn(async () => ({ error: 'That file holds a private key.' })) } })
    seed()
    await connection()
    await userEvent.click(screen.getByRole('button', { name: 'Choose file…' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('That file holds a private key.'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('refuses a pasted PEM containing a private key', async () => {
    seed()
    await connection()
    fireEvent.change(screen.getByLabelText('Paste a CA certificate (PEM)'), { target: { value: `${CERT}\n${KEY}` } })
    await userEvent.click(screen.getByRole('button', { name: 'Use pasted certificate' }))
    expect(screen.getByRole('alert').textContent).toMatch(/private key/)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(col().caPem).toBeUndefined()
  })

  it('routes through a saved server by writing the collection route', async () => {
    useApp.setState({ servers: [{ id: 'srv_1', name: 'web-01', workspaceId: useApp.getState().activeWorkspaceId, tags: [] }] } as never)
    seed()
    await connection()
    await userEvent.selectOptions(screen.getByLabelText('Send from'), 'server:srv_1')
    expect([col().viaServerId, col().vpnProfileId]).toEqual(['srv_1', null])
  })

  it('raises the sync review banner; Review shows Connection, and only Accept releases the collection', async () => {
    seed({ tlsReview: true })
    render(<CollectionTab tabId={tabFor()} />)
    expect(screen.getByRole('status').textContent).toMatch(/changed on another device/)
    await userEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(screen.getByRole('tab', { name: /Connection/ }).getAttribute('aria-selected')).toBe('true')
    expect(col().tlsReview).toBe(true)
    const accept = vi.spyOn(useApi.getState(), 'acceptTlsReview')
    await userEvent.click(screen.getByRole('button', { name: 'Accept these settings' }))
    expect(accept).toHaveBeenCalledWith('col_a')
    expect(col().tlsReview).toBe(false)
  })
})

describe('CollectionTab sections', () => {
  it('opens on the section it was asked for', () => {
    seed()
    render(<CollectionTab tabId={tabFor('connection')} />)
    expect(screen.getByRole('tab', { name: /Connection/ }).getAttribute('aria-selected')).toBe('true')
  })
})
