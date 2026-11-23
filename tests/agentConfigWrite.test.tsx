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
let fireCreate: ((e: { id: string; request: unknown }) => void) | null = null
let createReplies: { id: string; result: { ok: boolean; serverId?: string; error?: string } }[] = []
let deleted: string[] = []
let setCalls: { id: string; blob: string }[] = []
let replies: { id: string; result: { ok: boolean; error?: string } }[] = []
let stopped: string[] = []
// Saves and replies in the order they happened: a reply has to follow the save
// that refreshes main's cache, or the agent's next call misses the change.
let order: string[] = []
let retired: string[] = []
let closed: string[] = []

function mount(): void {
  fire = null
  fireCreate = null
  createReplies = []
  deleted = []
  setCalls = []
  replies = []
  stopped = []
  order = []
  retired = []
  closed = []
  stubBridge({
    aiMcp: {
      onCreateServerRequest: vi.fn((cb: (e: { id: string; request: unknown }) => void) => {
        fireCreate = cb
        return () => {}
      }),
      replyCreateServer: vi.fn((id: string, result: { ok: boolean; serverId?: string; error?: string }) => {
        createReplies.push({ id, result })
      }),
      onConfigWriteRequest: vi.fn((cb: (e: { id: string; request: unknown }) => void) => {
        fire = cb
        return () => {}
      }),
      replyConfigWrite: vi.fn((id: string, result: { ok: boolean; error?: string }) => {
        order.push(`reply:${id}`)
        replies.push({ id, result })
      })
    },
    data: {
      save: vi.fn(async () => {
        order.push('save')
      })
    },
    ssh: { poolEvict: vi.fn(async (id: string) => void retired.push(`ssh:${id}`)) },
    sftp: { disconnect: vi.fn(async (id: string) => void retired.push(`sftp:${id}`)) },
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
    },
    db: {
      close: vi.fn(async (id: string) => {
        closed.push(id)
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

const DATABASE = {
  id: 'd1',
  workspaceId: 'w1',
  name: 'Orders',
  kind: 'postgres',
  host: '10.0.0.5',
  port: 5432,
  username: 'app',
  database: 'orders',
  ssl: false,
  uri: false,
  folderId: null,
  sshServerId: null,
  vpnProfileId: null
}

const DB_FIELDS = {
  name: 'Billing',
  kind: 'mysql',
  host: '10.0.0.7',
  port: 3306,
  username: 'billing',
  database: '',
  ssl: false,
  uri: false,
  sshServerId: null
}

beforeEach(() => {
  useApp.setState({
    servers: [SERVER],
    workspaces: [
      { id: 'w1', name: 'W', color: 'green' },
      { id: 'w2', name: 'Other', color: 'purple' }
    ],
    folders: [
      { id: 'f1', workspaceId: 'w1', name: 'Web', parentId: null, kind: 'server' },
      { id: 'f-db', workspaceId: 'w1', name: 'DBs', parentId: null, kind: 'database' },
      { id: 'f-w2', workspaceId: 'w2', name: 'Elsewhere', parentId: null, kind: 'server' }
    ],
    tunnels: [{ id: 't1', workspaceId: 'w1', name: 'DB', kind: 'local', status: 'inactive', serverId: 's1', listen: '127.0.0.1:1', target: '10.0.0.1:2' }],
    databases: [DATABASE],
    openDatabaseIds: [],
    activeDatabaseId: null,
    activeWorkspaceId: 'w1',
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

  // Certificate auth is the key plus the certificate beside it, in one blob --
  // the shape AddServerModal writes and credentialResolver reads.
  it('stores the certificate path beside the key for certificate auth', async () => {
    mount()
    fire?.({
      id: 'r1',
      request: {
        kind: 'server.update',
        serverId: 's1',
        patch: { auth: 'certificate', keyPath: '/k', passphrase: 'p', certificatePath: '/ca/k-cert.pub' }
      }
    })

    await waitFor(() => expect(setCalls).toHaveLength(1))
    expect(JSON.parse(setCalls[0].blob)).toEqual({ keyPath: '/k', passphrase: 'p', certificatePath: '/ca/k-cert.pub' })
    expect(useApp.getState().servers[0].auth).toBe('certificate')
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

  it('lands in the workspace main named, not the one on screen', async () => {
    // It used to take activeWorkspaceId, so a tunnel an agent defined over a
    // carrier in one workspace appeared in whichever workspace was open.
    useApp.setState({ activeWorkspaceId: 'w-other' } as never)
    mount()
    fire?.({
      id: 'r1',
      request: { kind: 'tunnel.add', workspaceId: 'w1', name: 'Placed', tunnelKind: 'socks', serverId: 's1', listen: '127.0.0.1:1080', target: '' }
    })

    await waitFor(() => expect(replies).toHaveLength(1))
    expect(useApp.getState().tunnels.find((t) => t.name === 'Placed')!.workspaceId).toBe('w1')
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

describe('databases', () => {
  it('adds one to the named workspace and stores the credential under its id', async () => {
    useApp.setState({ activeWorkspaceId: 'w-other' } as never)
    mount()
    fire?.({ id: 'r1', request: { kind: 'database.add', workspaceId: 'w1', fields: DB_FIELDS, secret: { password: 'pw' } } })

    await waitFor(() => expect(replies).toHaveLength(1))
    expect(replies[0].result.ok).toBe(true)
    const added = useApp.getState().databases.find((d) => d.name === 'Billing')!
    expect(added.workspaceId).toBe('w1')
    // Never chosen by an agent, whatever it sent.
    expect(added.vpnProfileId).toBeNull()
    expect(setCalls).toEqual([{ id: added.id, blob: JSON.stringify({ password: 'pw' }) }])
  })

  it('takes the row back out when secure storage refuses the credential', async () => {
    mount()
    window.opsmaxx!.secrets.set = vi.fn(async () => false) as never
    fire?.({ id: 'r1', request: { kind: 'database.add', workspaceId: 'w1', fields: DB_FIELDS, secret: { password: 'pw' } } })

    await waitFor(() => expect(replies).toHaveLength(1))
    expect(replies[0].result.ok).toBe(false)
    expect(useApp.getState().databases.map((d) => d.name)).toEqual(['Orders'])
  })

  it('updates through the dialog\'s save path, bumping the revision, and keeps the credential when none was sent', async () => {
    mount()
    fire?.({ id: 'r1', request: { kind: 'database.update', databaseId: 'd1', patch: { port: 6432 } } })

    await waitFor(() => expect(replies).toHaveLength(1))
    const d = useApp.getState().databases[0]
    expect(d.port).toBe(6432)
    expect(d.rev).toBe(1)
    expect(setCalls).toHaveLength(0)
  })

  it('closes the pooled client and deletes the credential on removal', async () => {
    mount()
    fire?.({ id: 'r1', request: { kind: 'database.remove', databaseId: 'd1' } })

    await waitFor(() => expect(replies).toHaveLength(1))
    expect(closed).toContain('d1')
    expect(deleted).toContain('d1')
    expect(useApp.getState().databases).toHaveLength(0)
  })
})

describe('server folders', () => {
  const ADD = {
    workspaceId: 'w1',
    name: 'Web02',
    host: '10.0.0.9',
    port: 22,
    username: 'root',
    auth: 'agent'
  }

  it('files a new server under the folder it names', async () => {
    mount()
    fireCreate?.({ id: 'c1', request: { ...ADD, folderId: 'f1' } })

    await waitFor(() => expect(createReplies).toHaveLength(1))
    expect(createReplies[0].result.ok).toBe(true)
    expect(useApp.getState().servers.find((s) => s.name === 'Web02')!.folderId).toBe('f1')
  })

  it.each([
    ['in another workspace', 'f-w2', 'That folder is in a different workspace.'],
    ['for databases', 'f-db', 'That folder is not a server folder.'],
    ['that does not exist', 'f-gone', 'That folder no longer exists.']
  ])('refuses to add under a folder %s, and adds nothing', async (_what, folderId, error) => {
    mount()
    fireCreate?.({ id: 'c1', request: { ...ADD, folderId } })

    await waitFor(() => expect(createReplies).toHaveLength(1))
    expect(createReplies[0].result).toEqual({ ok: false, error })
    expect(useApp.getState().servers.map((s) => s.name)).toEqual(['Scanner01'])
  })

  it('moves a server into a folder, and back to the root with null', async () => {
    mount()
    fire?.({ id: 'r1', request: { kind: 'server.update', serverId: 's1', patch: { folderId: 'f1' } } })
    await waitFor(() => expect(replies).toHaveLength(1))
    expect(useApp.getState().servers[0].folderId).toBe('f1')

    fire?.({ id: 'r2', request: { kind: 'server.update', serverId: 's1', patch: { folderId: null } } })
    await waitFor(() => expect(replies).toHaveLength(2))
    expect(useApp.getState().servers[0].folderId).toBeNull()
  })

  it('leaves the folder alone when the patch does not mention one', async () => {
    useApp.setState({ servers: [{ ...SERVER, folderId: 'f1' }] } as never)
    mount()
    fire?.({ id: 'r1', request: { kind: 'server.update', serverId: 's1', patch: { port: 2200 } } })
    await waitFor(() => expect(replies).toHaveLength(1))
    expect(useApp.getState().servers[0].folderId).toBe('f1')
  })

  it('refuses a folder in another workspace and changes nothing else in the patch', async () => {
    // The workspace decides which session reaches a server; a move must never
    // be how a server ends up drawn inside another one.
    mount()
    fire?.({ id: 'r1', request: { kind: 'server.update', serverId: 's1', patch: { port: 2200, folderId: 'f-w2' } } })

    await waitFor(() => expect(replies).toHaveLength(1))
    expect(replies[0].result).toEqual({ ok: false, error: 'That folder is in a different workspace.' })
    expect(useApp.getState().servers[0]).toMatchObject({ workspaceId: 'w1', folderId: null, port: 22 })
  })

  it('refuses a database folder', async () => {
    mount()
    fire?.({ id: 'r1', request: { kind: 'server.update', serverId: 's1', patch: { folderId: 'f-db' } } })
    await waitFor(() => expect(replies).toHaveLength(1))
    expect(replies[0].result.ok).toBe(false)
    expect(useApp.getState().servers[0].folderId).toBeNull()
  })
})

describe('workspaces and folders', () => {
  it('creates a workspace, unlocked and visible, and answers with its id', async () => {
    mount()
    fire?.({ id: 'r1', request: { kind: 'workspace.add', name: '  Lab  ' } })

    await waitFor(() => expect(replies).toHaveLength(1))
    const ws = useApp.getState().workspaces.find((w) => w.name === 'Lab')!
    expect(replies[0].result).toEqual({ ok: true, id: ws.id })
    expect(ws).toMatchObject({ hidden: false, locked: false, hasPassword: false })
  })

  it('refuses a workspace with no name', async () => {
    mount()
    fire?.({ id: 'r1', request: { kind: 'workspace.add', name: '   ' } })
    await waitFor(() => expect(replies).toHaveLength(1))
    expect(replies[0].result).toEqual({ ok: false, error: 'A name is required.' })
    expect(useApp.getState().workspaces).toHaveLength(2)
  })

  it('renames a workspace, and refuses one that is gone', async () => {
    mount()
    fire?.({ id: 'r1', request: { kind: 'workspace.rename', workspaceId: 'w1', name: 'Prod' } })
    await waitFor(() => expect(replies).toHaveLength(1))
    expect(useApp.getState().workspaces[0].name).toBe('Prod')

    fire?.({ id: 'r2', request: { kind: 'workspace.rename', workspaceId: 'w-gone', name: 'X' } })
    await waitFor(() => expect(replies).toHaveLength(2))
    expect(replies[1].result).toEqual({ ok: false, error: 'That workspace no longer exists.' })
  })

  it('creates a server folder in the named workspace, not the one on screen', async () => {
    useApp.setState({ activeWorkspaceId: 'w2' } as never)
    mount()
    fire?.({ id: 'r1', request: { kind: 'folder.add', workspaceId: 'w1', name: 'API', parentId: 'f1' } })

    await waitFor(() => expect(replies).toHaveLength(1))
    const folder = useApp.getState().folders.find((f) => f.name === 'API')!
    expect(replies[0].result).toEqual({ ok: true, id: folder.id })
    expect(folder).toMatchObject({ workspaceId: 'w1', parentId: 'f1', kind: 'server' })
  })

  it.each([
    ['a parent in another workspace', { workspaceId: 'w1', parentId: 'f-w2' }, 'That folder is in a different workspace.'],
    ['a database parent', { workspaceId: 'w1', parentId: 'f-db' }, 'That folder is not a server folder.'],
    ['a workspace that is gone', { workspaceId: 'w-gone', parentId: null }, 'That workspace no longer exists.']
  ])('refuses a folder under %s', async (_what, where, error) => {
    mount()
    fire?.({ id: 'r1', request: { kind: 'folder.add', name: 'Nope', ...where } })
    await waitFor(() => expect(replies).toHaveLength(1))
    expect(replies[0].result).toEqual({ ok: false, error })
    expect(useApp.getState().folders.some((f) => f.name === 'Nope')).toBe(false)
  })

  it('renames a server folder but not a database one', async () => {
    mount()
    fire?.({ id: 'r1', request: { kind: 'folder.rename', folderId: 'f1', name: 'Frontend' } })
    await waitFor(() => expect(replies).toHaveLength(1))
    expect(useApp.getState().folders.find((f) => f.id === 'f1')!.name).toBe('Frontend')

    fire?.({ id: 'r2', request: { kind: 'folder.rename', folderId: 'f-db', name: 'X' } })
    await waitFor(() => expect(replies).toHaveLength(2))
    expect(replies[1].result).toEqual({ ok: false, error: 'That folder is not a server folder.' })
    expect(useApp.getState().folders.find((f) => f.id === 'f-db')!.name).toBe('DBs')
  })
})

describe('review round 1', () => {
  it('moves a server without retiring its connections or bumping its revision', async () => {
    // A move is a sidebar reshuffle. Going through updateServer dropped every
    // live terminal and SFTP session to the box for nothing.
    mount()
    fire?.({ id: 'r1', request: { kind: 'server.update', serverId: 's1', patch: { folderId: 'f1' } } })

    await waitFor(() => expect(replies).toHaveLength(1))
    expect(useApp.getState().servers[0].folderId).toBe('f1')
    expect(useApp.getState().servers[0].rev).toBeUndefined()
    expect(retired).toEqual([])
  })

  it('still retires connections when a move comes with a real change', async () => {
    mount()
    fire?.({ id: 'r1', request: { kind: 'server.update', serverId: 's1', patch: { folderId: 'f1', port: 2200 } } })
    await waitFor(() => expect(replies).toHaveLength(1))
    expect(useApp.getState().servers[0]).toMatchObject({ folderId: 'f1', port: 2200, rev: 1 })
    expect(retired).toContain('ssh:s1')
  })

  it.each([
    ['workspace.add', { kind: 'workspace.add', name: 'Lab' }],
    ['workspace.rename', { kind: 'workspace.rename', workspaceId: 'w1', name: 'Prod' }],
    ['folder.add', { kind: 'folder.add', workspaceId: 'w1', name: 'API', parentId: null }],
    ['folder.rename', { kind: 'folder.rename', folderId: 'f1', name: 'Frontend' }],
    ['a move', { kind: 'server.update', serverId: 's1', patch: { folderId: 'f1' } }]
  ])('saves before answering %s, so the next tool call sees it', async (_what, request) => {
    mount()
    fire?.({ id: 'r1', request })
    await waitFor(() => expect(replies).toHaveLength(1))
    expect(replies[0].result.ok).toBe(true)
    expect(order).toEqual(['save', 'reply:r1'])
  })

  it('marks a workspace an agent made', async () => {
    mount()
    fire?.({ id: 'r1', request: { kind: 'workspace.add', name: 'Lab' } })
    await waitFor(() => expect(replies).toHaveLength(1))
    expect(useApp.getState().workspaces.find((w) => w.name === 'Lab')!.agentCreated).toBe(true)
  })

  it.each([
    ['folder.add', { kind: 'folder.add', workspaceId: 'w1', name: 'ｗｅｂ', parentId: null }],
    ['folder.rename', { kind: 'folder.rename', folderId: 'f-new', name: 'WEB' }]
  ])('%s refuses a sibling name that differs only in case or form', async (_what, request) => {
    useApp.setState((s) => ({ folders: [...s.folders, { id: 'f-new', workspaceId: 'w1', name: 'New', parentId: null, kind: 'server' }] }) as never)
    mount()
    fire?.({ id: 'r1', request })
    await waitFor(() => expect(replies).toHaveLength(1))
    expect(replies[0].result).toEqual({ ok: false, error: 'A folder with that name already exists there.' })
  })

  it('lets a folder be renamed to a new case of its own name', async () => {
    mount()
    fire?.({ id: 'r1', request: { kind: 'folder.rename', folderId: 'f1', name: 'WEB' } })
    await waitFor(() => expect(replies).toHaveLength(1))
    expect(replies[0].result.ok).toBe(true)
  })

  describe('a locked workspace', () => {
    beforeEach(() => {
      useApp.setState((s) => ({
        workspaces: s.workspaces.map((w) => (w.id === 'w1' ? { ...w, hasPassword: true } : w)),
        unlockedWorkspaces: []
      }) as never)
    })

    it.each([
      ['workspace.rename', { kind: 'workspace.rename', workspaceId: 'w1', name: 'X' }],
      ['folder.add', { kind: 'folder.add', workspaceId: 'w1', name: 'X', parentId: null }],
      ['folder.rename', { kind: 'folder.rename', folderId: 'f1', name: 'X' }],
      ['a move', { kind: 'server.update', serverId: 's1', patch: { folderId: 'f1' } }],
      ['a move to the root', { kind: 'server.update', serverId: 's1', patch: { folderId: null } }]
    ])('refuses %s', async (_what, request) => {
      mount()
      fire?.({ id: 'r1', request })
      await waitFor(() => expect(replies).toHaveLength(1))
      expect(replies[0].result).toEqual({ ok: false, error: 'That workspace is locked in OpsMaxx.' })
    })

    it('refuses to add a server into one of its folders', async () => {
      mount()
      fireCreate?.({
        id: 'c1',
        request: { workspaceId: 'w1', name: 'Web03', host: '10.0.0.3', port: 22, username: 'root', auth: 'agent', folderId: 'f1' }
      })
      await waitFor(() => expect(createReplies).toHaveLength(1))
      expect(createReplies[0].result).toEqual({ ok: false, error: 'That workspace is locked in OpsMaxx.' })
    })

    it('allows all of it once unlocked', async () => {
      useApp.setState({ unlockedWorkspaces: ['w1'] } as never)
      mount()
      fire?.({ id: 'r1', request: { kind: 'workspace.rename', workspaceId: 'w1', name: 'Prod' } })
      await waitFor(() => expect(replies).toHaveLength(1))
      expect(replies[0].result.ok).toBe(true)
    })
  })
})

describe('review round 2', () => {
  const LOCKED_W1 = () =>
    useApp.setState((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === 'w1' ? { ...w, hasPassword: true } : w)),
      unlockedWorkspaces: []
    }) as never)
  const ADD = { workspaceId: 'w1', name: 'Web04', host: '10.0.0.4', port: 22, username: 'root', auth: 'agent' }

  it('refuses any server added to a locked workspace, folder or not', async () => {
    LOCKED_W1()
    mount()
    fireCreate?.({ id: 'c1', request: ADD })
    await waitFor(() => expect(createReplies).toHaveLength(1))
    expect(createReplies[0].result).toEqual({ ok: false, error: 'That workspace is locked in OpsMaxx.' })
    expect(useApp.getState().servers.map((s) => s.name)).toEqual(['Scanner01'])
  })

  it('refuses any edit to a server in a locked workspace', async () => {
    LOCKED_W1()
    mount()
    fire?.({ id: 'r1', request: { kind: 'server.update', serverId: 's1', patch: { port: 2200 } } })
    await waitFor(() => expect(replies).toHaveLength(1))
    expect(replies[0].result).toEqual({ ok: false, error: 'That workspace is locked in OpsMaxx.' })
    expect(useApp.getState().servers[0].port).toBe(22)
  })

  it('still lets a server in a locked workspace be removed', async () => {
    LOCKED_W1()
    mount()
    fire?.({ id: 'r1', request: { kind: 'server.remove', serverId: 's1' } })
    await waitFor(() => expect(replies).toHaveLength(1))
    expect(replies[0].result.ok).toBe(true)
  })

  it('saves before answering every add, not only one into a folder', async () => {
    mount()
    fireCreate?.({ id: 'c1', request: ADD })
    await waitFor(() => expect(createReplies).toHaveLength(1))
    expect(order[0]).toBe('save')
  })

  it('answers ok when the write fails, and tries the write again', async () => {
    // The change exists in the app; an error would have the agent make it twice.
    mount()
    let calls = 0
    window.opsmaxx!.data.save = vi.fn(async () => {
      calls++
      if (calls === 1) throw new Error('disk full')
    }) as never
    fire?.({ id: 'r1', request: { kind: 'workspace.add', name: 'Lab' } })
    await waitFor(() => expect(replies).toHaveLength(1))
    expect(replies[0].result.ok).toBe(true)
    await waitFor(() => expect(calls).toBe(2), { timeout: 2000 })
  })
})
