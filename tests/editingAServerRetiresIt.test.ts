import { describe, expect, it, beforeEach } from 'vitest'
import { useApp } from '../src/renderer/src/store/app'
import { saveDatabaseEdit } from '../src/renderer/src/store/dbEditor'

/**
 * Saving a connection profile retires the connections made to the old one.
 *
 * Two records, the same bug, asserted together because they were the same
 * oversight: a server (below) and a database (at the end of this file).
 *
 * `updateServer` was a pure spread with no side effects at all — compare
 * `deleteServer` directly below it, which has forgotten alerts, metrics and
 * tabs since the day it was written. So editing a server's host, pressing
 * Save and clicking it in the sidebar landed on the previous machine: main's
 * connection pool, the SFTP browser and the metrics sampler are each keyed on
 * the server id, which an edit does not change.
 *
 * `rev` is what those keys now carry. It is a COUNTER rather than a hash of
 * the record, and the empty-patch case below is why: rotating a password
 * changes nothing on this record — the secret lives in the OS keychain — and
 * a credential-only save still has to invalidate. `AddServerModal` calls
 * `updateServer(editId, fields)` on every edit save before it writes the
 * secret, so the unconditional bump is what turns that into an invalidation.
 */

const server = {
  id: 's1',
  workspaceId: 'w1',
  folderId: null,
  name: 'Test',
  host: '10.0.0.1',
  port: 22,
  username: 'root',
  auth: 'password' as const,
  status: 'offline' as const,
  tags: [],
  favorite: false,
  os: 'Linux',
  route: [],
  vpnProfileId: null
}

describe('updateServer bumps the record revision', () => {
  beforeEach(() => {
    useApp.setState({ servers: [{ ...server }] })
  })

  const rev = (): number | undefined => useApp.getState().servers[0].rev

  it('starts absent, meaning never edited', () => {
    // Every record saved before this field existed has none, and must keep the
    // pool key it has today rather than being re-authenticated on upgrade.
    expect(rev()).toBeUndefined()
  })

  it('bumps on a field edit', () => {
    useApp.getState().updateServer('s1', { host: '10.0.0.2' })
    expect(rev()).toBe(1)
    expect(useApp.getState().servers[0].host).toBe('10.0.0.2')
  })

  it('bumps on a save that changed no field', () => {
    // The secret-only path. A hash of the record could not see this.
    useApp.getState().updateServer('s1', {})
    expect(rev()).toBe(1)
    useApp.getState().updateServer('s1', {})
    expect(rev()).toBe(2)
  })

  it('cannot have a stale revision echoed back into it', () => {
    useApp.getState().updateServer('s1', { host: '10.0.0.2' })
    // A caller passing a whole record back — the modal does — must not carry
    // the revision it read before its own edit.
    useApp.getState().updateServer('s1', { ...server, rev: 0 } as never)
    expect(rev()).toBe(2)
  })

  it('leaves other servers alone', () => {
    useApp.setState({ servers: [{ ...server }, { ...server, id: 's2' }] })
    useApp.getState().updateServer('s1', { host: '10.0.0.2' })
    expect(useApp.getState().servers[1].rev).toBeUndefined()
  })
})

/**
 * The same thing for a saved database.
 *
 * `saveDatabaseEdit` had the identical shape: a spread over the record with no
 * invalidation, while main keeps one client per database id. So correcting a
 * wrong port — the exact case the editor was written for, per its own comment
 * that the only alternative used to be deleting the profile and typing it all
 * again — left the next query answered by the connection to the old one.
 */
describe('saveDatabaseEdit bumps the record revision', () => {
  const db = {
    id: 'db1',
    workspaceId: 'w1',
    name: 'Prod',
    kind: 'postgres' as const,
    host: '10.0.0.1',
    port: 5432,
    username: 'app',
    database: 'app',
    ssl: false,
    uri: false,
    folderId: null,
    sshServerId: null,
    vpnProfileId: null
  }

  beforeEach(() => {
    useApp.setState({ databases: [{ ...db }] })
  })

  const rev = (): number | undefined => useApp.getState().databases[0].rev

  it('starts absent, meaning never edited', () => {
    expect(rev()).toBeUndefined()
  })

  it('bumps on a field edit', () => {
    saveDatabaseEdit('db1', { port: 5433 })
    expect(rev()).toBe(1)
    expect(useApp.getState().databases[0].port).toBe(5433)
  })

  it('bumps on a save that changed no field', () => {
    // The password-only correction. The secret lives in the vault or the
    // keychain and changes nothing on this record.
    saveDatabaseEdit('db1', {})
    saveDatabaseEdit('db1', {})
    expect(rev()).toBe(2)
  })

  it('leaves other databases alone', () => {
    useApp.setState({ databases: [{ ...db }, { ...db, id: 'db2' }] })
    saveDatabaseEdit('db1', { port: 5433 })
    expect(useApp.getState().databases[1].rev).toBeUndefined()
  })
})
