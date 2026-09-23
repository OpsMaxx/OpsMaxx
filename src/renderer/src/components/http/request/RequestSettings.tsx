import type { ApiCollectionV2, HttpRequest, Id } from '../../../../../shared/apiModel'
import { DEFAULT_TIMEOUT_MS, MAX_REDIRECT_HOPS, MAX_TIMEOUT_MS } from '../../../../../shared/httpClient'
import { HTTP_FIX_EVENT, type HttpFixDetail } from '../response/ResponsePane'

export interface RequestSettingsProps {
  tabId: Id
  req: HttpRequest
  onChange: (req: HttpRequest) => void
  collection: ApiCollectionV2 | null
  readOnly?: boolean
}

export function RequestSettings({ tabId, req, onChange, collection, readOnly }: RequestSettingsProps): React.JSX.Element {
  const fallback = collection?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const settings = (patch: Partial<HttpRequest['settings']>): void => {
    if (!readOnly) onChange({ ...req, settings: { ...req.settings, ...patch } })
  }
  const certs = !collection
    ? 'Certificates: verified'
    : collection.insecureTls
      ? `Certificates: NOT verified (collection ${collection.name})`
      : collection.caPem
        ? `Certificates: verified with a custom CA from collection ${collection.name}`
        : 'Certificates: verified'

  return (
    <div className="hc-settings">
      <div className="hc-field">
        <label className="ui-label" htmlFor={`${tabId}-timeout`}>
          Timeout (seconds)
        </label>
        <input
          id={`${tabId}-timeout`}
          className="hc-input hc-num"
          type="number"
          min={1}
          max={MAX_TIMEOUT_MS / 1000}
          data-hc-focus="timeout"
          disabled={readOnly}
          placeholder={String(fallback / 1000)}
          value={req.settings.timeoutMs ? req.settings.timeoutMs / 1000 : ''}
          onChange={(e) => {
            const s = Number(e.target.value)
            settings({ timeoutMs: e.target.value === '' || !(s > 0) ? undefined : Math.min(s * 1000, MAX_TIMEOUT_MS) })
          }}
        />
        <span className="hc-note">
          Empty uses {collection?.timeoutMs ? 'the collection’s' : 'the default'} {fallback / 1000} s. At most 10 minutes.
        </span>
      </div>
      <label className="hc-check">
        <input
          type="checkbox"
          checked={req.settings.followRedirects}
          disabled={readOnly}
          onChange={(e) => settings({ followRedirects: e.target.checked })}
        />
        Follow redirects
      </label>
      <label className="hc-field">
        <span className="ui-label">Max redirects</span>
        <input
          className="hc-input hc-num"
          type="number"
          min={0}
          max={MAX_REDIRECT_HOPS}
          disabled={readOnly || !req.settings.followRedirects}
          value={req.settings.maxRedirects}
          onChange={(e) =>
            settings({ maxRedirects: Math.max(0, Math.min(MAX_REDIRECT_HOPS, Math.floor(Number(e.target.value) || 0))) })
          }
        />
      </label>
      <p className={collection?.insecureTls ? 'hc-note hc-danger' : 'hc-note'}>
        {certs}
        {collection && (
          <>
            {' · '}
            <button
              className="btn quiet sm"
              onClick={(e) =>
                e.currentTarget.dispatchEvent(
                  new CustomEvent<HttpFixDetail>(HTTP_FIX_EVENT, { bubbles: true, detail: { tabId, action: 'add-ca' } })
                )
              }
            >
              Change
            </button>
          </>
        )}
      </p>
    </div>
  )
}
