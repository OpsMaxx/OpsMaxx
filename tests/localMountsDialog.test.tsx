// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { useApp } from '../src/renderer/src/store/app'
import { useToasts } from '../src/renderer/src/store/toast'
import { LocalMountsButton } from '../src/renderer/src/components/panel/LocalMounts'
import type { Server } from '../src/renderer/src/types'
import type { LocalShare, MountStatus } from '../src/shared/localMounts'

/**
 * The Files view's local-folders dialog. What it must get right is what a
 * person cannot see anywhere else: why an auto-mount failed and what to do about
 * it, without a toast on every reconnect; read-only as the default; and a share
 * saved on the record before it is mounted, so it comes back next time.
 */

const share: LocalShare = {
  id: 'sh1',
  localDir: '/Users/someone/site',
  mountpoint: '~/opsmaxx/site',
  readOnly: true,
  autoMount: true
}

function setup(statuses: MountStatus[]): { mount: ReturnType<typeof vi.fn>; server: Server } {
  const server = { id: 's1', name: 'Box', username: 'deploy', shares: [share] } as unknown as Server
  useApp.setState({ servers: [server] })
  const mount = vi.fn(async () => ({ ok: true }))
  stubBridge({
    mounts: {
      list: vi.fn(async () => statuses),
      onChanged: vi.fn(() => () => {}),
      mount,
      unmount: vi.fn(async () => true),
      pickFolder: vi.fn(async () => '/Users/someone/My Docs')
    }
  })
  return { mount, server }
}

describe('the local folders dialog', () => {
  it('shows a failed auto-mount with its reason and fix, and raises no toast', async () => {
    const { server } = setup([
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
    useToasts.setState({ toasts: [] })
    render(<LocalMountsButton server={server} />)
    await act(async () => fireEvent.click(await screen.findByText('Local folders')))
    expect(await screen.findByText('sshfs is not installed on this server.')).toBeTruthy()
    expect(screen.getByText(/sudo apt install sshfs/)).toBeTruthy()
    expect(screen.getByText('Try again')).toBeTruthy()
    expect(useToasts.getState().toasts).toEqual([])
  })

  it('saves a new share, read-only by default, before mounting it', async () => {
    const { mount, server } = setup([])
    render(<LocalMountsButton server={server} />)
    await act(async () => fireEvent.click(await screen.findByText('Local folders')))
    await act(async () => fireEvent.click(screen.getByText(/Choose…/)))
    const mp = screen.getByPlaceholderText('~/opsmaxx/folder') as HTMLInputElement
    expect(mp.value).toBe('~/opsmaxx/My-Docs')
    await act(async () => fireEvent.click(screen.getByText('Share and mount')))
    await waitFor(() => expect(mount).toHaveBeenCalledTimes(1))
    const saved = useApp.getState().servers[0].shares ?? []
    expect(saved).toHaveLength(2)
    expect(saved[1]).toMatchObject({ localDir: '/Users/someone/My Docs', mountpoint: '~/opsmaxx/My-Docs', readOnly: true })
    expect(mount.mock.calls[0][1]).toEqual(saved[1])
  })
})
