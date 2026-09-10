import { useState } from 'react'
import { Field, Modal } from '../common/Modal'
import { useApp, useWorkspaceApiCollections, useWorkspaceServers } from '../../store/app'
import { clsx } from '../../lib/format'
import { parseTarget } from '../../../../shared/httpClient'

type Source = 'blank' | 'spec'

/**
 * Adds an API to the HTTP client, or edits one.
 *
 * Two ways in, because they are genuinely different starting points: a service
 * that publishes an OpenAPI description, and the far more common "I want to
 * hit this one endpoint and see what it says".
 *
 * Editing is this same modal with an id, following openServerEditor. It was
 * added because there was no way to change a saved API AT ALL: a base URL
 * typed with a typo, or a service that moved to a new host, meant deleting the
 * collection and building it again. The toolbar could reach `viaServerId` and
 * `insecureTls` and nothing else — not the name, not the URL, not the spec.
 */
export function AddApiModal(): React.JSX.Element {
  const setModal = useApp((s) => s.setModal)
  const addApiCollection = useApp((s) => s.addApiCollection)
  const updateApiCollection = useApp((s) => s.updateApiCollection)
  const editId = useApp((s) => s.editApiCollectionId)
  const collections = useWorkspaceApiCollections()
  const servers = useWorkspaceServers()

  const editing = collections.find((c) => c.id === editId) ?? null

  // Seeded once from the record being edited. A collection with a spec opens
  // on the spec tab, because that is what it is.
  const [source, setSource] = useState<Source>(
    editing && (editing.specUrl || editing.specPath) ? 'spec' : 'blank'
  )
  const [name, setName] = useState(editing?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? '')
  const [specUrl, setSpecUrl] = useState(editing?.specUrl ?? '')
  // A description chosen from disk: its path is what the collection keeps, and
  // the name is only what the picker is showing back to the user.
  const [specPath, setSpecPath] = useState<string | null>(editing?.specPath ?? null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [viaServerId, setViaServerId] = useState(editing?.viaServerId ?? '')

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
    if (editing) {
      // insecureTls is deliberately NOT touched here. It lives on the toolbar,
      // where turning certificate checking off is a visible, standing state —
      // and a field buried in a modal is exactly the quiet checkbox that
      // toolbar exists instead of.
      updateApiCollection(editing.id, {
        name: name.trim(),
        specUrl: source === 'spec' && !usingFile ? specUrl.trim() : null,
        specPath: usingFile ? specPath : null,
        baseUrl: usingFile ? '' : source === 'spec' ? originOf(specUrl.trim()) : baseUrl.trim(),
        viaServerId: viaServerId || null
      })
      setModal(null)
      return
    }
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
      title={editing ? `Edit ${editing.name}` : 'Add an API'}
      subtitle="Requests are sent by OpsMaxx, so internal certificates and APIs without CORS headers work."
      onClose={() => setModal(null)}
      confirm={{ label: editing ? 'Save' : 'Add', onClick: create, disabled: !valid }}
    >
      {/**
       * "Start empty", not "Single request".
       *
       * The label described what this used to build — one synthetic path off
       * the base URL — and stopped being true once a collection could define
       * its own endpoints. Somebody looking for a blank project read "single
       * request" as "this is not that" and concluded the app could not make
       * one, which is exactly what was reported.
       */}
      <div className="segment modal-segment">
        <button
          className={clsx('seg-btn', source === 'blank' && 'active')}
          onClick={() => setSource('blank')}
        >
          Start empty
        </button>
        <button
          className={clsx('seg-btn', source === 'spec' && 'active')}
          onClick={() => setSource('spec')}
        >
          Import OpenAPI
        </button>
      </div>
      <div className="field-hint" style={{ marginBottom: 'var(--sp-3)' }}>
        {source === 'blank'
          ? 'A base URL to send to, and requests you add yourself.'
          : 'Reads a description and lists every operation it declares.'}
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
