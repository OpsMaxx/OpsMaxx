import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseOpenApi } from '../src/shared/openapiImport'
import { requestsFromOpenApi } from '../src/shared/apiOpenApi'
import type { Folder, HttpRequest } from '../src/shared/apiModel'

afterEach(() => vi.unstubAllGlobals())

// Written by a stranger: three external references and a schema that contains
// itself. None of the three may be fetched or read (review SEC-H4).
const hostile = {
  openapi: '3.0.3',
  info: { title: 't', version: '1' },
  paths: {
    '/nodes': {
      post: {
        tags: ['nodes'],
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } },
        responses: { '200': { $ref: 'http://169.254.169.254/latest/meta-data' } }
      },
      get: {
        parameters: [{ $ref: 'file:///etc/passwd' }],
        responses: { '200': { content: { 'application/json': { schema: { $ref: './other.yaml#/Pet' } } } } }
      }
    }
  },
  components: {
    schemas: {
      Node: {
        type: 'object',
        properties: { name: { type: 'string' }, child: { $ref: '#/components/schemas/Node' } }
      }
    }
  }
}

describe('parseOpenApi (SEC-H4)', () => {
  it('never fetches, counts external refs, and survives a self-referential schema', () => {
    const fetch = vi.fn(() => {
      throw new Error('fetch must not be called')
    })
    vi.stubGlobal('fetch', fetch)
    const parsed = parseOpenApi(JSON.stringify(hostile), { url: 'https://specs.example.com/api.json' })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.externalRefs).toBe(3)
    const { items } = requestsFromOpenApi(parsed.doc)
    const post = (items[0] as Folder).items[0] as HttpRequest
    expect(post.body).toEqual({ mode: 'json', text: expect.stringContaining('"name": "string"') })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses a YAML alias bomb', () => {
    const bomb = [
      'a: &a ["x","x","x","x","x","x","x","x","x"]',
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]',
      'e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]',
      'f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]',
      'g: &g [*f,*f,*f,*f,*f,*f,*f,*f,*f]',
      'openapi: 3.0.0'
    ].join('\n')
    const r = parseOpenApi(bomb, {})
    expect(r.ok).toBe(false)
  })

  it('upgrades Swagger 2', () => {
    const swagger = {
      swagger: '2.0',
      info: { title: 't', version: '1' },
      host: 'petstore.example.com',
      basePath: '/v2',
      schemes: ['https'],
      paths: {
        '/pet/{petId}': {
          get: {
            tags: ['pet'],
            parameters: [{ name: 'petId', in: 'path', required: true, type: 'integer' }],
            responses: { '200': { description: 'ok' } }
          }
        }
      }
    }
    const r = parseOpenApi(JSON.stringify(swagger), {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.doc.openapi).toMatch(/^3\./)
    const { items, baseUrl } = requestsFromOpenApi(r.doc)
    expect(baseUrl).toBe('https://petstore.example.com/v2')
    const get = (items[0] as Folder).items[0] as HttpRequest
    expect(get.url).toBe('{{baseUrl}}/pet/{petId}')
    expect(get.pathParams.map((p) => p.key)).toEqual(['petId'])
  })

  it('reads YAML, turns tags into folders, and resolves a relative server against the URL', () => {
    const yaml = [
      'openapi: 3.1.0',
      'info: {title: t, version: "1"}',
      'servers: [{url: /api/v1}]',
      'paths:',
      '  /users:',
      '    get: {tags: [users], summary: List users, responses: {"200": {description: ok}}}',
      '  /health:',
      '    get: {responses: {"200": {description: ok}}}'
    ].join('\n')
    const r = parseOpenApi(yaml, { url: 'https://h.example/specs/openapi.yaml' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const { items, baseUrl } = requestsFromOpenApi(r.doc)
    expect(baseUrl).toBe('https://h.example/api/v1')
    expect(items.map((i) => i.name)).toEqual(['users', 'GET /health'])
    expect(((items[0] as Folder).items[0] as HttpRequest).name).toBe('List users')
  })

  it('leaves a relative server unresolved for a file', () => {
    const r = parseOpenApi('{"openapi":"3.0.0","servers":[{"url":"/v1"}],"paths":{}}', { fileName: 'api.json' })
    expect(r.ok && requestsFromOpenApi(r.doc).baseUrl).toBeNull()
  })

  it('refuses what is not OpenAPI', () => {
    expect(parseOpenApi('{"hello":1}', {}).ok).toBe(false)
    expect(parseOpenApi('{nope', {}).ok).toBe(false)
    expect(parseOpenApi('- 1\n- 2', {}).ok).toBe(false)
  })
})
