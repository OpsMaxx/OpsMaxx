import {
  Cookie,
  Download,
  History,
  FileText,
  FolderPlus,
  Keyboard,
  Layers,
  LayoutPanelLeft,
  Plus,
  Save,
  Send
} from 'lucide-react'
import type { ApiCollectionV2, Id, Item, RequestKind } from '../../../../shared/apiModel'
import { httpHotkey, useHttp } from '../../store/http'
import { useApi } from '../../store/api'
import { openSettings } from '../../store/nav'
import { toast } from '../../store/toast'
import type { useApp } from '../../store/app'
import { focusUrl } from './focus'

// The HTTP client's palette entries (§2.7.4), spread into CommandPalette. Every
// action here is also a button or a key somewhere; the palette is the place a
// user who knows the name but not the key finds it.

export interface PaletteCommand {
  id: string
  group: string
  title: string
  sub?: string
  icon: React.ReactNode
  run: () => void
}

type AppState = ReturnType<typeof useApp.getState>

const GROUP = 'HTTP client'

/** Every request in a collection, with its folder path. */
function requestsIn(col: ApiCollectionV2): { id: Id; path: string[]; label: string; url: string }[] {
  const out: { id: Id; path: string[]; label: string; url: string }[] = []
  const walk = (items: Item[], path: string[]): void => {
    for (const item of items) {
      if (item.kind === 'folder') walk(item.items, [...path, item.name])
      else {
        const method = item.kind === 'http' ? item.method : item.kind === 'ws' ? 'WS' : 'GQL'
        out.push({ id: item.id, path, label: item.name, url: `${method} ${item.url}` })
      }
    }
  }
  walk(col.items, [])
  return out
}

/** "Recover old data…" (§2.10): re-runs the migration into new collections, never over existing ones. */
export function recoverOldData(): void {
  const added = useApi.getState().recoverLegacy()
  toast(
    added.length
      ? `Recovered ${added.length} collection${added.length === 1 ? '' : 's'} from before the upgrade.`
      : 'There was nothing left to recover from before the upgrade.',
    added.length ? 'ok' : 'info'
  )
}

export function httpPaletteCommands(app: AppState): PaletteCommand[] {
  const http = useHttp.getState()
  const api = useApi.getState()
  const ws = app.activeWorkspaceId
  const inHttp = app.activity === 'http'
  const go = (fn: () => void) => () => {
    if (!inHttp) app.setActivity('http')
    fn()
  }
  const hotkey = (id: string): (() => void) | null => {
    const handler = inHttp ? httpHotkey(id) : undefined
    return handler ? () => void handler() : null
  }
  const scratch = (kind: RequestKind) =>
    go(() => {
      useHttp.getState().openScratch(kind)
      focusUrl()
    })

  const out: PaletteCommand[] = [
    { id: 'http-new', group: GROUP, title: 'New HTTP Request', icon: <Plus size={16} />, run: scratch('http') },
    { id: 'http-new-ws', group: GROUP, title: 'New WebSocket', icon: <Plus size={16} />, run: scratch('ws') },
    {
      id: 'http-new-gql',
      group: GROUP,
      title: 'New GraphQL Request',
      icon: <Plus size={16} />,
      run: scratch('graphql')
    },
    {
      id: 'http-new-collection',
      group: GROUP,
      title: 'New Collection',
      icon: <FolderPlus size={16} />,
      run: go(() => http.openCollectionTab(useApi.getState().createCollection('New collection'), 'overview'))
    },
    {
      id: 'http-import',
      group: GROUP,
      title: 'Import…',
      sub: 'cURL or OpenAPI',
      icon: <Download size={16} />,
      run: go(() => http.openImport())
    },
    {
      id: 'http-switch-env',
      group: GROUP,
      title: 'Switch Environment…',
      icon: <Layers size={16} />,
      run: go(() => http.setOverlay('env'))
    },
    {
      id: 'http-manage-envs',
      group: GROUP,
      title: 'Manage Environments',
      icon: <Layers size={16} />,
      run: go(() => http.openEnvironments())
    },
    {
      id: 'http-cookies',
      group: GROUP,
      title: 'Cookies…',
      icon: <Cookie size={16} />,
      run: go(() => http.setOverlay('cookies'))
    },
    {
      id: 'http-shortcuts',
      group: GROUP,
      title: 'Show Keyboard Shortcuts',
      sub: 'HTTP client',
      icon: <Keyboard size={16} />,
      run: () => openSettings('shortcuts')
    }
  ]

  // Only while the pre-upgrade copy is kept (two releases, §3.2).
  if (api.hasLegacy()) {
    out.push({
      id: 'http-recover',
      group: GROUP,
      title: 'Recover Pre-upgrade HTTP Data…',
      sub: 'Adds the old client’s collections again, as new ones',
      icon: <History size={16} />,
      run: go(recoverOldData)
    })
  }

  // Actions on the open tab, offered only where they can act: in the HTTP view,
  // with its workbench mounted.
  const onTab: [string, string, React.ReactNode][] = [
    ['http-send', 'Send', <Send size={16} key="i" />],
    ['http-save', 'Save Request', <Save size={16} key="i" />],
    ['http-copy-curl', 'Copy as cURL', <FileText size={16} key="i" />],
    ['http-toggle-response', 'Toggle Response', <LayoutPanelLeft size={16} key="i" />],
    ['http-toggle-request', 'Toggle Request', <LayoutPanelLeft size={16} key="i" />],
    ['http-toggle-layout', 'Toggle Side by Side / Stacked', <LayoutPanelLeft size={16} key="i" />]
  ]
  for (const [id, title, icon] of onTab) {
    const run = hotkey(id)
    if (run) out.push({ id: `${id}-cmd`, group: GROUP, title, icon, run })
  }

  for (const col of api.collectionsIn(ws)) {
    for (const r of requestsIn(col)) {
      out.push({
        id: `http-req-${r.id}`,
        group: 'HTTP Requests',
        title: [col.name, ...r.path, r.label].join(' / '),
        sub: r.url,
        icon: <FileText size={16} />,
        run: go(() => useHttp.getState().openRequest({ collectionId: col.id, requestId: r.id }))
      })
    }
  }

  for (const env of api.workspace.environments.filter((e) => e.workspaceId === ws)) {
    out.push({
      id: `http-env-${env.id}`,
      group: 'HTTP Environments',
      title: `Use Environment: ${env.name}`,
      sub: env.production ? 'Production' : undefined,
      icon: <Layers size={16} />,
      run: () => useApi.getState().setActiveEnvironment(ws, env.id)
    })
  }
  return out
}
