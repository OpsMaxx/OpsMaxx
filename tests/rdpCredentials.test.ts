import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { rdpSecretId } from '../src/shared/rdp'

/**
 * RDP's login, which used to be SSH's login.
 *
 * Reported as "RDP and SSH should be mutually exclusive not codependent in
 * the UI". Hiding the SSH fields for an RDP-only machine was only half of it:
 * the desktop resolved its account from `Server.username` and its password
 * from `getSecret(serverId)` — the ONE secret per server. So a Windows box
 * reached as Administrator over RDP and as root over SSH had to agree on a
 * single password, which on Windows they never do. That is codependence in
 * the data, not just in the form.
 */

const src = (p: string): string => readFileSync(resolve(__dirname, '..', p), 'utf8')
const RELAY = src('src/main/services/rdpRelay.ts')
const MODAL = src('src/renderer/src/components/connections/AddServerModal.tsx')

describe('where an RDP password lives', () => {
  it('is a different id from the server\'s own', () => {
    expect(rdpSecretId('srv-1')).toBe('srv-1:rdp')
    expect(rdpSecretId('srv-1')).not.toBe('srv-1')
  })

  it('is derived, so nothing has to be migrated', () => {
    // Two servers cannot collide, and the id is a pure function of the
    // server's — a record saved before this simply has nothing stored there.
    expect(rdpSecretId('a')).not.toBe(rdpSecretId('b'))
    expect(rdpSecretId('a')).toBe(rdpSecretId('a'))
  })

  // Written under its own id rather than merged into the SSH blob, which is
  // the whole point: one blob is one password.
  it('is stored separately by the form', () => {
    expect(MODAL).toContain('storeSecret(rdpSecretId(id)')
    expect(MODAL).toMatch(/speaks !== 'ssh' && rdpPassword/)
  })

  /**
   * A credential for a machine the app no longer knows about is worse than a
   * missing one: nothing in the UI can reach it to remove it.
   */
  it('is deleted with the server, from both delete paths', () => {
    expect(src('src/renderer/src/components/connections/ConnectionTree.tsx')).toContain(
      'secrets.delete(rdpSecretId(s.id))'
    )
    expect(src('src/renderer/src/components/workspace/WorkspaceManager.tsx')).toContain(
      'secrets.delete(rdpSecretId(d.id))'
    )
  })
})

/**
 * RDP is a connection type, not a correction to one.
 *
 * Reported as "why is there no connection type as RDP … even after selecting
 * RDP it asks for my username twice". The dialog asked how the machine is
 * reached in a row that offered SSH and three clouds, then asked again in a
 * segmented control underneath — and the SSH username box stayed on screen next
 * to the RDP one, which is the field that actually decided.
 */
describe('how a Windows machine is described', () => {
  it('offers RDP in the connection type row', () => {
    expect(MODAL).toMatch(/id: 'rdp', label: 'RDP'/)
    expect(MODAL).toMatch(/'ssh' \| 'rdp' \| CloudProvider/)
  })

  it('has no second control answering the same question', () => {
    // The segmented control is gone; the type row is the only place a protocol
    // is chosen, and `speaks` is read off it.
    // The label element, not the word: the comment above `speaks` still tells
    // the story of the control that used to be here.
    expect(MODAL).not.toContain('field-label">This machine speaks')
    expect(MODAL).not.toContain("['rdp', 'RDP only']")
    expect(MODAL).toMatch(/const speaks: 'ssh' \| 'ssh\+rdp' \| 'rdp' =/)
  })

  it('asks for one account, not two', () => {
    // The SSH username box is not rendered for a machine that speaks no SSH.
    const row = MODAL.slice(MODAL.indexOf('Server / IP'))
    const username = row.indexOf("field-label\">Username")
    expect(username).toBeGreaterThan(-1)
    expect(row.slice(0, username)).toContain("{speaks !== 'rdp' && (")
  })

  it('does not keep a combined mode it can no longer create', () => {
    // An older record that has both is still edited without losing its
    // desktop; nothing in the form produces that shape any more.
    expect(MODAL).toContain('const [legacyBoth] = useState(')
    expect(MODAL).not.toContain('setSpeaks(')
  })

  it('is still not offered for a cloud connection', () => {
    expect(MODAL).toMatch(/const isCloud = connectionType !== 'ssh' && connectionType !== 'rdp'/)
  })
})

/**
 * Loading the WebAssembly backend is not starting it.
 *
 * Reported as "Could not open the desktop — Cannot read properties of undefined
 * (reading '__wbindgen_malloc')", which is the wasm module's allocator being
 * reached before the module exists. <iron-remote-desktop> stores the module it
 * is handed and logs "Web bridge initialized"; it never calls init(), so every
 * desktop failed on the first frame.
 */
