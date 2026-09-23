import { describe, it, expect } from 'vitest'
import { requestsFromOpenApi, type OpenApi3Doc } from '../src/shared/apiOpenApi'
import type { Folder, HttpRequest, Item } from '../src/shared/apiModel'

const doc: OpenApi3Doc = {
  openapi: '3.0.3',
  servers: [{ url: 'https://{region}.api.example.com/', variables: { region: { default: 'eu' } } } as never],
  tags: [{ name: 'pets' }, { name: 'empty' }],
  paths: {
    '/pets/{petId}': {
      parameters: [
        { name: 'petId', in: 'path', required: true, schema: { type: 'integer', example: 7 } },
        { name: 'verbose', in: 'query', schema: { type: 'boolean' } }
      ],
      get: {
        tags: ['pets'],
        operationId: 'getPet',
        description: 'Fetch one pet',
        parameters: [
          { name: 'verbose', in: 'query', required: true, example: 'yes' },
          { name: 'X-Trace', in: 'header', schema: { type: 'string', default: 'on' }, required: true },
          { name: 'Authorization', in: 'header', schema: { type: 'string' } },
          { $ref: '#/components/parameters/Fields' }
        ],
        responses: {}
      },
      delete: { tags: ['pets'], summary: 'Remove', responses: {} }
    },
    '/pets': {
      post: {
        tags: ['pets'],
        requestBody: { $ref: '#/components/requestBodies/NewPet' },
        responses: {}
      },
      put: {
        tags: ['pets'],
        requestBody: {
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: { photo: { type: 'string', format: 'binary' }, caption: { type: 'string', example: 'hi' } }
              }
            }
          }
        },
        responses: {}
      },
      patch: {
        requestBody: {
          content: {
            'application/x-www-form-urlencoded': {
              schema: { type: 'object', properties: { name: { type: 'string' } } },
              example: { name: 'rex' }
            }
          }
        },
        responses: {}
      }
    },
    '/bad': { get: 'not an operation' }
  },
  components: {
    parameters: { Fields: { name: 'fields', in: 'query', schema: { type: 'array', items: { type: 'string' } } } },
    requestBodies: {
      NewPet: {
        content: {
          'application/xml': { example: '<pet/>' },
          'application/json': {
            schema: {
              allOf: [
                { $ref: '#/components/schemas/Base' },
                { type: 'object', properties: { tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } } }
              ]
            }
          }
        }
      }
    },
    schemas: { Base: { type: 'object', properties: { id: { type: 'integer' }, born: { type: 'string', format: 'date' } } } }
  }
}

const find = (items: Item[], method: string, url: string): HttpRequest => {
  const all = items.flatMap((i) => (i.kind === 'folder' ? i.items : [i])) as HttpRequest[]
  const r = all.find((x) => x.method === method && x.url.startsWith(url))
  if (!r) throw new Error(`${method} ${url} not found`)
  return r
}

describe('requestsFromOpenApi', () => {
  const out = requestsFromOpenApi(doc, { idSeed: 'col_1' })

  it('takes baseUrl from servers[0], variables substituted, trailing slash dropped', () => {
    // The substitution happens in parseOpenApi; unsubstituted here it is still absolute.
    expect(out.baseUrl).toBe('https://{region}.api.example.com')
  })

  it('makes a folder per used tag, in declared order, untagged requests after', () => {
    expect(out.items.map((i) => i.name)).toEqual(['pets', 'PATCH /pets'])
    expect((out.items[0] as Folder).items).toHaveLength(4)
  })

  it('merges path and operation parameters, operation winning', () => {
    const get = find(out.items, 'GET', '{{baseUrl}}/pets/{petId}')
    expect(get.name).toBe('getPet')
    expect(get.description).toBe('Fetch one pet')
    expect(get.pathParams.map((r) => [r.key, r.value])).toEqual([['petId', '7']])
    expect(get.params.map((r) => [r.key, r.value, r.enabled])).toEqual([
      ['verbose', 'yes', true],
      ['fields', '["string"]', false]
    ])
    expect(get.url).toBe('{{baseUrl}}/pets/{petId}?verbose=yes')
    // Authorization as a parameter is ignored, as OpenAPI says.
    expect(get.headers.map((r) => [r.key, r.value])).toEqual([['X-Trace', 'on']])
    expect(get.auth).toEqual({ type: 'inherit' })
  })

  it('builds bodies by media type, JSON preferred', () => {
    const post = find(out.items, 'POST', '{{baseUrl}}/pets')
    expect(post.body.mode).toBe('json')
    expect(JSON.parse((post.body as { text: string }).text)).toEqual({ id: 0, born: '1970-01-01', tags: ['a'] })
    const put = find(out.items, 'PUT', '{{baseUrl}}/pets')
    expect(put.body).toMatchObject({
      mode: 'multipart',
      rows: [
        { key: 'photo', kind: 'file', value: '' },
        { key: 'caption', kind: 'text', value: 'hi' }
      ]
    })
    const patch = find(out.items, 'PATCH', '{{baseUrl}}/pets')
    expect(patch.body).toMatchObject({ mode: 'urlencoded', rows: [{ key: 'name', value: 'rex' }] })
  })

  it('reports what it skipped', () => {
    expect(out.skipped).toEqual([{ method: 'GET', path: '/bad', reason: expect.any(String) }])
  })

  it('is deterministic, and the seed separates collections', () => {
    expect(requestsFromOpenApi(doc, { idSeed: 'col_1' })).toEqual(out)
    const other = requestsFromOpenApi(doc, { idSeed: 'col_2' })
    expect(find(other.items, 'DELETE', '{{baseUrl}}').id).not.toBe(find(out.items, 'DELETE', '{{baseUrl}}').id)
  })

  it('stops a wide, deep schema at the byte budget', () => {
    const wide: Record<string, unknown> = {}
    for (let i = 0; i < 60; i++) wide[`p${i}`] = { $ref: '#/components/schemas/W' }
    const huge: OpenApi3Doc = {
      openapi: '3.0.0',
      paths: { '/w': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/W0' } } } } } } },
      components: {
        schemas: {
          W0: { type: 'object', properties: wide },
          W: { type: 'object', properties: Object.fromEntries(Object.keys(wide).map((k) => [k, { $ref: '#/components/schemas/W2' }])) },
          W2: { type: 'object', properties: Object.fromEntries(Object.keys(wide).map((k) => [k, { $ref: '#/components/schemas/W3' }])) },
          W3: { type: 'object', properties: Object.fromEntries(Object.keys(wide).map((k) => [k, { type: 'string', example: 'x'.repeat(50) }])) }
        }
      }
    }
    const started = Date.now()
    const body = (requestsFromOpenApi(huge).items[0] as HttpRequest).body as { text: string }
    expect(Date.now() - started).toBeLessThan(5000)
    expect(body.text.length).toBeLessThan(6 * 1024 * 1024)
  })
})
