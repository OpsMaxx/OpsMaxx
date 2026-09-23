import type { HttpTabState, Id } from '../../../../shared/apiModel'
import { COMMANDS_BY_ID, isMac, resolveBindings } from '../../lib/shortcuts'
import { useApp } from '../../store/app'
import { useHttp, type HttpHotkey } from '../../store/http'
import { copyAsCurl, send } from '../../lib/httpSend'
import { beautifyWs, submitWs } from './ws/wsActions'
import { prettifyGql, runGql } from './gql/gqlActions'
import { cycleRegion, focusUrl } from './focus'
import { requestClose } from './tabs/closing'
import { orientationFor } from './ProtocolLayout'

// The HTTP client's shortcut handlers (§2.7). The workbench registers them
// while it is mounted; useHotkeys calls them for http-scope bindings and, in
// the HTTP view, for the Tabs commands it dispatches to the request strip.
// A handler returns false when it does not apply, and the key goes on to
// whatever would otherwise receive it.

/** The active workspace's strip and its active tab. */
function strip(): { tabs: HttpTabState[]; active: HttpTabState | undefined } {
  const ws = useApp.getState().activeWorkspaceId
  const http = useHttp.getState()
  const tabs = http.tabs.filter((t) => t.workspaceId === ws)
  return { tabs, active: tabs.find((t) => t.id === http.activeTab[ws]) }
}

const isEditable = (el: Element | null): boolean =>
  !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable)

function selectTab(n: number | 'last'): boolean {
  const { tabs } = strip()
  const tab = n === 'last' ? tabs.at(-1) : tabs[n - 1]
  if (tab) useHttp.getState().activateTab(tab.id)
  // Consumed either way: in the HTTP client a digit never falls through to the workspace switch.
  return true
}

function cycle(step: 1 | -1): boolean {
  const { tabs, active } = strip()
  if (tabs.length === 0) return false
  const at = active ? tabs.indexOf(active) : -1
  useHttp.getState().activateTab(tabs[(at + step + tabs.length) % tabs.length].id)
  return true
}

function toggleSplit(to: 'response-collapsed' | 'request-collapsed'): boolean {
  const { active } = strip()
  if (!active || active.kind !== 'request') return false
  useHttp.getState().setSplit(active.id, active.split === to ? 'normal' : to)
  return true
}

/**
 * ⌘↵ (UX-M11): Send, Connect or Run by protocol. On a WebSocket, D's
 * `submitWs` connects, or sends the composer's message when connected; it
 * never disconnects.
 */
export function primaryAction(tabId: Id): boolean {
  const req = useHttp.getState().requestFor(tabId)
  if (!req) return false
  if (req.kind === 'http') void send(tabId)
  // D's runGql picks the operation and loads the schema after the first good run.
  else if (req.kind === 'graphql') void runGql(tabId)
  else void submitWs(tabId)
  return true
}

/**
 * Copy as cURL (§2.14), masked. The with-secrets copy asks first, so it goes
 * through the workbench's confirm (`copy-curl-secrets`), never a shortcut.
 */
export function copyCurl(tabId: Id): Promise<boolean> {
  return copyAsCurl(tabId, { secrets: 'mask' })
}

export interface HotkeyCtx {
  /** The workbench's current width, for the side by side ↔ stacked toggle. */
  width: () => number
}

export function httpHotkeyHandlers(ctx: HotkeyCtx): Record<string, HttpHotkey> {
  const http = (): ReturnType<typeof useHttp.getState> => useHttp.getState()
  const newTab = (): boolean => {
    http().openScratch('http')
    focusUrl()
    return true
  }
  const closeActive = (): boolean => {
    const { active } = strip()
    if (!active) return false
    requestClose([active.id])
    return true
  }
  const handlers: Record<string, HttpHotkey> = {
    'new-terminal': newTab,
    'http-new-tab': newTab,
    'close-tab': closeActive,
    'http-close-tab': closeActive,
    'next-tab': () => cycle(1),
    'prev-tab': () => cycle(-1),
    'duplicate-tab': () => {
      const { active } = strip()
      return !!active && http().duplicateTab(active.id) !== null
    },
    // Not while typing: Ctrl+Shift+Z is redo there.
    'reopen-tab': () => !isEditable(document.activeElement) && (http().reopenClosed(), true),
    'select-tab-last': () => selectTab('last'),
    'http-select-tab-last': () => selectTab('last'),
    'http-send': () => {
      const { active } = strip()
      return !!active && active.kind === 'request' && primaryAction(active.id)
    },
    'http-save': () => {
      const { active } = strip()
      if (!active || active.kind !== 'request') return false
      if (!http().saveInPlace(active.id)) http().setOverlay('save')
      return true
    },
    'http-save-as': () => {
      const { active } = strip()
      if (!active || active.kind !== 'request') return false
      http().setOverlay('save')
      return true
    },
    'http-focus-region': () => cycleRegion(1),
    'http-focus-region-back': () => cycleRegion(-1),
    'http-focus-url': () => (focusUrl(), true),
    'http-env': () => (http().setOverlay('env'), true),
    'http-toggle-response': () => toggleSplit('response-collapsed'),
    'http-toggle-request': () => toggleSplit('request-collapsed'),
    'http-toggle-layout': () => {
      const { orientation } = orientationFor(ctx.width(), http().prefs.orientation)
      http().setPrefs({ orientation: orientation === 'horizontal' ? 'vertical' : 'horizontal' })
      return true
    },
    'http-import': () => (http().openImport(), true),
    'http-copy-curl': () => {
      const { active } = strip()
      if (!active || http().requestFor(active.id)?.kind === 'ws') return false
      void copyCurl(active.id)
      return true
    },
    // Outside an editor: WS and GraphQL beautify from here. REST's lives in C's body editor.
    'http-beautify': () => {
      const { active } = strip()
      const kind = active && http().requestFor(active.id)?.kind
      if (kind === 'ws') beautifyWs(active!.id)
      else if (kind === 'graphql') prettifyGql(active!.id)
      else return false
      return true
    }
  }
  for (let n = 1; n <= 8; n++) {
    handlers[`select-tab-${n}`] = () => selectTab(n)
    handlers[`http-select-tab-${n}`] = () => selectTab(n)
  }
  return handlers
}

const MAC_GLYPH: Record<string, string> = {
  Ctrl: '⌘',
  Alt: '⌥',
  Shift: '⇧',
  Enter: '↵',
  Backspace: '⌫',
  Escape: 'Esc',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→'
}
// Apple's order for modifier glyphs.
const MAC_ORDER = ['Alt', 'Shift', 'Ctrl']

/** A stored combo as the platform writes it: "⇧⌘J" on macOS, "Ctrl+Shift+J" elsewhere. */
export function formatCombo(combo: string, mac = isMac()): string {
  if (!combo) return ''
  if (!mac) return combo
  const parts = combo.split('+')
  const key = parts.pop()!
  const mods = parts.sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b))
  return [...mods, key].map((p) => MAC_GLYPH[p] ?? p).join('')
}

/** The live binding for a command, for tooltips and menus ("Collapse response (⌘J)"). */
export function keyLabel(id: string): string {
  const cmd = COMMANDS_BY_ID.get(id)
  if (!cmd) return ''
  if (cmd.fixed) return formatCombo(cmd.keys)
  return formatCombo(resolveBindings(useApp.getState().settings.shortcuts).get(id) ?? '')
}

/** "Collapse response (⌘J)", or just the label when the command is unbound. */
export function withKey(label: string, id: string): string {
  const k = keyLabel(id)
  return k ? `${label} (${k})` : label
}
