import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { refreshMcpDataCache, getCachedServer } from '../src/main/services/mcpDataCache'
import { setAssignment, resetPolicyCacheForTests } from '../src/main/services/policyStore'
import { setMcpConfig, createSession, resetMcpAuthForTests } from '../src/main/services/mcpAuth'
import { startMcpServer, stopMcpServer } from '../src/main/services/mcpServer'
import { AI_CAPABILITIES } from '../src/shared/mcp'
import { agentServerFields } from '../src/renderer/src/lib/agentServerPatch'

// A mounted folder hands a server — and anyone who is root on it — this
// computer's files. That is a decision a person makes in the Files view, for one
// folder, and nothing an agent may make, change, undo or even read back. So:
//
//   1. Runtime   — no tool the bridge serves is about mounting or sharing.
//   2. Static    — reverseMount.ts is not in the import closure of either agent
//                  entry point (the bridge, the CLI), so no tool can call it.
//   3. Records   — the two ways an agent touches a server record cannot carry
//                  `shares`: the bridge's cache never reads it, and the
//                  renderer applies an update_server patch by named field.
//   4. Vocabulary — no capability names it, so it cannot be granted.
//
// If one of these fails, the feature has grown an agent path. Do not widen the
// assertion; remove the path.

const ROOT = resolve(__dirname, '..')
const PORT = 18744
const MOUNTISH = /mount|share|sshfs|fuse/i

describe('the MCP bridge serves nothing that mounts', () => {
  let token: string

  beforeAll(async () => {
    resetMcpAuthForTests()
    resetPolicyCacheForTests()
    refreshMcpDataCache({ workspaces: [{ id: 'ws', name: 'W' }], servers: [] })
    // The widest group there is, so a tool hidden behind a capability is still listed.
    setAssignment({ level: 'workspace', workspaceId: 'ws' }, 'grp-full')
    setMcpConfig({ enabled: true, port: PORT, approvalTimeoutSeconds: 5 })
    token = createSession({
      agentName: 'Guard',
      workspaces: [{ id: 'ws', name: 'W' }],
      groupId: 'grp-full',
      groupName: 'Full',
      ttlMinutes: 60
    }).token
    const started = await startMcpServer()
    expect(started.ok, `MCP server did not start: ${started.error ?? ''}`).toBe(true)
  })

  afterAll(async () => {
    await stopMcpServer()
  })

  it('lists no tool, and no tool description, about mounting folders', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
    const client = new Client({ name: 'reverse-mount-guard', version: '1.0.0' })
    await client.connect(transport)
    try {
      const { tools } = await client.listTools()
      expect(tools.length, 'the bridge served no tools — this proves nothing').toBeGreaterThan(0)
      expect(tools.map((t) => t.name).filter((n) => MOUNTISH.test(n))).toEqual([])
      for (const t of tools) {
        const params = Object.keys((t.inputSchema as { properties?: object }).properties ?? {})
        expect(params.filter((p) => MOUNTISH.test(p)), `${t.name} takes a mount-like parameter`).toEqual([])
      }
    } finally {
      await client.close()
    }
  })
})

function tsFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((e) => {
    const full = join(dir, e)
    return statSync(full).isDirectory() ? tsFilesIn(full) : /\.tsx?$/.test(e) ? [full] : []
  })
}

function resolveSpecifier(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const literal = join(dirname(from), spec)
  const stripped = literal.replace(/\.[cm]?js$/i, '')
  for (const c of [literal, `${literal}.ts`, `${literal}.tsx`, `${stripped}.ts`, `${stripped}.tsx`, join(literal, 'index.ts')]) {
    if (existsSync(c) && statSync(c).isFile()) return c
  }
  return null
}

describe('no agent entry point can reach the mount manager', () => {
  it('keeps reverseMount.ts out of the bridge and CLI import closure', () => {
    const seeds = [join(ROOT, 'src/main/services/mcpServer.ts'), ...tsFilesIn(join(ROOT, 'src/cli'))]
    const seen = new Set<string>()
    const queue = [...seeds]
    const via = new Map<string, string>()
    while (queue.length) {
      const file = queue.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      const { importedFiles } = ts.preProcessFile(readFileSync(file, 'utf8'), true, true)
      for (const { fileName } of importedFiles) {
        const to = resolveSpecifier(file, fileName)
        if (to && !seen.has(to)) {
          via.set(to, file)
          queue.push(to)
        }
      }
    }
    // Anti-vacuity: the walk must actually have reached ssh.ts, which is the
    // module a careless wiring would import the manager from.
    expect([...seen].some((f) => f.endsWith('services/ssh.ts'))).toBe(true)

    const target = join(ROOT, 'src/main/services/reverseMount.ts')
    const chain: string[] = []
    for (let f: string | undefined = target; f && seen.has(f); f = via.get(f)) chain.unshift(relative(ROOT, f))
    expect(seen.has(target), `reachable from an agent entry point:\n  ${chain.join('\n  -> ')}`).toBe(false)
  })
})

describe('an agent cannot put a share on a server record', () => {
  it('is never read into the bridge cache', () => {
    refreshMcpDataCache({
      workspaces: [{ id: 'ws', name: 'W' }],
      servers: [
        {
          id: 's1',
          workspaceId: 'ws',
          name: 'Box',
          host: 'host-1',
          port: 22,
          username: 'deploy',
          auth: 'key',
          route: [],
          shares: [{ id: 'x', localDir: '/Users/someone', mountpoint: '~/x', readOnly: true, autoMount: true }]
        }
      ]
    })
    const cached = getCachedServer('s1') as unknown as Record<string, unknown>
    expect(cached).toBeTruthy()
    expect(cached.shares).toBeUndefined()
    expect(JSON.stringify(cached)).not.toContain('/Users/someone')
  })

  it('is dropped from an update_server patch, however it got there', () => {
    const patch = {
      name: 'Renamed',
      port: 2222,
      shares: [{ id: 'x', localDir: '/', mountpoint: '~/root', readOnly: false, autoMount: true }]
    }
    expect(agentServerFields(patch)).toEqual({ name: 'Renamed', port: 2222 })
  })

  it('has no capability that could grant it', () => {
    // Ids and labels: a detail sentence may say "shared" in passing.
    expect(AI_CAPABILITIES.flatMap((c) => [c.id, c.label]).filter((c) => MOUNTISH.test(c))).toEqual([])
  })
})