describe('starting the RDP backend', () => {
  const VIEW = src('src/renderer/src/components/rdp/RdpView.tsx')

  it('initialises the wasm module before handing it to the element', () => {
    expect(VIEW).toContain('await backend.init(')
    const init = VIEW.indexOf('await backend.init(')
    const element = VIEW.indexOf("createElement('iron-remote-desktop')")
    expect(init).toBeGreaterThan(-1)
    expect(element, 'the element must be created only after init resolves').toBeGreaterThan(init)
  })

  it('hands the element the Backend export, not the module namespace', () => {
    // The element does `new this.module.SessionBuilder()` and reads
    // DesktopSize, InputTransaction, ClipboardData and DeviceEvent off the same
    // object. Those five are what `Backend` holds; the namespace does not carry
    // them at the top level, so passing it got as far as connecting and then
    // failed with "this.module.SessionBuilder is not a constructor".
    expect(VIEW).toContain('.module = backend.Backend')
    expect(VIEW).not.toMatch(/\.module = backend\b(?!\.)/)
  })

  it('still takes init and the extensions off the namespace, where they live', () => {
    expect(VIEW).toContain('await backend.init(')
    expect(VIEW).toContain('backend.enableCredssp(')
  })

  it('checks for teardown after that await, like every other one here', () => {
    const after = VIEW.slice(VIEW.indexOf('await backend.init('))
    expect(after.slice(0, 120)).toContain('if (disposed) return')
  })
})

describe('which account the desktop signs in as', () => {
  it('prefers RDP\'s own, and falls back to the server\'s', () => {
    // The fallback is what keeps every record saved before this working.
    expect(RELAY).toContain("server.rdp.username?.trim() || server.username")
  })

  it('never falls back to the SSH default on a machine with no SSH', () => {
    // `root` against a Windows desktop. The fallback in the relay is right for
    // a record that speaks both; what was wrong is what the form stored — the
    // form's own SSH default, on a machine it had just stopped asking about.
    expect(MODAL).toContain("rdpUsername.trim() || (speaks === 'rdp' ? 'Administrator' : undefined)")
    expect(MODAL).toContain("username: speaks === 'rdp' ? rdpAccount : username.trim() || 'root',")
  })

  it('signs the ticket in as that account, not as the SSH one', () => {
    // The bug this prevents: resolving the right user and then handing the
    // relay `server.username` anyway.
    const ticket = RELAY.slice(RELAY.indexOf('const ticket: RdpTicket'))
    expect(ticket).toContain('username: rdpUser')
    expect(ticket).not.toContain('username: server.username')
  })

  /**
   * Tried under RDP's id first, then the server's. The order matters: reading
   * the shared secret first would mean a box with both set keeps using the
   * SSH password forever, and the new field would appear to do nothing.
   */
  it('reads its own secret before the shared one', () => {
    const own = RELAY.indexOf('serverId: rdpSecretId(server.id)')
    const shared = RELAY.indexOf('serverId: server.id', own)
    expect(own).toBeGreaterThan(-1)
    expect(shared, 'the shared secret must be the fallback, not the first try').toBeGreaterThan(own)
  })

  // The refusal names the account, because "no password is stored for this
  // server" is ambiguous once a server has two logins.
  it('names the account when no password is stored', () => {
    expect(RELAY).toContain('No password is stored for ${rdpUser}')
  })
})

/**
 * Connecting is not running.
 *
 * The third bug of this shape in this one component, and they are worth reading
 * together: `init()` had to be called before the module could be used;
 * `Backend` rather than the namespace had to be handed over; and `connect()`
 * returns a `run` function that has to be called or the protocol is never
 * pumped. Every one of them got further than the last before failing, and none
 * of them raised an error — the component is built so that the missing step
 * looks like a finished one.
 *
 * This one reached a black desktop. TLS and CredSSP both succeeded, the server
 * streamed updates continuously over the WebSocket, the canvas was allocated at
 * the negotiated size, and not one pixel was ever written, because nothing read
 * the stream. Inside the component `run` is `async () => { await session.run()
 * }`; the result of `connect()` was typed `Promise<unknown>` here and thrown
 * away.
 *
 * Pinned against the source rather than a render, because reproducing it needs
 * a real wasm session against a real RDP server. The shape of the mistake is
 * what recurs, so the shape is what is asserted.
 */
