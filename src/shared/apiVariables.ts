/**
 * Variable scopes and `{{name}}` templating for the HTTP client.
 *
 * Narrowest wins: global < collection < environment. Vault references are not
 * resolved here; that happens in the build, at the last moment.
 */

import type { ApiCollectionV2, Environment, Variable } from './apiModel'

export type VariableScope = 'global' | 'collection' | 'environment'

/** Broadest first; a later layer overrides an earlier one. */
export interface VariableScopeChain {
  layers: { scope: VariableScope; name: string; variables: Variable[] }[]
}

export function scopeChain(
  globals: Variable[],
  collection: ApiCollectionV2 | null | undefined,
  env: Environment | null | undefined
): VariableScopeChain {
  const layers: VariableScopeChain['layers'] = [{ scope: 'global', name: 'Globals', variables: globals }]
  if (collection) layers.push({ scope: 'collection', name: collection.name, variables: collection.variables })
  if (env) layers.push({ scope: 'environment', name: env.name, variables: env.variables })
  return { layers }
}

/** The narrowest enabled definition of a name, or null. */
export function lookupVariable(
  chain: VariableScopeChain,
  name: string
): { value: string; scope: VariableScope } | null {
  for (let i = chain.layers.length - 1; i >= 0; i--) {
    const layer = chain.layers[i]
    // Last wins within a layer too, matching what a KV editor shows lowest.
    for (let j = layer.variables.length - 1; j >= 0; j--) {
      const v = layer.variables[j]
      if (v.enabled && v.key === name) return { value: v.value, scope: layer.scope }
    }
  }
  return null
}

const TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g
const MAX_DEPTH = 3

/**
 * `{{name}}` replaced from the chain, narrowest first. A value may itself hold
 * `{{other}}`, to depth 3; anything deeper, and anything undefined, is left in
 * place and reported in `unresolved`, which is also how a cycle ends.
 */
export function resolveTemplate(
  text: string,
  chain: VariableScopeChain
): { text: string; unresolved: string[]; used: { name: string; scope: VariableScope }[] } {
  const unresolved = new Set<string>()
  const used = new Map<string, VariableScope>()
  const expand = (input: string, depth: number): string =>
    input.replace(TOKEN, (token, raw: string) => {
      const found = raw ? lookupVariable(chain, raw) : null
      if (!found || depth >= MAX_DEPTH) {
        unresolved.add(raw)
        return token
      }
      if (!used.has(raw)) used.set(raw, found.scope)
      return expand(found.value, depth + 1)
    })
  const out = text.includes('{{') ? expand(text, 0) : text
  return { text: out, unresolved: [...unresolved], used: [...used].map(([name, scope]) => ({ name, scope })) }
}
