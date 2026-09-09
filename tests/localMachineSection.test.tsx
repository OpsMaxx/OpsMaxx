// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { ConnectionTree } from '../src/renderer/src/components/connections/ConnectionTree'
import { useApp } from '../src/renderer/src/store/app'
import type { LocalShell } from '../src/shared/local'

/**
 * "This machine" in the connection list.
 *
 * A local terminal could already be opened three ways — the tab bar's caret
 * menu, the palette, and Ctrl+Shift+T — and the connection list, the one place
 * a person looks for something to connect to, never mentioned this machine.
 *
 * Two behaviours here are worth pinning rather than the markup. The section
 * must disappear when local support is switched off, because that switch is the
 * user-facing half of what `services/localGate.ts` enforces in main and a
 * visible row for a refused target is a bug report. And it must ask for the
 * shell list itself: this section is now the earliest mount-time caller of
 * `refreshLocalShells`, which the tab bar's shell menu used to claim sole
 * ownership of — so if this stops asking, the palette and the hotkey go inert
 * again for anyone who never opens the tab-bar caret.
 */

// `posix` for both, which is what LocalShellKind actually has — it does not
// distinguish bash from zsh, and the snippet chooser reads the path instead.
const SHELLS: LocalShell[] = [
  { id: 'darwin-bash-aaaa1111', label: 'bash', kind: 'posix', path: '/bin/bash', args: [] },
  {
    id: 'darwin-zsh-bbbb2222',
    label: 'zsh (default)',
    kind: 'posix',
    path: '/bin/zsh',
    args: [],
    isDefault: true
  }
]

describe('This machine section', () => {
  beforeEach(() => {
    stubBridge({ local: { shells: vi.fn().mockResolvedValue(SHELLS) } })
    useApp.setState({ localShells: [] })
  })

  it('asks for the shell list on mount', async () => {
    const refreshLocalShells = vi.fn().mockResolvedValue(undefined)
    useApp.setState({ refreshLocalShells })
    render(<ConnectionTree />)
    await waitFor(() => expect(refreshLocalShells).toHaveBeenCalled())
  })

  it('lists the shells this machine has, default first', async () => {
    useApp.setState({ localShells: SHELLS, refreshLocalShells: vi.fn() })
    render(<ConnectionTree />)

    expect(await screen.findByText('This machine')).toBeTruthy()
    const rows = screen.getAllByRole('button').filter((el) => el.className.includes('tree-row'))
    // The OS's own shell leads, chosen by `isDefault` rather than by parsing an
    // id that is an opaque path digest.
    expect(rows[0].textContent).toContain('zsh (default)')
    expect(rows.map((r) => r.textContent).join(' ')).toContain('bash')
  })

  it('is reachable by keyboard, not only by mouse', async () => {
    useApp.setState({ localShells: SHELLS, refreshLocalShells: vi.fn() })
    render(<ConnectionTree />)

    await screen.findByText('This machine')
    const rows = screen.getAllByRole('button').filter((el) => el.className.includes('tree-row'))
    // `.tree-row` is a div with an onClick. Without these it is a
    // discoverability feature no keyboard user can reach.
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.getAttribute('tabindex')).toBe('0')
  })

  it('disappears when local support is switched off', async () => {
    const refreshLocalShells = vi.fn()
    useApp.setState({
      localShells: SHELLS,
      refreshLocalShells,
      settings: { ...useApp.getState().settings, localTerminalEnabled: false }
    })
    render(<ConnectionTree />)

    expect(screen.queryByText('This machine')).toBeNull()
    // And it must not have asked, either: the switch is off in main too, so the
    // call would be refused rather than merely unused.
    expect(refreshLocalShells).not.toHaveBeenCalled()
  })

  it('shows nothing rather than an error when no shell was found', async () => {
    useApp.setState({ localShells: [], refreshLocalShells: vi.fn() })
    render(<ConnectionTree />)
    // The shell menu owns the "no shells found" message; a permanently empty
    // section header in the sidebar would just be furniture.
    expect(screen.queryByText('This machine')).toBeNull()
  })
})
