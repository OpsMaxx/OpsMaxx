import { useCallback, useMemo, useState } from 'react'
import { BookOpen, Loader2, Play } from 'lucide-react'
import { useApp } from '../../store/app'
import { sshTargetFor } from '../../lib/ssh'
import { clsx } from '../../lib/format'
import { bridgeHas } from '../../lib/bridge'
import { VAULT_LOCKED_MESSAGE, resolveSecrets, resolveUrl } from '../../../../shared/apiSecrets'
import { UnlockVaultButton } from '../common/UnlockVaultButton'
import { useVault } from '../../store/vault'
import {
  INTROSPECTION_QUERY,
  buildGraphQlBody,
  parseVariables,
  readGraphQlResponse,
  renderTypeRef,
  usefulTypes,
  type GraphQlResponse,
  type SchemaType
} from '../../../../shared/graphql'
import { charsetOf, type HttpVia } from '../../../../shared/httpClient'
import type { ApiCollection } from '../../types'

/**
 * A GraphQL console.
 *
 * The embedded API client has no GraphQL support whatsoever — grepped, not
 * assumed — so this is OpsMaxx's own. It is deliberately thin: a GraphQL
 * request IS an HTTP POST, so it goes through the same `http:request` as
 * everything else and inherits the SSH route, the certificate setting, the
 * redirect rules and vault-backed values for free.
 *
 * What it does NOT do is pretend to be a full GraphQL IDE. There is no
 * schema-aware autocomplete, because that needs a real parser and a second
 * editor stack. Introspection is one canned query rendered as a type list,
 * which is the part people actually use it for.
 */

type Phase =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'failed'; error: string }
  | { kind: 'done'; ok: boolean; status: number; ms: number; response?: GraphQlResponse; parseError?: string }

const decode = (buf: ArrayBuffer, contentType: string | undefined): string => {
  const charset = charsetOf(contentType) ?? 'utf-8'
  try {
    return new TextDecoder(charset).decode(new Uint8Array(buf))
  } catch {
    // An encoding label the platform does not know. UTF-8 is the only sensible
    // fallback and is what the endpoint almost certainly meant.
    return new TextDecoder().decode(new Uint8Array(buf))
  }
}

