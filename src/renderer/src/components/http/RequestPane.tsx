import { useCallback, useMemo, useState } from 'react'
import { Send, Plus, Trash2, Loader2 } from 'lucide-react'
import { useApp } from '../../store/app'
import { bridgeHas } from '../../lib/bridge'
import { sshTargetFor } from '../../lib/ssh'
import { clsx } from '../../lib/format'
import { API_METHODS, type ApiCollection, type ApiEndpoint } from '../../types'
import {
  buildHeaders,
  buildUrl,
  bodyFor,
  emptyDraft,
  guessContentType,
  hasContentType,
  prettyBody,
  type KeyValueRow,
  type RequestDraft
} from '../../../../shared/httpRequestDraft'
import { methodAllowsBody, type HttpResult, type HttpVia } from '../../../../shared/httpClient'

/**
 * Composing a request and sending it.
 *
 * This replaces an embedded OpenAPI client that could not be made to work.
 * It rendered operations out of a synthetic document, and after three attempts
 * at coaxing it — landing paths, selection hooks, document shape — clicking an
 * endpoint still left the pane reading "Select an operation to view details",
 * and it exposed no Send control this app could drive.
 *
 * Everything a request needs was already here: `http:request` in main returns
 * the status, the headers, the body and the duration, and it routes through
 * SSH forwarding and per-collection TLS. The only missing piece was a pane
 * that builds a request and shows what came back — a smaller thing to own than
 * an embedded client that has to be argued with.
 */

const uid = (): string => `kv-${crypto.randomUUID()}`
const blankRow = (): KeyValueRow => ({ id: uid(), enabled: true, key: '', value: '' })

const decode = (buf: ArrayBuffer): string => new TextDecoder().decode(new Uint8Array(buf))

