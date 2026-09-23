// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { findConflicts, findShadowed, resolveBindings } from '../src/renderer/src/lib/shortcuts'
import { runShortcut, useHotkeys } from '../src/renderer/src/hooks/useHotkeys'
import { registerHttpHotkeys, useHttp } from '../src/renderer/src/store/http'
import { useApp } from '../src/renderer/src/store/app'
import { httpHotkeyHandlers } from '../src/renderer/src/components/http/hotkeys'
import * as httpSend from '../src/renderer/src/lib/httpSend'
import * as wsActions from '../src/renderer/src/components/http/ws/wsActions'
import * as gqlActions from '../src/renderer/src/components/http/gql/gqlActions'

// The HTTP client's keyboard (§2.7): its own 'http' scope, the Tabs commands
// dispatched to the request strip, and the rules that keep both from stealing
// keys that belong to a text field, an editor or another platform's layout.

vi.mock('../src/renderer/src/lib/httpSend', () => ({
  send: vi.fn(async () => undefined),
  cancel: vi.fn(),
  runGraphQl: vi.fn(async () => undefined),
  openSocket: vi.fn(async () => undefined),
  sendWsMessage: vi.fn(async () => undefined),
  confirmIfProduction: vi.fn(async () => true),
  sendAgainFromHistory: vi.fn(async () => undefined),
  copyAsCurl: vi.fn(async () => true)
}))

vi.mock('../src/renderer/src/components/http/gql/gqlActions', () => ({
  runGql: vi.fn(async () => undefined),
  prettifyGql: vi.fn()
}))

vi.mock('../src/renderer/src/components/http/ws/wsActions', () => ({
  submitWs: vi.fn(async () => undefined),
  beautifyWs: vi.fn()
}))

function platform(mac: boolean): void {
  Object.defineProperty(navigator, 'platform', { value: mac ? 'MacIntel' : 'Win32', configurable: true })
}
afterEach(() => {
  delete (navigator as unknown as Record<string, unknown>).platform
  vi.clearAllMocks()
})

beforeEach(() => {
  platform(false)
  useApp.setState({ activity: 'http' })
})

/** A keydown as the browser delivers it; `code` decides the combo, as in comboFrom. */
function key(code: string, mods: Partial<KeyboardEventInit> & { modifierAltGraph?: boolean } = {}): KeyboardEvent {
  const key = code.startsWith('Key') ? code.slice(3).toLowerCase() : code.startsWith('Digit') ? code.slice(5) : code
  return new KeyboardEvent('keydown', { code, key, bubbles: true, cancelable: true, ...mods })
}

const mount = (): (() => void) => registerHttpHotkeys(httpHotkeyHandlers({ width: () => 1000 }))
const ws = (): string => useApp.getState().activeWorkspaceId
const activeTab = (): string | null => useHttp.getState().activeTab[ws()] ?? null

describe('the binding table', () => {
  it.each([true, false])('has no conflicts in its defaults (mac: %s)', (mac) => {
    platform(mac)
    expect(findConflicts(resolveBindings({}))).toEqual(new Map())
  })

  it('reports an http binding over an app one as shadowed, not as a conflict', () => {
    platform(true)
    const bindings = resolveBindings({ 'http-env': 'Ctrl+M' })
    expect(findConflicts(bindings).get('Ctrl+M')).toBeUndefined()
    expect(findShadowed(bindings).get('http-env')).toEqual(['open-monitor'])
  })

  it('keys the editors and the tree own are shown but not rebindable', () => {
    const bindings = resolveBindings({ 'http-find': 'Ctrl+G' })
    for (const id of ['http-find', 'http-duplicate', 'http-variable-card']) expect(bindings.has(id), id).toBe(false)
  })

  it('still reports two http bindings on one combo as a conflict', () => {
    const bindings = resolveBindings({ 'http-env': 'Ctrl+J' })
    expect(findConflicts(bindings).get('Ctrl+J')?.sort()).toEqual(['http-env', 'http-toggle-response'])
  })
})

