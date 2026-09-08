import { FileJson, Globe, ServerCog, Trash2 } from 'lucide-react'
import { useApp, useWorkspaceApiCollections, useWorkspaceServers } from '../../store/app'
import { clsx } from '../../lib/format'

/** The saved APIs in this workspace. */
export function ApiSidebar(): React.JSX.Element {
  const collections = useWorkspaceApiCollections()
  const servers = useWorkspaceServers()
  const activeId = useApp((s) => s.activeApiCollectionId)
  const setActive = useApp((s) => s.setActiveApiCollection)
  const remove = useApp((s) => s.deleteApiCollection)

  if (collections.length === 0) {
    return <div className="sidebar-empty muted">No APIs yet.</div>
  }

  // Matches the view's own fallback, so the highlighted row is the one shown.
  const shownId = collections.find((c) => c.id === activeId)?.id ?? collections[0]?.id

  return (
    <ul className="tree">
      {collections.map((c) => {
        const via = c.viaServerId ? servers.find((s) => s.id === c.viaServerId) : null
        return (
          <li key={c.id}>
            <div
              className={clsx('tree-row', shownId === c.id && 'active')}
              onClick={() => setActive(c.id)}
            >
              <span className="tree-icon">
                {c.specUrl ? <FileJson size={15} /> : <Globe size={15} />}
              </span>
              <span className="tree-label">
                {c.name}
                {/* Where a request goes is the thing most worth knowing about a
                    saved API at a glance, so it rides on the row itself. */}
                {via && (
                  <span className="tree-sub muted">
                    <ServerCog size={11} /> {via.name}
                  </span>
                )}
              </span>
              <button
                className="icon-btn tree-action"
                title={`Remove ${c.name}`}
                onClick={(e) => {
                  e.stopPropagation()
                  remove(c.id)
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
