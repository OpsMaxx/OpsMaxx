import { describe, expect, it } from 'vitest'
import { code, newHttpFiles, read, rel } from './httpSurface'

/**
 * Every request the HTTP client makes leaves from the main process (§0.2 rule
 * 4, §3.12 row 1): through `window.opsmaxx.http*`, where the route, the vault
 * and target vetting apply. A renderer `fetch` would skip all three, and the
 * prod CSP's `connect-src` is the only other thing that would stop it.
 */

const FORBIDDEN: [string, RegExp][] = [
  ['fetch(', /\bfetch\s*\(/],
  ['new WebSocket(', /\bnew\s+WebSocket\s*\(/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['EventSource', /\bEventSource\b/],
  ['sendBeacon', /\bsendBeacon\b/],
  // json-magic's resolvers that read the network and the disk (SEC-H4).
  ['json-magic fetchUrls', /\bfetchUrls\b/],
  ['json-magic readFiles', /\breadFiles\b/]
]

describe('the HTTP client never talks to the network from the renderer', () => {
  const files = newHttpFiles().filter((p) => /\.tsx?$/.test(p))

  it('scans the whole new surface', () => {
    const names = files.map(rel)
    for (const must of [
      'renderer/src/store/http.ts',
      'renderer/src/lib/httpSend.ts',
      'renderer/src/components/http/ProtocolLayout.tsx',
      'shared/apiRequestBuild.ts',
      'shared/curl.ts',
      'shared/apiMigration.ts',
      'shared/openapiImport.ts',
      'shared/apiOpenApi.ts'
    ]) {
      expect(names).toContain(must)
    }
    expect(names.some((n) => /components\/http\/(ScalarClient|HttpView)\.tsx$/.test(n))).toBe(false)
  })

  it.each(FORBIDDEN)('has no %s', (_what, pattern) => {
    const hits = files.filter((p) => pattern.test(code(read(p)))).map(rel)
    expect(hits).toEqual([])
  })

  it('catches the thing it looks for', () => {
    // The scan is only as good as its patterns: prove each one bites.
    const samples = [
      'window.fetch (u)',
      'const s = new WebSocket(u)',
      'new XMLHttpRequest()',
      'new EventSource(u)',
      'navigator.sendBeacon(u)',
      "import { fetchUrls } from '@scalar/json-magic/bundle/plugins/browser'",
      'readFiles()'
    ]
    samples.forEach((s, i) => expect(FORBIDDEN[i][1].test(code(s)), s).toBe(true))
    expect(FORBIDDEN[0][1].test(code('// fetch(url) is not allowed here'))).toBe(false)
    expect(FORBIDDEN[0][1].test('prefetch(url)')).toBe(false)
  })
})