const sizeOf = (n: number): string =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`

/** 2xx succeeded, 3xx went elsewhere, the rest did not work. */
const statusTone = (s: number): 'ok' | 'warn' | 'danger' =>
  s >= 200 && s < 300 ? 'ok' : s >= 300 && s < 400 ? 'warn' : 'danger'

function KeyValueEditor({
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  empty
}: {
  rows: KeyValueRow[]
  onChange: (rows: KeyValueRow[]) => void
  keyPlaceholder: string
  valuePlaceholder: string
  empty: string
}): React.JSX.Element {
  const set = (id: string, patch: Partial<KeyValueRow>): void =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))

  return (
    <div className="kv-editor">
      {rows.length === 0 && <p className="kv-empty">{empty}</p>}
      {rows.map((r) => (
        <div key={r.id} className="kv-row">
          {/* Off rather than deleted: something you are toggling while
              debugging is something you want back in a moment. */}
          <input
            type="checkbox"
            checked={r.enabled}
            aria-label={r.key ? `Send ${r.key}` : 'Send this row'}
            onChange={(e) => set(r.id, { enabled: e.target.checked })}
          />
          <input
            className="input sm"
            placeholder={keyPlaceholder}
            aria-label="Name"
            value={r.key}
            onChange={(e) => set(r.id, { key: e.target.value })}
          />
          <input
            className="input sm"
            placeholder={valuePlaceholder}
            aria-label="Value"
            value={r.value}
            onChange={(e) => set(r.id, { value: e.target.value })}
          />
          <button
            className="icon-btn sm"
            title="Remove"
            aria-label="Remove row"
            onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <button className="btn ghost sm kv-add" onClick={() => onChange([...rows, blankRow()])}>
        <Plus size={13} /> Add row
      </button>
    </div>
  )
}

function ResponseView({ result }: { result: HttpResult }): React.JSX.Element {
  const [tab, setTab] = useState<'body' | 'headers'>('body')

  if (!result.ok) {
    return (
      <div className="req-response">
        <div className="req-response-head">
          <span className="chip danger">Failed</span>
          {result.code && <span className="faint mono">{result.code}</span>}
        </div>
        <p className="req-response-error">{result.error}</p>
      </div>
    )
  }

  const headerCount = Object.keys(result.headers).length
  return (
    <div className="req-response">
      <div className="req-response-head">
        <span className={clsx('chip', statusTone(result.status))}>
          {result.status} {result.statusText}
        </span>
        <span className="faint">{Math.round(result.durationMs)} ms</span>
        <span className="faint">{sizeOf(result.body.byteLength)}</span>
        {/* Not a detail: the rest of the body is missing, and someone
            scrolling to the end would otherwise think it ended there. */}
        {result.truncated && <span className="chip warn">truncated</span>}
        <span className="spacer" />
        <div className="segment">
          {(
            [
              ['body', 'Body'],
              ['headers', `Headers (${headerCount})`]
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              className={clsx('seg-btn', tab === id && 'active')}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <pre className="req-response-body mono selectable">
        {tab === 'body'
          ? prettyBody(decode(result.body)) || '(empty)'
          : Object.entries(result.headers)
              .map(([k, v]) => `${k}: ${v}`)
              .join('\n')}
      </pre>
    </div>
  )
}

type Tab = 'params' | 'headers' | 'body'
type Phase = { kind: 'idle' } | { kind: 'sending' } | { kind: 'done'; result: HttpResult }

export function RequestPane({
  collection,
  endpoint
}: {
  collection: ApiCollection
  endpoint: ApiEndpoint | null
}): React.JSX.Element {
  const servers = useApp((s) => s.servers)
  const [draft, setDraft] = useState<RequestDraft>(() => draftFor(endpoint))
  const [tab, setTab] = useState<Tab>('params')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  /**
   * Selecting a different endpoint starts a different request.
   *
   * Reset during render on a changed key rather than in an effect: carrying
   * the previous request's headers into this one is how somebody sends the
   * wrong thing, and an effect would let one frame render with them.
   */
  const key = endpoint ? endpoint.id : 'blank'
  const [lastKey, setLastKey] = useState(key)
  if (key !== lastKey) {
    setLastKey(key)
    setDraft(draftFor(endpoint))
    setPhase({ kind: 'idle' })
    setTab('params')
  }

  const url = useMemo(() => buildUrl(collection.baseUrl, draft), [collection.baseUrl, draft])

  /**
   * Where the request leaves from.
   *
   * A collection outlives the server it named. Sending directly instead would
   * quietly reach a different machine — usually a public one bearing the same
   * name as something internal — so an unresolved target refuses to send.
   */
  const via = useMemo((): HttpVia | null => {
    if (!collection.viaServerId) return { kind: 'direct' }
    const server = servers.find((s) => s.id === collection.viaServerId)
    return server ? { kind: 'server', server: sshTargetFor(server) } : null
  }, [collection.viaServerId, servers])

  const sending = phase.kind === 'sending'
  const blocked = url.trim() === '' ? 'Give the request a path.' : via === null ? routeGone : null
  const canSend = !sending && blocked === null

  const send = useCallback(async (): Promise<void> => {
    if (sending || via === null || url.trim() === '') return
    setPhase({ kind: 'sending' })

    const headers = buildHeaders(draft)
    const body = bodyFor(draft)
    // A default only. An explicit Content-Type always wins, because somebody
    // who typed one meant it.
    if (body !== null && !hasContentType(headers)) headers['Content-Type'] = guessContentType(body)

    // Under `electron-vite dev` the renderer reloads while the process keeps
    // the preload bundle it booted with, so a method added today is undefined
    // for the rest of that session. Say so instead of throwing into the error
    // boundary and taking the window down with it.
    if (!bridgeHas(window.opsmaxx?.http as Record<string, unknown> | undefined, 'request')) {
      setPhase({
        kind: 'done',
        result: {
          ok: false,
          error: 'Restart OpsMaxx to send — this window is newer than the process behind it.'
        }
      })
      return
    }

    const result = await window.opsmaxx.http.request({
      url,
      method: draft.method,
      headers,
      ...(body !== null ? { body: new TextEncoder().encode(body).buffer as ArrayBuffer } : {}),
      via,
      insecureTls: collection.insecureTls
    })
    setPhase({ kind: 'done', result })
  }, [sending, via, url, draft, collection.insecureTls])

  const counted = (label: string, rows: KeyValueRow[]): string => {
    const on = rows.filter((r) => r.enabled && r.key.trim() !== '').length
    return on > 0 ? `${label} (${on})` : label
  }

  return (
    // Cmd/Ctrl+Enter sends from anywhere in the pane, including from inside
    // the body, where a plain Enter has to stay a newline.
    <div
      className="req-pane"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          void send()
        }
      }}
    >
      <div className="req-bar">
        <select
          className={clsx('input req-method', `m-${draft.method.toLowerCase()}`)}
          aria-label="Method"
          value={draft.method}
          onChange={(e) => setDraft({ ...draft, method: e.target.value })}
        >
          {API_METHODS.map((m) => (
            <option key={m} value={m.toUpperCase()}>
              {m.toUpperCase()}
            </option>
          ))}
        </select>
        <input
          className="input req-path mono"
          aria-label="Path"
          placeholder="/v1/users"
          value={draft.path}
          onChange={(e) => setDraft({ ...draft, path: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void send()
          }}
        />
        <button
          className="btn primary req-send"
          disabled={!canSend}
          title={blocked ?? 'Send (⌘↵)'}
          onClick={() => void send()}
        >
          {sending ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
          {sending ? 'Sending' : 'Send'}
        </button>
      </div>

      {/* What will actually be requested, which is not always what was typed:
          the base URL, the path and the parameters only become one string
          here, and seeing it is how a wrong one gets caught before it is
          sent. */}
      <div className="req-url mono selectable">{url || '—'}</div>
      {blocked && url.trim() !== '' && <p className="req-blocked">{blocked}</p>}

      <div className="segment req-tabs">
        {(
          [
            ['params', counted('Params', draft.params)],
            ['headers', counted('Headers', draft.headers)],
            ['body', 'Body']
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            className={clsx('seg-btn', tab === id && 'active')}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="req-editor">
        {tab === 'params' && (
          <KeyValueEditor
            rows={draft.params}
            onChange={(params) => setDraft({ ...draft, params })}
            keyPlaceholder="q"
            valuePlaceholder="london"
            empty="No query parameters. They are appended to the URL above as you add them."
          />
        )}
        {tab === 'headers' && (
          <KeyValueEditor
            rows={draft.headers}
            onChange={(headers) => setDraft({ ...draft, headers })}
            keyPlaceholder="Authorization"
            valuePlaceholder="Bearer …"
            empty="No headers. Content-Type is filled in from the body unless you set it here."
          />
        )}
        {tab === 'body' && (
          <>
            {/* Said rather than hidden. A control that does nothing with no
                explanation is the defect this screen was reported for. */}
            {!methodAllowsBody(draft.method) && (
              <p className="req-note">
                {draft.method} carries no body, so this is kept and not sent. Change the method to
                send it.
              </p>
            )}
            <textarea
              className="textarea req-body"
              aria-label="Body"
              rows={10}
              spellCheck={false}
              placeholder={'{\n  "name": "example"\n}'}
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
          </>
        )}
      </div>

      {phase.kind === 'sending' && (
        <div className="req-response">
          <div className="req-response-head">
            <Loader2 size={13} className="spin" />
            <span className="faint">Waiting for a response…</span>
          </div>
        </div>
      )}
      {phase.kind === 'done' && <ResponseView result={phase.result} />}
    </div>
  )
}

const routeGone =
  'This collection sends through a server that no longer exists. Point it at another one in the toolbar.'

function draftFor(endpoint: ApiEndpoint | null): RequestDraft {
  return endpoint ? emptyDraft(endpoint.method.toUpperCase(), endpoint.path) : emptyDraft()
}
