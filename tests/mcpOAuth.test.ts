import { describe, it, expect, beforeEach } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'

import {
  isAllowedRedirectUri,
  registerClient,
  beginAuthorization,
  approveConsent,
  denyConsent,
  listPendingConsents,
  consentRedirectUrl,
  exchangeCode,
  refresh,
  revoke,
  forgetSession,
  authorizationServerMetadata,
  protectedResourceMetadata,
  wwwAuthenticateHeader,
  resetOAuthForTests
} from '../src/main/services/mcpOAuth'
import {
  setMcpConfig,
  resetMcpAuthForTests,
  getSession,
  revokeSession,
  listSessions,
  authenticate
} from '../src/main/services/mcpAuth'

const PORT = 58811
const REDIRECT = 'http://localhost:52346/callback'
const WORKSPACES = [{ id: 'ws-prod', name: 'Production' }]
const GRANT = { groupId: 'grp-read-only', groupName: 'Read Only', workspaces: WORKSPACES }

/** A real PKCE pair, the way the client makes one. */
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

function newClient(name = 'Claude Code (opsmaxx)'): string {
  const result = registerClient({ client_name: name, redirect_uris: [REDIRECT] })
  if (!result.ok) throw new Error(result.error)
  return result.client.clientId
}

/** Register, authorize, approve, and redeem -- the whole happy path. */
function authorized(): { clientId: string; token: { access_token: string; refresh_token: string } } {
  const clientId = newClient()
  const { verifier, challenge } = pkce()
  const begun = beginAuthorization({
    clientId,
    redirectUri: REDIRECT,
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    state: 'st',
    resource: `http://127.0.0.1:${PORT}/mcp`,
    responseType: 'code'
  })
  if (!begun.ok) throw new Error(begun.error)
  expect(approveConsent(begun.consentId, GRANT)).toEqual({ ok: true })
  const url = new URL(consentRedirectUrl(begun.consentId)!)
  const code = url.searchParams.get('code')!
  const exchanged = exchangeCode({
    code,
    clientId,
    redirectUri: REDIRECT,
    codeVerifier: verifier,
    resource: `http://127.0.0.1:${PORT}/mcp`
  })
  if (!exchanged.ok) throw new Error(exchanged.description)
  return { clientId, token: exchanged.token }
}

