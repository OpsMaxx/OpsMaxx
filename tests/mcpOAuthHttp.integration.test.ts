/**
 * The OAuth flow over the real HTTP endpoints, in the order a client walks it.
 *
 * The shapes asserted here were taken from a live Claude Code 2.1.270 against a
 * throwaway server, not from documentation: the discovery order, the DCR body,
 * `token_endpoint_auth_method: "none"`, and a `resource` parameter on both the
 * authorization request and the token request.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'

import { setMcpConfig, resetMcpAuthForTests, listSessions } from '../src/main/services/mcpAuth'
import { resetPolicyCacheForTests } from '../src/main/services/policyStore'
import { refreshMcpDataCache } from '../src/main/services/mcpDataCache'
import { startMcpServer, stopMcpServer } from '../src/main/services/mcpServer'
import { approveConsent, listPendingConsents, resetOAuthForTests } from '../src/main/services/mcpOAuth'

const PORT = 18822
const BASE = `http://127.0.0.1:${PORT}`
const REDIRECT = 'http://localhost:52999/callback'

const sampleData = {
  workspaces: [{ id: 'ws-prod', name: 'Production' }],
  servers: [
    {
      id: 's1',
      workspaceId: 'ws-prod',
      name: 'Nginx Server Prod',
      host: '10.0.0.1',
      port: 22,
      username: 'root',
      auth: 'key',
      os: 'Linux',
      route: []
    }
  ]
}

const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString()

async function postForm(path: string, fields: Record<string, string>): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form(fields)
  })
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

/** Register a client the way the real one does. */
async function register(): Promise<string> {
  const res = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude Code (opsmaxx)',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native'
    })
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { client_id: string }).client_id
}

/** Walk authorize -> a human approving in the app -> the redirect carrying the code. */
async function authorizeAndApprove(clientId: string, challenge: string): Promise<string> {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    redirect_uri: REDIRECT,
    state: 'xyz',
    resource: `${BASE}/mcp`
  })
  const page = await fetch(`${BASE}/authorize?${query}`)
  expect(page.status).toBe(200)
  expect(page.headers.get('content-type')).toContain('text/html')
  await page.text()

  // Stands in for the human in the OpsMaxx window.
  const pending = listPendingConsents()
  expect(pending).toHaveLength(1)
  expect(pending[0].clientName).toBe('Claude Code (opsmaxx)')
  expect(approveConsent(pending[0].id, {
    groupId: 'grp-read-only',
    groupName: 'Read Only',
    workspaces: [{ id: 'ws-prod', name: 'Production' }]
  })).toEqual({ ok: true })

  const polled = await fetch(`${BASE}/authorize?consent=${pending[0].id}`)
  const outcome = (await polled.json()) as { done: boolean; redirect?: string }
  expect(outcome.done).toBe(true)
  const url = new URL(outcome.redirect!)
  expect(url.searchParams.get('state')).toBe('xyz')
  return url.searchParams.get('code')!
}

describe('OAuth over HTTP (integration)', () => {
  beforeAll(async () => {
    resetPolicyCacheForTests()
    refreshMcpDataCache(sampleData)
    setMcpConfig({ enabled: true, port: PORT, approvalTimeoutSeconds: 5 })
    expect((await startMcpServer()).ok).toBe(true)
  })

  afterAll(async () => {
    await stopMcpServer()
  })

  beforeEach(() => {
    resetMcpAuthForTests()
    resetOAuthForTests()
    setMcpConfig({ enabled: true, port: PORT, approvalTimeoutSeconds: 5 })
  })

  it('serves discovery without a token, because a client cannot have one yet', async () => {
    const resource = await fetch(`${BASE}/.well-known/oauth-protected-resource`)
    expect(resource.status).toBe(200)
    expect(await resource.json()).toMatchObject({
      resource: `${BASE}/mcp`,
      authorization_servers: [BASE]
    })

    const server = await fetch(`${BASE}/.well-known/oauth-authorization-server`)
    expect(server.status).toBe(200)
    expect(await server.json()).toMatchObject({
      registration_endpoint: `${BASE}/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none']
    })
  })

  it('walks register, authorize, approve, exchange and then answers MCP calls', async () => {
    const clientId = await register()
    const { verifier, challenge } = pkce()
    const code = await authorizeAndApprove(clientId, challenge)

    const tokenRes = await postForm('/token', {
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      resource: `${BASE}/mcp`
    })
    expect(tokenRes.status).toBe(200)
    const token = (await tokenRes.json()) as { access_token: string; refresh_token: string; expires_in: number }
    expect(token.expires_in).toBeGreaterThan(0)

    // The token the flow produced is a working MCP credential.
    const call = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token.access_token}`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_servers', arguments: {} } })
    })
    expect(call.status).toBe(200)
    expect(await call.text()).toContain('Nginx Server Prod')
  })

  it('refreshes without disturbing the session the approvals hang off', async () => {
    const clientId = await register()
    const { verifier, challenge } = pkce()
    const code = await authorizeAndApprove(clientId, challenge)
    const first = (await (
      await postForm('/token', {
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_verifier: verifier
      })
    ).json()) as { access_token: string; refresh_token: string }

    const sessionId = listSessions()[0].id

    const refreshed = await postForm('/token', {
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: clientId
    })
    expect(refreshed.status).toBe(200)
    const next = (await refreshed.json()) as { access_token: string; refresh_token: string }
    expect(next.access_token).not.toBe(first.access_token)
    expect(listSessions()).toHaveLength(1)
    expect(listSessions()[0].id).toBe(sessionId)

    // The retired access token stops working immediately.
    const stale = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${first.access_token}`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    })
    expect(stale.status).toBe(401)
  })

  it('refuses to redirect anywhere when the redirect_uri was never registered', async () => {
    const clientId = await register()
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      redirect_uri: 'http://localhost:1/evil',
      state: 'xyz'
    })
    const res = await fetch(`${BASE}/authorize?${query}`, { redirect: 'manual' })
    // Reported to the browser, never bounced onward: bouncing an unregistered
    // redirect_uri is the open redirect the exact-match rule exists to stop.
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
    expect(listPendingConsents()).toHaveLength(0)
  })

  it('refuses a token request that swaps in a different client', async () => {
    const clientId = await register()
    const other = await register()
    const { verifier, challenge } = pkce()
    const code = await authorizeAndApprove(clientId, challenge)
    const res = await postForm('/token', {
      grant_type: 'authorization_code',
      code,
      client_id: other,
      redirect_uri: REDIRECT,
      code_verifier: verifier
    })
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_grant' })
  })

  it('refuses an unsupported grant type', async () => {
    const res = await postForm('/token', { grant_type: 'password', username: 'a', password: 'b' })
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'unsupported_grant_type' })
  })

  it('always reports revocation as success, so it cannot be used to probe', async () => {
    const res = await postForm('/revoke', { token: 'never-existed' })
    expect(res.status).toBe(200)
  })

  it('will not register a client that asks to be redirected off this machine', async () => {
    const res = await fetch(`${BASE}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Evil', redirect_uris: ['https://evil.example.com/cb'] })
    })
    expect(res.status).toBe(400)
  })
})
