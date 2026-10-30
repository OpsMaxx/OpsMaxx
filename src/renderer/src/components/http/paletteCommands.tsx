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
import { t } from '../../lib/i18n'

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
      ? t('http.palette.recovered', { count: added.length })
      : t('http.palette.nothingToRecover'),
    added.length ? 'ok' : 'info'
  )
}

export function httpPaletteCommands(app: AppState): PaletteCommand[] {
  const http = useHttp.getState()
  const api = useApi.getState()
  const ws = app.activeWorkspaceId
  const inHttp = app.activity === 'http'
  const group = t('http.palette.group')
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
    { id: 'http-new', group, title: t('http.palette.newHttpRequest'), icon: <Plus size={16} />, run: scratch('http') },
    { id: 'http-new-ws', group, title: t('http.palette.newWebSocket'), icon: <Plus size={16} />, run: scratch('ws') },
    {
      id: 'http-new-gql',
      group,
      title: t('http.palette.newGraphQlRequest'),
      icon: <Plus size={16} />,
      run: scratch('graphql')
    },
    {
      id: 'http-new-collection',
      group,
      title: t('http.palette.newCollection'),
      icon: <FolderPlus size={16} />,
      run: go(() =>
        http.openCollectionTab(useApi.getState().createCollection(t('http.sidebar.newCollectionName')), 'overview')
      )
    },
    {
      id: 'http-import',
      group,
      title: t('http.palette.import'),
      sub: t('http.palette.importSub'),
      icon: <Download size={16} />,
      run: go(() => http.openImport())
    },
    {
      id: 'http-switch-env',
      group,
      title: t('http.palette.switchEnvironment'),
      icon: <Layers size={16} />,
      run: go(() => http.setOverlay('env'))
    },
    {
      id: 'http-manage-envs',
      group,
      title: t('http.palette.manageEnvironments'),
      icon: <Layers size={16} />,
      run: go(() => http.openEnvironments())
    },
    {
      id: 'http-cookies',
      group,
      title: t('http.palette.cookies'),
      icon: <Cookie size={16} />,
      run: go(() => http.setOverlay('cookies'))
    },
    {
      id: 'http-shortcuts',
      group,
      title: t('http.palette.showShortcuts'),
      sub: t('http.palette.group'),
      icon: <Keyboard size={16} />,
      run: () => openSettings('shortcuts')
    }
  ]

  // Only while the pre-upgrade copy is kept (two releases, §3.2).
  if (api.hasLegacy()) {
    out.push({
      id: 'http-recover',
      group,
      title: t('http.palette.recoverPreUpgrade'),
      sub: t('http.palette.recoverPreUpgradeSub'),
      icon: <History size={16} />,
      run: go(recoverOldData)
    })
  }

  // Actions on the open tab, offered only where they can act: in the HTTP view,
  // with its workbench mounted.
  const onTab: [string, string, React.ReactNode][] = [
    ['http-send', t('http.palette.send'), <Send size={16} key="i" />],
    ['http-save', t('http.palette.saveRequest'), <Save size={16} key="i" />],
    ['http-copy-curl', t('http.palette.copyAsCurl'), <FileText size={16} key="i" />],
    ['http-toggle-response', t('http.palette.toggleResponse'), <LayoutPanelLeft size={16} key="i" />],
    ['http-toggle-request', t('http.palette.toggleRequest'), <LayoutPanelLeft size={16} key="i" />],
    ['http-toggle-layout', t('http.palette.toggleLayout'), <LayoutPanelLeft size={16} key="i" />]
  ]
  for (const [id, title, icon] of onTab) {
    const run = hotkey(id)
    if (run) out.push({ id: `${id}-cmd`, group, title, icon, run })
  }

  for (const col of api.collectionsIn(ws)) {
    for (const r of requestsIn(col)) {
      out.push({
        id: `http-req-${r.id}`,
        group: t('http.palette.groupRequests'),
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
      group: t('http.palette.groupEnvironments'),
      title: t('http.palette.useEnvironment', { name: env.name }),
      sub: env.production ? t('http.palette.production') : undefined,
      icon: <Layers size={16} />,
      run: () => useApi.getState().setActiveEnvironment(ws, env.id)
    })
  }
  return out
}
