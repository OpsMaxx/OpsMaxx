// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { ErrorBoundary } from '../src/renderer/src/components/common/ErrorBoundary'

// The crash screen had no test at all, and it was the one path in the app that
// copied the diagnostics payload — the only payload containing text nobody here
// wrote — straight to the clipboard with nothing on screen first. Settings shows
// its preview and has no crash block; this screen had the crash block and no
// preview, which is exactly the wrong way round. These pin the preview.

const MESSAGE = 'Cannot read rows of db-prod.internal.example'

const DIAGNOSTICS = [
  'OpsMaxx diagnostics',
  'version: 0.6.2',
  '',
  '[crash]',
  `message: ${MESSAGE}`,
  ''
].join('\n')

function Boom(): never {
  throw new Error(MESSAGE)
}

const write = (): ReturnType<typeof vi.fn> =>
  (window as unknown as { opsmaxx: { clipboard: { write: ReturnType<typeof vi.fn> } } }).opsmaxx
    .clipboard.write

const text = (): ReturnType<typeof vi.fn> =>
  (window as unknown as { opsmaxx: { diagnostics: { text: ReturnType<typeof vi.fn> } } }).opsmaxx
    .diagnostics.text

beforeEach(() => {
  // React logs every caught render error, and so does componentDidCatch. Not
  // worth reading three times per assertion.
  vi.spyOn(console, 'error').mockImplementation(() => {})
  stubBridge({
    diagnostics: { text: vi.fn(() => Promise.resolve(DIAGNOSTICS)) },
    clipboard: { write: vi.fn() }
  })
})

const crash = (): void => {
  render(
    <ErrorBoundary>
      <Boom />
    </ErrorBoundary>
  )
}

describe('the crash screen', () => {
  it('replaces the tree with something that says what happened', () => {
    crash()
    expect(screen.getByText('Something broke in the interface')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Reload' })).not.toBeNull()
  })

  it('shows the diagnostics text before anything is copied', async () => {
    crash()
    await waitFor(() =>
      expect(document.querySelector('.paste-preview')?.textContent).toContain(`message: ${MESSAGE}`)
    )
    // The point of the preview: it is on screen without the user asking, and
    // nothing has reached the clipboard yet.
    expect(write()).not.toHaveBeenCalled()
  })

  it('asks main for that text with the crash main never saw', async () => {
    crash()
    await waitFor(() => expect(text()).toHaveBeenCalled())
    const arg = text().mock.calls[0][0] as {
      message: string
      stack: string | null
      componentStack: string | null
    }
    expect(arg.message).toBe(MESSAGE)
    expect(arg.stack).toContain('Error')
    expect(arg.componentStack).toContain('Boom')
  })

  it('copies exactly the text it showed', async () => {
    crash()
    const button = await waitFor(() => screen.getByRole('button', { name: 'Copy diagnostics' }))
    await waitFor(() =>
      expect(document.querySelector('.paste-preview')?.textContent).toBe(DIAGNOSTICS)
    )
    // Enabled only because the preview is there. The clipboard gets that text
    // and nothing assembled on the click.
    expect((button as HTMLButtonElement).disabled).toBe(false)
    await userEvent.click(button)
    expect(write()).toHaveBeenCalledWith(DIAGNOSTICS)
  })

  it('hides the button when the preload bridge has no diagnostics method', async () => {
    // An old preload under `electron-vite dev`. `diagnostics` is present and
    // `text` is not, so `bridgeHas` is the thing deciding — an absent namespace
    // would short-circuit on the optional chain instead and prove nothing.
    stubBridge({ diagnostics: {}, clipboard: { write: vi.fn() } })
    crash()
    expect(screen.queryByRole('button', { name: 'Copy diagnostics' })).toBeNull()
    expect(document.querySelector('.paste-preview')).toBeNull()
    // The unredacted local fallback is still there, and still the one that says
    // nothing about being clean.
    expect(screen.getByRole('button', { name: 'Copy details' })).not.toBeNull()
  })

  it('copies nothing when main cannot build the text', async () => {
    // This used to assert the opposite: no preview, button live, click copies
    // the local `report()` — which is the raw message, the raw stack with every
    // absolute path in it, and the raw component stack, under a caption saying
    // paths are trimmed and secrets stripped. The button is the promise, so it
    // goes grey instead. Copy details is the way to get the raw text, and it
    // does not promise it is clean.
    stubBridge({
      diagnostics: { text: vi.fn(() => Promise.reject(new Error('no ipc'))) },
      clipboard: { write: vi.fn() }
    })
    crash()
    const button = screen.getByRole('button', { name: 'Copy diagnostics' })
    await waitFor(() => expect(text()).toHaveBeenCalled())
    expect(document.querySelector('.paste-preview')).toBeNull()
    // Present, not absent: a vanished button reads as a broken screen, a greyed
    // one reads as a feature that needs something this crash did not get.
    expect((button as HTMLButtonElement).disabled).toBe(true)
    await userEvent.click(button)
    expect(write()).not.toHaveBeenCalled()
  })
})
