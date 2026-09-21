// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { DockerPanel } from '../src/renderer/src/components/docker/DockerPanel'
import type { Server } from '../src/renderer/src/types'

// Crash reported from 0.50.19:
//
//   TypeError: Cannot read properties of undefined (reading 'id')
//       at cfgFor -> targetCfg -> DockerPanel -> ErrorBoundary
//
// `serverId` is component-local and outlives the server it names. Delete the
// server, or switch to a workspace without it, and the panel still holds the
// old id: `servers.find` returns undefined, `localSelected` is false, and
// `targetCfg()` calls `cfgFor(undefined)`.
//
// It is a RENDER-time call — the compose panel is handed a cfg as a prop — so
// it does not fail a button, it takes the whole panel down. Every other caller
// of targetCfg() sits behind a `hasTarget` guard inside an event handler.

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

describe('a server that disappears while the panel is open', () => {
  it('does not take the panel down', async () => {
    const user = userEvent.setup()
    stubBridge({
      docker: {
        list: () =>
          Promise.resolve({
            ok: true,
            version: '24.0.7',
            composeLabels: 'read',
            containers: []
          })
      }
    })

    // The selection has to be EXPLICIT. Without it `serverId` stays '' and the
    // panel falls to LOCAL_ID, which is a valid target — so the crash never
    // reproduces and the test passes with the fix reverted. Selecting writes
    // the id that later goes stale.
    const BRAVO = server('srv-bravo', 'bravo')
    const { rerender } = render(<DockerPanel servers={[ALPHA, BRAVO]} />)
    await user.selectOptions(screen.getByRole('combobox'), 'srv-bravo')
    await user.click(screen.getByRole('button', { name: /Read containers/ }))
    await waitFor(() => expect(screen.getByText(/Disk usage/)).toBeTruthy())

    // The selected server is gone. Nothing resets the panel's own `serverId`.
    expect(() => rerender(<DockerPanel servers={[ALPHA]} />)).not.toThrow()
    // And it is still usable rather than a blank error boundary. The label is
    // "Refresh" once a read has happened, which is why this does not look for
    // the one clicked above.
    await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy())
    expect(screen.getByRole('button', { name: /Refresh/ })).toBeTruthy()
  })

  it('falls back to a target that exists rather than holding the dead id', async () => {
    const user = userEvent.setup()
    stubBridge({
      docker: {
        list: () =>
          Promise.resolve({ ok: true, version: '24.0.7', composeLabels: 'read', containers: [] })
      }
    })
    const BRAVO = server('srv-bravo', 'bravo')
    const { rerender } = render(<DockerPanel servers={[ALPHA, BRAVO]} />)
    await user.selectOptions(screen.getByRole('combobox'), 'srv-bravo')

    rerender(<DockerPanel servers={[ALPHA]} />)

    // The select must not be blank: a stale id matching no option is what made
    // "the dropdown and the target can never disagree" untrue.
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).not.toBe('srv-bravo')
    expect([...select.options].some((o) => o.value === select.value)).toBe(true)
  })
})
