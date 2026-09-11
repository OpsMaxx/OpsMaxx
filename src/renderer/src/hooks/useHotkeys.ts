import { useEffect } from 'react'
import { useApp } from '../store/app'
import { COMMANDS_BY_ID, comboFrom, isMac, resolveBindings, type Scope } from '../lib/shortcuts'
import { openMonitor } from '../store/nav'
import type { Workspace } from '../types'

type Store = ReturnType<typeof useApp.getState>

// Clipboard/search actions a terminal supplies for the terminal-scope commands.
// The terminal owns them, so they are handed in rather than reached for here.
export interface TerminalActions {
  copy: () => void
  paste: () => void
  find?: () => void
}

// What each command does. Returning false means "not applicable right now"
// (no tab open, workspace has no password) and lets the key through to
// whatever would normally receive it.
const RUNNERS: Record<string, (s: Store, term?: TerminalActions) => boolean> = {
  palette: (s) => (s.togglePalette(), true),
  'palette-global': (s) => (s.togglePalette(), true),
  settings: (s) => (s.setActivity('settings'), true),
  'toggle-sidebar': (s) => (s.toggleSidebar(), true),
  'toggle-sidebar-global': (s) => (s.toggleSidebar(), true),

  'new-server': (s) => (s.setModal('add-server'), true),
  // Mirrors the tab bar's + button: another session on whatever the current tab
  // is already talking to — a server or a local shell — or the add-server
  // dialog when there is nothing to open a session against.
  'new-terminal': (s) => {
    const tab = s.activeTab()
    if (tab?.kind === 'ssh') s.newSession(tab.serverId)
    else if (tab?.kind === 'local') s.openLocalById(tab.shellId, tab.cwd)
    else s.setModal('add-server')
    return true
  },
  // A shell on this machine, whatever the current tab is. The default shell is
  // picked with `isDefault` and never by inspecting an id: shell ids are opaque
  // and parsing one is how the wrong shell gets spawned under the right name.
  //
  // False, not a fallback, when the feature is off or nothing has been
  // discovered yet — the key then reaches whatever would normally receive it,
  // which is the contract every runner here has.
  'new-local-terminal': (s) => {
    if (s.settings.localTerminalEnabled === false) return false
    const shell = s.localShells.find((sh) => sh.isDefault) ?? s.localShells[0]
    if (!shell) return false
    s.openLocalById(shell.id)
    return true
  },
  'duplicate-tab': (s) => {
    const tab = s.activeTab()
    return tab ? (s.duplicateTab(tab.id), true) : false
  },
  'close-tab': (s) => (s.activeTabId ? (s.closeTab(s.activeTabId), true) : false),
  'reopen-tab': (s) => (s.reopenClosedTab(), true),
  'select-tab-1': (s) => (s.selectTabByNumber(1), true),
  'select-tab-2': (s) => (s.selectTabByNumber(2), true),
  'select-tab-3': (s) => (s.selectTabByNumber(3), true),
  'select-tab-4': (s) => (s.selectTabByNumber(4), true),
  'select-tab-5': (s) => (s.selectTabByNumber(5), true),
  'select-tab-6': (s) => (s.selectTabByNumber(6), true),
  'select-tab-7': (s) => (s.selectTabByNumber(7), true),
  'select-tab-8': (s) => (s.selectTabByNumber(8), true),
  'select-tab-last': (s) => (s.selectTabByNumber(9), true),
  'next-tab': (s) => (s.cycleTab(1), true),
  'prev-tab': (s) => (s.cycleTab(-1), true),
  'split-v': (s) => splitActive(s, 'v'),
  'split-h': (s) => splitActive(s, 'h'),

  'new-workspace': (s) => (s.setModal('workspaces'), true),
  // Locking an unprotected workspace would drop you out of it with no way
  // back in, so this only applies where a password is actually set.
  'lock-workspace': (s) => {
    const ws = s.activeWorkspace()
    if (!ws?.hasPassword) return false
    s.lockWorkspace(ws.id)
    return true
  },

  // SFTP needs a server to talk to. On a local tab this used to switch the view
  // to 'files' anyway, which left an empty pane and no shortcut back to the
  // terminal — so the key falls through instead of appearing to do something.
  'open-files': (s) => {
    const tab = s.activeTab()
    return tab?.kind === 'ssh' ? (s.setTabView(tab.id, 'files'), true) : false
  },
  // Through openMonitor, not setActivity: Monitoring and Operations share one
  // activity and are told apart by `fleetRail`, so setting the activity alone
  // reopens whichever rail was last used -- "Open Fleet Monitor" landing on
  // Operations.
  'open-monitor': () => (openMonitor('overview'), true),
  'zoom-in': (s) => (s.zoomTerminal(1), true),
  'zoom-in-alt': (s) => (s.zoomTerminal(1), true),
  'zoom-out': (s) => (s.zoomTerminal(-1), true),
  'zoom-reset': (s) => (s.zoomTerminal('reset'), true),

  'term-copy': (_s, term) => (term ? (term.copy(), true) : false),
  'term-copy-alt': (_s, term) => (term ? (term.copy(), true) : false),
  'term-paste': (_s, term) => (term ? (term.paste(), true) : false),
  'term-paste-alt': (_s, term) => (term ? (term.paste(), true) : false),
  'term-find': (_s, term) => (term?.find ? (term.find(), true) : false),
  'term-find-alt': (_s, term) => (term?.find ? (term.find(), true) : false)
}

