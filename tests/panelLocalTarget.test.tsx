// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { DockerPanel } from '../src/renderer/src/components/docker/DockerPanel'
import { KubernetesPanel } from '../src/renderer/src/components/kubernetes/KubernetesPanel'
import type { Server } from '../src/renderer/src/types'

/**
 * "This machine" was unselectable on both panels.
 *
 * Reported against 0.50.21: picking it from the host dropdown put the
 * selection straight back on the saved server. With any server in the list the
 * local daemon could not be targeted at all — and the local daemon is the one
 * most developers actually have running.
 *
 * The cause is the staleness guard added in 0.50.20, which exists for a real
 * crash: a component-local `serverId` outlives the server it names, and the
 * cfg builder reads `.id` off the `undefined` that `servers.find` returns, at
 * RENDER time, taking the panel down through the error boundary.
 *
 * That guard was `serverId && servers.some((sv) => sv.id === serverId)`. The
 * local target is deliberately NOT a row in `servers` — that list is persisted
 * and mirrored into the MCP data cache, so a pseudo-server would become an
 * agent-addressable target the moment it was written — so the sentinel failed
 * the guard, was treated as stale, and `defaultHostId` overrode it.
 *
 * Both halves are asserted together on purpose. A fix that made the sentinel
 * selectable by dropping the guard would restore the 0.50.19 crash, and a
 * green "This machine works" would be the only evidence anyone saw.
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

const ALPHA = server('srv-alpha', 'alpha')
const BRAVO = server('srv-bravo', 'bravo')

beforeEach(() => {
  stubBridge({
    docker: {
      list: () =>
        Promise.resolve({ ok: true, version: '24.0.7', composeLabels: 'read', containers: [] })
    },
    k8s: { read: vi.fn(async () => ({ ok: true, output: '', exitCode: 0 })) },
    jobs: { onProgress: () => () => {}, run: vi.fn() }
  })
})

/** The host dropdown, which both panels label the same way. */
const hostSelect = (): HTMLSelectElement =>
  screen.getAllByRole('combobox').find((el) => [...(el as HTMLSelectElement).options].some((o) => o.text === 'This machine')) as HTMLSelectElement

describe('choosing this machine as the target', () => {
  it('stays chosen on the Docker panel', async () => {
    const user = userEvent.setup()
    render(<DockerPanel servers={[ALPHA, BRAVO]} />)

    const select = hostSelect()
    // It starts on a saved server — that is the intended default and is not
    // what is under test.
    expect(select.value).toBe('srv-alpha')

    await user.selectOptions(select, 'local')
    expect(select.value).toBe('local')
  })

  it('stays chosen on the Kubernetes panel', async () => {
    const user = userEvent.setup()
    render(<KubernetesPanel servers={[ALPHA, BRAVO]} />)

    const select = hostSelect()
    await user.selectOptions(select, 'local')
    expect(select.value).toBe('local')
  })

  it('does not bring back the crash the guard was added for', () => {
    // The same reproduction as tests/dockerStaleServer.test.tsx: select a
    // server, then take it away. The panel must resolve to something that
    // exists rather than handing `undefined` to the cfg builder.
    const { rerender } = render(<DockerPanel servers={[ALPHA, BRAVO]} />)
    expect(() => rerender(<DockerPanel servers={[ALPHA]} />)).not.toThrow()
    const select = hostSelect()
    expect([...select.options].some((o) => o.value === select.value)).toBe(true)
  })
})
