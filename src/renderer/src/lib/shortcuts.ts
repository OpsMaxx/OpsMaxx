// The single source of truth for keyboard shortcuts.
//
// Every binding is a canonical combo string ("Ctrl+Shift+P") produced by
// `comboFrom` — the recorder in Settings and the dispatcher in useHotkeys both
// call it, so what the user presses while recording is exactly what matches
// later. Nothing else parses key events.

import type { MessageKey, Vars } from '../../../shared/i18n'
import { t } from './i18n'

export type Scope = 'global' | 'app' | 'terminal' | 'http'

export interface Command {
  id: string
  name: string
  group: string
  // Where the binding is live:
  //   app      – only when focus is outside a terminal, so shell control keys
  //              (Ctrl+K, Ctrl+W, Ctrl+L …) still reach the remote host.
  //   global   – everywhere, terminals included. Reserve for combos no shell
  //              owns, which in practice means Shift-qualified ones.
  //   terminal – only inside a terminal (clipboard, find).
  //   http     – only in the HTTP client, checked before app bindings, which
  //              it shadows there. On macOS a Ctrl binding needs Cmd, so a
  //              physical Ctrl+E in a text field keeps its emacs meaning.
  scope: Scope
  keys: string
  /**
   * The binding off macOS, where it differs.
   *
   * `comboFrom` folds Cmd into Ctrl so one stored binding means "the platform's
   * app modifier" -- which is right on a Mac, where Cmd is the app modifier and
   * no shell wants it. On Windows and Linux the app modifier IS Control, and
   * Control belongs to the shell: Ctrl+W, Ctrl+L, Ctrl+K and Ctrl+1..9 are all
   * keys a terminal is entitled to, so `scopeApplies` refuses app bindings
   * there. Correct, and it left those users with five working keys out of
   * thirty-three, because the terminal always has focus.
   *
   * The answer their own terminals already use: Ctrl+Shift for actions and Alt
   * for tab digits -- what Windows Terminal and GNOME Terminal bind, and what
   * readline does not claim. Only where it differs; a command whose binding is
   * already Shift-qualified needs nothing here.
   */
  winKeys?: string
  // Bindings the app computes rather than matches — shown for reference, not
  // rebindable.
  fixed?: boolean
  hint?: string
}

interface CommandSpec extends Omit<Command, 'name' | 'group' | 'hint'> {
  nameKey: MessageKey
  nameVars?: Vars
  groupKey: MessageKey
  hintKey?: MessageKey
}

// The words are looked up each time they are read rather than once at import,
// so Settings and the palette follow a language change.
function cmd({ nameKey, nameVars, groupKey, hintKey, ...rest }: CommandSpec): Command {
  return Object.defineProperties(rest as Command, {
    name: { get: () => t(nameKey, nameVars), enumerable: true },
    group: { get: () => t(groupKey), enumerable: true },
    ...(hintKey ? { hint: { get: () => t(hintKey), enumerable: true } } : {})
  })
}