describe('the http scope', () => {
  it('fires only in the HTTP client', () => {
    const env = vi.fn(() => true)
    registerHttpHotkeys({ 'http-env': env })
    useApp.setState({ activity: 'connections' })
    expect(runShortcut(key('KeyE', { ctrlKey: true }), 'app')).toBe(false)
    expect(env).not.toHaveBeenCalled()
    useApp.setState({ activity: 'http' })
    expect(runShortcut(key('KeyE', { ctrlKey: true }), 'app')).toBe(true)
    expect(env).toHaveBeenCalledOnce()
  })

  it('on macOS needs Cmd, so a physical Ctrl+E in a text field keeps its emacs meaning', () => {
    platform(true)
    const env = vi.fn(() => true)
    registerHttpHotkeys({ 'http-env': env })
    expect(runShortcut(key('KeyE', { ctrlKey: true }), 'app')).toBe(false)
    expect(runShortcut(key('KeyE', { metaKey: true }), 'app')).toBe(true)
    expect(env).toHaveBeenCalledOnce()
  })

  it('never matches AltGr', () => {
    const toggle = vi.fn(() => true)
    registerHttpHotkeys({ 'http-toggle-layout': toggle })
    expect(runShortcut(key('KeyJ', { ctrlKey: true, altKey: true, modifierAltGraph: true }), 'app')).toBe(false)
    expect(runShortcut(key('KeyJ', { ctrlKey: true, altKey: true }), 'app')).toBe(true)
    expect(toggle).toHaveBeenCalledOnce()
  })

  it('does nothing when the workbench is not mounted', () => {
    expect(runShortcut(key('KeyE', { ctrlKey: true }), 'app')).toBe(false)
  })
})

describe('Windows and Linux tab keys in the HTTP client', () => {
  it('Ctrl+W closes the request tab, not a terminal', () => {
    mount()
    const a = useHttp.getState().openScratch('http')
    const b = useHttp.getState().openScratch('http')
    expect(runShortcut(key('KeyW', { ctrlKey: true }), 'app')).toBe(true)
    expect(useHttp.getState().tabs.map((t) => t.id)).toEqual([a])
    // The app binding (Ctrl+Shift+W) is dispatched to the strip as well.
    expect(runShortcut(key('KeyW', { ctrlKey: true, shiftKey: true }), 'app')).toBe(true)
    expect(useHttp.getState().tabs).toEqual([])
    void b
  })

  it('Ctrl+1…9 are request tabs, and never switch the workspace there', () => {
    mount()
    useApp.setState({
      workspaces: [...useApp.getState().workspaces, { ...useApp.getState().workspaces[0], id: 'ws-2' }]
    })
    const [a, b] = [useHttp.getState().openScratch('http'), useHttp.getState().openScratch('http')]
    expect(runShortcut(key('Digit1', { ctrlKey: true }), 'app')).toBe(true)
    expect(activeTab()).toBe(a)
    expect(runShortcut(key('Digit9', { ctrlKey: true }), 'app')).toBe(true)
    expect(activeTab()).toBe(b)
    // Tab 5 does not exist: the key is still the strip's, not the workspace switch's.
    expect(runShortcut(key('Digit5', { ctrlKey: true }), 'app')).toBe(true)
    expect(activeTab()).toBe(b)
    expect(useApp.getState().activeWorkspaceId).toBe('ws-default')

    useApp.setState({ activity: 'connections' })
    runShortcut(key('Digit2', { ctrlKey: true }), 'app')
    expect(useApp.getState().activeWorkspaceId).toBe('ws-2')
  })

  it('Ctrl+T opens a request tab', () => {
    mount()
    expect(runShortcut(key('KeyT', { ctrlKey: true }), 'app')).toBe(true)
    expect(useHttp.getState().tabs).toHaveLength(1)
  })
})

