// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { deferredView } from '../src/renderer/src/lib/deferredView'

/**
 * The views App keeps out of the startup bundle must render exactly as the
 * static imports they replaced: synchronously once the chunk is here, with
 * their props, and into the ErrorBoundary if the chunk cannot be loaded.
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

  it('throws a load failure into the nearest error boundary', async () => {
    const v = deferredView<{ label: string }>(() => Promise.reject(new Error('chunk gone')))
    await v.preload()
    expect(() => render(<v.View label="x" />)).toThrow('chunk gone')
  })
})