// Order here is the order shown in Settings.
export const COMMANDS: Command[] = [
  cmd({ id: 'palette', nameKey: 'lib.shortcuts.palette.name', groupKey: 'lib.shortcuts.group.general', scope: 'app', keys: 'Ctrl+K' }),
  cmd({
    id: 'palette-global',
    nameKey: 'lib.shortcuts.paletteGlobal.name',
    groupKey: 'lib.shortcuts.group.general',
    scope: 'global',
    keys: 'Ctrl+Shift+P',
    hintKey: 'lib.shortcuts.paletteGlobal.hint'
  }),
  cmd({ id: 'settings', nameKey: 'lib.shortcuts.settings.name', groupKey: 'lib.shortcuts.group.general', scope: 'app', keys: 'Ctrl+,', winKeys: 'Ctrl+Shift+,' }),
  cmd({ id: 'toggle-sidebar', nameKey: 'lib.shortcuts.toggleSidebar.name', groupKey: 'lib.shortcuts.group.general', scope: 'app', keys: 'Ctrl+B' }),
  cmd({
    id: 'toggle-sidebar-global',
    nameKey: 'lib.shortcuts.toggleSidebarGlobal.name',
    groupKey: 'lib.shortcuts.group.general',
    scope: 'global',
    keys: 'Ctrl+Shift+B',
    hintKey: 'lib.shortcuts.toggleSidebarGlobal.hint'
  }),

  cmd({ id: 'new-server', nameKey: 'lib.shortcuts.newServer.name', groupKey: 'lib.shortcuts.group.tabs', scope: 'app', keys: 'Ctrl+N', winKeys: 'Alt+N' }),
  cmd({ id: 'new-terminal', nameKey: 'lib.shortcuts.newTerminal.name', groupKey: 'lib.shortcuts.group.tabs', scope: 'app', keys: 'Ctrl+T', winKeys: 'Ctrl+Shift+T' }),
  cmd({
    id: 'new-local-terminal',
    nameKey: 'lib.shortcuts.newLocalTerminal.name',
    groupKey: 'lib.shortcuts.group.tabs',
    scope: 'app',
    keys: 'Ctrl+Shift+T',
    // Ctrl+Shift+T is New Tab on Windows and Linux -- what both their terminals
    // bind -- so the local shell moves aside there rather than taking it.
    winKeys: 'Alt+Shift+T',
    hintKey: 'lib.shortcuts.newLocalTerminal.hint'
  }),
  cmd({ id: 'duplicate-tab', nameKey: 'lib.shortcuts.duplicateTab.name', groupKey: 'lib.shortcuts.group.tabs', scope: 'app', keys: 'Ctrl+Shift+D' }),
  cmd({ id: 'close-tab', nameKey: 'lib.shortcuts.closeTab.name', groupKey: 'lib.shortcuts.group.tabs', scope: 'app', keys: 'Ctrl+W', winKeys: 'Ctrl+Shift+W' }),
  cmd({ id: 'next-tab', nameKey: 'lib.shortcuts.nextTab.name', groupKey: 'lib.shortcuts.group.tabs', scope: 'global', keys: 'Ctrl+Tab' }),
  cmd({ id: 'prev-tab', nameKey: 'lib.shortcuts.prevTab.name', groupKey: 'lib.shortcuts.group.tabs', scope: 'global', keys: 'Ctrl+Shift+Tab' }),
  /**
   * NOT Ctrl+Shift+T, which every browser uses for this and which this app
   * already spends on New Local Terminal. In a terminal client that meaning is
   * the stronger convention — GNOME Terminal, Konsole and Terminator all use
   * it — and moving a binding people already have in their fingers to gain the
   * browser's is a bad trade. Ctrl+Shift+Z reads as the undo it is.
   */
  cmd({
    id: 'reopen-tab',
    nameKey: 'lib.shortcuts.reopenTab.name',
    groupKey: 'lib.shortcuts.group.tabs',
    scope: 'app',
    keys: 'Ctrl+Shift+Z',
    hintKey: 'lib.shortcuts.reopenTab.hint'
  }),
  cmd({ id: 'split-v', nameKey: 'lib.shortcuts.splitV.name', groupKey: 'lib.shortcuts.group.tabs', scope: 'app', keys: 'Ctrl+\\', winKeys: 'Alt+\\' }),
  cmd({ id: 'split-h', nameKey: 'lib.shortcuts.splitH.name', groupKey: 'lib.shortcuts.group.tabs', scope: 'app', keys: 'Ctrl+Shift+\\' }),

  /**
   * Jump to a tab by position, 9 meaning the last one however many there are.
   *
   * Spelled out rather than generated in a loop, because this list is also the
   * settings pane's source of truth and a generated block cannot be read by
   * someone scanning for a key they think is taken.
   */
  cmd({ id: 'select-tab-1', nameKey: 'lib.shortcuts.selectTab.name', nameVars: { n: 1 }, groupKey: 'lib.shortcuts.group.tabs', scope: 'app', keys: 'Ctrl+1', winKeys: 'Alt+1' }),
  cmd({ id: 'select-tab-2', nameKey: 'lib.shortcuts.selectTab.name', nameVars: { n: 2 }, groupKey: 'lib.shortcuts.group.tabs', scope: 'app', keys: 'Ctrl+2', winKeys: 'Alt+2' }),
  cmd({ id: 'select-tab-3', nameKey: 'lib.shortcuts.selectTab.name', nameVars: { n: 3 }, groupKey: 'lib.shortcuts.group.tabs', scope: 'app', keys: 'Ctrl+3', winKeys: 'Alt+3' }),
  cmd({ id: 'select-tab-4', nameKey: 'lib.shortcuts.selectTab.name', nameVars: { n: 4 }, groupKey: 'lib.shortcuts.group.tabs', scope: 'app', keys: 'Ctrl+4', winKeys: 'Alt+4' }),
  cmd({ id: 'select-tab-5', nameKey: 'lib.shortcuts.selectTab.name', nameVars: { n: 5 }, groupKey: 'lib.shortcuts.group.tabs', scope: 'app', keys: 'Ctrl+5', winKeys: 'Alt+5' }),
  cmd({ id: 'select-tab-6', nameKey: 'lib.shortcuts.selectTab.name', nameVars: { n: 6 }, groupKey: 'lib.shortcuts.group.tabs', scope: 'app', keys: 'Ctrl+6', winKeys: 'Alt+6' }),
  cmd({ id: 'select-tab-7', nameKey: 'lib.shortcuts.selectTab.name', nameVars: { n: 7 }, groupKey: 'lib.shortcuts.group.tabs', scope: 'app', keys: 'Ctrl+7', winKeys: 'Alt+7' }),
  cmd({ id: 'select-tab-8', nameKey: 'lib.shortcuts.selectTab.name', nameVars: { n: 8 }, groupKey: 'lib.shortcuts.group.tabs', scope: 'app', keys: 'Ctrl+8', winKeys: 'Alt+8' }),
  cmd({
    id: 'select-tab-last',
    nameKey: 'lib.shortcuts.selectTabLast.name',
    groupKey: 'lib.shortcuts.group.tabs',
    scope: 'app',
    keys: 'Ctrl+9',
    winKeys: 'Alt+9',
    hintKey: 'lib.shortcuts.selectTabLast.hint'
  }),

  cmd({
    id: 'new-workspace',
    nameKey: 'lib.shortcuts.newWorkspace.name',
    groupKey: 'lib.shortcuts.group.workspaces',
    scope: 'global',
    keys: 'Ctrl+Shift+N'
  }),
  cmd({
    id: 'switch-workspace',
    nameKey: 'lib.shortcuts.switchWorkspace.name',
    groupKey: 'lib.shortcuts.group.workspaces',
    scope: 'global',
    keys: 'Ctrl+1…9',
    fixed: true,
    hintKey: 'lib.shortcuts.switchWorkspace.hint'
  }),
  cmd({
    id: 'lock-workspace',
    nameKey: 'lib.shortcuts.lockWorkspace.name',
    groupKey: 'lib.shortcuts.group.workspaces',
    scope: 'app',
    keys: 'Ctrl+L',
    winKeys: 'Ctrl+Shift+L',
    hintKey: 'lib.shortcuts.lockWorkspace.hint'
  }),

  cmd({ id: 'open-files', nameKey: 'lib.shortcuts.openFiles.name', groupKey: 'lib.shortcuts.group.views', scope: 'global', keys: 'Ctrl+Shift+E' }),
  cmd({ id: 'open-monitor', nameKey: 'lib.shortcuts.openMonitor.name', groupKey: 'lib.shortcuts.group.views', scope: 'app', keys: 'Ctrl+M', winKeys: 'Ctrl+Shift+M' }),
  cmd({ id: 'zoom-in', nameKey: 'lib.shortcuts.zoomIn.name', groupKey: 'lib.shortcuts.group.views', scope: 'global', keys: 'Ctrl+=' }),
  cmd({
    id: 'zoom-in-alt',
    nameKey: 'lib.shortcuts.zoomInAlt.name',
    groupKey: 'lib.shortcuts.group.views',
    scope: 'global',
    keys: 'Ctrl+Shift+=',
    hintKey: 'lib.shortcuts.zoomInAlt.hint'
  }),
  cmd({ id: 'zoom-out', nameKey: 'lib.shortcuts.zoomOut.name', groupKey: 'lib.shortcuts.group.views', scope: 'global', keys: 'Ctrl+-' }),
  cmd({ id: 'zoom-reset', nameKey: 'lib.shortcuts.zoomReset.name', groupKey: 'lib.shortcuts.group.views', scope: 'global', keys: 'Ctrl+0' }),

  /**
   * The HTTP client (§2.7). Tabs there are request tabs: the Tabs commands
   * above are dispatched to its strip while it is showing, and off macOS these
   * plain-Ctrl aliases give Postman's keys in a view that has no terminal to
   * protect. `keys: ''` leaves an alias unbound on macOS, where Cmd already
   * does the job.
   */
  cmd({ id: 'http-new-tab', nameKey: 'lib.shortcuts.httpNewTab.name', groupKey: 'lib.shortcuts.group.httpClient', scope: 'http', keys: '', winKeys: 'Ctrl+T' }),
  cmd({ id: 'http-close-tab', nameKey: 'lib.shortcuts.httpCloseTab.name', groupKey: 'lib.shortcuts.group.httpClient', scope: 'http', keys: '', winKeys: 'Ctrl+W' }),
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
    cmd({
      id: `http-select-tab-${n}`,
      nameKey: 'lib.shortcuts.httpSelectTab.name',
      nameVars: { n },
      groupKey: 'lib.shortcuts.group.httpClient',
      scope: 'http',
      keys: '',
      winKeys: `Ctrl+${n}`
    })
  ),
  cmd({
    id: 'http-select-tab-last',
    nameKey: 'lib.shortcuts.httpSelectTabLast.name',
    groupKey: 'lib.shortcuts.group.httpClient',
    scope: 'http',
    keys: '',
    winKeys: 'Ctrl+9',
    hintKey: 'lib.shortcuts.httpSelectTabLast.hint'
  }),
  cmd({
    id: 'http-send',
    nameKey: 'lib.shortcuts.httpSend.name',
    groupKey: 'lib.shortcuts.group.httpClient',
    scope: 'http',
    keys: 'Ctrl+Enter',
    hintKey: 'lib.shortcuts.httpSend.hint'
  }),
  cmd({ id: 'http-save', nameKey: 'lib.shortcuts.httpSave.name', groupKey: 'lib.shortcuts.group.httpClient', scope: 'http', keys: 'Ctrl+S' }),
  cmd({ id: 'http-save-as', nameKey: 'lib.shortcuts.httpSaveAs.name', groupKey: 'lib.shortcuts.group.httpClient', scope: 'http', keys: 'Ctrl+Shift+S' }),
  cmd({
    id: 'http-focus-region',
    nameKey: 'lib.shortcuts.httpFocusRegion.name',
    groupKey: 'lib.shortcuts.group.httpClient',
    scope: 'http',
    keys: 'F6',
    hintKey: 'lib.shortcuts.httpFocusRegion.hint'
  }),
  cmd({ id: 'http-focus-region-back', nameKey: 'lib.shortcuts.httpFocusRegionBack.name', groupKey: 'lib.shortcuts.group.httpClient', scope: 'http', keys: 'Shift+F6' }),
  cmd({
    id: 'http-focus-url',
    nameKey: 'lib.shortcuts.httpFocusUrl.name',
    groupKey: 'lib.shortcuts.group.httpClient',
    scope: 'http',
    // ⌘L is Lock Workspace on macOS and stays so; F6 reaches the URL there.
    keys: '',
    winKeys: 'Ctrl+L'
  }),
  cmd({ id: 'http-env', nameKey: 'lib.shortcuts.httpEnv.name', groupKey: 'lib.shortcuts.group.httpClient', scope: 'http', keys: 'Ctrl+E' }),
  cmd({ id: 'http-toggle-response', nameKey: 'lib.shortcuts.httpToggleResponse.name', groupKey: 'lib.shortcuts.group.httpClient', scope: 'http', keys: 'Ctrl+J' }),
  cmd({ id: 'http-toggle-request', nameKey: 'lib.shortcuts.httpToggleRequest.name', groupKey: 'lib.shortcuts.group.httpClient', scope: 'http', keys: 'Ctrl+Shift+J' }),
  cmd({
    id: 'http-toggle-layout',
    nameKey: 'lib.shortcuts.httpToggleLayout.name',
    groupKey: 'lib.shortcuts.group.httpClient',
    scope: 'http',
    keys: 'Ctrl+Alt+J'
  }),
  cmd({ id: 'http-beautify', nameKey: 'lib.shortcuts.httpBeautify.name', groupKey: 'lib.shortcuts.group.httpClient', scope: 'http', keys: 'Ctrl+Alt+B' }),
  cmd({
    id: 'http-copy-curl',
    nameKey: 'lib.shortcuts.httpCopyCurl.name',
    groupKey: 'lib.shortcuts.group.httpClient',
    scope: 'http',
    keys: 'Ctrl+Shift+C',
    hintKey: 'lib.shortcuts.httpCopyCurl.hint'
  }),
  /*
   * Fixed, not rebindable: the editors (CodeMirror's Mod-F) and the collection
   * tree (Mod-D) own these keys where they apply, so a rebinding here would
   * change what Settings shows and nothing else.
   */
  cmd({ id: 'http-find', nameKey: 'lib.shortcuts.httpFind.name', groupKey: 'lib.shortcuts.group.httpClient', scope: 'http', keys: 'Ctrl+F', fixed: true }),
  cmd({ id: 'http-duplicate', nameKey: 'lib.shortcuts.httpDuplicate.name', groupKey: 'lib.shortcuts.group.httpClient', scope: 'http', keys: 'Ctrl+D', fixed: true }),
  cmd({ id: 'http-import', nameKey: 'lib.shortcuts.httpImport.name', groupKey: 'lib.shortcuts.group.httpClient', scope: 'http', keys: 'Ctrl+O' }),
  cmd({
    id: 'http-variable-card',
    nameKey: 'lib.shortcuts.httpVariableCard.name',
    groupKey: 'lib.shortcuts.group.httpClient',
    scope: 'http',
    keys: 'Ctrl+I',
    fixed: true,
    hintKey: 'lib.shortcuts.httpVariableCard.hint'
  }),
  cmd({ id: 'http-cancel', nameKey: 'lib.shortcuts.httpCancel.name', groupKey: 'lib.shortcuts.group.httpClient', scope: 'http', keys: 'Escape', fixed: true }),
  cmd({ id: 'http-rename', nameKey: 'lib.shortcuts.httpRename.name', groupKey: 'lib.shortcuts.group.httpClient', scope: 'http', keys: 'F2', fixed: true }),
  cmd({
    id: 'http-delete',
    nameKey: 'lib.shortcuts.httpDelete.name',
    groupKey: 'lib.shortcuts.group.httpClient',
    scope: 'http',
    keys: isMac() ? 'Ctrl+Backspace' : 'Delete',
    fixed: true,
    hintKey: 'lib.shortcuts.httpDelete.hint'
  }),
  cmd({ id: 'http-tree-undo', nameKey: 'lib.shortcuts.httpTreeUndo.name', groupKey: 'lib.shortcuts.group.httpClient', scope: 'http', keys: 'Ctrl+Z', fixed: true }),

  cmd({ id: 'term-copy', nameKey: 'lib.shortcuts.termCopy.name', groupKey: 'lib.shortcuts.group.terminal', scope: 'terminal', keys: 'Ctrl+Shift+C' }),
  cmd({
    id: 'term-copy-alt',
    nameKey: 'lib.shortcuts.termCopyAlt.name',
    groupKey: 'lib.shortcuts.group.terminal',
    scope: 'terminal',
    keys: 'Ctrl+Insert'
  }),
  cmd({ id: 'term-paste', nameKey: 'lib.shortcuts.termPaste.name', groupKey: 'lib.shortcuts.group.terminal', scope: 'terminal', keys: 'Ctrl+Shift+V' }),
  cmd({
    id: 'term-paste-alt',
    nameKey: 'lib.shortcuts.termPasteAlt.name',
    groupKey: 'lib.shortcuts.group.terminal',
    scope: 'terminal',
    keys: 'Shift+Insert'
  }),
  cmd({ id: 'term-find', nameKey: 'lib.shortcuts.termFind.name', groupKey: 'lib.shortcuts.group.terminal', scope: 'terminal', keys: 'Ctrl+Shift+F' }),
  cmd({
    id: 'term-find-alt',
    nameKey: 'lib.shortcuts.termFindAlt.name',
    groupKey: 'lib.shortcuts.group.terminal',
    scope: 'terminal',
    /**
     * macOS only, because Cmd folds into Ctrl here.
     *
     * On macOS this binding is Cmd+F, which conflicts with nothing and is what
     * every Mac app uses to search. Off macOS the same stored combo is a real
     * Ctrl+F -- readline's `forward-char`, and page-forward in `less` and `vim`
     * -- and this is a `terminal`-scope binding, so it was intercepted before
     * xterm ever saw it. Moving the cursor right in a shell prompt opened a
     * find bar instead.
     *
     * Unbound rather than rebound: Ctrl+Shift+F already does this on every
     * platform, so there is nothing to replace, and a user who wants their own
     * alias can set one in Settings > Keyboard Shortcuts.
     */
    keys: isMac() ? 'Ctrl+F' : ''
  })
]

