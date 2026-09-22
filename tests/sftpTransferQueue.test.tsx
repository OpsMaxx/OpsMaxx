// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { useToasts } from '../src/renderer/src/store/toast'
import { SftpView } from '../src/renderer/src/components/panel/SftpView'
import type { SftpEntry, SftpResult, SftpUploadSummary } from '../src/shared/ssh'

/**
 * The Files view's transfer queue.
 *
 * Every transfer shares one SFTP channel, so only one runs. What these hold is
 * what happens to the rest: a second drop used to hit an early return and
 * vanish, overwrite was a window.confirm, and nothing could be stopped.
 */

const file = (name: string): SftpEntry => ({ name, dir: false, link: false, size: 1, mtime: 0, perms: '-rw-r--r--' })

function setup(listing: SftpEntry[] = []): {
  upload: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  finish: (r: SftpResult<SftpUploadSummary>) => void
} {
  const finishers: ((r: SftpResult<SftpUploadSummary>) => void)[] = []
  const upload = vi.fn(
    () => new Promise<SftpResult<SftpUploadSummary>>((resolve) => finishers.push(resolve))
  )
  const cancel = vi.fn(async () => {})
  stubBridge({
    sftp: {
      connect: vi.fn(async () => ({ ok: true, data: { home: '/srv' } })),
      list: vi.fn(async () => ({ ok: true, data: listing })),
      upload,
      cancel,
      pathFor: (f: File) => `/local/${f.name}`,
      onExternalSaved: vi.fn(() => () => {})
    },
    local: { write: vi.fn() }
  })
  return { upload, cancel, finish: (r) => finishers.shift()?.(r) }
}

async function drop(...names: string[]): Promise<void> {
  const files = names.map((n) => new File(['x'], n))
  await act(async () => {
    fireEvent.drop(screen.getByPlaceholderText('Filter files…').closest('.content') as Element, {
      dataTransfer: { files }
    })
  })
}

describe('a drop while a transfer runs', () => {
  it('is queued and shown, then runs when the first finishes', async () => {
    const { upload, finish } = setup()
    render(<SftpView tabId="t" />)
    await screen.findByText('Empty directory')

    await drop('first.tar')
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))

    await drop('second.tar')
    // Kept, visible, and not started on the busy channel.
    expect(screen.getByTestId('transfer-queue').textContent).toMatch(/1 queued: second\.tar/)
    expect(upload).toHaveBeenCalledTimes(1)

    await act(async () => finish({ ok: true, data: { uploaded: ['first.tar'], failed: [] } }))
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2))
    expect(upload.mock.calls[1][1]).toEqual(['/local/second.tar'])
    expect(screen.queryByTestId('transfer-queue')).toBeNull()
  })
})

describe('cancel', () => {
  it('stops the running transfer in main, and Clear queue drops the waiting ones', async () => {
    const { upload, cancel, finish } = setup()
    render(<SftpView tabId="t" />)
    await screen.findByText('Empty directory')
    await drop('first.tar')
    await drop('second.tar')
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))

    act(() => screen.getByText('Clear queue').click())
    expect(screen.queryByTestId('transfer-queue')).toBeNull()

    act(() => screen.getByText('Cancel').click())
    expect(cancel).toHaveBeenCalledWith('local')
    // Pressed, and says so until the transfer actually ends.
    expect((screen.getByText('Cancelling…') as HTMLButtonElement).disabled).toBe(true)

    await act(async () => finish({ ok: false, data: { uploaded: [], failed: [], cancelled: true } }))
    // The cleared file never went out.
    expect(upload).toHaveBeenCalledTimes(1)
  })
})

describe('overwrite', () => {
  it('asks in the shared dialog, not window.confirm, and Skip uploads only the rest', async () => {
    const confirm = vi.spyOn(window, 'confirm')
    const { upload } = setup([file('app.conf')])
    render(<SftpView tabId="t" />)
    await screen.findByText('app.conf')

    await drop('app.conf', 'new.conf')
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toMatch(/Replace files on the server\?/)
    expect(dialog.textContent).toMatch(/app\.conf/)
    expect(confirm).not.toHaveBeenCalled()

    act(() => screen.getByText('Skip').click())
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
    expect(upload.mock.calls[0][1]).toEqual(['/local/new.conf'])
  })

  it('Cancel all sends nothing', async () => {
    const { upload } = setup([file('app.conf')])
    render(<SftpView tabId="t" />)
    await screen.findByText('app.conf')

    await drop('app.conf')
    await screen.findByRole('dialog')
    act(() => screen.getByText('Cancel all').click())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(upload).not.toHaveBeenCalled()
  })

  it('asks about every name when the directory could not be listed', async () => {
    const { upload } = setup([file('app.conf')])
    render(<SftpView tabId="t" />)
    await screen.findByText('app.conf')
    // The listing taken when the upload starts fails.
    const bridge = (window as unknown as { opsmaxx: { sftp: { list: ReturnType<typeof vi.fn> } } }).opsmaxx
    bridge.sftp.list.mockResolvedValueOnce({ ok: false, error: 'Permission denied' })

    await drop('new.conf')
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toMatch(/Could not check \/srv for existing files/)
    expect(upload).not.toHaveBeenCalled()
  })
})

describe('files that can only be overwritten in place', () => {
  const needs = (reason: 'dir' | 'owner'): SftpResult<SftpUploadSummary> => ({
    ok: true,
    data: { uploaded: [], failed: [], needsInPlace: [{ name: 'app.conf', reason }] }
  })

  it('asks, and sends them again in place when the user agrees', async () => {
    const { upload, finish } = setup()
    render(<SftpView tabId="t" />)
    await screen.findByText('Empty directory')
    await drop('app.conf')
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
    await act(async () => finish(needs('dir')))

    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toMatch(/isn't writable, so the file can only be overwritten in place/)
    expect(dialog.textContent).toMatch(/may be left incomplete/)
    act(() => screen.getByText('Overwrite in place').click())
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2))
    expect(upload.mock.calls[1]).toEqual(['local', ['/local/app.conf'], '/srv', ['app.conf']])
  })

  it('sends nothing more when the user skips', async () => {
    const { upload, finish } = setup()
    render(<SftpView tabId="t" />)
    await screen.findByText('Empty directory')
    await drop('app.conf')
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
    await act(async () => finish(needs('owner')))

    expect((await screen.findByRole('dialog')).textContent).toMatch(/owner or permissions/)
    act(() => screen.getByText('Skip').click())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(upload).toHaveBeenCalledTimes(1)
  })
})

describe('how an upload ended', () => {
  // A cancel that lands during the final swap lets it finish, so the result
  // is both "uploaded" and "cancelled". One toast, saying what happened.
  it('says one accurate thing when the upload finished despite a cancel', async () => {
    const { upload, finish } = setup()
    render(<SftpView tabId="t" />)
    await screen.findByText('Empty directory')
    await drop('app.conf')
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
    await act(async () => finish({ ok: false, data: { uploaded: ['app.conf'], failed: [], cancelled: true } }))

    const messages = useToasts.getState().toasts.map((t) => t.message)
    expect(messages).toEqual(['Upload finished before it could be cancelled.'])
  })
})