// Splitting applies to any terminal tab, local or remote. It used to require a
// serverId, which silently made Ctrl+\ a no-op in a local tab.
function splitActive(s: Store, dir: 'h' | 'v'): boolean {
  const tab = s.activeTab()
  if (!tab) return false
  s.toggleSplit(tab.id, dir)
  return true
}

/**
 * Whether a command bound in `scope` should fire for a key event seen in
 * `where`. 'global' fires everywhere; the other two only in their own context.
 *
 * The exception is the Command key on macOS, and it exists because
 * `comboFrom` folds Ctrl and Cmd into ONE token. That fold is right for
 * storage — a binding written `Ctrl+T` should mean the platform's own app
 * modifier — and it costs the app the ability to tell the two apart at the
 * moment it matters most: inside a terminal.
 *
 * Refusing app bindings there is what keeps Ctrl+W, Ctrl+K and Ctrl+L reaching
 * the shell, and that is correct for the CONTROL key on every platform. Cmd is
 * not a shell modifier on macOS — no readline binding uses it, and every Mac
 * terminal opens a tab on Cmd+T — so refusing it stole a shortcut from the app
 * without giving anything to the shell. Cmd+T did nothing at all, because the
 * terminal always has focus.
 */
function scopeApplies(
  scope: Scope,
  where: 'app' | 'terminal',
  appModifier = false
): boolean {
  if (scope === 'global' || scope === where) return true
  return scope === 'app' && where === 'terminal' && appModifier
}

/**
 * True when this event used a modifier the shell has no claim on.
 *
 * macOS only, and Command only. On Windows and Linux the app modifier IS
 * Control, so there is no key here that a terminal is not entitled to.
 */
function usedAppModifier(e: KeyboardEvent): boolean {
  return isMac() && e.metaKey && !e.ctrlKey
}

// Runs whatever the user has bound to this key event, if anything.
// `where` is 'terminal' when focus is inside a terminal, which is what keeps
// shell control keys (Ctrl+K, Ctrl+W, Ctrl+L …) reaching the remote host —
// only 'global' and 'terminal' bindings are considered there.
export function runShortcut(
  e: KeyboardEvent,
  where: 'app' | 'terminal',
  term?: TerminalActions
): boolean {
  const combo = comboFrom(e)
  if (!combo) return false
  const s = useApp.getState()
  const bindings = resolveBindings(s.settings.shortcuts)

  for (const [id, keys] of bindings) {
    if (keys !== combo) continue
    const cmd = COMMANDS_BY_ID.get(id)
    if (!cmd || !scopeApplies(cmd.scope, where, usedAppModifier(e))) continue
    if (RUNNERS[id]?.(s, term)) return true
  }

  // Ctrl/Cmd+1…9 jumps to the Nth visible workspace. Checked after the user's
  // bindings so rebinding a digit still wins, and matched on e.code so it
  // lands on the right digit under non-US keyboard layouts.
  return switchWorkspaceByDigit(e, s)
}

function switchWorkspaceByDigit(e: KeyboardEvent, s: Store): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return false
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(e.code)?.[1]
  if (!digit) return false
  const target = switchableWorkspaces(s.workspaces, s.settings.switchHiddenWorkspaces)[
    Number(digit) - 1
  ]
  if (!target) return false
  if (target.id !== s.activeWorkspaceId) s.setWorkspace(target.id)
  return true
}

// The switcher menu and the Ctrl+1…9 shortcuts must agree on ordering, so both
// number the workspaces through here. With `includeHidden` off, hidden
// workspaces are skipped entirely and the numbering closes up around them.
export function switchableWorkspaces(workspaces: Workspace[], includeHidden: boolean): Workspace[] {
  return includeHidden ? workspaces : workspaces.filter((w) => !w.hidden)
}

function inTerminal(target: EventTarget | null): boolean {
  return !!(target as HTMLElement)?.closest?.('.xterm, .terminal-wrap')
}

export function useHotkeys(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      // Terminals route their own keys through runShortcut via
      // attachCustomKeyEventHandler, so they are skipped here.
      if (inTerminal(e.target)) return
      if (runShortcut(e, 'app')) e.preventDefault()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])
}
