import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { API_METHODS, type ApiCollection, type ApiEndpoint, type ApiMethod } from '../../types'
import { useApp } from '../../store/app'
import { clsx } from '../../lib/format'

/**
 * The requests a collection defines by hand.
 *
 * This client was built around an imported OpenAPI description. A collection
 * without one got a SYNTHETIC description instead: a single path, derived from
 * the base URL, with all seven methods stubbed on it. Nothing wrote paths
 * back, so there was no way to name a second one — which is why the client had
 * no way to add an endpoint, remove one, or craft a request against a service
 * that publishes no description at all.
 *
 * Endpoints written here become that document. The point of doing it this way,
 * rather than building a separate request builder beside the client, is that a
 * hand-written endpoint then reaches the SAME client, the same Send button and
 * the same transport as an imported one — including the SSH and VPN routing
 * that is the reason this client lives in OpsMaxx at all. A parallel builder
 * would have had to re-earn every bit of that.
 */

/** Only what an OpenAPI path can be. Query strings belong in the client. */
function normalisePath(raw: string): string | null {
  const t = raw.trim()
  if (t === '') return null
  const withSlash = t.startsWith('/') ? t : `/${t}`
  // A path carrying a query or a fragment would be silently dropped by the
  // document, so it is refused here where the user can see why. `{id}` is
  // deliberately allowed: that is how an OpenAPI path parameter is written,
  // and the client relies on it to offer a field for the value.
  if (/[?#\s]/.test(withSlash)) return null
  return withSlash
}

export function EndpointEditor({
  collection
}: {
  collection: ApiCollection
}): React.JSX.Element | null {
  const update = useApp((s) => s.updateApiCollection)
  const [method, setMethod] = useState<ApiMethod>('get')
  const [path, setPath] = useState('')
  const [summary, setSummary] = useState('')

  /**
   * Only for a collection that has no description.
   *
   * With one imported, the document is the source of truth and inventing
   * paths beside it would list operations the API does not have.
   */
  const importsSpec = Boolean(collection.specUrl || collection.specPath)
  if (importsSpec) return null

  const endpoints = collection.endpoints ?? []
  const clean = normalisePath(path)
  // A duplicate would overwrite the other's operation in the document rather
  // than adding anything, so it is refused with a reason instead.
  const duplicate =
    clean !== null && endpoints.some((e) => e.method === method && e.path === clean)
  const canAdd = clean !== null && !duplicate

  const add = (): void => {
    if (!canAdd) return
    const next: ApiEndpoint = {
      id: `ep-${crypto.randomUUID()}`,
      method,
      path: clean,
      ...(summary.trim() ? { summary: summary.trim() } : {})
    }
    update(collection.id, { endpoints: [...endpoints, next] })
    setPath('')
    setSummary('')
  }

  const remove = (id: string): void => {
    update(collection.id, { endpoints: endpoints.filter((e) => e.id !== id) })
  }

  return (
    <div className="endpoints">
      <div className="endpoints-head">
        <span className="ui-section-title">Endpoints</span>
        <span className="faint">
          {endpoints.length === 0
            ? 'Add a path to send a request to it.'
            : `${endpoints.length} defined`}
        </span>
      </div>

      <div className="endpoints-add">
        <select
          className="input sm"
          aria-label="Method"
          value={method}
          onChange={(e) => setMethod(e.target.value as ApiMethod)}
        >
          {API_METHODS.map((m) => (
            <option key={m} value={m}>
              {m.toUpperCase()}
            </option>
          ))}
        </select>
        <input
          className="input sm"
          placeholder="/v1/users"
          aria-label="Path"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <input
          className="input sm"
          placeholder="What it does (optional)"
          aria-label="Summary"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button className="btn primary sm" disabled={!canAdd} onClick={add}>
          <Plus size={13} /> Add
        </button>
      </div>

      {/* The reason it is refused, where the refusal happens. A disabled
          button with no explanation is the bug this whole screen had. */}
      {path.trim() !== '' && clean === null && (
        <div className="faint endpoints-why">
          A path cannot contain a space, <code>?</code> or <code>#</code> — set query parameters in
          the request itself.
        </div>
      )}
      {duplicate && (
        <div className="faint endpoints-why">
          {method.toUpperCase()} {clean} is already defined.
        </div>
      )}

      {endpoints.length > 0 && (
        <ul className="endpoints-list">
          {endpoints.map((e) => (
            <li key={e.id} className="endpoints-row">
              <span className={clsx('method-tag', `m-${e.method}`)}>{e.method.toUpperCase()}</span>
              <span className="mono selectable endpoints-path">{e.path}</span>
              <span className="faint endpoints-summary">{e.summary ?? ''}</span>
              <button
                className="btn ghost sm"
                title={`Remove ${e.method.toUpperCase()} ${e.path}`}
                onClick={() => remove(e.id)}
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