export function GraphQlConsole({ collection }: { collection: ApiCollection }): React.JSX.Element {
  const servers = useApp((s) => s.servers)
  const vaultUnlocked = useVault((s) => s.unlocked)
  const vaultEntries = useVault((s) => s.entries)

  const [url, setUrl] = useState(() => graphqlUrlFor(collection.baseUrl))
  const [query, setQuery] = useState('query {\n  \n}')
  const [variablesText, setVariablesText] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [schema, setSchema] = useState<SchemaType[] | null>(null)
  const [tab, setTab] = useState<'response' | 'schema'>('response')

  const variables = useMemo(() => parseVariables(variablesText), [variablesText])

  const via = useMemo((): HttpVia | null => {
    if (!collection.viaServerId) return { kind: 'direct' }
    const server = servers.find((s) => s.id === collection.viaServerId)
    return server ? { kind: 'server', server: sshTargetFor(server) } : null
  }, [collection.viaServerId, servers])

  const vault = useMemo(
    () => ({
      unlocked: vaultUnlocked,
      read: ({ entryId, field }: { entryId: string; field: 'password' | 'username' }) => {
        const entry = vaultEntries.find((e) => e.id === entryId)
        if (!entry) return null
        return field === 'username' ? entry.username : entry.password
      }
    }),
    [vaultUnlocked, vaultEntries]
  )

  /** One POST. Used for both the user's query and introspection. */
  const post = useCallback(
    async (body: string): Promise<Phase> => {
      if (via === null) {
        return {
          kind: 'failed',
          error:
            'This collection sends through a server that no longer exists. Point it at another one in the toolbar.'
        }
      }
      if (!bridgeHas(window.opsmaxx?.http as Record<string, unknown> | undefined, 'request')) {
        return {
          kind: 'failed',
          error: 'Restart OpsMaxx to send — this window is newer than the process behind it.'
        }
      }

      let target: string
      let headers: Record<string, string>
      try {
        target = resolveUrl(url, vault)
        headers = resolveSecrets({ 'Content-Type': 'application/json', Accept: 'application/json' }, vault)
      } catch (err) {
        return { kind: 'failed', error: err instanceof Error ? err.message : String(err) }
      }

      const started = performance.now()
      const result = await window.opsmaxx.http.request({
        url: target,
        method: 'POST',
        headers,
        body: new TextEncoder().encode(body).buffer as ArrayBuffer,
        via,
        insecureTls: collection.insecureTls,
        maxRedirects: 5
      })
      if (!result.ok) return { kind: 'failed', error: result.error }

      const text = decode(result.body, result.headers['content-type'])
      const read = readGraphQlResponse(result.status, text)
      return {
        kind: 'done',
        ok: read.ok,
        status: result.status,
        ms: Math.round(performance.now() - started),
        response: read.response,
        parseError: read.parseError
      }
    },
    [via, url, vault, collection.insecureTls]
  )

  const run = useCallback(async (): Promise<void> => {
    if (!variables.ok || url.trim() === '') return
    setPhase({ kind: 'sending' })
    setTab('response')
    setPhase(
      await post(buildGraphQlBody({ query, ...(variables.variables ? { variables: variables.variables } : {}) }))
    )
  }, [post, query, variables, url])

  const introspect = useCallback(async (): Promise<void> => {
    setPhase({ kind: 'sending' })
    const result = await post(buildGraphQlBody({ query: INTROSPECTION_QUERY }))
    setPhase(result)
    if (result.kind === 'done' && result.response?.data) {
      const data = result.response.data as { __schema?: { types?: SchemaType[] } }
      setSchema(data.__schema?.types ?? [])
      setTab('schema')
    }
  }, [post])

  const sending = phase.kind === 'sending'
  const blocked = url.trim() === '' ? 'Give the request a URL.' : !variables.ok ? variables.error : null

  return (
    <div
      className="req-pane"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          void run()
        }
      }}
    >
      <div className="req-bar">
        <input
          className="input req-path mono"
          aria-label="GraphQL endpoint"
          placeholder="https://host/graphql"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button
          className="btn"
          title="Read the schema from the endpoint"
          disabled={sending || url.trim() === ''}
          onClick={() => void introspect()}
        >
          <BookOpen size={14} /> Schema
        </button>
        <button
          className="btn primary req-send"
          disabled={sending || blocked !== null}
          title={blocked ?? 'Run (⌘↵)'}
          onClick={() => void run()}
        >
          {sending ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
          {sending ? 'Running' : 'Run'}
        </button>
      </div>

      <div className="gql-editors">
        <label className="gql-editor">
          <span className="ui-section-title">Query</span>
          <textarea
            className="textarea mono"
            aria-label="Query"
            rows={10}
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label className="gql-editor">
          <span className="ui-section-title">Variables</span>
          <textarea
            className="textarea mono"
            aria-label="Variables"
            rows={10}
            spellCheck={false}
            placeholder={'{\n  "id": 1\n}'}
            value={variablesText}
            onChange={(e) => setVariablesText(e.target.value)}
          />
          {/* The reason it is refused, where the refusal happens. */}
          {!variables.ok && <span className="req-blocked">{variables.error}</span>}
        </label>
      </div>

      <Result phase={phase} schema={schema} tab={tab} onTab={setTab} />
    </div>
  )
}