export const COMMANDS_BY_ID = new Map(COMMANDS.map((c) => [c.id, c]))

// Punctuation and named keys, keyed by e.code so the combo survives a
// non-US layout. Letters and digits are derived from their code prefixes.
const CODE_TOKENS: Record<string, string> = {
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  NumpadAdd: '=',
  NumpadSubtract: '-',
  NumpadDecimal: '.',
  NumpadDivide: '/',
  NumpadMultiply: '*',
  NumpadEnter: 'Enter',
  Space: 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right'
}

const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Alt', 'Shift'])

// The printable/named token for a key press, without modifiers.
function keyToken(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null
  const code = e.code
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code)?.[1]
  if (digit) return digit
  if (/^F[1-9][0-9]?$/.test(code)) return code
  if (CODE_TOKENS[code]) return CODE_TOKENS[code]
  // Keyboards that report no useful code (IME, some virtual keyboards) still
  // give a usable e.key.
  if (!code && e.key.length === 1) return e.key.toUpperCase()
  if (['Tab', 'Enter', 'Escape', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown'].includes(code)) {
    return code
  }
  return e.key.length === 1 ? e.key.toUpperCase() : e.key
}

// Canonical combo for a key event, or null if only modifiers are held.
// Cmd is folded into Ctrl: one stored binding then works on both platforms,
// which is also how the app has always matched (e.ctrlKey || e.metaKey).
export function comboFrom(e: KeyboardEvent): string | null {
  const token = keyToken(e)
  if (!token) return null
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(token)
  return parts.join('+')
}

