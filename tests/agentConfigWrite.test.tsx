// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { AgentConfigWatcher } from '../src/renderer/src/components/ai/AgentConfigWatcher'
import { useApp } from '../src/renderer/src/store/app'

/**
 * The renderer half of update_server, remove_server and the tunnel tools.
 *
 * Main cannot do any of this: the renderer owns the connection list and the
 * persistence that auto-saves from it, and that save is what refreshes the
 * cache main reads back. So the tools ask, and this is what answers.
 *
 * The two behaviours worth pinning are both about NOT losing something: a
 * removal has to take the credential with it (deleteServer does not), and an
 * update must not wipe a credential nobody asked it to touch.
 */

let fire: ((e: { id: string; request: unknown }) => void) | null = null
let deleted: string[] = []
let setCalls: { id: string; blob: string }[] = []
let replies: { id: string; result: { ok: boolean; error?: string } }[] = []
let stopped: string[] = []

function mount(): void {
  fire = null
  deleted = []
  setCalls = []
  replies = []
  stopped = []
  stubBridge({
    aiMcp: {
      onCreateServerRequest: vi.fn(() => () => {}),
      replyCreateServer: vi.fn(),
      onConfigWriteRequest: vi.fn((cb: (e: { id: string; request: unknown }) => void) => {
        fire = cb
        return () => {}
      }),
      replyConfigWrite: vi.fn((id: string, result: { ok: boolean; error?: string }) => {
        replies.push({ id, result })
      })
    },
    secrets: {
      set: vi.fn(async (id: string, blob: string) => {
        setCalls.push({ id, blob })
        return true
      }),
      delete: vi.fn(async (id: string) => {
        deleted.push(id)
        return true
      })
    },
    tunnel: {
      stop: vi.fn(async (id: string) => {
        stopped.push(id)
      })
    }
  })
  render(<AgentConfigWatcher />)
}

const SERVER = {
  id: 's1',
  workspaceId: 'w1',
  folderId: null,
  name: 'Scanner01',
  host: '10.21.15.7',
  port: 22,
  username: 'root',
  auth: 'key',
  status: 'offline',
  tags: [],
  favorite: false,
  os: 'Linux',
  route: [],
  vpnProfileId: null
}

beforeEach(() => {
  useApp.setState({
    servers: [SERVER],
    workspaces: [{ id: 'w1', name: 'W' }],
    tunnels: [{ id: 't1', workspaceId: 'w1', name: 'DB', kind: 'local', status: 'inactive', serverId: 's1', listen: '127.0.0.1:1', target: '10.0.0.1:2' }],
    tabs: []
  } as never)
})

describe('removing a server', () => {
  it('deletes the stored credential as well as the row', async () => {
    // deleteServer forgets alerts, metrics and tabs but NOT the credential --
    // ConnectionTree does that separately. A removal that left one behind would
    // be the worst possible half-completion for a tool whose purpose is cleanup.
    mount()
    fire?.({ id: 'r1', request: { kind: 'server.remove', serverId: 's1' } })

    await waitFor(() => expect(replies).toHaveLength(1))
    expect(replies[0].result.ok).toBe(true)
    expect(useApp.getState().servers).toHaveLength(0)
    expect(deleted).toContain('s1')
    // The RDP credential rides a second key off the same server id.
    expect(deleted.length).toBeGreaterThan(1)
  })

  it('reports a failure rather than a success when the server is already gone', async () => {
    mount()
    fire?.({ id: 'r1', request: { kind: 'server.remove', serverId: 'nope' } })

    await waitFor(() => expect(replies).toHaveLength(1))
    expect(replies[0].result.ok).toBe(false)
  })
})

describe('updating a server', () => {
  it('leaves the credential alone when the patch carries none', async () => {
    // The failure this prevents: changing a port and silently erasing the key
    // the connection has been authenticating with ever since.
    mount()
    fire?.({ id: 'r1', request: { kind: 'server.update', serverId: 's1', patch: { port: 2222 } } })

    await waitFor(() => expect(replies).toHaveLength(1))
    expect(useApp.getState().servers[0].port).toBe(2222)
    expect(setCalls).toHaveLength(0)
  })

  it('writes a new credential when one was sent', async () => {
    mount()
    fire?.({
      id: 'r1',
      request: { kind: 'server.update', serverId: 's1', patch: { auth: 'password', password: 'hunter2' } }
    })

    await waitFor(() => expect(setCalls).toHaveLength(1))
    expect(setCalls[0].id).toBe('s1')
    expect(JSON.parse(setCalls[0].blob).password).toBe('hunter2')
  })

  it('applies a jump chain, giving each hop the id the store expects', async () => {
    mount()
    fire?.({
      id: 'r1',
      request: {
        kind: 'server.update',
        serverId: 's1',
        patch: {
          route: [{ serverId: 'bastion', label: 'Bastion', host: '10.21.15.239', port: 22, username: 'root', auth: 'key' }]
        }
      }
    })

    await waitFor(() => expect(replies).toHaveLength(1))
    const route = useApp.getState().servers[0].route
    expect(route).toHaveLength(1)
    expect(route[0].serverId).toBe('bastion')
    // Minted here rather than sent across: it is the store's own key for a row
    // in the route editor and means nothing outside this window.
    expect(route[0].id).toBeTruthy()
  })
})

describe('tunnels', () => {
  it('defines one without starting it', async () => {
    mount()
    fire?.({
      id: 'r1',
      request: {
        kind: 'tunnel.add',
        workspaceId: 'w1',
        name: 'New forward',
        tunnelKind: 'local',
        serverId: 's1',
        listen: '127.0.0.1:15432',
        target: '10.0.0.5:5432'
      }
    })

    await waitFor(() => expect(replies).toHaveLength(1))
    const added = useApp.getState().tunnels.find((t) => t.name === 'New forward')!
    expect(added.status).toBe('inactive')
  })

  it('stops a running forward before forgetting its record', async () => {
    // A listener whose record is gone is one nothing in the UI can close.
    mount()
    fire?.({ id: 'r1', request: { kind: 'tunnel.remove', tunnelId: 't1' } })

    await waitFor(() => expect(replies).toHaveLength(1))
    expect(stopped).toContain('t1')
    expect(useApp.getState().tunnels).toHaveLength(0)
  })
})