describe('keys that belong to something else', () => {
  it('reopen-tab is left to a text field, where Ctrl+Shift+Z is redo', () => {
    mount()
    const a = useHttp.getState().openScratch('http')
    useHttp.getState().closeTab(a)
    const input = document.body.appendChild(document.createElement('input'))
    input.focus()
    expect(runShortcut(key('KeyZ', { ctrlKey: true, shiftKey: true }), 'app')).toBe(false)
    expect(useHttp.getState().tabs).toEqual([])
    input.blur()
    expect(runShortcut(key('KeyZ', { ctrlKey: true, shiftKey: true }), 'app')).toBe(true)
    expect(useHttp.getState().tabs.map((t) => t.id)).toEqual([a])
    input.remove()
  })

  it('a key an editor handled is the editor’s; outside an editor a prevented key still reaches the app', () => {
    function Host(): null {
      useHotkeys()
      return null
    }
    render(<Host />)
    useApp.setState({ activity: 'connections', paletteOpen: false })
    const editor = document.body.appendChild(document.createElement('div'))
    editor.className = 'cm-editor'
    const inEditor = editor.appendChild(document.createElement('div'))
    const outside = document.body.appendChild(document.createElement('div'))
    for (const el of [inEditor, outside]) el.addEventListener('keydown', (e) => e.preventDefault())

    inEditor.dispatchEvent(key('KeyK', { ctrlKey: true }))
    expect(useApp.getState().paletteOpen).toBe(false)
    outside.dispatchEvent(key('KeyK', { ctrlKey: true }))
    expect(useApp.getState().paletteOpen).toBe(true)
    editor.remove()
    outside.remove()
  })
})

describe('⌘↵', () => {
  it('on a WebSocket goes through D’s submitWs, which sends when connected and never disconnects', () => {
    mount()
    const tab = useHttp.getState().openScratch('ws')
    expect(runShortcut(key('Enter', { ctrlKey: true }), 'app')).toBe(true)
    expect(wsActions.submitWs).toHaveBeenCalledWith(tab)
    expect(httpSend.send).not.toHaveBeenCalled()
  })

  it('runs GraphQL through D’s runGql and sends REST', () => {
    mount()
    const gql = useHttp.getState().openScratch('graphql')
    runShortcut(key('Enter', { ctrlKey: true }), 'app')
    expect(gqlActions.runGql).toHaveBeenCalledWith(gql)
    const rest = useHttp.getState().openScratch('http')
    runShortcut(key('Enter', { ctrlKey: true }), 'app')
    expect(httpSend.send).toHaveBeenCalledWith(rest)
  })

  it('⌥⌘B beautifies a WebSocket composer or a GraphQL query outside the editor', () => {
    mount()
    const tab = useHttp.getState().openScratch('ws')
    expect(runShortcut(key('KeyB', { ctrlKey: true, altKey: true }), 'app')).toBe(true)
    expect(wsActions.beautifyWs).toHaveBeenCalledWith(tab)
    const gql = useHttp.getState().openScratch('graphql')
    expect(runShortcut(key('KeyB', { ctrlKey: true, altKey: true }), 'app')).toBe(true)
    expect(gqlActions.prettifyGql).toHaveBeenCalledWith(gql)
    useHttp.getState().openScratch('http')
    expect(runShortcut(key('KeyB', { ctrlKey: true, altKey: true }), 'app')).toBe(false)
  })
})

describe('F6', () => {
  it('lands on the URL first, then cycles the regions', () => {
    mount()
    document.body.innerHTML = `
      <div data-hc-region="tree"><div role="treeitem" tabindex="0">httpbin</div></div>
      <div data-hc-region="url"><button>GET</button><div data-hc-url tabindex="0">url</div></div>
      <div data-hc-region="request-tabs"><button>Params</button></div>
      <div data-hc-region="response"><button>Body</button></div>`
    const press = (): string | null => {
      runShortcut(key('F6'), 'app')
      return document.activeElement?.textContent ?? null
    }
    expect(press()).toBe('url')
    expect(press()).toBe('Params')
    expect(press()).toBe('Body')
    expect(press()).toBe('httpbin')
    runShortcut(key('F6', { shiftKey: true }), 'app')
    expect(document.activeElement?.textContent).toBe('Body')
    document.body.innerHTML = ''
  })

  it('skips a region that cannot take focus', () => {
    mount()
    document.body.innerHTML = `
      <div data-hc-region="url"><div data-hc-url tabindex="0">url</div></div>
      <div data-hc-region="request-tabs"><div class="cm-content">not focusable</div></div>
      <div data-hc-region="response"><button>Body</button></div>`
    runShortcut(key('F6'), 'app')
    runShortcut(key('F6'), 'app')
    expect(document.activeElement?.textContent).toBe('Body')
    document.body.innerHTML = ''
  })
})
