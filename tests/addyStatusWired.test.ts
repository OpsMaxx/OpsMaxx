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