describe('MCP OAuth', () => {
  beforeEach(() => {
    resetMcpAuthForTests()
    resetOAuthForTests()
    setMcpConfig({ enabled: true, port: PORT })
  })

  describe('discovery', () => {
    it('advertises S256 only, and no client secret', () => {
      const meta = authorizationServerMetadata()
      expect(meta.code_challenge_methods_supported).toEqual(['S256'])
      expect(meta.token_endpoint_auth_methods_supported).toEqual(['none'])
      expect(meta.grant_types_supported).toContain('refresh_token')
    })

    it('points the resource at the MCP endpoint and back at itself', () => {
      expect(protectedResourceMetadata().resource).toBe(`http://127.0.0.1:${PORT}/mcp`)
      expect(wwwAuthenticateHeader()).toContain('/.well-known/oauth-protected-resource')
    })
  })

  describe('redirect URIs', () => {
    it.each([
      'http://localhost:52346/callback',
      'http://127.0.0.1:9/cb',
      'http://[::1]:80/cb'
    ])('accepts the loopback URI %s', (uri) => {
      expect(isAllowedRedirectUri(uri)).toBe(true)
    })

    it.each([
      ['an external host', 'http://evil.example.com/cb'],
      ['a host that merely resolves to loopback', 'http://localtest.me/cb'],
      ['https, which a native client cannot serve', 'https://localhost/cb'],
      ['a custom scheme', 'myapp://cb'],
      ['a query the server would collide with', 'http://localhost:1/cb?x=1'],
      ['a fragment', 'http://localhost:1/cb#f'],
      ['nonsense', 'not a url']
    ])('rejects %s', (_why, uri) => {
      expect(isAllowedRedirectUri(uri)).toBe(false)
    })
  })

  describe('registration', () => {
    it('refuses a client with no redirect_uris', () => {
      expect(registerClient({ client_name: 'x' })).toEqual({ ok: false, error: expect.any(String) })
    })

    it('refuses a client that asks for a non-loopback redirect', () => {
      const result = registerClient({ client_name: 'x', redirect_uris: ['https://evil.example.com/cb'] })
      expect(result.ok).toBe(false)
    })

    it('strips control characters out of the name a human will read', () => {
      const result = registerClient({
        client_name: `Evil ${String.fromCharCode(27)}[31m Client${String.fromCharCode(0)}`,
        redirect_uris: [REDIRECT]
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.client.clientName).toBe('Evil [31m Client')
    })

    it('falls back to a placeholder rather than an empty name', () => {
      const result = registerClient({ redirect_uris: [REDIRECT] })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.client.clientName).toBe('Unnamed client')
    })
  })

  describe('authorization', () => {
    const base = (over: Record<string, unknown> = {}): Parameters<typeof beginAuthorization>[0] => ({
      clientId: newClient(),
      redirectUri: REDIRECT,
      codeChallenge: pkce().challenge,
      codeChallengeMethod: 'S256',
      state: 'st',
      resource: null,
      responseType: 'code',
      ...over
    })

    it('refuses an unknown client', () => {
      const result = beginAuthorization(base({ clientId: 'nope' }))
      expect(result).toMatchObject({ ok: false, error: 'invalid_client' })
    })

    it('refuses a redirect_uri the client never registered', () => {
      const result = beginAuthorization(base({ redirectUri: 'http://localhost:9999/other' }))
      expect(result).toMatchObject({ ok: false, error: 'invalid_request' })
    })

    it('refuses plain PKCE, which protects nothing here', () => {
      const result = beginAuthorization(base({ codeChallengeMethod: 'plain' }))
      expect(result).toMatchObject({ ok: false, error: 'invalid_request' })
    })

    it('refuses a missing or stub code_challenge', () => {
      expect(beginAuthorization(base({ codeChallenge: '' }))).toMatchObject({ ok: false })
      expect(beginAuthorization(base({ codeChallenge: 'short' }))).toMatchObject({ ok: false })
    })

    it('refuses an implicit-style response_type', () => {
      const result = beginAuthorization(base({ responseType: 'token' }))
      expect(result).toMatchObject({ ok: false, error: 'unsupported_response_type' })
    })
  })

  describe('consent', () => {
    const begin = (): string => {
      const result = beginAuthorization({
        clientId: newClient(),
        redirectUri: REDIRECT,
        codeChallenge: pkce().challenge,
        codeChallengeMethod: 'S256',
        state: 'st',
        resource: null,
        responseType: 'code'
      })
      if (!result.ok) throw new Error(result.error)
      return result.consentId
    }

    it('waits for a human: nothing is issued until one answers', () => {
      const id = begin()
      expect(listPendingConsents().map((c) => c.id)).toContain(id)
      expect(consentRedirectUrl(id)).toBeNull()
    })

    it('will not grant without an access group, which has no default', () => {
      const id = begin()
      expect(approveConsent(id, { ...GRANT, groupId: '' })).toMatchObject({ ok: false })
      expect(consentRedirectUrl(id)).toBeNull()
    })

    it('will not grant without a workspace', () => {
      const id = begin()
      expect(approveConsent(id, { ...GRANT, workspaces: [] })).toMatchObject({ ok: false })
    })

    it('carries state back on the redirect, so the client can match it', () => {
      const id = begin()
      approveConsent(id, GRANT)
      const url = new URL(consentRedirectUrl(id)!)
      expect(url.searchParams.get('state')).toBe('st')
      expect(url.searchParams.get('code')).toBeTruthy()
    })

    it('reports a denial as access_denied rather than silence', () => {
      const id = begin()
      denyConsent(id)
      const url = consentRedirectUrl(id)
      expect(url).toContain('error=access_denied')
      expect(listPendingConsents().map((c) => c.id)).not.toContain(id)
    })

    it('cannot be approved twice', () => {
      const id = begin()
      expect(approveConsent(id, GRANT)).toEqual({ ok: true })
      expect(approveConsent(id, GRANT)).toMatchObject({ ok: false })
    })
  })

  describe('code exchange', () => {
    it('issues a session marked oauth, with the chosen group', () => {
      const { token } = authorized()
      expect(token.access_token).toBeTruthy()
      expect(token.refresh_token).toBeTruthy()
      const session = listSessions()[0]
      expect(session.kind).toBe('oauth')
      expect(session.groupId).toBe('grp-read-only')
    })

    it('refuses a wrong PKCE verifier', () => {
      const clientId = newClient()
      const { challenge } = pkce()
      const begun = beginAuthorization({
        clientId,
        redirectUri: REDIRECT,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        state: null,
        resource: null,
        responseType: 'code'
      })
      if (!begun.ok) throw new Error('begin failed')
      approveConsent(begun.consentId, GRANT)
      const code = new URL(consentRedirectUrl(begun.consentId)!).searchParams.get('code')!
      const result = exchangeCode({
        code,
        clientId,
        redirectUri: REDIRECT,
        codeVerifier: pkce().verifier, // a different one
        resource: null
      })
      expect(result).toMatchObject({ ok: false, error: 'invalid_grant' })
    })

    it('burns the code: a replay fails even with the right verifier', () => {
      const clientId = newClient()
      const { verifier, challenge } = pkce()
      const begun = beginAuthorization({
        clientId,
        redirectUri: REDIRECT,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        state: null,
        resource: null,
        responseType: 'code'
      })
      if (!begun.ok) throw new Error('begin failed')
      approveConsent(begun.consentId, GRANT)
      const code = new URL(consentRedirectUrl(begun.consentId)!).searchParams.get('code')!
      const args = { code, clientId, redirectUri: REDIRECT, codeVerifier: verifier, resource: null }
      expect(exchangeCode(args).ok).toBe(true)
      expect(exchangeCode(args)).toMatchObject({ ok: false, error: 'invalid_grant' })
    })

    it('refuses a code redeemed by a different client', () => {
      const clientId = newClient()
      const other = newClient('Other')
      const { verifier, challenge } = pkce()
      const begun = beginAuthorization({
        clientId,
        redirectUri: REDIRECT,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        state: null,
        resource: null,
        responseType: 'code'
      })
      if (!begun.ok) throw new Error('begin failed')
      approveConsent(begun.consentId, GRANT)
      const code = new URL(consentRedirectUrl(begun.consentId)!).searchParams.get('code')!
      const result = exchangeCode({
        code,
        clientId: other,
        redirectUri: REDIRECT,
        codeVerifier: verifier,
        resource: null
      })
      expect(result).toMatchObject({ ok: false, error: 'invalid_grant' })
    })

    it('refuses an unknown code', () => {
      expect(
        exchangeCode({
          code: 'made-up',
          clientId: newClient(),
          redirectUri: REDIRECT,
          codeVerifier: pkce().verifier,
          resource: null
        })
      ).toMatchObject({ ok: false, error: 'invalid_grant' })
    })
  })

  describe('refresh', () => {
    it('keeps the same session, so approvals already given are not re-asked', () => {
      const { clientId, token } = authorized()
      const before = listSessions()[0].id
      const result = refresh({ refreshToken: token.refresh_token, clientId })
      expect(result.ok).toBe(true)
      const after = listSessions()
      expect(after).toHaveLength(1)
      expect(after[0].id).toBe(before)
    })

    it('hands back a working new access token, and retires the old one', () => {
      const { clientId, token } = authorized()
      const result = refresh({ refreshToken: token.refresh_token, clientId })
      if (!result.ok) throw new Error(result.description)
      expect(result.token.access_token).not.toBe(token.access_token)
      expect(authenticate(result.token.access_token)).toHaveProperty('session')
      expect(authenticate(token.access_token)).toMatchObject({ error: 'invalid-token' })
    })

    it('rotates: a refresh token is good exactly once', () => {
      const { clientId, token } = authorized()
      expect(refresh({ refreshToken: token.refresh_token, clientId }).ok).toBe(true)
      expect(refresh({ refreshToken: token.refresh_token, clientId })).toMatchObject({
        ok: false,
        error: 'invalid_grant'
      })
    })

    it('refuses a refresh token presented by another client', () => {
      const { token } = authorized()
      expect(refresh({ refreshToken: token.refresh_token, clientId: newClient('Other') })).toMatchObject({
        ok: false,
        error: 'invalid_grant'
      })
    })

    it('stops dead once the session is revoked in the app', () => {
      const { clientId, token } = authorized()
      const sessionId = listSessions()[0].id
      revokeSession(sessionId)
      forgetSession(sessionId)
      expect(refresh({ refreshToken: token.refresh_token, clientId })).toMatchObject({ ok: false })
    })
  })

  describe('revocation', () => {
    it('ends the session behind the token, not just the token', () => {
      const { token } = authorized()
      const sessionId = listSessions()[0].id
      revoke(token.refresh_token)
      expect(getSession(sessionId)?.revoked).toBe(true)
    })

    it('ignores a token it does not know, without throwing', () => {
      expect(() => revoke('not-a-token')).not.toThrow()
    })
  })
})
