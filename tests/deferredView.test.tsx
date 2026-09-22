// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { deferredView } from '../src/renderer/src/lib/deferredView'

/**
 * The views App keeps out of the startup bundle must render exactly as the
 * static imports they replaced: synchronously once the chunk is here, with
 * their props — and a chunk that cannot load must fail in the view's own place,
 * not tear down the app around it.
 */
describe('deferredView', () => {
  const Probe = ({ label }: { label: string }): React.JSX.Element => <p>{label}</p>

  it('renders on the first pass once preloaded — no empty frame', async () => {
    const v = deferredView(() => Promise.resolve(Probe))
    await v.preload()
    render(<v.View label="ready" />)
    // No waitFor: synchronously present, as a static import would be.
    expect(screen.getByText('ready')).toBeTruthy()
  })

  it('renders when the chunk arrives if it was not preloaded', async () => {
    let calls = 0
    const v = deferredView(() => {
      calls++
      return Promise.resolve(Probe)
    })
    render(<v.View label="late" />)
    await waitFor(() => expect(screen.getByText('late')).toBeTruthy())
    await v.preload()
    expect(calls).toBe(1)
  })

  it('renders when the chunk lands between an empty render and its effect', async () => {
    // Outside act(), so the render and its passive effects run as separate
    // scheduler tasks — the way an ordinary, non-discrete update does in the
    // app — and the chunk can resolve in the gap between them.
    const actEnv = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      let arrive!: (c: typeof Probe) => void
      const v = deferredView(() => new Promise<typeof Probe>((r) => (arrive = r)))
      // The idle preload is already in flight when the view is first shown.
      void v.preload()
      root.render(<v.View label="raced" />)
      // In jsdom this task runs after the commit and before React's scheduled
      // passive-effect flush — the gap the chunk has to land in.
      setTimeout(() => arrive(Probe), 0)
      await waitFor(() => expect(host.textContent).toBe('raced'))
    } finally {
      root.unmount()
      host.remove()
      ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = actEnv
    }
  })

  it('fails in place with a retry, leaving the rest of the app mounted', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    let attempts = 0
    const v = deferredView<{ label: string }>(() =>
      ++attempts === 1 ? Promise.reject(new Error('chunk gone')) : Promise.resolve(Probe)
    )
    await v.preload()
    // Visible in the debug trace even though no view was on screen to fail.
    expect(error).toHaveBeenCalled()
    render(
      <>
        <p>terminal still here</p>
        <v.View label="second try" />
      </>
    )
    expect(screen.getByText(/This view failed to load: chunk gone/)).toBeTruthy()
    expect(screen.getByText('terminal still here')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByText('second try')).toBeTruthy())
    expect(screen.getByText('terminal still here')).toBeTruthy()
    expect(attempts).toBe(2)
    error.mockRestore()
  })
})