function Result({
  phase,
  schema,
  tab,
  onTab
}: {
  phase: Phase
  schema: SchemaType[] | null
  tab: 'response' | 'schema'
  onTab: (tab: 'response' | 'schema') => void
}): React.JSX.Element | null {
  if (phase.kind === 'idle' && schema === null) return null

  return (
    <div className="req-response">
      <div className="req-response-head">
        {phase.kind === 'sending' && (
          <>
            <Loader2 size={13} className="spin" />
            <span className="faint">Waiting for a response…</span>
          </>
        )}
        {phase.kind === 'failed' && <span className="chip danger">Failed</span>}
        {phase.kind === 'done' && (
          <>
            {/*
              The status chip follows the GRAPHQL outcome, not the HTTP one.
              A GraphQL error arrives with 200, and a green 200 over a body
              full of errors is the single thing that makes a generic HTTP
              client wrong for this.
            */}
            <span className={clsx('chip', phase.ok ? 'ok' : 'danger')}>
              {phase.ok ? 'OK' : 'Errors'}
            </span>
            <span className="faint">HTTP {phase.status}</span>
            <span className="faint">{phase.ms} ms</span>
          </>
        )}
        <span className="spacer" />
        {schema !== null && (
          <div className="segment">
            {(
              [
                ['response', 'Response'],
                ['schema', `Schema (${usefulTypes(schema).length})`]
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                className={clsx('seg-btn', tab === id && 'active')}
                onClick={() => onTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {tab === 'schema' && schema !== null ? (
        <SchemaList types={schema} />
      ) : (
        <ResponseBody phase={phase} />
      )}
    </div>
  )
}

function ResponseBody({ phase }: { phase: Phase }): React.JSX.Element | null {
  if (phase.kind === 'failed') {
    return (
      <p className="req-response-error">
        {phase.error}
        {phase.error === VAULT_LOCKED_MESSAGE && (
          <UnlockVaultButton reason="Running this GraphQL query" />
        )}
      </p>
    )
  }
  if (phase.kind !== 'done') return null
  if (phase.parseError) return <p className="req-response-error">{phase.parseError}</p>

  const errors = phase.response?.errors ?? []
  return (
    <div className="gql-result">
      {/* Errors ABOVE data, and rendered rather than buried in the body. A
          partial success is legal in GraphQL, so both can be present. */}
      {errors.length > 0 && (
        <ul className="gql-errors">
          {errors.map((e, i) => (
            <li key={i}>
              <span className="gql-error-message">{e.message}</span>
              {e.path && <span className="faint mono"> at {e.path.join('.')}</span>}
              {e.locations?.[0] && (
                <span className="faint mono">
                  {' '}
                  line {e.locations[0].line}:{e.locations[0].column}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <pre className="req-response-body mono selectable">
        {phase.response?.data === undefined
          ? '(no data)'
          : JSON.stringify(phase.response.data, null, 2)}
      </pre>
    </div>
  )
}

function SchemaList({ types }: { types: SchemaType[] }): React.JSX.Element {
  const useful = usefulTypes(types)
  return (
    <div className="req-response-body selectable gql-schema">
      {useful.length === 0 && <p className="kv-empty">The endpoint described no types.</p>}
      {useful.map((t) => (
        <details key={t.name} className="gql-type">
          <summary>
            <span className="method-tag">{t.kind.toLowerCase()}</span>
            <span className="mono">{t.name}</span>
            {t.description && <span className="faint"> — {t.description}</span>}
          </summary>
          <ul className="gql-fields">
            {(t.fields ?? []).map((f) => (
              <li key={f.name}>
                <span className="mono">{f.name}</span>
                <span className="faint mono">: {renderTypeRef(f.type)}</span>
                {f.description && <span className="faint"> — {f.description}</span>}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  )
}

/**
 * A sensible starting endpoint from the collection's base.
 *
 * `/graphql` is the overwhelming convention, and a base URL that already names
 * a path is left exactly as it is — somebody who typed one meant it.
 */
export function graphqlUrlFor(baseUrl: string): string {
  const raw = baseUrl.trim()
  if (raw === '') return ''
  try {
    const url = new URL(raw)
    if (url.pathname && url.pathname !== '/') return raw
    return `${url.origin}/graphql`
  } catch {
    return raw
  }
}
