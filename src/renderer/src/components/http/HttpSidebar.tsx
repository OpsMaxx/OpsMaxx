import { useRef, useState } from 'react'
import { ChevronDown, Import, MoreHorizontal, Plus } from 'lucide-react'
import type { Id } from '../../../../shared/apiModel'
import { useApi } from '../../store/api'
import { useHttp } from '../../store/http'
import { ContextMenu, type MenuEntry } from '../connections/ContextMenu'
import { Tabs } from '../common/Tabs'
import { CollectionTree } from './sidebar/CollectionTree'
import { HistoryList } from './sidebar/HistoryList'
import { recoverOldData } from './paletteCommands'
import './nav.css'

/**
 * Opens the import dialog, which the workbench hosts. With a collection id it
 * is a re-import into that collection.
 */
export function requestImport(collectionId?: Id): void {
  useHttp.getState().openImport(collectionId)
}

/**
 * The HTTP client's half of the OpsMaxx sidebar: the header, the
 * Collections / History switch, a filter, and the list below it.
 */
export function HttpSidebar(): React.JSX.Element {
  const sidebarTab = useHttp((s) => s.sidebarTab)
  const [query, setQuery] = useState('')
  const [renaming, setRenaming] = useState<Id | null>(null)
  const [menu, setMenu] = useState<DOMRect | null>(null)
  const [more, setMore] = useState<DOMRect | null>(null)
  const hasLegacy = useApi((s) => s.hasLegacy())
  const undo = useRef<(() => void)[]>([])

  const newCollection = (): void => {
    const id = useApi.getState().createCollection('New collection')
    useHttp.getState().setExpanded(id, true)
    useHttp.getState().setSidebarTab('collections')
    setRenaming(id)
  }
  const entries: MenuEntry[] = [
    { label: 'New collection', onClick: newCollection },
    { separator: true, label: '' },
    { label: 'New HTTP request', onClick: () => useHttp.getState().openScratch('http') },
    { label: 'New WebSocket', onClick: () => useHttp.getState().openScratch('ws') },
    { label: 'New GraphQL request', onClick: () => useHttp.getState().openScratch('graphql') }
  ]

  return (
    <div className="hc-sidebar">
      <div className="hc-sidebar-head">
        <h2 className="hc-sidebar-title">Collections (formerly APIs)</h2>
        <div className="hc-sidebar-actions">
          <button
            type="button"
            className="btn sm"
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())}
          >
            <Plus size={13} aria-hidden="true" /> New <ChevronDown size={12} aria-hidden="true" />
          </button>
          <button type="button" className="btn sm" aria-label="Import" title="Import (cURL, OpenAPI)" onClick={() => requestImport()}>
            <Import size={13} aria-hidden="true" />
            <span className="hc-import-text">Import</span>
          </button>
          {hasLegacy && (
            <button
              type="button"
              className="hc-icon-btn"
              aria-label="More"
              title="More"
              aria-haspopup="menu"
              onClick={(e) => setMore(e.currentTarget.getBoundingClientRect())}
            >
              <MoreHorizontal size={13} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      <Tabs
        ariaLabel="Sidebar view"
        idPrefix="hc-sidebar"
        tabs={[
          { id: 'collections', label: 'Collections' },
          { id: 'history', label: 'History' }
        ]}
        active={sidebarTab}
        onChange={(id) => useHttp.getState().setSidebarTab(id as 'collections' | 'history')}
      />
      <input
        className="hc-input hc-sidebar-filter"
        type="search"
        aria-label={sidebarTab === 'history' ? 'Filter history' : 'Filter collections'}
        placeholder="Filter"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="hc-sidebar-body" data-hc-region="tree" role="tabpanel" id="hc-sidebar-panel" aria-labelledby={`hc-sidebar-tab-${sidebarTab}`}>
        {sidebarTab === 'history' ? (
          <HistoryList query={query} />
        ) : (
          <CollectionTree
            query={query}
            renaming={renaming}
            setRenaming={setRenaming}
            undo={undo}
            onNewCollection={newCollection}
            onImport={requestImport}
          />
        )}
      </div>
      {more && (
        <ContextMenu
          x={more.left}
          y={more.bottom}
          anchor={more}
          entries={[{ label: 'Recover old data…', onClick: recoverOldData }]}
          onClose={() => setMore(null)}
        />
      )}
      {menu && <ContextMenu x={menu.left} y={menu.bottom} anchor={menu} entries={entries} onClose={() => setMenu(null)} />}
    </div>
  )
}
