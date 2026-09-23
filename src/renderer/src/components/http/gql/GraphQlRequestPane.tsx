import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, PanelRight, Play } from 'lucide-react'
import type { EditorView } from '@codemirror/view'
import { updateSchema } from 'cm6-graphql'
import type { Id, ResponseState, Row } from '../../../../../shared/apiModel'
import type { VariableScopeChain } from '../../../../../shared/apiVariables'
import { clsx, duration } from '../../../lib/format'
import { isMac } from '../../../lib/shortcuts'
import { useApi } from '../../../store/api'
import { schemaOf, useGqlSchemas } from '../../../store/gqlSchemas'
import { useHttp } from '../../../store/http'
import { CodeEditor } from '../../common/CodeEditor'
import { SplitButton } from '../../common/SplitButton'
import { Tabs } from '../../common/Tabs'
import { VariableInput } from '../fields/VariableInput'
import { ProtocolLayout, urlRowLayout, useWidth } from '../ProtocolLayout'
import { AuthEditor } from '../request/AuthEditor'
import { HeadersEditor } from '../request/HeadersEditor'
import {
  HTTP_FIX_EVENT,
  HTTP_SET_VARIABLE_EVENT,
  ResponsePane,
  type HttpFixDetail,
  type SetVariableDetail
} from '../response/ResponsePane'
import { RouteChip } from '../RouteChip'
import { TlsChip } from '../TlsChip'
import { errorsStrip, gqlExtensions, literalSecretsIn, operationsIn, prettify } from './graphqlLanguage'
import { gqlRequestOf, loadGqlSchema, prettifyGql, runGql, schemaKeyFor, updateGql } from './gqlActions'
import { SchemaExplorer, explorerMode } from './SchemaExplorer'
import './gql.css'

type Section = 'query' | 'auth' | 'headers' | 'settings'

const EMPTY_CHAIN: VariableScopeChain = { layers: [] }
const enabledCount = (rows: Row[]): number => rows.filter((r) => r.enabled && r.key !== '').length

function responseLine(res: ResponseState | undefined): string {
  switch (res?.status) {
    case 'sending':
      return 'Waiting for response…'
    case 'done':
      return `${res.response.status} ${res.response.statusText} · ${res.response.durationMs} ms`
    case 'error':
      return res.message
    default:
      return 'Run the query to see the response'
  }
}

export interface GraphQlRequestPaneProps {
  tabId: Id
  /** The request half's width, when the caller already knows it; measured otherwise. */
  requestWidth?: number
}

