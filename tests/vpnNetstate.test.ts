import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const h = vi.hoisted(() => ({
  replies: new Map<string, { code?: number; stdout?: string; stderr?: string }>()
}))

vi.mock('node:child_process', () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (e: unknown, stdout: string, stderr: string) => void
  ) => {
    const reply = h.replies.get(`${cmd} ${args.join(' ')}`) ?? { code: 1, stderr: 'no fixture' }
    const code = reply.code ?? 0
    setImmediate(() =>
      code === 0
        ? cb(null, reply.stdout ?? '', reply.stderr ?? '')
        : cb(Object.assign(new Error(`exit ${code}`), { code }), reply.stdout ?? '', reply.stderr ?? '')
    )
    return undefined
  },
  spawn: () => {
    throw new Error('spawn is not used by netstate')
  }
}))

import {
  applyNetState,
  bootTime,
  clearNetState,
  netStatePath,
  parseNetState,
  readNetState,
  restoreOrphanedNetstate,
  revertNetState,
  writeNetState
} from '../src/main/services/vpn/netstate'
import type { NetApplyContext, NetStateFile, PrivilegedResult } from '../src/main/services/vpn/netstate'
import { parseResolvConf } from '../src/main/services/vpn/dns/linux'
import { buildQueryScript } from '../src/main/services/vpn/dns/win32'
import { runTag } from '../src/main/services/vpn/dns/index'

// Not exported from win32.ts — it is that module's private invocation, and the
// point of spelling it out here is that the fixture key has to match what the
// manager really runs, character for character.
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']

// applyNetState reads the resolver back after a DNS apply, and the privileged
// channel in these tests is a recorder that changes nothing — so the resolver
// still reports whatever this host was already using. Planning exactly those
// servers keeps the ordering tests below about ordering, without pretending a
// change landed that never did. (No resolvectl fixture is registered, so the
// Linux manager takes its resolv.conf branch on every host, including one
// without the file at all.)
function hostResolvers(): string[] {
  try {
    return parseResolvConf(readFileSync('/etc/resolv.conf', 'utf8')).servers
  } catch {
    return []
  }
}

// RFC 5737 reserves this range, so no host's resolver is ever really using it —
// which is what makes a plan naming it impossible to verify on any machine.
const UNREACHED_DNS = '192.0.2.53'

let root: string
let runDir: string

interface Recorder {
  ctx: NetApplyContext
  calls: { cmd: string; args: string[]; snapshotOnDisk: boolean }[]
  result: PrivilegedResult
  fail?: boolean
}

function recorder(runId = 'run-1'): Recorder {
  const rec: Recorder = {
    calls: [],
    result: { code: 0, stdout: '', stderr: '' },
    ctx: {
      runId,
      runDir,
      supportsStdin: true,
      runPrivileged: async (cmd, args) => {
        // Recorded per call: the ordering guarantee is that no privileged
        // command ever runs before the snapshot is durable.
        rec.calls.push({ cmd, args, snapshotOnDisk: existsSync(netStatePath(runId, root)) })
        if (rec.fail) return { code: 1, stdout: '', stderr: 'nope' }
        return rec.result
      }
    }
  }
  return rec
}

function baseState(over: Partial<NetStateFile> = {}): NetStateFile {
  return {
    version: 1,
    runId: 'orphan-1',
    platform: 'linux',
    interfaceName: 'wg0',
    appliedAt: Date.now(),
    bootAt: bootTime(),
    ...over
  }
}

function seedOrphan(state: NetStateFile): void {
  mkdirSync(join(root, state.runId), { recursive: true })
  writeFileSync(join(root, state.runId, 'netstate.json'), JSON.stringify(state))
}

