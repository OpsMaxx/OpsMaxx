// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { stubBridge } from './setup/renderer'
import { useApp } from '../src/renderer/src/store/app'
import { useToasts } from '../src/renderer/src/store/toast'
import { AddServerModal } from '../src/renderer/src/components/connections/AddServerModal'
import { FolderSharesIndicator, FolderSharesSection } from '../src/renderer/src/components/panel/LocalMounts'
import type { Server } from '../src/renderer/src/types'
import { serverIdentity, type LocalShare, type MountsView } from '../src/shared/localMounts'

/**
 * Folder shares in the renderer: defined in the server editor like
 * `docker -v host:path:ro`, shown on the tab's view bar. What has to hold is
 * what a person cannot check anywhere else — read-only and mount-on-connect as
 * the defaults, why a mount failed without a toast on every reconnect, what to
 * do when no terminal is open or the server moved, and that a share is saved
 * through main and never onto the server record.
 */

const share: LocalShare = {
  id: 'sh1',
  localDir: '/Users/someone/site',
  mountpoint: '~/opsmaxx/site',
  readOnly: true,
  autoMount: true
}

function stub(view: Partial<MountsView> = {}) {
  const full: MountsView = { connected: true, shares: [], mounts: [], ...view }
  const api = {
    view: vi.fn(async (_serverId: string) => full),
    onChanged: vi.fn(() => () => {}),
    setShares: vi.fn(async (_serverId: string, _shares: LocalShare[], _identity: string) => ({ ok: true })),
    reenable: vi.fn(async (_serverId: string) => {}),
    mount: vi.fn(async (_serverId: string, _shareId: string) => ({ ok: true })),
    unmount: vi.fn(async (_serverId: string, _mountpoint: string) => true),
    pickFolder: vi.fn(async () => '/Users/someone/My Docs')
  }
  stubBridge({
    mounts: api,
    ssh: { defaultKeys: () => Promise.resolve([]) },
    secrets: { set: () => Promise.resolve(true), get: () => Promise.resolve(null), delete: () => Promise.resolve() }
  })
  return api
}

const server = { id: 's1', name: 'Box', username: 'deploy', host: '10.0.0.5', port: 22 } as unknown as Server
async function openIndicator(): Promise<void> {
  render(<FolderSharesIndicator server={server} />)
  const button = await screen.findByRole('button', { name: /Folder shares/ })
  await act(async () => fireEvent.click(button))
}
const mounted = { shareId: 'sh1', localDir: share.localDir, mountpoint: share.mountpoint, readOnly: true }

