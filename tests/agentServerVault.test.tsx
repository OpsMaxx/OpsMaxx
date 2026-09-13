// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { AgentConfigWatcher } from '../src/renderer/src/components/ai/AgentConfigWatcher'
import { useApp } from '../src/renderer/src/store/app'
import { useVault } from '../src/renderer/src/store/vault'

/**
 * Where an AI-added server's credential lands.
 *
 * The vault is where a credential belongs — one record, reusable, rotated in
 * one place, and it travels inside an encrypted backup where a keychain copy
 * cannot. So this path prefers it, like the two Add dialogs do.
 *
 * What it must NOT do is prompt. There is no person in this path by
 * definition: raising a master-password dialog because an agent did something
 * unattended is the same defect this whole change is removing, wearing a
 * different hat. So it takes the vault when the vault is already open and the
 * keychain otherwise, and never asks.
 */

const REQUEST = {
  workspaceId: 'w1',
  name: 'Bastion',
  host: '10.0.0.1',
  port: 22,
  username: 'deploy',
  auth: 'password' as const,
  password: 'hunter2'
}

let fire: ((e: { id: string; request: unknown }) => void) | null = null
let stored: { id: string; blob: string } | null = null

function mount(): void {
  stored = null
  fire = null
  stubBridge({
    aiMcp: {
      onCreateServerRequest: vi.fn((cb: (e: { id: string; request: unknown }) => void) => {
        fire = cb
        return () => {}
      }),
      replyCreateServer: vi.fn()
    },
    secrets: {
      set: vi.fn(async (id: string, blob: string) => {
        stored = { id, blob }
        return true
      })
    }
  })
  render(<AgentConfigWatcher />)
}

beforeEach(() => {
  useApp.setState({ servers: [], workspaces: [{ id: 'w1', name: 'W' }] } as never)
})

describe('a server an AI agent adds', () => {
  it('puts the credential in the vault when the vault is open', async () => {
    const createEntry = vi.fn(async () => 'v-new')
    useVault.setState({ stage: 'open', unlocked: true, entries: [], createEntry } as never)
    mount()

    fire?.({ id: 'r1', request: REQUEST })

    await waitFor(() => expect(stored).not.toBeNull())
    expect(createEntry).toHaveBeenCalledOnce()
    // A reference, not a copy. The password itself never reaches the keychain
    // blob, which is the whole difference between one record and three.
    expect(JSON.parse(stored!.blob)).toEqual({ vaultEntryId: 'v-new' })
  })

  it('falls back to the keychain when the vault is secured, without prompting', async () => {
    const createEntry = vi.fn(async () => 'v-new')
    useVault.setState({ stage: 'secured', unlocked: false, entries: [], createEntry } as never)
    mount()

    fire?.({ id: 'r1', request: REQUEST })

    await waitFor(() => expect(stored).not.toBeNull())
    expect(createEntry).not.toHaveBeenCalled()
    expect(JSON.parse(stored!.blob)).toEqual({ password: 'hunter2' })
  })

  it('falls back to the keychain when the vault write fails, so nothing is lost', async () => {
    const createEntry = vi.fn(async () => null)
    useVault.setState({ stage: 'open', unlocked: true, entries: [], createEntry } as never)
    mount()

    fire?.({ id: 'r1', request: REQUEST })

    await waitFor(() => expect(stored).not.toBeNull())
    expect(JSON.parse(stored!.blob)).toEqual({ password: 'hunter2' })
  })
})
