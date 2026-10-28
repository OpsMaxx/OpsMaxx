// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { stubBridge } from './setup/renderer'
import { initPersistence } from '../src/renderer/src/store/persist'
import { useApp } from '../src/renderer/src/store/app'

/**
 * A workspace's lock belongs to this device. The synced workspace record
 * carries `hasPassword`, and another device sending `false` unlocked the
 * workspace here, because a synced reload replaced the flags and nothing
 * checked them against the lock file in main again.
 */
describe('a synced workspaces list', () => {
  it('cannot unlock a workspace that is locked on this device', async () => {
    const locked = { id: 'ws-prod', name: 'Prod', hasPassword: true, locked: true }
    let onExternal: ((c: string[]) => void) | undefined
    let saved: Record<string, unknown> = { version: 2, servers: [], workspaces: [locked], activeWorkspaceId: 'ws-prod' }
    stubBridge({
      data: {
        load: async () => saved,
        save: async () => undefined,
        onExternalChange: (cb: (c: string[]) => void) => {
          onExternal = cb
        }
      },
      workspaceLock: { ids: async () => ['ws-prod'] },
      addy: { held: async () => [] },
      vault: { setAutoLock: async () => undefined },
      ssh: { setPoolIdle: async () => undefined },
      jobs: { setDetached: async () => undefined }
    } as never)
    await initPersistence()
    expect(useApp.getState().isWorkspaceAccessible('ws-prod')).toBe(false)

    // Another device pushes the same workspace with the lock flag cleared.
    saved = { ...saved, workspaces: [{ ...locked, hasPassword: false, locked: false }] }
    onExternal?.(['workspaces'])
    await new Promise((r) => setTimeout(r, 20))

    expect(useApp.getState().isWorkspaceAccessible('ws-prod')).toBe(false)
  })
})
