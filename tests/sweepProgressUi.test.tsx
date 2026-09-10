// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { SweepProgress } from '../src/renderer/src/components/monitor/SweepProgress'
import { useApp } from '../src/renderer/src/store/app'
import type { FleetSweepProgress } from '../src/shared/fleet'
import type { Server } from '../src/renderer/src/types'

/**
 * The visible half of "Check now".
 *
 * The collection itself was fixed first, and the button still read as broken:
 * a sweep that asks servers one at a time, with a 45-second timeout for each
 * host that has gone away, showed a 13px spinning icon and an unchanged label
 * for a minute and a half. What is asserted here is the part a person actually
 * uses to tell a running check from a dead button.
 */

const server = (id: string, name: string): Server =>
  ({
    id,
    workspaceId: 'ws-default',
    folderId: null,
    name,
    host: `${id}.example.internal`,
    port: 22,
    username: 'ops',
    auth: 'key',
    status: 'online',
    tags: [],
    favorite: false,
    os: 'linux',
    route: [],
    vpnProfileId: null
  }) as Server

/** Installs a bridge whose progress subscription this test can drive. */
function progressBridge(): { emit: (p: FleetSweepProgress) => void } {
  let listener: ((p: FleetSweepProgress) => void) | null = null
  stubBridge({
    fleet: {
      onProgress: vi.fn((cb: (p: FleetSweepProgress) => void) => {
        listener = cb
        return () => {
          listener = null
        }
      })
    }
  })
  return { emit: (p) => act(() => listener?.(p)) }
}

describe('the sweep indicator', () => {
  it('shows nothing at all when idle', () => {
    progressBridge()
    const { container } = render(<SweepProgress active={false} label="Collecting facts" />)
    expect(container.firstChild).toBeNull()
  })

  it('says it is waiting before the first report arrives', () => {
    // The gap this closes: resolving targets and waiting out an in-flight sweep
    // happen before any progress exists, and a button that looks unpressed for
    // that second is the whole complaint.
    progressBridge()
    render(<SweepProgress active={true} label="Collecting facts" />)
    expect(screen.getByText(/waiting for the running check/i)).toBeTruthy()
  })

  it('names the server it is waiting on, and how far through it is', () => {
    useApp.setState({ servers: [server('s1', 'Scanner01'), server('s2', 'Bastion')] })
    const { emit } = progressBridge()
    render(<SweepProgress active={true} label="Collecting facts" />)

    emit({ done: 0, total: 2, serverId: 's1', phase: 'sweeping' })
    // The name is the point. "1 of 2" on an estate stuck for forty seconds says
    // nothing about why; the host that is timing out is usually the answer.
    expect(screen.getByText('Asking Scanner01 — 1 of 2')).toBeTruthy()

    emit({ done: 1, total: 2, serverId: 's2', phase: 'sweeping' })
    expect(screen.getByText('Asking Bastion — 2 of 2')).toBeTruthy()
  })

  it('becomes a real progressbar once the sweep starts', () => {
    useApp.setState({ servers: [server('s1', 'Scanner01')] })
    const { emit } = progressBridge()
    render(<SweepProgress active={true} label="Collecting facts" />)

    // Indeterminate while waiting — how long an earlier sweep has left is
    // genuinely unknowable from here, and a determinate bar would invent it.
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBeNull()

    emit({ done: 2, total: 4, serverId: 's1', phase: 'sweeping' })
    expect(bar.getAttribute('aria-valuenow')).toBe('2')
    expect(bar.getAttribute('aria-valuemax')).toBe('4')
    expect((bar.firstChild as HTMLElement).style.width).toBe('50%')
  })

  it('ignores a sweep the scheduler started once this control is done', () => {
    // Progress is broadcast window-wide and the scheduler sweeps by itself. A
    // bar that moves when nobody pressed anything reads as work the user
    // caused, which is worse than no bar.
    useApp.setState({ servers: [server('s1', 'Scanner01')] })
    const { emit } = progressBridge()
    const { rerender } = render(<SweepProgress active={true} label="Collecting facts" />)
    emit({ done: 0, total: 2, serverId: 's1', phase: 'sweeping' })
    expect(screen.getByText(/Asking Scanner01/)).toBeTruthy()

    rerender(<SweepProgress active={false} label="Collecting facts" />)
    emit({ done: 1, total: 2, serverId: 's1', phase: 'sweeping' })
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('does not throw when the preload bridge predates it', () => {
    stubBridge({})
    render(<SweepProgress active={true} label="Collecting facts" />)
    // Degrades to the waiting line rather than taking the window down.
    expect(screen.getByText(/waiting for the running check/i)).toBeTruthy()
  })
})
