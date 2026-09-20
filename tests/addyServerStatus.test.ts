import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A connection is not a setting, and must not cross a device boundary.
 *
 * `Server.status` — online, connecting, idle, offline — is live state about a
 * socket THIS machine holds. It lives on the `Server` record because that is
 * where the list renders it from, and the record is saved into
 * `opsmaxx-data.json`, which is how it ended up inside a synced collection
 * without anyone deciding it should be.
 *
 * Reported from a real pair of devices: the second machine imported the estate
 * and every indicator in the sidebar was green, while nothing was connected and
 * monitoring was empty. Those were the first device's sockets, drawn on the
 * second device's screen. A status indicator that is green for a machine you
 * have never dialled is worse than no indicator: it is the one widget whose
 * entire job is to answer "is this up", answering confidently and wrongly.
 *
 * So an arriving `servers` collection lands DISCONNECTED. Not "unknown": the
 * type has four states and none of them means "no opinion", and `offline` is
 * the true one for a machine this process has no connection to — which is
 * exactly what it has, a moment after a sync.
 */

const userData = mkdtempSync(join(tmpdir(), 'opsmaxx-addy-server-status-'))
vi.mock('electron', () => ({
  app: { getPath: () => userData, getVersion: () => '0' }
}))

const { SOURCES } = await import('../src/main/services/addy/collections')

const DATA = join(userData, 'opsmaxx-data.json')

const inbound = (servers: unknown[]): Buffer => Buffer.from(JSON.stringify(servers), 'utf8')

const storedServers = (): Array<Record<string, unknown>> =>
  (JSON.parse(readFileSync(DATA, 'utf8')) as { servers: Array<Record<string, unknown>> }).servers

beforeEach(() => rmSync(DATA, { force: true }))

describe('the servers collection, arriving from another device', () => {
  it('lands disconnected however connected it was on the device that sent it', () => {
    SOURCES.servers!.write(
      inbound([
        { id: 'a', name: 'web-1', host: 'x', status: 'online' },
        { id: 'b', name: 'db-1', host: 'y', status: 'connecting' },
        { id: 'c', name: 'edge-1', host: 'z', status: 'idle' }
      ])
    )

    expect(storedServers().map((s) => s.status)).toEqual(['offline', 'offline', 'offline'])
  })

  it('keeps everything else about the server exactly as it arrived', () => {
    // The point is narrow. A server's name, host, route, tags and folder are
    // the reason the collection is carried at all, and a fix that quietly
    // normalised any of them would be a worse bug than the one it replaced.
    SOURCES.servers!.write(
      inbound([
        {
          id: 'a',
          name: 'web-1',
          host: 'example.internal',
          port: 2222,
          username: 'deploy',
          auth: 'key',
          status: 'online',
          tags: ['prod'],
          favorite: true,
          folderId: null
        }
      ])
    )

    const [s] = storedServers()
    expect(s).toMatchObject({
      id: 'a',
      name: 'web-1',
      host: 'example.internal',
      port: 2222,
      username: 'deploy',
      auth: 'key',
      tags: ['prod'],
      favorite: true,
      folderId: null
    })
  })

  it('gives a server that arrived without a status one anyway', () => {
    // Absent is what a device running a build that stopped sending the field
    // would write. The renderer's indicator reads `status` directly, so an
    // undefined there renders as nothing at all.
    SOURCES.servers!.write(inbound([{ id: 'a', name: 'web-1', host: 'x' }]))

    expect(storedServers()[0].status).toBe('offline')
  })

  it('writes an empty estate through unchanged', () => {
    // Deleting your last server is a real edit that has to travel. Nothing
    // here may turn it into a no-op.
    SOURCES.servers!.write(inbound([]))

    expect(existsSync(DATA)).toBe(true)
    expect(storedServers()).toEqual([])
  })
})
