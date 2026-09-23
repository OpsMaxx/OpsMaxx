/**
 * OpenAPI text (JSON or YAML, Swagger 2 upgraded) into an OpenAPI 3 document.
 * `$ref`s are resolved only when internal (`#/...`); external ones are counted,
 * never fetched.
 *
 * NOTHING HERE READS A FILE OR THE NETWORK. `@scalar/json-magic`'s
 * `dereference(doc)` with no options fetches every remote `$ref` it finds, with
 * its private-network guard off, so a spec whose author wrote
 * `$ref: http://169.254.169.254/...` would have been an SSRF read pointed by a
 * stranger, and the response inlined into the collection (review SEC-H4). The
 * document is therefore never dereferenced as a whole: `apiOpenApi.ts` follows
 * internal pointers one at a time as it converts, and anything else — `http:`,
 * `file:`, `./other.yaml` — is counted here and reported as "not followed".
 */

import { parse as parseYaml } from 'yaml'
import { upgradeFromTwoToThree } from '@scalar/openapi-upgrader/2.0-to-3.0'
import type { OpenApi3Doc } from './apiOpenApi'

/** The same ceiling `http:chooseSpecFile` reads to. */
export const MAX_SPEC_CHARS = 32 * 1024 * 1024

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * `$ref`s that point outside the document. An iterative walk with a visited
 * set: YAML anchors can make a document that refers to itself, and a nested
 * enough one would overflow a recursive walk.
 */
export function countExternalRefs(doc: unknown): number {
  let count = 0
  const seen = new WeakSet<object>()
  const stack: unknown[] = [doc]
  while (stack.length > 0) {
    const node = stack.pop()
    if (typeof node !== 'object' || node === null || seen.has(node)) continue
    seen.add(node)
    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') {
        if (!v.startsWith('#')) count++
      } else stack.push(v)
    }
  }
  return count
}

/** `{name}` in a server URL replaced by that variable's default. */
function substituteServerVariables(server: Record<string, unknown>): string {
  const url = typeof server.url === 'string' ? server.url : ''
  const vars = isObj(server.variables) ? server.variables : {}
  return url.replace(/\{([^{}]+)\}/g, (whole, name: string) => {
    const v = Object.hasOwn(vars, name) ? vars[name] : undefined
    return isObj(v) && typeof v.default === 'string' ? v.default : whole
  })
}

export function parseOpenApi(
  text: string,
  source: { url?: string; fileName?: string }
): { ok: true; doc: OpenApi3Doc; externalRefs: number } | { ok: false; error: string } {
  if (text.length > MAX_SPEC_CHARS) return { ok: false, error: 'That description is larger than 32 MB.' }
  let raw: unknown
  try {
    raw = /^\s*[{[]/.test(text)
      ? JSON.parse(text)
      : // The alias limit is what refuses a "billion laughs" document: a few
        // lines of anchors that expand to gigabytes.
        parseYaml(text, { maxAliasCount: 100 })
  } catch (err) {
    return { ok: false, error: `Could not read it as JSON or YAML: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!isObj(raw)) return { ok: false, error: 'That is not an OpenAPI description.' }

  let doc: Record<string, unknown>
  if (raw.swagger === '2.0' || raw.swagger === 2) {
    try {
      doc = upgradeFromTwoToThree(raw) as Record<string, unknown>
    } catch (err) {
      return { ok: false, error: `Could not upgrade the Swagger 2 description: ${err instanceof Error ? err.message : String(err)}` }
    }
  } else if (typeof raw.openapi === 'string' && /^3\.[0-2](\.|$)/.test(raw.openapi)) {
    doc = raw
  } else {
    return { ok: false, error: 'That is not an OpenAPI 3 or Swagger 2 description.' }
  }

  // servers[0], absolute: a relative one is resolved against where the spec
  // came from, and left relative (and so unresolved) for a file.
  if (Array.isArray(doc.servers) && isObj(doc.servers[0])) {
    const first = doc.servers[0]
    let url = substituteServerVariables(first)
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && source.url) {
      try {
        url = new URL(url || '/', source.url).toString()
      } catch {
        /* an unparseable spec URL leaves it as written */
      }
    }
    doc.servers = [{ ...first, url }, ...doc.servers.slice(1)]
  } else if (source.url) {
    // OpenAPI: no `servers` means "/", relative to where the document is.
    try {
      doc.servers = [{ url: new URL('/', source.url).toString() }]
    } catch {
      /* as above */
    }
  }

  return { ok: true, doc: doc as OpenApi3Doc, externalRefs: countExternalRefs(doc) }
}
