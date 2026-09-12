// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { Settings } from '../src/renderer/src/components/settings/Settings'
import { useNav } from '../src/renderer/src/store/nav'

// Advanced was in the nav union, had a label and an icon, and rendered NOTHING:
// it fell through to a placeholder whose Reset button toasts "nothing to reset".
// It now holds Diagnostics.
//
// The placeholder's exclusion list is the other half of this, and it had a real
// bug: `modules` renders a full panel and was missing from the list, so that page
// showed its modules AND a stray "Reset modules" row. A page that renders content
// must not also render the placeholder, which is what these two assertions pin.

const DIAGNOSTICS = 'OpsMaxx diagnostics\nversion: 0.6.2\nservers: 3\n'

beforeEach(() => {
  stubBridge({
    autoStart: { get: () => Promise.resolve({ supported: false, reason: 'not here' }) },
    updates: { state: () => Promise.resolve(null), onState: () => () => undefined },
    diagnostics: { text: () => Promise.resolve(DIAGNOSTICS) },
    clipboard: { write: vi.fn() }
  })
})

const open = (section: 'advanced' | 'modules'): void => {
  useNav.getState().setSettingsSection(section)
}

describe('Settings → Advanced', () => {
  it('shows the diagnostics text it is about to copy', async () => {
    open('advanced')
    render(<Settings />)
    expect(screen.getByText('Copy diagnostics')).not.toBeNull()
    // The preview, not a promise about a file: the user reads the payload first.
    await waitFor(() => expect(document.querySelector('.paste-preview')?.textContent).toContain('servers: 3'))
  })

  it('copies that same text, unedited', async () => {
    open('advanced')
    render(<Settings />)
    const copy = await waitFor(() => {
      const btn = screen.getByRole('button', { name: 'Copy' }) as HTMLButtonElement
      expect(btn.disabled).toBe(false)
      return btn
    })
    await userEvent.click(copy)
    const write = (window as unknown as { opsmaxx: { clipboard: { write: ReturnType<typeof vi.fn> } } })
      .opsmaxx.clipboard.write
    expect(write).toHaveBeenCalledWith(DIAGNOSTICS)
  })

  it('disables the Copy button when the preload bridge has no diagnostics method', async () => {
    // An old preload under `electron-vite dev` does not have the method. Settings
    // always RENDERS the button; what it must not do is throw, so the button is
    // there and disabled. (The other behaviour — hiding it entirely — is
    // ErrorBoundary.tsx's, behind `bridgeHas`, and tests/errorBoundary.test.tsx
    // exercises that.)
    //
    // `diagnostics: {}` rather than no `diagnostics` key: with the key missing,
    // `window.opsmaxx?.diagnostics` is undefined and the optional chain prevents
    // the throw on its own, so this passed without `bridgeHas` ever being the
    // thing that held. The empty namespace is what puts the guard under test.
    stubBridge({
      autoStart: { get: () => Promise.resolve({ supported: false, reason: 'not here' }) },
      updates: { state: () => Promise.resolve(null), onState: () => () => undefined },
      diagnostics: {}
    })
    open('advanced')
    render(<Settings />)
    expect((screen.getByRole('button', { name: 'Copy' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('does not also offer the "nothing to reset" placeholder', () => {
    for (const section of ['advanced', 'modules'] as const) {
      open(section)
      const { unmount } = render(<Settings />)
      expect(screen.queryByRole('button', { name: 'Reset' }), section).toBeNull()
      unmount()
    }
  })
})
