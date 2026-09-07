import { describe, it, expect } from 'vitest'

import { hasBackupContent } from '../src/shared/backupContent'
import type { BackupContentState } from '../src/shared/backupContent'

const state = (over: Partial<BackupContentState> = {}): BackupContentState => ({
  workspaces: [{}],
  folders: [],
  servers: [],
  databases: [],
  tunnels: [],
  vpns: [],
  ...over
})

// A fresh install showed "Backup out of date" in red before the user had
// created anything. The staleness check watched `state.workspaces`, and the app
// creates a default workspace for itself on first run — so the first coloured
// signal in the product was a failure about data that did not exist.
//
// That teaches the reader the status bar cries wolf, on the same bar that later
// carries the alert count and the pending-approval chip.

describe('a workspace the app made for itself is not user data', () => {
  it('has nothing to back up on a fresh install', () => {
    expect(hasBackupContent(state())).toBe(false)
  })

  it('has nothing to back up with no workspace at all', () => {
    expect(hasBackupContent(state({ workspaces: [] }))).toBe(false)
  })

  // A second workspace is a decision somebody made; the first was made for them.
  it('counts a second workspace, even an empty one', () => {
    expect(hasBackupContent(state({ workspaces: [{}, {}] }))).toBe(true)
  })
})

describe('anything the user created counts', () => {
  it.each(['servers', 'databases', 'tunnels', 'vpns', 'folders'] as const)('counts %s', (key) => {
    expect(hasBackupContent(state({ [key]: [{}] }))).toBe(true)
  })

  // The test is about CONTENT, not about "is this the first run" — a user who
  // deletes their last server is back in the same state and should get the same
  // answer both times, rather than a permanent alarm because they once had one.
  it('goes quiet again when the last thing is deleted', () => {
    const withOne = state({ servers: [{}] })
    expect(hasBackupContent(withOne)).toBe(true)
    expect(hasBackupContent({ ...withOne, servers: [] })).toBe(false)
  })
})