// Display form. Only differs from storage on macOS, where Ctrl is really Cmd.
export function displayCombo(combo: string, mac = isMac()): string[] {
  if (!combo) return []
  return combo.split('+').map((p) => (p === 'Ctrl' && mac ? 'Cmd' : p))
}

export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
}

// Effective binding for every command: built-in defaults with the user's
// overrides applied. An override of '' means the user unbound it.
/**
 * What this command is bound to out of the box, on THIS platform.
 *
 * Anything showing a default -- the restore-default control, a cheat sheet --
 * has to ask for it rather than read `keys`, which is the macOS default and
 * would name a key that does nothing on the machine it is printed on.
 */
export function defaultKeys(c: Command): string {
  return isMac() ? c.keys : (c.winKeys ?? c.keys)
}

export function resolveBindings(overrides: Record<string, string>): Map<string, string> {
  const out = new Map<string, string>()
  for (const c of COMMANDS) {
    if (c.fixed) continue
    // The platform default first, then the user's override on top. A rebinding
    // is a rebinding on whatever machine it was made; only the DEFAULT differs.
    const keys = overrides[c.id] ?? defaultKeys(c)
    if (keys) out.set(c.id, keys)
  }
  return out
}

// Two commands clash only where their scopes overlap — 'global' overlaps
// everything, 'app' and 'terminal' never see each other's key events. 'http'
// against 'app' is not a clash: the http binding wins in the HTTP client and
// the app one everywhere else, which `findShadowed` reports as a note.
export function scopesOverlap(a: Scope, b: Scope): boolean {
  return a === 'global' || b === 'global' || a === b
}