describe('running the RDP session', () => {
  const VIEW = src('src/renderer/src/components/rdp/RdpView.tsx')

  it('calls run() on what connect() hands back', () => {
    expect(VIEW).toContain('const session = await ui.connect(')
    expect(VIEW, 'connect() only gets a willing server; run() is the session').toMatch(
      /session\s*\n?\s*\.run\(\)/
    )
  })

  it('does not await run(), which would stall the rest of the effect', () => {
    // run() resolves when the session ENDS. Awaiting it here would never reach
    // the resize observer, so the pane would stop following the window.
    //
    // Anchored on `void session`, not on the first `.run()` in the file: the
    // doc comment above the interface quotes the component's own
    // `await session.run()`, and the first version of this test matched that
    // and passed against prose.
    expect(VIEW).toContain('void session')
    expect(VIEW).not.toMatch(/^\s*await session\s*\n?\s*\.run\(\)/m)
  })

  it('reports a session that ends instead of leaving the tab looking live', () => {
    // Both halves: a clean end is not an error but must not read as connected,
    // and a failure has to surface rather than being swallowed by the void.
    expect(VIEW).toContain('The remote desktop session ended.')
    const call = VIEW.indexOf('void session')
    expect(call).toBeGreaterThan(-1)
    const after = VIEW.slice(call, call + 900)
    expect(after).toContain('.catch(')
    expect(after).toContain("setPhase('failed')")
  })
})

/**
 * Painting into a surface nobody can see.
 *
 * The fourth of these, and the clearest. <iron-remote-desktop> renders into a
 * canvas that starts `visibility: hidden` and translated off-screen, and the
 * only call it makes to setVisibility itself is `false`, in the `finally` when
 * a session ends. Turning it on is the embedder's job -- which is why
 * setVisibility is on the object handed to the embedder at all.
 *
 * Measured on a live session before this was fixed: the canvas held a complete
 * Windows desktop, 800,038 of its 800,128 pixels non-black, sitting at
 * (-688, -677) with visibility hidden on it and two of its ancestors. Every
 * layer below it worked; the picture was simply not on screen.
 */
describe('showing the RDP surface', () => {
  const VIEW = src('src/renderer/src/components/rdp/RdpView.tsx')

  it('turns the component visible, because it never does it itself', () => {
    expect(VIEW).toContain('ui.setVisibility(true)')
  })

  it('does so before the overlay stops covering the surface', () => {
    // If the phase flips first, the pane is uncovered while still hidden --
    // the same black screen, for a few frames or for ever if the call is lost.
    const show = VIEW.indexOf('ui.setVisibility(true)')
    const connected = VIEW.indexOf("setPhase('connected')")
    expect(show).toBeGreaterThan(-1)
    expect(connected).toBeGreaterThan(-1)
    expect(show, 'setVisibility must precede the connected phase').toBeLessThan(connected)
  })
})

/**
 * Keys that belong to the other machine.
 *
 * Two independent bugs met here. App shortcuts fired while a remote desktop had
 * focus, stealing the keystroke — and worse, the modifier's keyup then landed
 * after the tab had been hidden, where the component's capture gate drops it,
 * so the remote held Ctrl down indefinitely and every later keystroke arrived
 * as a chord.
 *
 * The component releases held input on window blur, visibilitychange and canvas
 * mouseleave. Switching OpsMaxx tabs is none of those: it sets `display: none`,
 * which blurs the host while the OS window keeps focus. `releaseAllInputs` is
 * not on the object the component hands the embedder, so the release is reached
 * through its own window-blur listener.
 */
describe('keys while a remote desktop has focus', () => {
  const HOTKEYS = src('src/renderer/src/hooks/useHotkeys.ts')
  const VIEW = src('src/renderer/src/components/rdp/RdpView.tsx')

  it('app shortcuts yield to the desktop, as they already did to a terminal', () => {
    expect(HOTKEYS).toContain('.rdp-surface')
    // Alongside the terminal selectors, not replacing them.
    expect(HOTKEYS).toMatch(/\.xterm[^']*\.rdp-surface/)
  })

  it('releases held keys when the tab stops being visible', () => {
    expect(VIEW).toContain("window.dispatchEvent(new Event('blur'))")

    // Guarded on the tab going AWAY, not on it arriving: dispatching while the
    // desktop is on screen would drop the user's own held modifiers.
    //
    // Asserted on the effect's own guard line rather than on how many
    // characters precede the dispatch — the first version of this measured a
    // 160-character window and broke the moment a try/catch and its comment
    // were added between the two, which is a test measuring layout.
    expect(VIEW).toContain("if (visible || phase !== 'connected') return")

    // And wrapped: the component's shutdown() leaves `this.session` set, so a
    // dispatch after teardown reaches a consumed WASM session and throws
    // synchronously into the effect that dispatched it.
    const at = VIEW.indexOf("window.dispatchEvent(new Event('blur'))")
    const around = VIEW.slice(at - 600, at + 200)
    expect(around).toContain('try {')
    expect(around).toContain('} catch {')
  })
})