beforeEach(() => {
  h.replies.clear()
  root = mkdtempSync(join(tmpdir(), 'opsmaxx-netstate-'))
  runDir = mkdtempSync(join(tmpdir(), 'opsmaxx-rundir-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(runDir, { recursive: true, force: true })
})

describe('netstate file', () => {
  it('writes into the run directory, owner-only', async () => {
    const file = await writeNetState(baseState({ runId: 'run-1' }), root)
    expect(file).toBe(netStatePath('run-1', root))
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(statSync(join(root, 'run-1')).mode & 0o777).toBe(0o700)
    }
    expect((await readNetState('run-1', root))?.interfaceName).toBe('wg0')
  })

  it('refuses a file it cannot trust rather than reverting against undefined', () => {
    expect(parseNetState('not json')).toBeNull()
    expect(parseNetState('{"version":2,"runId":"a"}')).toBeNull()
    expect(parseNetState('{"version":1}')).toBeNull()
    expect(parseNetState(JSON.stringify(baseState()))).not.toBeNull()
  })

  it('clears without complaint when there is nothing to clear', async () => {
    await expect(clearNetState('never-existed', root)).resolves.toBeUndefined()
  })
})

describe('apply ordering', () => {
  it('persists the snapshot before the first change reaches the system (E14)', async () => {
    const rec = recorder()
    const state = await applyNetState(
      {
        interfaceName: 'wg0',
        routes: [{ destination: '10.8.0.0/24', interfaceName: 'wg0' }],
        dns: { servers: hostResolvers(), searchDomains: [], interfaceName: 'wg0' }
      },
      rec.ctx,
      { platform: 'linux', root }
    )
    expect(rec.calls.length).toBeGreaterThan(0)
    // Every one of them, not just the first: a later apply step still has to
    // be undoable if the process dies between two of them.
    expect(rec.calls.every((c) => c.snapshotOnDisk)).toBe(true)
    expect(state.routes?.planned).toEqual([{ destination: '10.8.0.0/24', interfaceName: 'wg0' }])
    expect(state.dns?.runId).toBe('run-1')
    expect(state.dns?.planned?.servers).toEqual(hostResolvers())
    expect(await readNetState('run-1', root)).toEqual(JSON.parse(JSON.stringify(state)))
  })

  it('applies routes before DNS, and reverts DNS before routes', async () => {
    const rec = recorder()
    const state = await applyNetState(
      {
        interfaceName: 'wg0',
        routes: [{ destination: '10.8.0.0/24', interfaceName: 'wg0' }],
        dns: { servers: hostResolvers(), searchDomains: [], interfaceName: 'wg0' }
      },
      rec.ctx,
      { platform: 'linux', root }
    )
    expect(rec.calls.map((c) => c.cmd)).toEqual(['ip', 'install'])
    rec.calls.length = 0
    await revertNetState(state, rec.ctx, { platform: 'linux', root })
    // Which command puts the resolver back depends on whether this host's
    // /etc/resolv.conf is a symlink; that it goes before the routes does not.
    expect(rec.calls).toHaveLength(2)
    expect(['install', 'ln']).toContain(rec.calls[0].cmd)
    expect(rec.calls[1].cmd).toBe('ip')
  })

  it('rolls back what it managed to apply when a later step fails', async () => {
    const rec = recorder()
    rec.fail = true
    await expect(
      applyNetState(
        { interfaceName: 'wg0', routes: [{ destination: '10.8.0.0/24', interfaceName: 'wg0' }] },
        rec.ctx,
        { platform: 'linux', root }
      )
    ).rejects.toMatchObject({ name: 'VpnError' })
    expect(rec.calls.map((c) => c.args.slice(0, 3))).toEqual([
      ['-4', 'route', 'replace'],
      ['-4', 'route', 'del']
    ])
    // The snapshot stays on disk: a rollback that itself failed is exactly
    // what the startup pass is for.
    expect(existsSync(netStatePath('run-1', root))).toBe(true)
  })

  it('refuses a DNS change the resolver never picked up', async () => {
    // The whole reason verify() exists: every DNS command here exits 0 whether
    // or not the resolver took the change, so this recorder's cheerful exit 0
    // is exactly what a silently ignored apply looks like from in here.
    const rec = recorder()
    await expect(
      applyNetState(
        {
          interfaceName: 'wg0',
          dns: { servers: [UNREACHED_DNS], searchDomains: [], interfaceName: 'wg0' }
        },
        rec.ctx,
        { platform: 'linux', root }
      )
    ).rejects.toMatchObject({
      name: 'VpnError',
      // Its own code, not 'internal' and certainly not 'dns-failure' — that one
      // means a name could not be looked up and would send the reader to check
      // their own DNS settings when it is ours that did not stick.
      code: 'dns-not-applied',
      detail: expect.stringContaining('did not take effect')
    })
    // And it is rolled back rather than left half-applied.
    expect(['install', 'ln']).toContain(rec.calls[rec.calls.length - 1].cmd)
  })

  // win32 rather than linux for the two cases below: every command the NRPT
  // manager runs is a fixture here, including the read-back, so "the resolver
  // says the old servers" and "the read-back could not be performed" can be
  // staged exactly rather than inferred from whatever this host's resolver
  // happens to be doing.
  const NRPT_QUERY = `powershell.exe ${[...PS_ARGS, buildQueryScript(runTag('run-1'))].join(' ')}`
  const nrptPlan = {
    interfaceName: 'OpsMaxx wg',
    dns: { servers: ['10.8.0.1'], searchDomains: [], interfaceName: 'OpsMaxx wg' }
  }

  it('rolls back when the read-back shows the old servers still in force', async () => {
    const rec = recorder()
    // A rule is there and it is ours — it just points at the resolver the
    // machine was already using. This is the leak the check exists to catch.
    h.replies.set(NRPT_QUERY, { code: 0, stdout: '{"Namespace":".","NameServers":["192.0.2.1"]}' })

    await expect(applyNetState(nrptPlan, rec.ctx, { platform: 'win32', root })).rejects.toMatchObject({
      name: 'VpnError',
      code: 'dns-not-applied'
    })
    // Two privileged calls: the add, then the rollback's remove.
    expect(rec.calls).toHaveLength(2)
    expect(rec.calls[1].args.join(' ')).toContain('Remove-DnsClientNrptRule')
  })

  it('keeps a change it could not read back, and says so instead of rolling it back', async () => {
    const rec = recorder()
    const notes: string[] = []
    // The read-back itself failed. The rule was added and probably works; all
    // that happened is that we cannot see it. Tearing the tunnel down here would
    // be worse than the silent success verify() replaced.
    h.replies.set(NRPT_QUERY, { code: 1, stderr: 'Access is denied.' })

    const state = await applyNetState(nrptPlan, rec.ctx, {
      platform: 'win32',
      root,
      onNote: (m) => notes.push(m)
    })

    // The apply stands: the snapshot came back and nothing was reverted.
    expect(state.dns).toBeDefined()
    expect(rec.calls).toHaveLength(1)
    expect(rec.calls[0].args.join(' ')).toContain('Add-DnsClientNrptRule')
    // And it is not silent. A condition we decided not to fail on and then
    // never mentioned is the original bug in a new place.
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('Access is denied.')
  })

  it('reverts idempotently', async () => {
    const rec = recorder()
    const state = await applyNetState(
      { interfaceName: 'wg0', routes: [{ destination: '10.8.0.0/24', interfaceName: 'wg0' }] },
      rec.ctx,
      { platform: 'linux', root }
    )
    rec.calls.length = 0
    rec.fail = true
    await revertNetState(state, rec.ctx, { platform: 'linux', root })
    const first = rec.calls.map((c) => c.args)
    rec.calls.length = 0
    await expect(revertNetState(state, rec.ctx, { platform: 'linux', root })).resolves.toBeUndefined()
    expect(rec.calls.map((c) => c.args)).toEqual(first)
  })

  it('does nothing at all when the plan is empty', async () => {
    const rec = recorder()
    const state = await applyNetState({ interfaceName: 'wg0' }, rec.ctx, { platform: 'linux', root })
    expect(rec.calls).toEqual([])
    expect(state.routes).toBeUndefined()
    expect(state.dns).toBeUndefined()
  })
})

describe('restoreOrphanedNetstate', () => {
  const contextFor = (rec: Recorder) => (): NetApplyContext => rec.ctx

  it('leaves a live run completely alone', async () => {
    const rec = recorder()
    seedOrphan(
      baseState({
        routes: { platform: 'linux', capturedAt: 0, defaults: [], planned: [{ destination: '10.8.0.0/24', interfaceName: 'wg0' }] }
      })
    )
    const reports = await restoreOrphanedNetstate({
      liveRunIds: ['orphan-1'],
      createContext: contextFor(rec),
      platform: 'linux',
      root
    })
    expect(reports).toEqual([
      { runId: 'orphan-1', outcome: 'skipped', routes: 'none', dns: 'none', reason: 'run is still live' }
    ])
    expect(rec.calls).toEqual([])
    expect(existsSync(netStatePath('orphan-1', root))).toBe(true)
  })

  it('reverts a dead run and then forgets about it', async () => {
    const rec = recorder()
    seedOrphan(
      baseState({
        routes: {
          platform: 'linux',
          capturedAt: 0,
          defaults: [],
          planned: [{ destination: '10.8.0.0/24', interfaceName: 'wg0' }]
        }
      })
    )
    const reports = await restoreOrphanedNetstate({
      liveRunIds: [],
      createContext: contextFor(rec),
      platform: 'linux',
      root,
      interfaceExists: () => true
    })
    expect(reports).toEqual([{ runId: 'orphan-1', outcome: 'restored', routes: 'reverted', dns: 'none', reason: undefined }])
    expect(rec.calls.map((c) => c.args)).toEqual([['-4', 'route', 'del', '10.8.0.0/24', 'dev', 'wg0']])
    expect(existsSync(netStatePath('orphan-1', root))).toBe(false)
  })

  it('discards routes for an interface that no longer exists but still puts DNS back', async () => {
    // The kernel took the routes away with the device; the resolver is the
    // part that is still wrong, and it is the part a user would notice.
    const rec = recorder()
    seedOrphan(
      baseState({
        routes: {
          platform: 'linux',
          capturedAt: 0,
          defaults: [],
          planned: [{ destination: '10.8.0.0/24', interfaceName: 'wg0' }]
        },
        dns: {
          platform: 'linux',
          capturedAt: 0,
          runId: 'orphan-1',
          interfaceName: 'wg0',
          previous: ['192.168.1.1'],
          backend: 'resolvectl'
        }
      })
    )
    const reports = await restoreOrphanedNetstate({
      liveRunIds: [],
      createContext: contextFor(rec),
      platform: 'linux',
      root,
      interfaceExists: () => false
    })
    expect(reports[0]).toMatchObject({
      outcome: 'restored',
      routes: 'skipped-missing-interface',
      dns: 'reverted'
    })
    expect(reports[0].reason).toContain('wg0')
    expect(rec.calls.map((c) => [c.cmd, ...c.args])).toEqual([['resolvectl', 'revert', 'wg0']])
  })

  it('skips a vanished interface entirely when there is nothing else to undo', async () => {
    const rec = recorder()
    seedOrphan(
      baseState({
        routes: {
          platform: 'linux',
          capturedAt: 0,
          defaults: [],
          planned: [{ destination: '10.8.0.0/24', interfaceName: 'wg0' }]
        }
      })
    )
    const reports = await restoreOrphanedNetstate({
      liveRunIds: [],
      createContext: contextFor(rec),
      platform: 'linux',
      root,
      interfaceExists: () => false
    })
    expect(reports[0]).toMatchObject({ outcome: 'skipped', routes: 'skipped-missing-interface' })
    expect(rec.calls).toEqual([])
    expect(existsSync(netStatePath('orphan-1', root))).toBe(false)
  })

  it('discards routes from a previous boot but not the DNS they came with', async () => {
    const rec = recorder()
    seedOrphan(
      baseState({
        bootAt: bootTime() - 3_600_000,
        routes: {
          platform: 'linux',
          capturedAt: 0,
          defaults: [],
          planned: [{ destination: '10.8.0.0/24', interfaceName: 'wg0' }]
        },
        dns: {
          platform: 'linux',
          capturedAt: 0,
          runId: 'orphan-1',
          interfaceName: 'wg0',
          previous: [],
          backend: 'resolvectl'
        }
      })
    )
    const reports = await restoreOrphanedNetstate({
      liveRunIds: [],
      createContext: contextFor(rec),
      platform: 'linux',
      root,
      interfaceExists: () => true
    })
    expect(reports[0]).toMatchObject({ routes: 'skipped-stale-boot', dns: 'reverted' })
    expect(rec.calls.map((c) => c.cmd)).toEqual(['resolvectl'])
  })

  it('ignores a snapshot taken on another platform', async () => {
    const rec = recorder()
    seedOrphan(baseState({ platform: 'win32' }))
    const reports = await restoreOrphanedNetstate({
      liveRunIds: [],
      createContext: contextFor(rec),
      platform: 'linux',
      root
    })
    expect(reports[0]).toMatchObject({ outcome: 'skipped' })
    expect(reports[0].reason).toContain('win32')
    expect(existsSync(netStatePath('orphan-1', root))).toBe(true)
  })

  it('keeps the snapshot for next time when no privileged channel is available', async () => {
    seedOrphan(
      baseState({
        dns: {
          platform: 'linux',
          capturedAt: 0,
          runId: 'orphan-1',
          interfaceName: 'wg0',
          previous: [],
          backend: 'resolvectl'
        }
      })
    )
    const reports = await restoreOrphanedNetstate({
      liveRunIds: [],
      createContext: () => null,
      platform: 'linux',
      root
    })
    expect(reports[0]).toMatchObject({ outcome: 'skipped' })
    expect(reports[0].reason).toContain('privileged')
    expect(existsSync(netStatePath('orphan-1', root))).toBe(true)
  })

  it('keeps the snapshot when the revert itself failed', async () => {
    const rec = recorder()
    seedOrphan(
      baseState({
        platform: 'freebsd',
        dns: {
          platform: 'freebsd',
          capturedAt: 0,
          runId: 'orphan-1',
          interfaceName: 'tun0',
          previous: []
        }
      })
    )
    const reports = await restoreOrphanedNetstate({
      liveRunIds: [],
      createContext: contextFor(rec),
      platform: 'freebsd',
      root,
      interfaceExists: () => true
    })
    expect(reports[0]).toMatchObject({ outcome: 'failed', dns: 'failed' })
    expect(existsSync(netStatePath('orphan-1', root))).toBe(true)
  })

  it('handles several orphans and a run directory with no snapshot in it', async () => {
    const rec = recorder()
    mkdirSync(join(root, 'no-netstate'), { recursive: true })
    seedOrphan(baseState({ runId: 'orphan-1' }))
    seedOrphan(
      baseState({
        runId: 'orphan-2',
        dns: {
          platform: 'linux',
          capturedAt: 0,
          runId: 'orphan-2',
          interfaceName: 'wg1',
          previous: [],
          backend: 'resolvectl'
        }
      })
    )
    const reports = await restoreOrphanedNetstate({
      liveRunIds: [],
      createContext: contextFor(rec),
      platform: 'linux',
      root,
      interfaceExists: () => true
    })
    expect(reports.map((r) => r.runId).sort()).toEqual(['orphan-1', 'orphan-2'])
    expect(rec.calls.map((c) => [c.cmd, ...c.args])).toEqual([['resolvectl', 'revert', 'wg1']])
  })

  it('returns nothing when the run root has never been created', async () => {
    await expect(
      restoreOrphanedNetstate({
        liveRunIds: [],
        createContext: () => null,
        platform: 'linux',
        root: join(root, 'missing')
      })
    ).resolves.toEqual([])
  })
})
