import { describe, expect, it, beforeEach } from 'vitest'
import { useApp } from '../src/renderer/src/store/app'

// The store actions the agent's workspace and folder tools lean on, and the
// rename the Workspaces dialog now offers.

beforeEach(() => {
  useApp.setState({
    workspaces: [
      { id: 'w1', name: 'One', color: 'green', hidden: false, locked: false, hasPassword: false },
      { id: 'w2', name: 'Two', color: 'purple', hidden: false, locked: false, hasPassword: false }
    ],
    folders: [],
    activeWorkspaceId: 'w1'
  } as never)
})

describe('workspaces', () => {
  it('renames one, trimmed, and ignores a blank name', () => {
    useApp.getState().renameWorkspace('w2', '  Staging ')
    expect(useApp.getState().workspaces[1].name).toBe('Staging')
    useApp.getState().renameWorkspace('w2', '   ')
    expect(useApp.getState().workspaces[1].name).toBe('Staging')
  })

  it('keeps a chosen color, and otherwise picks the first one no workspace has', () => {
    const chosen = useApp.getState().addWorkspace('Red', 'red')
    const picked = useApp.getState().addWorkspace('Next')
    const byId = (id: string) => useApp.getState().workspaces.find((w) => w.id === id)!
    expect(byId(chosen).color).toBe('red')
    expect(byId(picked).color).toBe('blue')
  })

  it('goes round the palette once every color is taken', () => {
    for (let i = 0; i < 5; i++) useApp.getState().addWorkspace(`W${i}`)
    const id = useApp.getState().addWorkspace('Eighth')
    expect(useApp.getState().workspaces.find((w) => w.id === id)!.color).toBe('green')
  })
})

describe('addFolder', () => {
  it('uses the active workspace when none is named, as the sidebar always has', () => {
    const id = useApp.getState().addFolder('Web')
    expect(useApp.getState().folders.find((f) => f.id === id)).toMatchObject({ workspaceId: 'w1', kind: 'server' })
  })

  it('uses the workspace it is given', () => {
    const id = useApp.getState().addFolder('Web', null, 'server', 'w2')
    expect(useApp.getState().folders.find((f) => f.id === id)!.workspaceId).toBe('w2')
  })
})
