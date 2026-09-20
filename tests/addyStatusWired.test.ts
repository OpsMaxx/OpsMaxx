import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * The Sync & devices panel can actually be told something.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS
 * ===========================================================================
 *
 * The panel was written BEFORE anything could answer it. That was deliberate
 * and it is documented in `addyStatus.ts`: the screen typed the four questions
 * it needed answered and rendered "not reported" for every one of them, so it
 * was honest while the engine behind it was built. The whole design depends on
 * one thing — that when main lands the answer, the panel notices.
 *
 * It notices through `addyStatusSupported()`, which asks the bridge whether it
 * has a `status` call. So the failure this file exists against is precise and
 * it is silent: `session.status()` implemented, typechecking, unit-tested, and
 * no IPC handler or no preload method — in which case `supported` stays false
 * for ever and the panel goes on saying "sync is not running on this build"
 * over a build where it is.
 *
 * That exact failure has happened five times in this codebase (VPN profile
 * import, WireGuard discovery, coexistence advisories, addy's `attach` and
 * addy's login) and three times in CI/CD alone, which is why
 * `cicdBridgeWired.test.ts` exists. This is the same check for the same shape
 * of hole. It walks source text on purpose: that a name appears is weak proof
 * the call is right, and strong proof it is not missing.
 */

const ROOT = resolve(__dirname, '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

const MAIN = read('src/main/index.ts')
const PRELOAD = read('src/preload/index.ts')
const SESSION = read('src/main/services/addy/session.ts')
const STATUS = read('src/renderer/src/components/addy/addyStatus.ts')

describe('the status the panel asks for is reachable from the panel', () => {
  it('main answers the channel the preload invokes', () => {
    // Anchored on the channel name and the call, never on the layout: a
    // handler wrapped onto two lines is the same wiring, and a test that
    // breaks on a reformat is one people learn to edit rather than read.
    expect(MAIN).toMatch(/ipcMain\.handle\(\s*'addy:status'/)
    expect(MAIN).toMatch(/addySession\.status\(\)/)
    expect(PRELOAD).toMatch(/ipcRenderer\.invoke\('addy:status'\)/)
  })

  it('exposes both halves, because the panel subscribes only when it has both', () => {
    // `useAddyStatus` returns early unless `supported`, and `supported` reads
    // `status`. A build with the push and not the read subscribes to nothing;
    // one with the read and not the push shows a number that never changes
    // again — including "1 device" for the whole session after a pairing that
    // just added a second.
    expect(PRELOAD).toMatch(/\bstatus:\s*\(\)/)
    expect(PRELOAD).toMatch(/\bonStatus:\s*\(/)
    expect(PRELOAD).toMatch(/ipcRenderer\.on\('addy:status'/)
    expect(PRELOAD).toMatch(/removeListener\('addy:status'/)
  })

  it('main pushes on change rather than waiting to be asked', () => {
    expect(MAIN).toMatch(/addySession\.watch\(/)
    expect(MAIN).toMatch(/webContents\.send\('addy:status'/)
    // And something actually calls the notifier. A `watch` nobody announces to
    // is a subscription that never fires, which looks exactly like a working
    // one until a device is added.
    expect(SESSION).toMatch(/this\.announce\(\)/)
  })

  it('the panel reads the bridge without a cast around it', () => {
    // The cast was the marker for "main has not landed this yet", and
    // `addyStatus.ts` says in its own words that it is the line to delete when
    // main does. Leaving it would mean a rename on either side compiles
    // cleanly and reports nothing — the failure mode this whole file is about.
    expect(STATUS).not.toMatch(/as unknown as AddyStatusBridge/)
  })

  it('the shape is declared once, in the shared contract', () => {
    // Two copies of it would let main's answer drift from the panel's question
    // with neither side failing to compile.
    expect(read('src/shared/addy.ts')).toMatch(/export interface AddyStatusSnapshot/)
    expect(STATUS).toMatch(/from '\.\.\/\.\.\/\.\.\/\.\.\/shared\/addy'/)
  })
})

/**
 * The clipboard, which was entirely dead.
 *
 * `updateClipboardShortcuts` was written, correct, and called from NOWHERE —
 * so the two global shortcuts were never registered and the only way to send a
 * clipboard was a key combination nothing listened for. The handlers, the
 * sealing, the mailbox, the echo suppression and the p2p fallback all worked;
 * the feature did not exist.
 *
 * That is the sixth time this exact hole has appeared in this codebase. It is
 * not a typo class and it is not caught by a typechecker: a function nobody
 * calls compiles perfectly and its unit tests pass.
 */
describe('the clipboard shortcuts are actually registered', () => {
  it('something asks for them', () => {
    // The bug, precisely: the only mention of this function in the entire
    // repository was its own declaration.
    const mentions = MAIN.match(/updateClipboardShortcuts\(/g) ?? []
    expect(
      mentions.length,
      'updateClipboardShortcuts is declared and never called — the shortcuts are never registered'
    ).toBeGreaterThan(1)
  })

  it('is driven by a setting the user can see, not by a default', () => {
    // A global shortcut is taken from every application on the machine, and
    // Cmd/Ctrl+Shift+C is DevTools in every browser. Holding it for somebody
    // who never asked is worse than not shipping the feature.
    expect(MAIN).toMatch(/ipcMain\.handle\(\s*'addy:setClipboardShortcuts'/)
    expect(PRELOAD).toMatch(/invoke\('addy:setClipboardShortcuts'/)
    const PERSIST = read('src/renderer/src/store/persist.ts')
    expect(PERSIST).toMatch(/setClipboardShortcuts/)
    // At startup AND on change: main keeps no copy across restarts, so a
    // startup push is what stops the setting being silently off every launch.
    expect((PERSIST.match(/setClipboardShortcuts/g) ?? []).length).toBeGreaterThan(1)
  })

  it('is released when this device is not on an account', () => {
    // A shortcut whose handler can only answer "this device is not attached"
    // teaches the user the feature is broken.
    expect(MAIN).toMatch(/addySession\.attached/)
    expect(MAIN).toMatch(/refreshClipboardShortcuts/)
  })

  it('offers the switch on the panel, where the feature lives', () => {
    // A setting nobody can find cannot be how you find the feature — the same
    // argument the addy module's own registry entry makes about its nav entry.
    const PANEL = read('src/renderer/src/components/addy/AddyPanel.tsx')
    expect(PANEL).toMatch(/addyClipboardShortcuts/)
  })
})
