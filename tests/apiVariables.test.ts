import { describe, it, expect } from 'vitest'
import { defaults, type Environment, type Variable } from '../src/shared/apiModel'
import { lookupVariable, resolveTemplate, scopeChain } from '../src/shared/apiVariables'

const v = (key: string, value: string, enabled = true): Variable => ({ id: `var_${key}`, key, value, enabled })
const env = (variables: Variable[]): Environment => ({
  id: 'env_1',
  workspaceId: 'ws_1',
  name: 'dev',
  color: 'blue',
  production: false,
  variables
})
const collection = (variables: Variable[]) => ({ ...defaults.collection('ws_1', 'Pets'), variables })

describe('scopeChain', () => {
  it('orders global < collection < environment and skips absent layers', () => {
    expect(scopeChain([], null, null).layers.map((l) => l.scope)).toEqual(['global'])
    const chain = scopeChain([v('a', 'g')], collection([]), env([]))
    expect(chain.layers.map((l) => [l.scope, l.name])).toEqual([
      ['global', 'Globals'],
      ['collection', 'Pets'],
      ['environment', 'dev']
    ])
  })
})

describe('resolveTemplate', () => {
  it('narrowest scope wins, and a disabled variable does not count', () => {
    const chain = scopeChain([v('host', 'g'), v('only', 'global')], collection([v('host', 'c')]), env([v('host', 'e')]))
    expect(resolveTemplate('{{host}}/{{only}}', chain)).toEqual({
      text: 'e/global',
      unresolved: [],
      used: [
        { name: 'host', scope: 'environment' },
        { name: 'only', scope: 'global' }
      ]
    })
    const off = scopeChain([v('host', 'g')], collection([v('host', 'c')]), env([v('host', 'e', false)]))
    expect(resolveTemplate('{{host}}', off).text).toBe('c')
    expect(lookupVariable(off, 'host')).toEqual({ value: 'c', scope: 'collection' })
  })

  it('tolerates spaces inside the braces', () => {
    expect(resolveTemplate('{{ a }}', scopeChain([v('a', '1')], null, null)).text).toBe('1')
  })

  it('nests to depth 3 and no further', () => {
    const chain = scopeChain([v('a', '{{b}}'), v('b', '{{c}}'), v('c', '{{d}}'), v('d', 'deep')], null, null)
    const r = resolveTemplate('{{b}}', chain)
    expect(r.text).toBe('deep')
    const deeper = resolveTemplate('{{a}}', chain)
    expect(deeper.text).toBe('{{d}}')
    expect(deeper.unresolved).toEqual(['d'])
  })

  it('reports undefined names once and leaves them in place; a cycle ends', () => {
    const r = resolveTemplate('{{x}}-{{x}}-{{y}}', scopeChain([], null, null))
    expect(r).toEqual({ text: '{{x}}-{{x}}-{{y}}', unresolved: ['x', 'y'], used: [] })
    const loop = resolveTemplate('{{a}}', scopeChain([v('a', '{{a}}')], null, null))
    expect(loop.unresolved).toEqual(['a'])
  })

  it('never resolves vault references', () => {
    const chain = scopeChain([v('t', 'vault:abc#password')], null, null)
    expect(resolveTemplate('Bearer {{t}}', chain).text).toBe('Bearer vault:abc#password')
  })
})
