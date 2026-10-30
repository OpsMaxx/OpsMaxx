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
import { useT } from '../../lib/i18n'
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
  const t = useT()

  const newCollection = (): void => {
    const id = useApi.getState().createCollection(t('http.sidebar.newCollectionName'))
    useHttp.getState().setExpanded(id, true)
    useHttp.getState().setSidebarTab('collections')
    setRenaming(id)
  }
  const entries: MenuEntry[] = [
    { label: t('http.sidebar.newCollection'), onClick: newCollection },
    { separator: true, label: '' },
    { label: t('http.sidebar.newHttpRequest'), onClick: () => useHttp.getState().openScratch('http') },
    { label: t('http.sidebar.newWebSocket'), onClick: () => useHttp.getState().openScratch('ws') },
    { label: t('http.sidebar.newGraphQlRequest'), onClick: () => useHttp.getState().openScratch('graphql') }
  ]

  return (
    <div className="hc-sidebar">
      <div className="hc-sidebar-head">
        <h2 className="hc-sidebar-title">{t('http.sidebar.title')}</h2>
        <div className="hc-sidebar-actions">
          <button
            type="button"
            className="btn sm"
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())}
          >
            <Plus size={13} aria-hidden="true" /> {t('http.sidebar.new')} <ChevronDown size={12} aria-hidden="true" />
          </button>
          <button type="button" className="btn sm" aria-label={t('http.sidebar.import')} title={t('http.sidebar.importTitle')} onClick={() => requestImport()}>
            <Import size={13} aria-hidden="true" />
            <span className="hc-import-text">{t('http.sidebar.import')}</span>
          </button>
          {hasLegacy && (
            <button
              type="button"
              className="hc-icon-btn"
              aria-label={t('http.sidebar.more')}
              title={t('http.sidebar.more')}
              aria-haspopup="menu"
              onClick={(e) => setMore(e.currentTarget.getBoundingClientRect())}
            >
              <MoreHorizontal size={13} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      <Tabs
        ariaLabel={t('http.sidebar.viewLabel')}
        idPrefix="hc-sidebar"
        tabs={[
          { id: 'collections', label: t('http.sidebar.collections') },
          { id: 'history', label: t('http.sidebar.history') }
        ]}
        active={sidebarTab}
        onChange={(id) => useHttp.getState().setSidebarTab(id as 'collections' | 'history')}
      />
      <input
        className="hc-input hc-sidebar-filter"
        type="search"
        aria-label={sidebarTab === 'history' ? t('http.sidebar.filterHistory') : t('http.sidebar.filterCollections')}
        placeholder={t('http.sidebar.filter')}
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
          entries={[{ label: t('http.sidebar.recoverOldData'), onClick: recoverOldData }]}
          onClose={() => setMore(null)}
        />
      )}
      {menu && <ContextMenu x={menu.left} y={menu.bottom} anchor={menu} entries={entries} onClose={() => setMenu(null)} />}
    </div>
  )
}
