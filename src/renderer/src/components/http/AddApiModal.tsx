import { useState } from 'react'
import { Field, Modal } from '../common/Modal'
import { useApp, useWorkspaceServers } from '../../store/app'
import { clsx } from '../../lib/format'
import { parseTarget } from '../../../../shared/httpClient'

type Source = 'blank' | 'spec'

/**
 * Adds an API to the HTTP client.
 *
 * Two ways in, because they are genuinely different starting points: a service
 * that publishes an OpenAPI description, and the far more common "I want to
 * hit this one endpoint and see what it says".
 */
export function AddApiModal(): React.JSX.Element {
  const setModal = useApp((s) => s.setModal)
  const addApiCollection = useApp((s) => s.addApiCollection)
  const servers = useWorkspaceServers()

  const [source, setSource] = useState<Source>('blank')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [specUrl, setSpecUrl] = useState('')
  // A description chosen from disk: its path is what the collection keeps, and
  // the name is only what the picker is showing back to the user.
  const [specPath, setSpecPath] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [viaServerId, setViaServerId] = useState('')

  const urlField = source === 'spec' ? specUrl : baseUrl
  // A file-backed description has no URL to parse, and demanding one would be
  // asking for the thing the file replaces.
  const usingFile = source === 'spec' && specPath !== null
  const parsed = !usingFile && urlField.trim() ? parseTarget(urlField.trim()) : null
  const urlError = parsed && 'error' in parsed ? parsed.error : null
  const valid =
    name.trim().length > 0 && (usingFile || (urlField.trim().length > 0 && !urlError))

  const create = (): void => {
    if (!valid) return
    addApiCollection({
      name: name.trim(),
      specUrl: source === 'spec' && !usingFile ? specUrl.trim() : null,
      specPath: usingFile ? specPath : null,
      // A description names its own servers, but the user still has to be able
      // to say "not that one" — so a spec-backed collection keeps a base URL
      // too, defaulted from the spec's origin.
      // A file names no origin, so the base URL stays empty until the
      // description's own servers supply one.
      baseUrl: usingFile ? '' : source === 'spec' ? originOf(specUrl.trim()) : baseUrl.trim(),
      viaServerId: viaServerId || null,
      insecureTls: false
    })
    setModal(null)
  }

  return (
    <Modal
      title="Add an API"
      subtitle="Requests are sent by OpsMaxx, so internal certificates and APIs without CORS headers work."
      onClose={() => setModal(null)}
      confirm={{ label: 'Add', onClick: create, disabled: !valid }}
    >
      <div className="segment modal-segment">
        <button
          className={clsx('seg-btn', source === 'blank' && 'active')}
          onClick={() => setSource('blank')}
        >
          Single request
        </button>
        <button
          className={clsx('seg-btn', source === 'spec' && 'active')}
          onClick={() => setSource('spec')}
        >
          From OpenAPI
        </button>
      </div>

      <Field label="Name" required>
        <input
          className="input"
          value={name}
          autoFocus
          placeholder={source === 'spec' ? 'Billing API' : 'Prometheus'}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>

      {source === 'spec' ? (
        <Field
          label="OpenAPI document"
          required
          error={fileError ?? urlError ?? undefined}
          hint="A URL is fetched the same way requests are sent, so a description served by the target host is reachable too. A file is re-read each time, so editing it and reopening shows the change."
        >
          {specPath ? (
            <div className="row" style={{ gap: 'var(--sp-2)', alignItems: 'center' }}>
              <span className="mono ellipsis" title={specPath} style={{ flex: 1, minWidth: 0 }}>
                {specPath}
              </span>
              <button
                className="btn secondary size-28"
                onClick={() => {
                  setSpecPath(null)
                  setFileError(null)
                }}
              >
                Use a URL instead
              </button>
            </div>
          ) : (
            <div className="row" style={{ gap: 'var(--sp-2)' }}>
              <input
                className="input"
                value={specUrl}
                placeholder="https://api.example.com/openapi.json"
                onChange={(e) => setSpecUrl(e.target.value)}
              />
              <button
                className="btn secondary size-28"
                onClick={() => {
                  setFileError(null)
                  void window.opsmaxx?.http
                    .chooseSpecFile()
                    .then((chosen) => {
                      if (!chosen) return
                      setSpecPath(chosen.path)
                      // Name the collection after the file, but never over
                      // something the user has already typed.
                      if (!name.trim()) {
                        setName(chosen.path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'API')
                      }
                    })
                    .catch((e: unknown) =>
                      setFileError(e instanceof Error ? e.message : String(e))
                    )
                }}
              >
                Choose a file…
              </button>
            </div>
          )}
        </Field>
      ) : (
        <Field
          label="Base URL"
          required
          error={urlError ?? undefined}
          hint="Where requests go. Paths are added to this."
        >
          <input
            className="input"
            value={baseUrl}
            placeholder="http://localhost:9090"
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </Field>
      )}

      <Field
        label="Send from"
        hint={
          viaServerId
            ? 'Hostnames resolve on that server, so localhost means its loopback.'
            : 'Requests leave from this machine.'
        }
      >
        <select
          className="input"
          value={viaServerId}
          onChange={(e) => setViaServerId(e.target.value)}
        >
          <option value="">This machine</option>
          {servers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>
    </Modal>
  )
}

/**
 * The origin a spec was served from, as the default place to send requests.
 *
 * Most descriptions name production in `servers`, and someone who fetched the
 * spec from a staging host almost never means production — so the host they
 * typed is the better default. It stays editable in the toolbar.
 */
function originOf(raw: string): string {
  const parsed = parseTarget(raw)
  return 'error' in parsed ? '' : parsed.url.origin
}
