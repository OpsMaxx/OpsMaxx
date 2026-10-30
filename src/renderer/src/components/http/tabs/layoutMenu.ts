import { DEFAULT_PREFS, type Id, type RequestKind, type SplitState } from '../../../../../shared/apiModel'
import type { MenuEntry } from '../../connections/ContextMenu'
import { useHttp } from '../../../store/http'
import { useApp } from '../../../store/app'
import { keyLabel } from '../hotkeys'
import { t } from '../../../lib/i18n'

/**
 * The Layout menu (§2.5): the ⊞ button at the right of the tab strip and a
 * right-click on any splitter open these same entries. `tabId` is the active
 * (or ghost) tab; `kind` picks the context section. `forced` means an explicit
 * Side by side is rendering stacked for want of width.
 */
export function layoutMenuEntries(opts: { tabId: Id | null; kind: RequestKind | null; forced: boolean }): MenuEntry[] {
  const http = useHttp.getState()
  const app = useApp.getState()
  const { prefs } = http
  const split: SplitState = http.tabs.find((t) => t.id === opts.tabId)?.split ?? 'normal'
  const inStrip = !!opts.tabId && http.tabs.some((t) => t.id === opts.tabId)
  const toggleSplit = (to: SplitState): void => {
    if (opts.tabId) http.setSplit(opts.tabId, split === to ? 'normal' : to)
  }
  const orientation = (value: typeof prefs.orientation, label: string, extra: Partial<MenuEntry> = {}): MenuEntry => ({
    label,
    radio: 'orientation',
    checked: prefs.orientation === value,
    onClick: () => http.setPrefs({ orientation: value }),
    ...extra
  })
  const pref = (key: keyof typeof prefs, label: string): MenuEntry => ({
    label,
    checked: prefs[key] === true,
    onClick: () => http.setPrefs({ [key]: !prefs[key] })
  })

  const context: MenuEntry[] =
    opts.kind === 'http'
      ? [
          pref('kvDescriptions', t('http.layoutMenu.descriptionColumn')),
          pref('showAutoHeaders', t('http.layoutMenu.autoHeaders'))
        ]
      : opts.kind === 'ws'
        ? [pref('kvDescriptions', t('http.layoutMenu.descriptionColumn'))]
        : opts.kind === 'graphql'
          ? [pref('gqlVariablesOpen', t('http.layoutMenu.variables')), pref('gqlSchemaOpen', t('http.layoutMenu.schemaExplorer'))]
          : []
  if (context.length) context[0] = { ...context[0], section: t('http.layoutMenu.thisTab') }

  return [
    orientation('auto', t('http.layoutMenu.auto'), { section: t('http.layoutMenu.orientation') }),
    orientation(
      'horizontal',
      opts.forced && prefs.orientation === 'horizontal'
        ? t('http.layoutMenu.sideBySideForced')
        : t('http.layoutMenu.sideBySide')
    ),
    orientation('vertical', t('http.layoutMenu.stacked'), { shortcut: keyLabel('http-toggle-layout') }),
    { label: '', separator: true },
    {
      label: t('http.layoutMenu.sidebar'),
      checked: !app.sidebarCollapsed,
      shortcut: keyLabel('toggle-sidebar'),
      onClick: () => app.toggleSidebar()
    },
    {
      label: t('http.layoutMenu.response'),
      checked: split !== 'response-collapsed',
      disabled: !inStrip,
      shortcut: keyLabel('http-toggle-response'),
      onClick: () => toggleSplit('response-collapsed')
    },
    {
      label: t('http.layoutMenu.request'),
      checked: split !== 'request-collapsed',
      disabled: !inStrip,
      shortcut: keyLabel('http-toggle-request'),
      onClick: () => toggleSplit('request-collapsed')
    },
    ...(context.length ? [{ label: '', separator: true }, ...context] : []),
    { label: '', separator: true },
    { label: t('http.layoutMenu.cookies'), onClick: () => http.setOverlay('cookies') },
    { label: t('http.layoutMenu.resetSizes'), onClick: () => http.setPrefs({ ratios: DEFAULT_PREFS.ratios }) }
  ]
}
