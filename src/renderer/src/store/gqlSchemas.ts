import { create } from 'zustand'
import type { GraphQLSchema } from 'graphql'
import type { RouteKey } from '../../../shared/apiModel'

// Introspected GraphQL schemas, in memory, keyed by endpoint and route: the
// same URL through two routes can be two different servers.
//
// A schema is never loaded as a side effect of typing: only an explicit Load,
// or the first successful Run against that (URL, route). A failed reload keeps
// the schema it already had and says why beside it (§2.13).

export type SchemaKey = `${string}|${RouteKey}`

export interface LoadedSchema {
  schema: GraphQLSchema
  at: number
  /** Said once beside the schema, e.g. that it was reloaded without descriptions. */
  note?: string
}

export type SchemaEntry =
  | { status: 'loading'; previous?: LoadedSchema }
  | ({ status: 'ready'; /** The last reload failed; this schema is the one before it. */ error?: string } & LoadedSchema)
  | { status: 'error'; message: string; at: number }

export type SchemaFetch = () => Promise<GraphQLSchema | { schema: GraphQLSchema; note: string }>

interface GqlSchemasState {
  byKey: Record<SchemaKey, SchemaEntry>
  load: (key: SchemaKey, fetcher: SchemaFetch) => Promise<void>
  clear: (key: SchemaKey) => void
}

const inflight = new Map<SchemaKey, Promise<void>>()

export function resetGqlSchemasForTests(): void {
  inflight.clear()
}

export const schemaOf = (entry: SchemaEntry | undefined): GraphQLSchema | undefined =>
  entry?.status === 'ready' ? entry.schema : entry?.status === 'loading' ? entry.previous?.schema : undefined

export const useGqlSchemas = create<GqlSchemasState>((set, get) => {
  const put = (key: SchemaKey, entry: SchemaEntry): void => set((s) => ({ byKey: { ...s.byKey, [key]: entry } }))

  return {
    byKey: {},

    load: (key, fetcher) => {
      const running = inflight.get(key)
      if (running) return running
      const was = get().byKey[key]
      const previous: LoadedSchema | undefined =
        was?.status === 'ready' ? { schema: was.schema, at: was.at, note: was.note } : undefined
      put(key, { status: 'loading', previous })
      const run = (async () => {
        try {
          const got = await fetcher()
          const loaded = 'schema' in got ? got : { schema: got }
          put(key, { status: 'ready', at: Date.now(), ...loaded })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          put(key, previous ? { status: 'ready', ...previous, error: message } : { status: 'error', message, at: Date.now() })
        } finally {
          inflight.delete(key)
        }
      })()
      inflight.set(key, run)
      return run
    },

    clear: (key) =>
      set((s) => {
        const { [key]: _gone, ...byKey } = s.byKey
        return { byKey }
      })
  }
})
