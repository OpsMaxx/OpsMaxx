import { Globe, Plus, ServerCog, ShieldAlert, ShieldCheck } from 'lucide-react'
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

function HttpToolbar({ collectionId }: { collectionId: string }): React.JSX.Element {
  const collections = useWorkspaceApiCollections()
  const servers = useWorkspaceServers()
  const update = useApp((s) => s.updateApiCollection)
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
          OpsMaxx, not by the browser engine.
        </p>
        <button className="btn primary" onClick={onAdd}>
          <Plus size={15} /> Add an API
        </button>
      </div>
    </div>
  )
}
