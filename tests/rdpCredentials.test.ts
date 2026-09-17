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
