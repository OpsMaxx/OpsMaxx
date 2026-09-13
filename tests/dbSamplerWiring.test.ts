import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * The size sampler is reachable at all.
 *
 * `db:sampler-configure` and `db:sampler-status` existed in main from the day
 * the sampler was written, with no preload bridge and no caller anywhere in
 * the renderer. So the sampler never ran on any install: every database size
 * series was empty, and nothing said the thing that fills them was not wired
 * up. A feature with no path to it fails silently and for ever, which is the
 * one failure mode nobody files a bug about.
 *
 * Greps rather than a runtime harness, because what broke was not behaviour —
 * each half worked — it was that the halves were never joined. The join is
 * what this asserts.
 */
const read = (p: string): string => readFileSync(p, 'utf8')

describe('the database size sampler', () => {
  it('has a handler in main', () => {
    const main = read('src/main/index.ts')
    expect(main).toContain("ipcMain.handle('db:sampler-configure'")
    expect(main).toContain("ipcMain.handle('db:sampler-status'")
  })

  it('has a bridge in preload', () => {
    const preload = read('src/preload/index.ts')
    expect(preload).toContain("ipcRenderer.invoke('db:sampler-configure'")
    expect(preload).toContain("ipcRenderer.invoke('db:sampler-status'")
  })

  it('is actually called by the renderer', () => {
    // The half that was missing. Without this the two above are a road that
    // goes nowhere, which is exactly the state this shipped in.
    const watcher = read('src/renderer/src/components/monitor/FleetWatcher.tsx')
    expect(watcher).toContain('samplerConfigure')
  })

  it('has a setting a person can find', () => {
    const settings = read('src/renderer/src/components/settings/Settings.tsx')
    expect(settings).toContain('dbSizeSamplingEnabled')
    // Indexed too: a switch that settings-search cannot find is most of the way
    // back to not being reachable.
    expect(settings).toContain('Record how large each database is')
  })

  it('is off by default', () => {
    // A server check is an exec channel on a connection this app already
    // holds; this opens one on somebody's database. Different enough in kind
    // that it has to be asked for.
    const app = read('src/renderer/src/store/app.ts')
    expect(app).toMatch(/dbSizeSamplingEnabled:\s*false/)
  })

  it('sends its desired state even when switched off', () => {
    // `enabled: false` is what STOPS a running sampler. Skipping the call when
    // the setting is off would make turning it off do nothing until a restart.
    const watcher = read('src/renderer/src/components/monitor/FleetWatcher.tsx')
    expect(watcher).toMatch(/enabled:\s*dbSamplingEnabled/)
  })
})
