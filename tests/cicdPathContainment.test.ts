import { describe, it, expect } from 'vitest'

import { makeCicdHttp } from '../src/main/services/cicd/service'
import type { CicdConnection } from '../src/shared/cicd'
import type { HttpResult } from '../src/shared/httpClient'

/**
 * A pipeline ref and a run id are handles, not paths.
 *
 * They are documented as opaque and an AI agent passes them back verbatim —
 * which means the string deciding WHICH endpoint on a CI server gets an
 * authenticated request is chosen by the one party this module's threat model
 * assumes is compromised. The agent reads build output written by whoever
 * opened the merge request.
 *
 * Before the containment check, a `runId` of `../../scriptText?script=…`
 * reached Jenkins' Groovy console as the service account, and a `pipelineRef`
 * of `../../credentials/store/…/api/json` returned the credential store as
 * "the build log" under `ciRead` — a read-only tool with no approval.
 *
 * These are regression tests for that. Every case must be refused BEFORE a
 * request is issued: the fake transport records calls, and a call reaching it
 * at all is a failure even if the URL then looks harmless.
 */

const connection = (over: Partial<CicdConnection> = {}): CicdConnection => ({
  id: 'c1',
  workspaceId: 'ws-1',
  name: 'CI',
  provider: 'jenkins',
  baseUrl: 'https://ci.internal/jenkins',
  username: 'svc',
  vaultEntryId: 'v1',
  route: { kind: 'direct' },
  enabled: true,
  ...over
})

const ok: HttpResult = {
  ok: true,
  status: 200,
  statusText: '',
  headers: {},
  body: new TextEncoder().encode('{}').buffer as ArrayBuffer,
  durationMs: 1,
  truncated: false
}

function harness(c: CicdConnection): { call: (path: string) => Promise<unknown>; urls: string[] } {
  const urls: string[] = []
  const http = makeCicdHttp(c, 'token', {
    request: async (spec) => {
      urls.push(spec.url)
      return ok
    }
  })
  return { call: (path: string) => http({ method: 'GET', path }), urls }
}

describe('a handle cannot address anything outside its API root', () => {
  const escapes: [string, string][] = [
    ['plain dot-segments', '/job/app/../../credentials/store/system/domain/_/api/json'],
    ['dot-segments that also carry a query', '/job/app/../../scriptText?script=x&y=/build'],
    ['deep traversal past the origin root', '/job/app/../../../../../../etc/passwd'],
    ['percent-encoded dot-segments', '/job/app/%2e%2e/%2e%2e/scriptText'],
    ['a scheme-relative host', '//attacker.tld/steal'],
    ['an absolute url in the path slot', '/https://attacker.tld/steal'],
    ['a sibling path that merely shares a prefix', '/../jenkinsevil/api/json']
  ]

  for (const [name, path] of escapes) {
    it(`refuses ${name}`, async () => {
      const h = harness(connection())
      await expect(h.call(path)).rejects.toThrow(/Refused/)
      // The point is that nothing was SENT. A check that let the request out
      // and inspected it afterwards would already have leaked the credential.
      expect(h.urls).toEqual([])
    })
  }

  it('still allows an ordinary handle through untouched', async () => {
    const h = harness(connection())
    await h.call('/job/team/job/web/42/api/json')
    expect(h.urls).toEqual(['https://ci.internal/jenkins/job/team/job/web/42/api/json'])
  })

  it('allows a handle that merely contains a dot', async () => {
    // `.github/workflows/ci.yml` is a real GitHub ref and must not be caught.
    const h = harness(connection({ provider: 'github', baseUrl: 'https://github.com' }))
    await h.call('/repos/acme/web/contents/.github/workflows/ci.yml')
    expect(h.urls[0]).toContain('/.github/workflows/ci.yml')
  })

  it('holds for GitLab, whose root carries a path of its own', async () => {
    const h = harness(connection({ provider: 'gitlab', baseUrl: 'https://gitlab.example.com' }))
    await expect(h.call('/projects/7/../../../admin')).rejects.toThrow(/Refused/)
    expect(h.urls).toEqual([])
  })

  it('refuses a sibling root that shares a string prefix', async () => {
    // `/api/v4` must not admit `/api/v4evil`: the root is a path boundary, not
    // a substring.
    const h = harness(connection({ provider: 'gitlab', baseUrl: 'https://gitlab.example.com' }))
    await expect(h.call('/../v4evil/projects')).rejects.toThrow(/Refused/)
    expect(h.urls).toEqual([])
  })

  it('refuses a handle that would change host even on a GHES root', async () => {
    const h = harness(connection({ provider: 'github', baseUrl: 'https://ghe.acme.internal' }))
    await expect(h.call('/..//attacker.tld/x')).rejects.toThrow(/Refused/)
    expect(h.urls).toEqual([])
  })
})
