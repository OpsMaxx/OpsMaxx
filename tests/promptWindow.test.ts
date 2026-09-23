import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { app, BrowserWindow, dialog } from 'electron'
import { mainWindowStub } from './mocks/electron'

/**
 * Host-key and certificate prompts from the main process.
 *
 * With no parent window, `dialog.showMessageBox` is app-modal: on macOS an
 * NSAlert run with `runModal`, which holds the main thread in its own loop.
 * A stack sample of a real session showed main parked there while IPC, CDP and
 * the MCP bridge all stalled behind one unanswered question. These hold that
 * every such prompt is a sheet on a window, and that with no window the answer
 * is an immediate refusal rather than a blocking box.
 */

const { verifyHostKey, askedWithoutWindow } = await import('../src/main/services/knownhosts')
const { verifyRdpCertificate } = await import('../src/main/services/rdpTrust')

type Box = Awaited<ReturnType<typeof dialog.showMessageBox>>

let box: ReturnType<typeof vi.spyOn>
let n = 0
// A fresh host each time, so nothing is already trusted.
const host = (): string => `new-${++n}.example.test`

beforeEach(() => {
  box = vi.spyOn(dialog, 'showMessageBox').mockResolvedValue({ response: 1 } as Box)
})
afterEach(() => vi.restoreAllMocks())

describe('with a window', () => {
  it('asks about an unknown host key as a sheet on that window', async () => {
    await verifyHostKey(host(), 22, Buffer.from('key-a'))
    expect(box).toHaveBeenCalledTimes(1)
    expect(box.mock.calls[0][0]).toBe(mainWindowStub)
    expect(box.mock.calls[0][1]).toMatchObject({ title: 'Unknown server', defaultId: 1 })
  })

  it('asks about an unknown remote desktop certificate the same way', async () => {
    await verifyRdpCertificate(host(), 3389, Buffer.from('cert-a'))
    expect(box.mock.calls[0][0]).toBe(mainWindowStub)
  })

  it('brings a hidden or minimised window forward first', async () => {
    const win = { ...mainWindowStub, isVisible: () => false, isMinimized: () => true, show: vi.fn(), restore: vi.fn(), focus: vi.fn() }
    vi.spyOn(BrowserWindow, 'getFocusedWindow').mockReturnValue(null)
    vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([win] as never)
    await verifyHostKey(host(), 22, Buffer.from('key-b'))
    expect(win.restore).toHaveBeenCalled()
    expect(win.show).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
    expect(box.mock.calls[0][0]).toBe(win)
  })

  it('still needs an explicit Trust: the default answer refuses', async () => {
    await expect(verifyHostKey(host(), 22, Buffer.from('key-c'))).resolves.toBe(false)
  })
})

describe('with no window at all', () => {
  beforeEach(() => {
    vi.spyOn(BrowserWindow, 'getFocusedWindow').mockReturnValue(null)
    vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([])
  })

  it('refuses at once instead of raising an app-modal box', async () => {
    const verdict = verifyHostKey(host(), 22, Buffer.from('key-d'))
    await expect(verdict).resolves.toBe(false)
    expect(box).not.toHaveBeenCalled()
    // And says why, for the connection error.
    expect(askedWithoutWindow(verdict)).toBe(true)
  })

  // A terminal, SFTP and metrics can all connect at once on first use and
  // join one prompt. Each of them has to be able to say why it failed.
  it('tells every connection that joined the prompt why it was refused', async () => {
    const h = host()
    const a = verifyHostKey(h, 22, Buffer.from('key-f'))
    const b = verifyHostKey(h, 22, Buffer.from('key-f'))
    await Promise.all([a, b])
    expect(askedWithoutWindow(a)).toBe(true)
    expect(askedWithoutWindow(b)).toBe(true)
  })

  it('refuses a remote desktop certificate the same way', async () => {
    await expect(verifyRdpCertificate(host(), 3389, Buffer.from('cert-b'))).resolves.toBe(false)
    expect(box).not.toHaveBeenCalled()
  })

  it('does not trust the key, so the next attempt asks again', async () => {
    const h = host()
    await verifyHostKey(h, 22, Buffer.from('key-e'))
    vi.spyOn(BrowserWindow, 'getFocusedWindow').mockReturnValue(mainWindowStub as never)
    await verifyHostKey(h, 22, Buffer.from('key-e'))
    expect(box).toHaveBeenCalledTimes(1)
  })
})

describe('a window closed while its sheet is up', () => {
  // A destroyed window's sheet never settles, and the prompt is the one every
  // later connection to that host joins — so it has to settle on close.
  it('counts as Cancel, and the next connect asks again', async () => {
    const win = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      isMinimized: () => false,
      isVisible: () => true,
      restore: () => undefined,
      show: () => undefined,
      focus: () => undefined
    })
    vi.spyOn(BrowserWindow, 'getFocusedWindow').mockReturnValue(win as never)
    box.mockReturnValueOnce(new Promise(() => {}))
    const h = host()
    const first = verifyHostKey(h, 22, Buffer.from('key-g'))
    await vi.waitFor(() => expect(box).toHaveBeenCalledTimes(1))
    win.emit('closed')
    await expect(first).resolves.toBe(false)
    expect(win.listenerCount('closed')).toBe(0)

    await verifyHostKey(h, 22, Buffer.from('key-g'))
    expect(box).toHaveBeenCalledTimes(2)
  })
})

describe('when the app is in the background on macOS', () => {
  it('bounces the dock while the trust sheet waits', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const bounce = vi.fn()
    Object.assign(app, { dock: { bounce } })
    vi.spyOn(BrowserWindow, 'getFocusedWindow').mockReturnValue(null)
    try {
      await verifyHostKey(host(), 22, Buffer.from('key-h'))
      expect(bounce).toHaveBeenCalledWith('critical')
    } finally {
      Object.defineProperty(process, 'platform', platform)
      delete (app as { dock?: unknown }).dock
    }
  })

  it('does not when a window already has focus', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const bounce = vi.fn()
    Object.assign(app, { dock: { bounce } })
    try {
      await verifyHostKey(host(), 22, Buffer.from('key-i'))
      expect(bounce).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', platform)
      delete (app as { dock?: unknown }).dock
    }
  })
})

describe('no main-process message box is raised without a parent', () => {
  // A source check, because the failure is invisible in a test: an app-modal
  // box resolves the same way a sheet does. The runtime cost is only seen as
  // a frozen app. Every message box goes through askInWindow, which is the
  // one place allowed to call showMessageBox, and only with a window first;
  // the Sync variant blocks by design and is not allowed anywhere.
  it('holds for every service', async () => {
    const { readFileSync, readdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const root = join(__dirname, '../src/main')
    const files: string[] = []
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (p.endsWith('.ts')) files.push(p)
      }
    }
    walk(root)
    const offenders: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      if (/showMessageBoxSync/.test(src)) offenders.push(`${f}: showMessageBoxSync`)
      const calls = [...src.matchAll(/showMessageBox\s*\(\s*([^,)]*)/g)].map((m) => m[1].trim())
      if (!f.endsWith('promptWindow.ts')) {
        if (calls.length) offenders.push(`${f}: showMessageBox outside promptWindow.ts`)
      } else if (calls.some((arg) => arg !== 'win')) offenders.push(`${f}: showMessageBox without the window first`)
    }
    expect(offenders).toEqual([])
  })
})
