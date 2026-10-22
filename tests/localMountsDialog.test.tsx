// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AddServerModal } from '../src/renderer/src/components/connections/AddServerModal'
import { useState } from 'react'
import { stubBridge } from './setup/renderer'
import { useApp } from '../src/renderer/src/store/app'
import { useToasts } from '../src/renderer/src/store/toast'
import {
  FolderSharesIndicator,
  FolderSharesSection,
  applyShareChanges,
  sharesProblem
} from '../src/renderer/src/components/panel/LocalMounts'
import type { Server } from '../src/renderer/src/types'
import type { LocalShare, MountStatus } from '../src/shared/localMounts'

/**
 * Folder shares in the renderer: defined in the server editor like
 * `docker -v host:path:ro`, shown on the tab's view bar. What has to hold is
 * what a person cannot check anywhere else — read-only and mount-on-connect as
 * the defaults, why a mount failed without a toast on every reconnect, and an
 * edit reaching the live mounts.
 */

const share: LocalShare = {
  id: 'sh1',
  localDir: '/Users/someone/site',
  mountpoint: '~/opsmaxx/site',
  readOnly: true,
  autoMount: true
}

function stub(statuses: MountStatus[] = []) {
  const api = {
    list: vi.fn(async () => statuses),
    onChanged: vi.fn(() => () => {}),
    mount: vi.fn(async (_serverId: string, _share: LocalShare) => ({ ok: true })),
    unmount: vi.fn(async (_serverId: string, _mountpoint: string) => true),
    pickFolder: vi.fn(async () => '/Users/someone/My Docs')
  }
  stubBridge({ mounts: api })
  return api
}

describe('the folder shares indicator', () => {
  it('shows a failed mount with its reason and fix, offers Retry, and raises no toast', async () => {
    stub([
      {
        shareId: 'sh1',
        localDir: share.localDir,
        mountpoint: share.mountpoint,
        readOnly: true,
        state: 'failed',
        error: 'sshfs is not installed on this server.',
        fix: 'Install it on the server: sudo apt install sshfs (Debian, Ubuntu) or sudo dnf install fuse-sshfs (Fedora, RHEL).'
      }
    ])
    const server = { id: 's1', name: 'Box', username: 'deploy', shares: [share] } as unknown as Server
    useApp.setState({ servers: [server] })
    useToasts.setState({ toasts: [] })
    render(<FolderSharesIndicator server={server} />)
    await act(async () => fireEvent.click(await screen.findByLabelText('Folder shares')))
    expect(await screen.findByText('sshfs is not installed on this server.')).toBeTruthy()
    expect(screen.getByText(/sudo apt install sshfs/)).toBeTruthy()
    expect(screen.getByText('Retry')).toBeTruthy()
    expect(useToasts.getState().toasts).toEqual([])
  })

  it('opens the server editor on its Folder shares section', async () => {
    stub()
    const server = { id: 's1', name: 'Box', username: 'deploy' } as unknown as Server
    useApp.setState({ servers: [server], modal: null, editServerId: null, editServerSection: null })
    render(<FolderSharesIndicator server={server} />)
    await act(async () => fireEvent.click(await screen.findByLabelText('Folder shares')))
    await act(async () => fireEvent.click(screen.getByText('Add a share…')))
    expect(useApp.getState()).toMatchObject({ modal: 'add-server', editServerId: 's1', editServerSection: 'shares' })
  })
})

describe('the Folder shares section of the server editor', () => {
  function Harness({ onShares }: { onShares: (s: LocalShare[]) => void }): React.JSX.Element {
    const [shares, setShares] = useState<LocalShare[]>([])
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
    expect(latest).toHaveLength(1)
    expect(latest[0]).toMatchObject({
      localDir: '/Users/someone/My Docs',
      mountpoint: '~/opsmaxx/My-Docs',
      readOnly: true,
      autoMount: true
    })
    expect(screen.getByText(/can read every file/)).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Access'), { target: { value: 'rw' } })
    expect(latest[0].readOnly).toBe(false)
    expect(screen.getByText(/can change and delete files/)).toBeTruthy()
  })

  it('will not save two shares at one mount point', () => {
    expect(sharesProblem([share, { ...share, id: 'sh2', localDir: '/other' }])).toMatch(/Two folders/)
    expect(sharesProblem([share])).toBeNull()
  })
})

describe('saving the editor', () => {
  it('saves a share added in the server editor on the server record, and mounts it', async () => {
    const api = stub()
    stubBridge({
      mounts: api,
      ssh: { defaultKeys: () => Promise.resolve([]) },
      secrets: { set: () => Promise.resolve(true), get: () => Promise.resolve(null), delete: () => Promise.resolve() }
    })
    useApp.setState({ servers: [], modal: 'add-server', editServerId: null, editServerSection: null })
    const u = userEvent.setup()
    render(<AddServerModal />)
    await u.type(screen.getByPlaceholderText('Production API'), 'web')
    await u.type(screen.getByPlaceholderText('10.20.0.10'), '10.0.0.5')
    await u.click(screen.getByText('SSH Agent'))
    await u.click(screen.getByText('Add folder share'))
    const buttons = document.querySelectorAll('.modal-footer button')
    await u.click(buttons[buttons.length - 1] as HTMLButtonElement)

    const saved = useApp.getState().servers.find((s) => s.name === 'web')!
    expect(saved.shares).toEqual([
      expect.objectContaining({ localDir: '/Users/someone/My Docs', mountpoint: '~/opsmaxx/My-Docs', readOnly: true })
    ])
    await vi.waitFor(() => expect(api.mount).toHaveBeenCalledWith(saved.id, saved.shares![0]))
  })

  it('unmounts what was removed or changed and mounts what is new, in that order', async () => {
    const api = stub()
    const calls: string[] = []
    api.unmount.mockImplementation(async (_s: string, mp: string) => (calls.push(`unmount ${mp}`), true))
    api.mount.mockImplementation(async (_s: string, sh: LocalShare) => (calls.push(`mount ${sh.mountpoint}`), { ok: true }))

    const kept = { ...share, id: 'keep', mountpoint: '~/opsmaxx/keep' }
    const gone = { ...share, id: 'gone', mountpoint: '~/opsmaxx/gone' }
    const flipped = { ...share, id: 'flip', mountpoint: '~/opsmaxx/flip' }
    const added = { ...share, id: 'new', mountpoint: '~/opsmaxx/new' }
    const manual = { ...share, id: 'manual', mountpoint: '~/opsmaxx/manual', autoMount: false }
    await applyShareChanges('s1', [kept, gone, flipped], [kept, { ...flipped, readOnly: false }, added, manual])

    expect(calls).toEqual([
      'unmount ~/opsmaxx/gone',
      'unmount ~/opsmaxx/flip',
      'mount ~/opsmaxx/flip',
      'mount ~/opsmaxx/new'
    ])
  })
})
