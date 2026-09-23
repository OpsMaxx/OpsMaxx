// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { MigrationReport } from '../src/shared/apiMigration'
import { UpgradeBanner } from '../src/renderer/src/components/http/UpgradeBanner'
import { useApi } from '../src/renderer/src/store/api'
import { useHttp } from '../src/renderer/src/store/http'

// The one-time banner after the v1 → v2 migration (§2.10, UX-M16).

const report = (patch: Partial<MigrationReport> = {}): MigrationReport => ({
  id: 'mig-1',
  collections: 3,
  requests: 41,
  environments: 2,
  needsReimport: [],
  dropped: ['cookies', 'auth'],
  rejected: [],
  baseUrlCollisions: [],
  shedForCap: [],
  ...patch
})

describe('UpgradeBanner', () => {
  it('says what moved over and what did not', () => {
    useApi.setState({ report: report() })
    render(<UpgradeBanner />)
    const text = screen.getByRole('status').textContent
    expect(text).toContain('3 collections, 41 requests and 2 environments moved over.')
    expect(text).toContain('Cookies from the old client were cleared.')
    // v1 never saved typed credentials, so there is nothing to say about them.
    expect(text).not.toContain('Auth panel')
  })

  it('names only what there was: an environments-only upgrade is not “0 collections”', () => {
    useApi.setState({ report: report({ collections: 0, requests: 0, environments: 1 }) })
    render(<UpgradeBanner />)
    const text = screen.getByRole('status').textContent
    expect(text).toContain('1 environment moved over.')
    expect(text).not.toContain('0 ')
  })

  it('does not count a collection that needs re-importing as moved over', () => {
    useApi.setState({
      report: report({
        collections: 2,
        requests: 4,
        environments: 0,
        needsReimport: [{ id: 'col_a', name: 'billing' }]
      })
    })
    render(<UpgradeBanner />)
    expect(screen.getByRole('status').textContent).toContain('1 collection and 4 requests moved over.')
    act(() =>
      useApi.setState({
        report: report({
          collections: 1,
          requests: 0,
          environments: 0,
          needsReimport: [{ id: 'col_a', name: 'billing' }]
        })
      })
    )
    expect(screen.getByRole('status').textContent).not.toContain('moved over')
  })

  it('says how many saved items could not be converted', () => {
    useApi.setState({
      report: report({
        collections: 0,
        requests: 0,
        environments: 0,
        rejected: [
          { kind: 'collection', id: '__proto__', reason: 'invalid id' },
          { kind: 'environment', id: 'x y', reason: 'invalid id' }
        ]
      })
    })
    render(<UpgradeBanner onRecover={() => undefined} />)
    expect(screen.getByRole('status').textContent).toContain(
      '2 saved items could not be converted and were kept aside.'
    )
    expect(screen.getByRole('button', { name: 'Recover old data…' })).toBeTruthy()
  })

  it('lists every collection that needs re-importing, each with its own button', () => {
    useApi.setState({
      report: report({
        needsReimport: [
          { id: 'col_a', name: 'billing' },
          { id: 'col_b', name: 'petstore' }
        ]
      })
    })
    render(<UpgradeBanner />)
    expect(screen.getByText(/billing/)).toBeTruthy()
    const buttons = screen.getAllByRole('button', { name: 'Re-import' })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[1])
    expect(useHttp.getState()).toMatchObject({ overlay: 'import', importTarget: 'col_b' })
  })

  it('warns once per baseUrl collision, naming the environment, the collection and the value', () => {
    const col = useApi.getState().createCollection('httpbin')
    useApi.setState({
      report: report({
        baseUrlCollisions: [{ collectionId: col, environment: 'prod', value: 'https://api.example.com' }]
      })
    })
    render(<UpgradeBanner />)
    expect(screen.getByRole('status').textContent).toContain(
      'Environment prod also defines baseUrl. Requests in httpbin will use the environment’s value (https://api.example.com) while prod is active.'
    )
  })

  it('offers recovery when the workbench wires it', () => {
    useApi.setState({ report: report() })
    const onRecover = vi.fn()
    render(<UpgradeBanner onRecover={onRecover} />)
    fireEvent.click(screen.getByRole('button', { name: 'Recover old data…' }))
    expect(onRecover).toHaveBeenCalledOnce()
  })

  it('stays dismissed for that report, and the dismissal is part of the saved session', () => {
    useApi.setState({ report: report() })
    const { container, rerender } = render(<UpgradeBanner />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(container.textContent).toBe('')
    expect(useHttp.getState().getHttpSession().bannerDismissed).toBe('mig-1')
    // A later migration's report is news again.
    useApi.setState({ report: report({ id: 'mig-2' }) })
    rerender(<UpgradeBanner />)
    expect(screen.getByRole('status')).toBeTruthy()
  })

  it('shows nothing for an empty or absent report', () => {
    useApi.setState({ report: report({ collections: 0, requests: 0, environments: 0 }) })
    const { container } = render(<UpgradeBanner />)
    expect(container.textContent).toBe('')
  })
})