export function GraphQlRequestPane({ tabId, requestWidth }: GraphQlRequestPaneProps): React.JSX.Element | null {
  const tab = useHttp((s) => s.tabs.find((t) => t.id === tabId))
  const res = useHttp((s) => s.responses[tabId])
  const prefs = useHttp((s) => s.prefs)
  const setPrefs = useHttp((s) => s.setPrefs)
  const collections = useApi((s) => s.collections)
  const workspace = useApi((s) => s.workspace)
  const byKey = useGqlSchemas((s) => s.byKey)
  const [section, setSection] = useState<Section>('query')
  const [requestRef, measured] = useWidth<HTMLDivElement>()
  const [barRef, barWidth] = useWidth<HTMLDivElement>()
  const view = useRef<EditorView | null>(null)
  const responseRef = useRef<HTMLDivElement>(null)
  const language = useMemo(() => gqlExtensions(), [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const req = useMemo(() => gqlRequestOf(tab), [tab, collections])
  const chain = useMemo(
    () => (tab ? useApi.getState().scopeChainFor(tab) : EMPTY_CHAIN),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab?.ref?.collectionId, collections, workspace]
  )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const key = useMemo(() => (tab && req ? schemaKeyFor(tab, req) : null), [tab, req?.url, collections, workspace])
  const entry = key ? byKey[key] : undefined
  const schema = schemaOf(entry)
  const ops = useMemo(() => operationsIn(req?.query ?? ''), [req?.query])
  const secrets = useMemo(() => literalSecretsIn(req?.variables ?? ''), [req?.variables])
  const strip = useMemo(() => errorsStrip(res), [res])

  // The editor stays mounted while the schema changes, and remounts when the
  // Query tab comes back; either way it gets the current schema.
  useEffect(() => {
    if (view.current) updateSchema(view.current, schema)
  }, [schema, section])

  // Unpinned, the explorer belongs to this tab only.
  const pinned = prefs.gqlSchemaPinned
  useEffect(
    () => () => {
      if (!useHttp.getState().prefs.gqlSchemaPinned) useHttp.getState().setPrefs({ gqlSchemaOpen: false })
    },
    []
  )

  const mounted = tab !== undefined
  // The response pane's fix buttons (C) bubble an event; these three are the
  // request's to act on. Anything else goes on up to the workbench.
  useEffect(() => {
    const el = responseRef.current
    if (!el) return
    const onFix = (e: Event): void => {
      const { action } = (e as CustomEvent<HttpFixDetail>).detail
      const draft = gqlRequestOf(useHttp.getState().tabs.find((t) => t.id === tabId))
      if (action === 'send-anyway') void runGql(tabId, { allowUnresolved: true })
      else if (action === 'raise-timeout') setSection('settings')
      else if (action === 'retry-http' && draft && /^\s*https:\/\//i.test(draft.url)) {
        updateGql(tabId, { url: draft.url.replace(/^\s*https:\/\//i, 'http://') })
        void runGql(tabId)
      } else return
      e.stopPropagation()
    }
    el.addEventListener(HTTP_FIX_EVENT, onFix)
    return () => el.removeEventListener(HTTP_FIX_EVENT, onFix)
  }, [tabId, mounted])

  if (!tab || !req) return null

  const mode = explorerMode(requestWidth ?? measured)
  const collection = collections.find((c) => c.id === tab.ref?.collectionId)
  const run = (operationName?: string): void =>
    void runGql(tabId, { cursor: view.current?.state.selection.main.head, operationName })
  const openSection = (s: Section): void => {
    setSection(s)
    if (tab.split === 'request-collapsed') useHttp.getState().setSplit(tabId, 'normal')
  }
  const running = res?.status === 'sending'

  const explorer = prefs.gqlSchemaOpen ? (
    <SchemaExplorer
      entry={entry}
      mode={mode}
      pinned={pinned}
      onPin={(p) => setPrefs({ gqlSchemaPinned: p })}
      onClose={() => setPrefs({ gqlSchemaOpen: false })}
      onLoad={() => void loadGqlSchema(tabId)}
      target={req.url || 'this endpoint'}
    />
  ) : null

  // §2.1's degradation, from S's pure function; unmeasured (and in jsdom) nothing degrades.
  const tls = !!collection && (collection.insecureTls || !!collection.caPem)
  const step = barWidth > 0 ? urlRowLayout(barWidth, { tls }).step : 0

  const bar = (
    <div className="hc-gql-bar" ref={barRef} data-step={step}>
      <span className="hc-gql-badge" aria-label="GraphQL">
        GQL
      </span>
      <div className="hc-gql-url">
        <VariableInput
          value={req.url}
          onChange={(url) => updateGql(tabId, { url })}
          chain={chain}
          placeholder="https://host/graphql"
          ariaLabel="GraphQL endpoint"
          onSubmit={() => run()}
        />
      </div>
      <RouteChip tabId={tabId} compact={step >= 1} />
      <TlsChip tabId={tabId} compact={step >= 3} />
      <div className="hc-gql-run">
        <SplitButton
          label="Run"
          icon={<Play size={14} aria-hidden />}
          ariaLabel={`Run (${isMac() ? '⌘↵' : 'Ctrl+Enter'})`}
          variant="primary"
          iconOnly={step >= 2}
          busy={running}
          onClick={() => run()}
          entries={
            ops.length > 1
              ? ops.map((o, i) => ({
                  label: `Run ${o.name ?? `anonymous ${o.type} ${i + 1}`}`,
                  shortcut: o.type,
                  disabled: !o.name,
                  onClick: () => run(o.name)
                }))
              : []
          }
        />
      </div>
    </div>
  )

  const requestTabs = (
    <Tabs
      ariaLabel="Request"
      idPrefix={`${tabId}-gql`}
      active={section}
      onChange={(id) => setSection(id as Section)}
      tabs={[
        { id: 'query', label: 'Query' },
        { id: 'auth', label: 'Auth', dot: req.auth.type === 'none' || req.auth.type === 'inherit' ? undefined : 'set' },
        { id: 'headers', label: 'Headers', count: enabledCount(req.headers) },
        { id: 'settings', label: 'Settings' }
      ]}
    />
  )

  const types = schema ? Object.keys(schema.getTypeMap()).filter((n) => !n.startsWith('__')).length : 0
  const requestToolbar =
    section === 'query' ? (
      <div className="hc-gql-toolbar">
        <button
          type="button"
          className="btn ghost sm"
          title={`Prettify (${isMac() ? '⌥⌘B' : 'Ctrl+Alt+B'})`}
          disabled={prettify(req.query) === null}
          onClick={() => prettifyGql(tabId)}
        >
          Prettify
        </button>
        <button
          type="button"
          className={clsx('btn ghost sm', prefs.gqlSchemaOpen && 'is-on')}
          aria-pressed={prefs.gqlSchemaOpen}
          onClick={() => setPrefs({ gqlSchemaOpen: !prefs.gqlSchemaOpen })}
        >
          Schema <PanelRight size={13} aria-hidden />
        </button>
        {entry?.status === 'loading' ? (
          <span className="hc-gql-meta">Loading schema…</span>
        ) : schema && entry?.status === 'ready' ? (
          <span className="hc-gql-meta">
            · {types} types · {duration(entry.at)} ago
          </span>
        ) : (
          <button type="button" className="btn ghost sm" onClick={() => void loadGqlSchema(tabId)}>
            Load schema
          </button>
        )}
      </div>
    ) : undefined

  const query = (
    <div className="hc-gql-query">
      <div className="hc-gql-editor">
        <CodeEditor
          value={req.query}
          onChange={(q) => updateGql(tabId, { query: q })}
          language={language}
          onSubmit={() => run()}
          placeholder="query { … }"
          ariaLabel="GraphQL query"
          editorRef={view}
        />
      </div>
      <div className="hc-gql-vars">
        <button
          type="button"
          className="hc-gql-vars-head"
          aria-expanded={prefs.gqlVariablesOpen}
          onClick={() => setPrefs({ gqlVariablesOpen: !prefs.gqlVariablesOpen })}
        >
          {prefs.gqlVariablesOpen ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
          <span className="ui-label">Variables</span>
        </button>
        {prefs.gqlVariablesOpen && (
          <div className="hc-gql-vars-editor">
            <CodeEditor
              value={req.variables}
              onChange={(variables) => updateGql(tabId, { variables })}
              language="json"
              variables={chain}
              onSubmit={() => run()}
              placeholder='{ "id": 1 }'
              ariaLabel="GraphQL variables"
            />
          </div>
        )}
        {secrets.length > 0 && (
          // Variables are saved with the request and synced (§3.5 keeps them, with this warning).
          <p className="hc-gql-warn" role="note">
            {secrets.map((s) => s.key).join(', ')} {secrets.length === 1 ? 'looks' : 'look'} like a credential: saved and
            synced as plain text.{' '}
            <button
              type="button"
              className="btn ghost sm"
              onClick={(e) =>
                e.currentTarget.dispatchEvent(
                  new CustomEvent<SetVariableDetail>(HTTP_SET_VARIABLE_EVENT, {
                    bubbles: true,
                    detail: { tabId, name: secrets[0].key, value: secrets[0].value }
                  })
                )
              }
            >
              Set as variable…
            </button>{' '}
            then write {`"{{${secrets[0].key}}}"`} in its place, and the vault can hold it.
          </p>
        )}
      </div>
    </div>
  )

  const request: ReactNode = (
    <div
      className={clsx('hc-gql-request', mode === 'dock' && explorer && 'has-dock')}
      ref={requestRef}
      role="tabpanel"
      id={`${tabId}-gql-panel`}
      aria-labelledby={`${tabId}-gql-tab-${section}`}
    >
      {section === 'query' ? (
        <>
          {query}
          {mode === 'dock' && explorer}
        </>
      ) : section === 'auth' ? (
        <AuthEditor
          value={req.auth}
          onChange={(auth) => updateGql(tabId, { auth })}
          inheritFrom={collection?.name}
          collectionName={collection?.name}
        />
      ) : section === 'headers' ? (
        <HeadersEditor rows={req.headers} onChange={(headers) => updateGql(tabId, { headers })} chain={chain} />
      ) : (
        <div className="hc-gql-settings">
          <label className="hc-gql-field">
            <span className="ui-label">Timeout (ms)</span>
            <input
              className="input mono"
              type="number"
              min={0}
              aria-label="Timeout in milliseconds"
              placeholder="Collection default"
              value={req.settings.timeoutMs ?? ''}
              onChange={(e) =>
                updateGql(tabId, {
                  settings: { ...req.settings, timeoutMs: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)) }
                })
              }
            />
          </label>
        </div>
      )}
    </div>
  )

  const response = (
    <div className="hc-gql-response" ref={responseRef}>
      <ResponsePane tabId={tabId} />
      {mode === 'overlay' && explorer}
    </div>
  )

  const requestSummary = (
    <span className="hc-gql-summary">
      Request ·{' '}
      <button type="button" className="btn ghost sm" onClick={() => openSection('query')}>
        Query
      </button>
      <button type="button" className="btn ghost sm" onClick={() => openSection('auth')}>
        Auth{req.auth.type !== 'none' && req.auth.type !== 'inherit' ? ' •' : ''}
      </button>
      <button type="button" className="btn ghost sm" onClick={() => openSection('headers')}>
        Headers {enabledCount(req.headers)}
      </button>
    </span>
  )

  return (
    <ProtocolLayout
      tabId={tabId}
      kind="graphql"
      bar={bar}
      requestTabs={requestTabs}
      requestToolbar={requestToolbar}
      request={request}
      response={response}
      requestSummary={requestSummary}
      responseSummary={<span className="hc-gql-summary">{strip ?? responseLine(res)}</span>}
    />
  )
}