describe('the folder shares indicator', () => {
  it('names its state and that it opens a dialog', async () => {
    stub({ shares: [{ ...share, stale: false }], mounts: [{ ...mounted, state: 'mounted' }] })
    render(<FolderSharesIndicator server={server} />)
    const button = await screen.findByRole('button', { name: 'Folder shares: 1 folder from this computer mounted' })
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
  })

  it('shows a failed mount with its reason and fix, offers Retry, and raises no toast', async () => {
    stub({
      shares: [{ ...share, stale: false }],
      mounts: [
        {
          ...mounted,
          state: 'failed',
          error: 'sshfs is not installed on this server.',
          fix: 'Install it on the server: sudo apt install sshfs (Debian, Ubuntu) or sudo dnf install fuse-sshfs (Fedora, RHEL).'
        }
      ]
    })
    useToasts.setState({ toasts: [] })
    await openIndicator()
    expect(await screen.findByText('sshfs is not installed on this server.')).toBeTruthy()
    expect(screen.getByText(/sudo apt install sshfs/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry site' })).toBeTruthy()
    expect(useToasts.getState().toasts).toEqual([])
  })

  it('says when no terminal is open, and Mount explains instead of doing nothing', async () => {
    const api = stub({ connected: false, shares: [{ ...share, autoMount: false, stale: false }] })
    useToasts.setState({ toasts: [] })
    await openIndicator()
    expect(await screen.findByText(/No terminal open/)).toBeTruthy()
    const mount = screen.getByRole('button', { name: 'Mount site' })
    expect(mount.getAttribute('aria-disabled')).toBe('true')
    await act(async () => fireEvent.click(mount))
    expect(api.mount).not.toHaveBeenCalled()
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual([expect.stringMatching(/No terminal to this server is open/)])
  })

  it('shows Unmounting… while the unmount runs, and keeps the button explaining itself', async () => {
    stub({ shares: [{ ...share, stale: false }], mounts: [{ ...mounted, state: 'unmounting' }] })
    await openIndicator()
    expect(await screen.findByText(/Unmounting…/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Unmount site' }).getAttribute('aria-disabled')).toBe('true')
  })

  it('pauses shares on a server whose address changed, and re-enables them on request', async () => {
    const api = stub({ shares: [{ ...share, stale: true }] })
    await openIndicator()
    expect(await screen.findByText(/^Paused/)).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByText('Re-enable for this address')))
    expect(api.reenable).toHaveBeenCalledWith('s1')
  })

  it('opens the server editor on its Folder shares section', async () => {
    stub()
    useApp.setState({ servers: [server], modal: null, editServerId: null, editServerSection: null })
    await openIndicator()
    await act(async () => fireEvent.click(screen.getByText('Add a share…')))
    expect(useApp.getState()).toMatchObject({ modal: 'add-server', editServerId: 's1', editServerSection: 'shares' })
  })
})

describe('the Folder shares section of the server editor', () => {
  function Harness({ onShares, initial = [] }: { onShares: (s: LocalShare[]) => void; initial?: LocalShare[] }): React.JSX.Element {
    const [shares, setShares] = useState<LocalShare[]>(initial)
    return (
      <FolderSharesSection
        shares={shares}
        username="deploy"
        onChange={(next) => {
          setShares(next)
          onShares(next)
        }}
      />
    )
  }

  it('adds a share read-only, mounted on connect, at ~/opsmaxx/<folder>', async () => {
    stub()
    let latest: LocalShare[] = []
    render(<Harness onShares={(s) => (latest = s)} />)
    await act(async () => fireEvent.click(screen.getByText('Add folder share')))
    expect(latest[0]).toMatchObject({
      localDir: '/Users/someone/My Docs',
      mountpoint: '~/opsmaxx/My-Docs',
      readOnly: true,
      autoMount: true
    })
    expect(screen.getByText(/can read every file/)).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Access for My Docs'), { target: { value: 'rw' } })
    expect(latest[0].readOnly).toBe(false)
    expect(screen.getByText(/can change and delete files/)).toBeTruthy()
  })

  it('names every control after its folder, and marks the row that is wrong', () => {
    stub()
    const other = { ...share, id: 'sh2', localDir: '/Users/someone/blog' }
    render(<Harness onShares={() => {}} initial={[share, other]} />)
    for (const name of ['site', 'blog']) {
      expect(screen.getByRole('button', { name: new RegExp(`^Change the folder shared as ${name}`) })).toBeTruthy()
      expect(screen.getByLabelText(`Mount point on the server for ${name}`)).toBeTruthy()
      expect(screen.getByLabelText(`Mount ${name} when a terminal connects`)).toBeTruthy()
      expect(screen.getByRole('button', { name: `Remove the share of ${name}` })).toBeTruthy()
    }
    // Both at ~/opsmaxx/site: the second is the one in the way.
    const bad = screen.getByLabelText('Mount point on the server for blog')
    expect(bad.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById(bad.getAttribute('aria-describedby')!)!.textContent).toMatch(/Two folders/)
    expect(screen.getByLabelText('Mount point on the server for site').getAttribute('aria-invalid')).toBeNull()
  })
})

describe('the server editor', () => {
  const confirm = (): HTMLButtonElement => {
    const buttons = document.querySelectorAll('.modal-footer button')
    return buttons[buttons.length - 1] as HTMLButtonElement
  }
  const editing = (section: 'shares' | null): void =>
    useApp.setState({
      servers: [{ ...server, workspaceId: 'ws', auth: 'agent', route: [], tags: [] } as unknown as Server],
      modal: 'add-server',
      editServerId: 's1',
      editServerSection: section
    })

  it('saves a share through main, stamped with the server it was given to, and not on the record', async () => {
    const api = stub()
    useApp.setState({ servers: [], modal: 'add-server', editServerId: null, editServerSection: null })
    const u = userEvent.setup()
    render(<AddServerModal />)
    await u.type(screen.getByPlaceholderText('Production API'), 'web')
    await u.type(screen.getByPlaceholderText('10.20.0.10'), '10.0.0.5')
    await u.click(screen.getByText('SSH Agent'))
    await u.click(screen.getByText('Add folder share'))
    await u.click(confirm())

    const saved = useApp.getState().servers.find((s) => s.name === 'web')!
    expect((saved as unknown as Record<string, unknown>).shares).toBeUndefined()
    expect(api.setShares).toHaveBeenCalledWith(
      saved.id,
      [expect.objectContaining({ localDir: '/Users/someone/My Docs', mountpoint: '~/opsmaxx/My-Docs', readOnly: true })],
      serverIdentity({ host: '10.0.0.5', port: 22, username: 'root' })
    )
  })

  it('opened from the indicator, puts focus on the first Folder shares control', async () => {
    stub({ shares: [{ ...share, stale: false }] })
    // jsdom does no layout, so it has no scrollIntoView.
    Element.prototype.scrollIntoView = () => {}
    editing('shares')
    render(<AddServerModal />)
    const first = await screen.findByRole('button', { name: /^Change the folder shared as site/ })
    await vi.waitFor(() => expect(document.activeElement).toBe(first))
  })

  it('says why Save is off when two shares collide', async () => {
    stub({ shares: [{ ...share, stale: false }, { ...share, id: 'sh2', localDir: '/Users/someone/blog', stale: false }] })
    editing(null)
    render(<AddServerModal />)
    expect(await screen.findByText(/Folder shares: Two folders are shared at ~\/opsmaxx\/site/)).toBeTruthy()
    expect(confirm().disabled).toBe(true)
  })
})
