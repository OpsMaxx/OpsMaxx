import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * The auto-import of already-installed profiles is REACHABLE.
 *
 * Modelled on tests/cicdBridgeWired.test.ts, and for the same reason it
 * exists: this feature was built by an agent working in one directory, and it
 * arrived complete, unit-tested, typechecking — and unreachable. The service
 * functions had no IPC handler, the preload had no method, and no renderer
 * called anything. Every individual piece did exactly what it promised.
 *
 * That is invisible to a typechecker and to every unit test, because an
 * exported function nobody calls is perfectly well-formed. So this walks the
 * text of all four layers. It is crude on purpose: a name appearing is not
 * proof the call is correct, but "nothing anywhere mentions this" is the
 * failure that actually happened.
 */

const ROOT = resolve(__dirname, '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

const SERVICE = read('src/main/services/vpn/import.ts')
const SHARED = read('src/shared/vpn.ts')
const MAIN = read('src/main/index.ts')
const PRELOAD = read('src/preload/index.ts')
const MODAL = read('src/renderer/src/components/vpn/VpnImportModal.tsx')

describe('discovering profiles already on this machine', () => {
  it('is implemented in main', () => {
    expect(SERVICE).toContain('export async function discoverVpnProfiles')
    expect(SERVICE).toContain('export async function vpnCommitImportFile')
  })

  it('has an IPC handler for each', () => {
    // Matched on the channel name and the call, not on where the formatter
    // decided to break the line — a test that pins layout breaks on the next
    // reformat and tells you nothing about the wiring.
    expect(MAIN).toContain("'vpn:discoverProfiles'")
    expect(MAIN).toContain("'vpn:commitImportFile'")
    expect(MAIN).toContain('discoverVpnProfiles({ knownSourcePaths })')
    expect(MAIN).toContain('vpnCommitImportFile(name, workspaceId, kind, sourcePath)')
    // Imported, not merely referenced by a string that resolves to nothing.
    expect(MAIN).toContain('discoverVpnProfiles')
    expect(MAIN).toContain('vpnCommitImportFile')
  })

  it('is exposed on the preload bridge', () => {
    expect(PRELOAD).toContain("ipcRenderer.invoke('vpn:discoverProfiles'")
    expect(PRELOAD).toContain("ipcRenderer.invoke('vpn:commitImportFile'")
  })

  it('is actually called by a renderer', () => {
    // The hole this file exists for. Every layer below was correct and the
    // feature could not be used once.
    expect(MODAL).toContain('discoverProfiles(')
    expect(MODAL).toContain('commitImportFile(')
  })

  it('carries the type across the process boundary through shared', () => {
    // It lived in the main service, where the preload cannot import it — which
    // is how a bridge method ends up typed `any` or the build breaks.
    expect(SHARED).toContain('export interface DiscoveredVpnProfile')
    expect(SERVICE).not.toContain('export interface DiscoveredVpnProfile')
  })

  it('never sends the profile text to the renderer', () => {
    // An .ovpn with an inline <key> block IS the private key. The file is read
    // in main; the renderer passes a path and gets back a spec of vault refs.
    const at = MAIN.indexOf("'vpn:commitImportFile'")
    expect(at).toBeGreaterThan(-1)
    // The handler takes a PATH. If it ever grows a `text` parameter, the key
    // material is crossing IPC again.
    const handler = MAIN.slice(at, at + 300)
    expect(handler).toContain('sourcePath: string')
    expect(handler).not.toContain('text: string')
  })

  it('excludes what is already imported by path, not by content', () => {
    // The file stays on disk and is re-found by every scan, so the path is the
    // identity. A content hash offers the same profile again the day the user
    // edits the upstream .ovpn.
    expect(MODAL).toContain('sourcePath')
    expect(SERVICE).toContain('knownSourcePaths')
  })
})
