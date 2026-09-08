import { Globe, Pencil, Plus, ServerCog, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useApp, useWorkspaceApiCollections, useWorkspaceServers } from '../../store/app'
import { clsx } from '../../lib/format'
import { ApiClientPane } from './ApiClientPane'

/**
 * The HTTP client.
 *
 * The toolbar carries the two decisions that make this client different from a
 * standalone one — where the request leaves from, and whether the certificate
 * is checked — because both change what a request MEANS, and neither should
 * have to be remembered from a settings screen somewhere else.
 */
export function HttpView(): React.JSX.Element {
  const collections = useWorkspaceApiCollections()
  const activeId = useApp((s) => s.activeApiCollectionId)
  const setModal = useApp((s) => s.setModal)

  // A selection that outlived its collection (deleted, or a workspace switch)
  // falls back to the first one rather than showing an empty pane.
  const active = collections.find((c) => c.id === activeId) ?? collections[0] ?? null

  if (!active) return <EmptyState onAdd={() => setModal('add-api')} />

  return (
    <div className="main">
      <HttpToolbar collectionId={active.id} />
      {/* Keyed so switching collections builds a fresh client rather than
          trying to retarget a live one. */}
      <ApiClientPane key={active.id} collection={active} />
    </div>
  )
}

/**
 * The toolbar owns WHICH api as well as how it is sent.
 *
 * It did not, and that was the whole of "I can only add one domain and I
 * cannot edit it". Adding, switching and deleting a saved API lived only in
 * the left sidebar — the `+` in its header and the list below it — so with the
 * sidebar collapsed, which is how a lot of people run it, the HTTP view had no
 * way to reach any of the three. The big "Add an API" button in the empty
 * state is the last one a person sees: it disappears the moment the first
 * collection exists, and nothing in the main pane replaces it.
 *
 * Editing was worse than hidden — it did not exist anywhere. The toolbar could
 * change `viaServerId` and `insecureTls`; the name, the base URL and the spec
 * were fixed at creation, so a typo meant deleting the API and retyping it.
 */
function HttpToolbar({ collectionId }: { collectionId: string }): React.JSX.Element {
  const collections = useWorkspaceApiCollections()
  const servers = useWorkspaceServers()
  const update = useApp((s) => s.updateApiCollection)
  const setActive = useApp((s) => s.setActiveApiCollection)
  const setModal = useApp((s) => s.setModal)
  const openApiEditor = useApp((s) => s.openApiEditor)
  const collection = collections.find((c) => c.id === collectionId)
  if (!collection) return <div className="viewbar" />

  const viaServer = collection.viaServerId
    ? servers.find((s) => s.id === collection.viaServerId)
    : null
  // Named a server that is no longer here. Saying so is the only honest option:
  // silently sending the request directly would send it somewhere else.
  const viaMissing = collection.viaServerId !== null && !viaServer

  return (
    <div className="viewbar http-toolbar">
      {/* Which API, first, because it names everything to the right of it.
          A single collection still gets the row — it is where Add and Edit
          live, and a control that appears only once a second API exists
          cannot be how the second one is added. */}
      <label className="http-via">
        <span className="http-via-label">
          <Globe size={14} /> API
        </span>
        <select
          className="input http-via-select"
          value={collection.id}
          onChange={(e) => setActive(e.target.value)}
        >
          {collections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <button
        className="icon-btn"
        title={`Edit ${collection.name}`}
        onClick={() => openApiEditor(collection.id)}
      >
        <Pencil size={14} />
      </button>
      <button className="icon-btn" title="Add an API" onClick={() => setModal('add-api')}>
        <Plus size={15} />
      </button>

      <label className="http-via">
        <span className="http-via-label">
          {viaServer ? <ServerCog size={14} /> : <Globe size={14} />} Send from
        </span>
        <select
          className="input http-via-select"
          value={collection.viaServerId ?? ''}
          onChange={(e) => update(collection.id, { viaServerId: e.target.value || null })}
        >
          <option value="">This machine</option>
          {servers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>

      {viaMissing && (
        <span className="http-warning" role="status">
          That server was removed — requests will not be sent.
        </span>
      )}

      {viaServer && (
        <span className="muted http-via-hint">
          Hostnames resolve on {viaServer.name}, so <code>localhost</code> is its own loopback.
        </span>
      )}

      <div className="spacer" />

      {/* Not a quiet checkbox. An API client that has stopped verifying
          certificates has to look like it, every time the view is open. */}
      <button
        className={clsx('seg-btn', 'http-tls', collection.insecureTls && 'http-tls-off')}
        title={
          collection.insecureTls
            ? 'Certificates are not being checked for this API. Click to verify again.'
            : 'Certificates are verified. Click to skip the check for this API.'
        }
        onClick={() => update(collection.id, { insecureTls: !collection.insecureTls })}
      >
        {collection.insecureTls ? <ShieldAlert size={14} /> : <ShieldCheck size={14} />}
        {collection.insecureTls ? 'Certificate check off' : 'Certificate checked'}
      </button>
    </div>
  )
}

function EmptyState({ onAdd }: { onAdd: () => void }): React.JSX.Element {
  return (
    <div className="main">
      <div className="empty">
        <div className="empty-icon">
          <Globe size={26} />
        </div>
        <h3>No APIs yet</h3>
        <p>
          Send HTTP requests from this machine, or down any server&apos;s SSH connection — which
          reaches services bound to that host&apos;s loopback and exposed to nothing else.
        </p>
        <p>
          Internal certificates and APIs without CORS headers work here too: requests are sent by
          ShellPilot, not by the browser engine.
        </p>
        <button className="btn primary" onClick={onAdd}>
          <Plus size={15} /> Add an API
        </button>
      </div>
    </div>
  )
}
