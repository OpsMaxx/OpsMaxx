import { DEFAULT_PREFS, type Id, type RequestKind, type SplitState } from '../../../../../shared/apiModel'
import type { MenuEntry } from '../../connections/ContextMenu'
import { useHttp } from '../../../store/http'
import { useApp } from '../../../store/app'
import { keyLabel } from '../hotkeys'

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
      ? [pref('kvDescriptions', 'Description column'), pref('showAutoHeaders', 'Auto-generated headers')]
      : opts.kind === 'ws'
        ? [pref('kvDescriptions', 'Description column')]
        : opts.kind === 'graphql'
          ? [pref('gqlVariablesOpen', 'Variables'), pref('gqlSchemaOpen', 'Schema explorer')]
          : []
  if (context.length) context[0] = { ...context[0], section: 'This tab' }

  return [
    orientation('auto', 'Auto', { section: 'Orientation' }),
    orientation(
      'horizontal',
      opts.forced && prefs.orientation === 'horizontal' ? 'Side by side (needs more width)' : 'Side by side'
    ),
    orientation('vertical', 'Stacked', { shortcut: keyLabel('http-toggle-layout') }),
    { label: '', separator: true },
    {
      label: 'Sidebar',
      checked: !app.sidebarCollapsed,
      shortcut: keyLabel('toggle-sidebar'),
      onClick: () => app.toggleSidebar()
    },
    {
      label: 'Response',
      checked: split !== 'response-collapsed',
      disabled: !inStrip,
      shortcut: keyLabel('http-toggle-response'),
      onClick: () => toggleSplit('response-collapsed')
    },
    {
      label: 'Request',
      checked: split !== 'request-collapsed',
      disabled: !inStrip,
      shortcut: keyLabel('http-toggle-request'),
      onClick: () => toggleSplit('request-collapsed')
    },
    ...(context.length ? [{ label: '', separator: true }, ...context] : []),
    { label: '', separator: true },
    { label: 'Cookies…', onClick: () => http.setOverlay('cookies') },
    { label: 'Reset pane sizes', onClick: () => http.setPrefs({ ratios: DEFAULT_PREFS.ratios }) }
  ]
}