// combo -> command ids sharing it within an overlapping scope.
export function findConflicts(bindings: Map<string, string>): Map<string, string[]> {
  const byCombo = new Map<string, string[]>()
  for (const [id, keys] of bindings) {
    byCombo.set(keys, [...(byCombo.get(keys) ?? []), id])
  }
  const conflicts = new Map<string, string[]>()
  for (const [combo, ids] of byCombo) {
    if (ids.length < 2) continue
    const clashing = ids.filter((id) =>
      ids.some((other) => {
        if (other === id) return false
        const a = COMMANDS_BY_ID.get(id)?.scope
        const b = COMMANDS_BY_ID.get(other)?.scope
        return !!a && !!b && scopesOverlap(a, b)
      })
    )
    if (clashing.length > 1) conflicts.set(combo, clashing)
  }
  return conflicts
}

/**
 * http id -> the app commands it shadows in the HTTP client. Not an error: the
 * app binding still works everywhere else, so Settings shows it as a note.
 */
export function findShadowed(bindings: Map<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [id, keys] of bindings) {
    if (COMMANDS_BY_ID.get(id)?.scope !== 'http') continue
    const shadowed = [...bindings].filter(([other, k]) => k === keys && COMMANDS_BY_ID.get(other)?.scope === 'app')
    if (shadowed.length) out.set(id, shadowed.map(([other]) => other))
  }
  return out
}
