import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setMcpConfig, createSession, resetMcpAuthForTests } from '../src/main/services/mcpAuth'
import { startMcpServer, stopMcpServer } from '../src/main/services/mcpServer'

// The edges of the HTTP listener, as any local process can reach them.
const PORT = 18793
const BASE = `http://127.0.0.1:${PORT}`
let token: string

beforeAll(async () => {
  resetMcpAuthForTests()
  setMcpConfig({ enabled: true, port: PORT })
  token = createSession({
    agentName: 'Hardening',
    workspaces: [],
    groupId: 'grp-read-only',
    groupName: 'Read Only',
    ttlMinutes: 60
  }).token
  expect((await startMcpServer()).ok).toBe(true)
})

afterAll(async () => {
  await stopMcpServer()
})

const mcpHeaders = (): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream'
})

// Several routes read their body before any authentication, and every body is
// held whole in the main process. Uncapped, one POST could exhaust its memory.
describe('request bodies are capped', () => {
  const huge = 'x'.repeat(5 * 1024 * 1024)

  it('refuses an oversized body on an unauthenticated route with 413', async () => {
    const res = await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=${huge}`
    })
    expect(res.status).toBe(413)
  })

  it('refuses one on /register too, which answers in its own words', async () => {
    const res = await fetch(`${BASE}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: huge })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  it('refuses one on /mcp', async () => {
    const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers: mcpHeaders(), body: huge })
    expect(res.status).toBe(413)
  })

  it('still serves the next request normally', async () => {
    const res = await fetch(`${BASE}/.well-known/oauth-authorization-server`)
    expect(res.status).toBe(200)
  })
})

describe('malformed input', () => {
  it('answers unparseable JSON with a JSON-RPC parse error, not an empty 500', async () => {
    const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers: mcpHeaders(), body: '{"jsonrpc":' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } })
  })

  it('treats a path that merely starts with /mcp as unknown', async () => {
    const res = await fetch(`${BASE}/mcpanything`, { method: 'POST', headers: mcpHeaders(), body: '{}' })
    expect(res.status).toBe(404)
  })
})
